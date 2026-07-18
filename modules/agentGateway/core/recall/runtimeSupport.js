const { collectRagItems } = require('./ragRetriever');
const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { estimateTokenCount, truncateTextByTokens } = require('./recallProjectionService');
const {
    aggregateDeduplicateItems,
    applyTruncate,
    createRecallBlock,
    deduplicateItems,
    interleaveItems,
    itemKey,
    sortItemsByScore
} = require('./recallItem');
const { applyBudgetPostProcessing } = require('./tokenBudget');
const {
    normalizeString,
    normalizeStringArray,
    parseBoolean,
    parseJsonObject
} = require('../../policy/shared/normalize');

const MODIFIER_TO_RAG_OPTION = Object.freeze({
    time: 'timeAware',
    group: 'groupAware',
    rerank: 'rerank',
    tagMemo: 'tagMemo'
});

const MODIFIER_PIPELINE_ORDER = Object.freeze([
    'time',
    'group',
    'tagMemo',
    'rerank',
    'timeDecay',
    'roleValve',
    'base64Memo',
    'truncate',
    'aiMemo'
]);

const GATED_RULE_TYPES = new Set(['gated_rag', 'gated_full_text']);

const FULL_TEXT_RULE_TYPES = new Set(['full_text', 'gated_full_text']);

function resolvePolicyAuthContext(authContext, fallbackAgentId = '') {
    const baseAuthContext = authContext && typeof authContext === 'object' && !Array.isArray(authContext)
        ? authContext
        : {};
    const resolvedAgentId = normalizeString(baseAuthContext.agentId || fallbackAgentId);
    if (!resolvedAgentId || resolvedAgentId === normalizeString(baseAuthContext.agentId)) {
        return baseAuthContext;
    }
    return {
        ...baseAuthContext,
        agentId: resolvedAgentId
    };
}

function resolveRuleType(rule) {
    return normalizeString(rule?.baseMode || rule?.type);
}

function resolveRuleDiaries(rule) {
    return normalizeStringArray(rule?.targets?.diaries !== undefined ? rule.targets.diaries : rule?.diaries);
}

function resolveRuleProjection(rule) {
    if (typeof rule?.projection === 'string') {
        return normalizeString(rule.projection);
    }
    if (rule?.projection && typeof rule.projection === 'object' && !Array.isArray(rule.projection)) {
        return normalizeString(rule.projection.emit);
    }
    return '';
}

function resolveRuleAggregate(rule) {
    return parseBoolean(rule?.targets?.aggregate, false);
}

function resolveRuleKMultiplier(rule) {
    const rawValue = rule?.targets?.kMultiplier !== undefined
        ? rule.targets.kMultiplier
        : rule?.kMultiplier;
    return typeof rawValue === 'number' && Number.isFinite(rawValue) && rawValue > 0
        ? rawValue
        : 1.0;
}

function resolveRuleTargetMode(rule) {
    const diaries = resolveRuleDiaries(rule);
    const hasStructuredTargets = Boolean(rule?.targets && typeof rule.targets === 'object' && !Array.isArray(rule.targets));
    const aggregate = resolveRuleAggregate(rule);
    if (diaries.length <= 1) {
        return {
            diaries,
            aggregate,
            mode: 'single',
            supported: true
        };
    }
    if (aggregate) {
        return {
            diaries,
            aggregate: true,
            mode: 'aggregate',
            supported: true
        };
    }
    if (hasStructuredTargets) {
        return {
            diaries,
            aggregate: false,
            mode: 'parallel',
            supported: false,
            error: 'Structured multi-diary rules must set targets.aggregate=true'
        };
    }
    return {
        diaries,
        aggregate: true,
        mode: 'aggregate',
        supported: true,
        inferredFromLegacy: true
    };
}

function buildAgentAliases(agentId) {
    const aliases = new Set();
    const normalizedAgentId = normalizeString(agentId);
    if (!normalizedAgentId) {
        return aliases;
    }
    aliases.add(normalizedAgentId);
    normalizedAgentId
        .split(/[./:\\]/)
        .map((segment) => segment.trim())
        .filter(Boolean)
        .forEach((segment) => aliases.add(segment));
    return aliases;
}

function resolveAllowedDiaries({ agentId, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const agentAliases = buildAgentAliases(agentId);
    const configuredDiaries = new Set();
    for (const alias of agentAliases) {
        normalizeStringArray(ragConfig.agentDiaryMap?.[alias])
            .forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    normalizeStringArray(ragConfig.agentDiaryMap?.['*'])
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizeStringArray(ragConfig.defaultDiaries)
        .forEach((diaryName) => configuredDiaries.add(diaryName));

    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return [];
}

function parseModifierValue(key, value) {
    if (key === 'truncate') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    }
    return Boolean(value);
}

function parseTimeDecayConfig(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const halfLifeDays = value.halfLifeDays;
        if (typeof halfLifeDays === 'number' && Number.isFinite(halfLifeDays) && halfLifeDays > 0) {
            return { halfLifeDays };
        }
    }
    return null;
}

function normalizeConversationMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    return messages
        .filter((message) => message && typeof message === 'object')
        .map((message) => {
            const role = normalizeString(message.role).toLowerCase();
            if (!role) {
                return null;
            }
            return {
                role,
                content: typeof message.content === 'string' ? message.content : ''
            };
        })
        .filter(Boolean);
}

function resolveRoleValveMessages({ messages, requestContext, authContext }) {
    const candidates = [
        messages,
        requestContext?.messages,
        authContext?.messages
    ];
    for (const candidate of candidates) {
        const normalized = normalizeConversationMessages(candidate);
        if (normalized.length > 0) {
            return normalized;
        }
    }
    return [];
}

function countRoleMessages(messages) {
    return normalizeConversationMessages(messages).reduce((counts, message) => {
        const role = message.role === 'assistant'
            ? 'Assistant'
            : message.role === 'system'
                ? 'System'
                : 'User';
        counts[role] += 1;
        return counts;
    }, { User: 0, Assistant: 0, System: 0 });
}

function evaluateRoleValveCondition(condition, roleCounts) {
    const match = normalizeString(condition).match(/^@?(User|Assistant|System)(?:([<>]=?|=)(\d+))?$/i);
    if (!match) {
        return true;
    }

    const [, rawRoleName, operator, rawValue] = match;
    const roleName = rawRoleName.charAt(0).toUpperCase() + rawRoleName.slice(1).toLowerCase();
    const currentCount = roleCounts[roleName] || 0;

    if (!operator) {
        return currentCount > 0;
    }

    const targetValue = Number.parseInt(rawValue, 10);
    switch (operator) {
        case '<':
            return currentCount < targetValue;
        case '>':
            return currentCount > targetValue;
        case '<=':
            return currentCount <= targetValue;
        case '>=':
            return currentCount >= targetValue;
        case '=':
            return currentCount === targetValue;
        default:
            return true;
    }
}

function evaluateRoleValveExpression(expression, messages) {
    const normalizedExpression = normalizeString(expression);
    if (!normalizedExpression) {
        return {
            passed: true,
            roleCounts: countRoleMessages(messages),
            expression: normalizedExpression
        };
    }

    const roleCounts = countRoleMessages(messages);
    const passed = normalizedExpression
        .split('|')
        .some((orGroup) => orGroup
            .split('&')
            .every((condition) => evaluateRoleValveCondition(condition, roleCounts)));

    return {
        passed,
        roleCounts,
        expression: normalizedExpression
    };
}

function buildRagOptionsFromModifiers(modifiers, baseK = 5) {
    const normalizedModifiers = modifiers && typeof modifiers === 'object' && !Array.isArray(modifiers)
        ? modifiers
        : {};

    const options = {
        mode: 'rag',
        k: baseK,
        timeAware: false,
        groupAware: false,
        rerank: false,
        tagMemo: false
    };

    for (const modifierKey of MODIFIER_PIPELINE_ORDER) {
        if (modifierKey === 'truncate') {
            continue;
        }
        const ragOptionKey = MODIFIER_TO_RAG_OPTION[modifierKey];
        if (ragOptionKey && normalizedModifiers[modifierKey] !== undefined) {
            const modifierValue = normalizedModifiers[modifierKey];
            // Structured object modifiers: extract nested fields while preserving boolean compatibility
            if (modifierKey === 'tagMemo' && modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
                options.tagMemo = true;
                if (typeof modifierValue.weight === 'number' && Number.isFinite(modifierValue.weight)) {
                    options.tagMemoWeight = modifierValue.weight;
                }
                if (modifierValue.geodesic === true) {
                    options.tagMemoGeodesic = true;
                }
            } else if (modifierKey === 'rerank' && modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
                options.rerank = true;
                if (typeof modifierValue.weight === 'number' && Number.isFinite(modifierValue.weight)) {
                    options.rerankWeight = modifierValue.weight;
                }
            } else {
                options[ragOptionKey] = parseModifierValue(modifierKey, modifierValue);
            }
        }
    }

    const truncateValue = parseModifierValue('truncate', normalizedModifiers.truncate);

    return { options, truncate: truncateValue };
}

function computeCosineSimilarity(vectorA, vectorB) {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || vectorA.length !== vectorB.length || vectorA.length === 0) {
        return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < vectorA.length; index += 1) {
        dotProduct += vectorA[index] * vectorB[index];
        normA += vectorA[index] * vectorA[index];
        normB += vectorB[index] * vectorB[index];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function evaluateGateWithPort(rule, queryVector, ragRetrieverPort) {
    const ruleType = resolveRuleType(rule);
    if (!GATED_RULE_TYPES.has(ruleType)) return { passed: true, similarity: null };
    if (typeof rule.gateThreshold !== 'number' || !Number.isFinite(rule.gateThreshold)) {
        return { passed: true, similarity: null };
    }
    if (!Array.isArray(queryVector) || queryVector.length === 0) return { passed: false, similarity: 0 };
    const vectors = ragRetrieverPort?.getConceptVectors?.(resolveRuleDiaries(rule)) || [];
    if (!Array.isArray(vectors) || vectors.length === 0) return { passed: true, similarity: null };
    const maxSimilarity = Math.max(...vectors.map((vector) => computeCosineSimilarity(queryVector, vector)));
    return { passed: maxSimilarity >= rule.gateThreshold, similarity: maxSimilarity };
}

// --- S02 Post-Processing Modifiers ---

module.exports = {
    AGW_ERROR_CODES,
    MODIFIER_TO_RAG_OPTION,
    MODIFIER_PIPELINE_ORDER,
    GATED_RULE_TYPES,
    FULL_TEXT_RULE_TYPES,
    normalizeString,
    normalizeStringArray,
    resolvePolicyAuthContext,
    resolveRuleType,
    resolveRuleDiaries,
    resolveRuleProjection,
    resolveRuleAggregate,
    resolveRuleKMultiplier,
    resolveRuleTargetMode,
    parseBoolean,
    parseJsonObject,
    buildAgentAliases,
    resolveAllowedDiaries,
    parseModifierValue,
    parseTimeDecayConfig,
    normalizeConversationMessages,
    resolveRoleValveMessages,
    countRoleMessages,
    evaluateRoleValveCondition,
    evaluateRoleValveExpression,
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    evaluateGate: evaluateGateWithPort,
    evaluateGateWithPort
};
