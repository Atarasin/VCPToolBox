const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { collectRagItems } = require('./ragRetriever');
const {
    normalizeDiaryCanonicalName,
    resolveDiaryAliasesToAvailable
} = require('../../policy/mcpAgentMemoryPolicy');
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

function getBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getRagConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    const ragConfig = parseJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parseJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parseJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeStringArray(
        ragConfig.defaultDiaries !== undefined
            ? ragConfig.defaultDiaries
            : process.env.OPENCLAW_RAG_DEFAULT_DIARIES
    );
    const agentDiaryMap = Object.keys(configuredAgentDiaryMap).length > 0
        ? configuredAgentDiaryMap
        : envAgentDiaryMap;

    return {
        agentDiaryMap,
        defaultDiaries,
        allowCrossRoleAccess: parseBoolean(rawAllowCrossRoleAccess, false),
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
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

function getKnowledgeBaseManager(deps, pluginManager) {
    if (deps.ragRetrieverPort?.knowledgeBaseManager) return deps.ragRetrieverPort.knowledgeBaseManager;
    const ctxService = deps.contextRuntimeService;
    if (ctxService?.getKnowledgeBaseManager) {
        return ctxService.getKnowledgeBaseManager(pluginManager);
    }
    return pluginManager?.vectorDBManager ||
        pluginManager?.knowledgeBaseManager ||
        pluginManager?.openClawBridge?.knowledgeBaseManager ||
        null;
}

function getRagPlugin(deps, pluginManager) {
    if (deps.ragRetrieverPort?.ragPlugin) return deps.ragRetrieverPort.ragPlugin;
    const ctxService = deps.contextRuntimeService;
    if (ctxService?.getRagPlugin) {
        return ctxService.getRagPlugin(pluginManager);
    }
    return pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin') ||
        pluginManager?.openClawBridge?.ragPlugin ||
        null;
}

async function listDiaryTargets(knowledgeBaseManager) {
    if (typeof knowledgeBaseManager?.listDiaryNames === 'function') {
        return normalizeStringArray(await Promise.resolve(knowledgeBaseManager.listDiaryNames()));
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return [];
    }
    const rows = knowledgeBaseManager.db
        .prepare('SELECT DISTINCT diary_name FROM files ORDER BY diary_name COLLATE NOCASE')
        .all();
    return rows
        .map((row) => normalizeString(row.diary_name))
        .filter(Boolean);
}

function buildFullTextItem({ diaryName, content, rank }) {
    return {
        text: normalizeString(content),
        score: typeof rank === 'number' && Number.isFinite(rank) ? rank : 1,
        sourceDiary: normalizeString(diaryName),
        sourceFile: '',
        timestamp: null,
        tags: []
    };
}

async function defaultFullTextRetriever({
    deps,
    pluginManager,
    requestedDiaries,
    agentId,
    authContext,
    agentPolicyResolver,
    adapterAppliedDefaultDiaryPolicy
}) {
    const knowledgeBaseManager = getKnowledgeBaseManager(deps, pluginManager);
    const ragPlugin = getRagPlugin(deps, pluginManager);
    const availableDiaries = await listDiaryTargets(knowledgeBaseManager);
    const policyAuthContext = resolvePolicyAuthContext(authContext, agentId);
    const resolvedPolicy = agentPolicyResolver
        ? await agentPolicyResolver.resolvePolicy({
            authContext: policyAuthContext,
            availableDiaries
        })
        : null;
    const allowedDiaries = resolvedPolicy
        ? normalizeStringArray(resolvedPolicy.allowedDiaryNames)
        : resolveAllowedDiaries({
            agentId,
            availableDiaries,
            ragConfig: getRagConfig(pluginManager)
        });
    const defaultDiaries = resolvedPolicy?.defaultDiaryNames?.length > 0
        ? normalizeStringArray(resolvedPolicy.defaultDiaryNames)
        : allowedDiaries;
    const normalizedRequestedDiaries = resolveDiaryAliasesToAvailable(requestedDiaries, availableDiaries)
        .map((requestedDiary) => normalizeDiaryCanonicalName(requestedDiary))
        .filter(Boolean);
    const forbiddenDiaries = normalizedRequestedDiaries.filter((requestedDiary) => !allowedDiaries.includes(requestedDiary));
    if (forbiddenDiaries.length > 0) {
        if (adapterAppliedDefaultDiaryPolicy) {
            const filteredDefaultDiaries = normalizedRequestedDiaries.filter((requestedDiary) => allowedDiaries.includes(requestedDiary));
            if (filteredDefaultDiaries.length > 0) {
                requestedDiaries = filteredDefaultDiaries;
            } else {
                return {
                    success: false,
                    status: 403,
                    code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
                    error: 'No default diary targets are configured for this agent'
                };
            }
        } else {
            return {
                success: false,
                status: 403,
                code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
                error: 'Requested diary target is not allowed for this agent'
            };
        }
    } else {
        requestedDiaries = normalizedRequestedDiaries;
    }

    const targetDiaries = requestedDiaries.length > 0
        ? requestedDiaries
        : resolveDiaryAliasesToAvailable(defaultDiaries, availableDiaries)
            .map((defaultDiary) => normalizeDiaryCanonicalName(defaultDiary))
            .filter(Boolean);
    if (targetDiaries.length === 0) {
        return {
            success: false,
            status: 403,
            code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
            error: 'No default diary targets are configured for this agent'
        };
    }
    if (typeof ragPlugin?.getDiaryContent !== 'function') {
        return {
            success: false,
            status: 500,
            code: AGW_ERROR_CODES.RECALL_EXECUTION_ERROR,
            error: 'Full text retrieval is not available'
        };
    }

    const items = [];
    for (let index = 0; index < targetDiaries.length; index += 1) {
        const diaryName = targetDiaries[index];
        const content = await ragPlugin.getDiaryContent(diaryName);
        if (!normalizeString(content)) {
            continue;
        }
        items.push(buildFullTextItem({
            diaryName,
            content,
            rank: Math.max(0.1, 1 - (index * 0.01))
        }));
    }

    return {
        success: true,
        targetDiaries,
        items
    };
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

async function getQueryVector(query, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader) {
    if (ragPlugin?.getSingleEmbeddingCached) {
        return await ragPlugin.getSingleEmbeddingCached(query);
    }
    const { getEmbeddingsBatch } = embeddingUtilsLoader();
    const [vector] = await getEmbeddingsBatch([query], {
        apiKey: knowledgeBaseManager?.config?.apiKey,
        apiUrl: knowledgeBaseManager?.config?.apiUrl,
        model: knowledgeBaseManager?.config?.model
    });
    return vector || null;
}

function getDiaryConceptVectors(ragPlugin, diaries) {
    const vectors = [];
    const cache = ragPlugin?.enhancedVectorCache;
    if (!cache || typeof cache !== 'object') {
        return vectors;
    }
    for (const diary of normalizeStringArray(diaries)) {
        const vec = cache[diary];
        if (Array.isArray(vec) && vec.length > 0) {
            vectors.push({ diary, vector: vec });
        }
    }
    return vectors;
}

function evaluateGate(rule, queryVector, ragPlugin) {
    const ruleType = resolveRuleType(rule);
    if (!GATED_RULE_TYPES.has(ruleType)) {
        return { passed: true, similarity: null };
    }
    if (typeof rule.gateThreshold !== 'number' || !Number.isFinite(rule.gateThreshold)) {
        return { passed: true, similarity: null };
    }
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
        return { passed: false, similarity: 0 };
    }

    const conceptVectors = getDiaryConceptVectors(ragPlugin, resolveRuleDiaries(rule));
    if (conceptVectors.length === 0) {
        // No concept vectors available — gate cannot block, pass through
        return { passed: true, similarity: null };
    }

    let maxSimilarity = 0;
    for (const { vector } of conceptVectors) {
        const similarity = computeCosineSimilarity(queryVector, vector);
        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
        }
    }

    return {
        passed: maxSimilarity >= rule.gateThreshold,
        similarity: maxSimilarity
    };
}

// --- S02 Post-Processing Modifiers ---

module.exports = {
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
    getBridgeConfig,
    getRagConfig,
    buildAgentAliases,
    resolveAllowedDiaries,
    getKnowledgeBaseManager,
    getRagPlugin,
    listDiaryTargets,
    buildFullTextItem,
    defaultFullTextRetriever,
    parseModifierValue,
    parseTimeDecayConfig,
    normalizeConversationMessages,
    resolveRoleValveMessages,
    countRoleMessages,
    evaluateRoleValveCondition,
    evaluateRoleValveExpression,
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    getQueryVector,
    getDiaryConceptVectors,
    evaluateGate
};
