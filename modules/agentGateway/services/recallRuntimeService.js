const { AGW_ERROR_CODES } = require('../contracts/errorCodes');
const { collectRagItems } = require('./contextRuntimeService');
const {
    normalizeDiaryCanonicalName,
    resolveDiaryAliasesToAvailable
} = require('../policy/mcpAgentMemoryPolicy');
const { estimateTokenCount, truncateTextByTokens } = require('./recallProjectionService');

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

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

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

function parseBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
            return true;
        }
        if (normalized === 'false' || normalized === '0') {
            return false;
        }
    }
    return fallback;
}

function parseJsonObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        } catch (_error) {
            return fallback;
        }
    }
    return fallback;
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

function applyTimeDecay(items, modifierValue) {
    const config = parseTimeDecayConfig(modifierValue);
    if (!config) {
        return items;
    }

    const lambda = Math.log(2) / config.halfLifeDays;
    const now = Date.now();

    return items.map((item) => {
        const ts = item?.timestamp;
        if (!ts) {
            return item;
        }
        const ageMs = now - new Date(ts).getTime();
        if (ageMs <= 0) {
            return item;
        }
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const decayFactor = Math.exp(-lambda * ageDays);
        return {
            ...item,
            score: (item.score || 0) * decayFactor
        };
    });
}

function parseRoleValveConfig(modifierValue) {
    if (modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
        const enabled = modifierValue.enabled !== false;
        const roles = normalizeStringArray(modifierValue.roles);
        const rawExpression = normalizeString(modifierValue.expression);
        const expression = rawExpression.toUpperCase();
        const isExpressionMode = /[@<>=|&]/.test(rawExpression);
        return {
            enabled,
            mode: isExpressionMode ? 'expression' : 'roles',
            roles,
            expression: isExpressionMode
                ? rawExpression
                : (expression === 'AND' ? 'AND' : 'OR')
        };
    }
    const roles = normalizeStringArray(modifierValue);
    return {
        enabled: true,
        mode: 'roles',
        roles,
        expression: 'OR'
    };
}

function applyRoleValve(items, modifierValue, options = {}) {
    const config = parseRoleValveConfig(modifierValue);
    if (config.enabled === false) {
        return { items, expression: config.expression, matchedCount: items.length, passed: true };
    }
    if (config.mode === 'expression') {
        const expressionResult = evaluateRoleValveExpression(config.expression, options.messages);
        return {
            items: expressionResult.passed ? items : [],
            expression: config.expression,
            matchedCount: expressionResult.passed ? items.length : 0,
            passed: expressionResult.passed,
            roleCounts: expressionResult.roleCounts
        };
    }
    if (config.roles.length === 0) {
        return { items, expression: config.expression, matchedCount: items.length, passed: true };
    }
    const filtered = items.filter((item) => {
        const role = normalizeString(item?.role);
        if (!role) {
            // Items without a role pass through (full_text may not have role metadata)
            return true;
        }
        if (config.expression === 'AND') {
            return config.roles.includes(role);
        }
        // OR (default): any matching role passes
        return config.roles.includes(role);
    });
    return { items: filtered, expression: config.expression, matchedCount: filtered.length, passed: true };
}

function applyBase64Memo(items, modifierValue) {
    const isEnabled = parseModifierValue('base64Memo', modifierValue);
    if (!isEnabled) {
        return { items, attachments: [] };
    }

    const BASE64_PATTERN = /(?:data:(?:image|application|video|audio|text)\/[^;]+;base64,[A-Za-z0-9+/=]+)/g;

    const attachments = [];
    const processedItems = [];

    for (const item of items) {
        const text = normalizeString(item?.text);
        const matches = text.match(BASE64_PATTERN);
        if (matches && matches.length > 0) {
            for (const match of matches) {
                attachments.push({
                    sourceDiary: normalizeString(item?.sourceDiary),
                    sourceFile: normalizeString(item?.sourceFile || item?.source_file),
                    content: match
                });
            }
            // Strip base64 content from item text to keep output compact
            const strippedText = text.replace(BASE64_PATTERN, '[base64-attachment]');
            processedItems.push({
                ...item,
                text: strippedText
            });
        } else {
            processedItems.push(item);
        }
    }

    return { items: processedItems, attachments };
}

// --- AIMemo Post-Recall Summarization ---

function defaultAiMemoConfigLoader() {
    const url = (process.env.AIMemoUrl || '').trim();
    const apiKey = (process.env.AIMemoApi || '').trim();
    const model = (process.env.AIMemoModel || '').trim();
    if (url && apiKey && model) {
        return { url, apiKey, model };
    }
    return null;
}

const AIMEMO_PROMPT = [
    '你是一个知识摘要助手。以下是检索系统为用户查询召回的相关记忆条目。',
    '请阅读所有条目，生成一段结构化的中文摘要，突出关键信息、重要事实和有价值的关联。',
    '如果条目数量较多，请按主题或时间线组织摘要。',
    '',
    '召回条目：',
    '{{knowledge_base}}',
    '',
    '请生成摘要：'
].join('\n');

const AIMEMO_PRESETS = Object.freeze({
    default: AIMEMO_PROMPT,
    concise: [
        '你是一个知识摘要助手。以下是检索系统召回的相关记忆条目。',
        '请用 2-3 句话概括核心信息，保持简洁。',
        '',
        '召回条目：',
        '{{knowledge_base}}',
        '',
        '请生成简洁摘要：'
    ].join('\n'),
    detailed: [
        '你是一个知识摘要助手。以下是检索系统为用户查询召回的相关记忆条目。',
        '请阅读所有条目，生成一段详细的中文摘要，涵盖：',
        '1. 每个条目的关键信息',
        '2. 条目之间的重要关联',
        '3. 有价值的事实和细节',
        '4. 按主题或时间线组织的结构',
        '',
        '召回条目：',
        '{{knowledge_base}}',
        '',
        '请生成详细摘要：'
    ].join('\n'),
    timeline: [
        '你是一个知识摘要助手。以下是检索系统召回的相关记忆条目。',
        '请按时间顺序组织摘要，突出事件的发展脉络和时序关系。',
        '',
        '召回条目：',
        '{{knowledge_base}}',
        '',
        '请生成时间线摘要：'
    ].join('\n')
});

async function applyAIMemo(items, config, llmCompletionPort) {
    const startedAt = Date.now();
    const requestedPreset = normalizeString(config?.preset) || 'default';
    const modifierDetail = {
        modifier: 'aiMemo',
        durationMs: 0,
        inputCount: Array.isArray(items) ? items.length : 0,
        skipped: false,
        summaryLength: null,
        preset: AIMEMO_PRESETS[requestedPreset] ? requestedPreset : 'default',
        error: null
    };

    // Silently skip if config is missing or items are empty
    if (!config || !config.url || !config.apiKey || !config.model || !llmCompletionPort?.available) {
        modifierDetail.skipped = true;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary: null, modifierDetail };
    }

    if (!Array.isArray(items) || items.length === 0) {
        modifierDetail.skipped = true;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary: null, modifierDetail };
    }

    try {
        const knowledgeBase = items.map((item, idx) => {
            const text = normalizeString(item?.text);
            const sourceDiary = normalizeString(item?.sourceDiary);
            const sourceFile = normalizeString(item?.sourceFile);
            const sourceLabel = sourceDiary || sourceFile || '';
            return `[${idx + 1}]${sourceLabel ? ` (${sourceLabel})` : ''}\n${text}`;
        }).join('\n\n---\n\n');

        const presetName = normalizeString(config.preset) || 'default';
        const effectivePreset = AIMEMO_PRESETS[presetName] ? presetName : 'default';
        const presetPrompt = AIMEMO_PRESETS[presetName] || AIMEMO_PRESETS.default;
        modifierDetail.preset = effectivePreset;
        const prompt = presetPrompt.replace('{{knowledge_base}}', knowledgeBase);

        const response = await llmCompletionPort.complete(config, {
                model: config.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2000
            });

        const summary = response.data?.choices?.[0]?.message?.content || null;
        modifierDetail.summaryLength = summary ? summary.length : null;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary, modifierDetail };
    } catch (error) {
        modifierDetail.durationMs = Date.now() - startedAt;
        modifierDetail.error = error.message;
        return { items, summary: null, modifierDetail };
    }
}

function applyS02Modifiers(items, modifiers, options = {}) {
    if (!modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers)) {
        return { items, attachments: [], modifierDetails: [] };
    }

    let currentItems = items;
    let accumulatedAttachments = [];
    const modifierDetails = [];

    // Apply modifiers in pipeline order (only S02 post-processing modifiers)
    for (const modifierKey of MODIFIER_PIPELINE_ORDER) {
        if (modifierKey === 'time' || modifierKey === 'group' || modifierKey === 'tagMemo' ||
            modifierKey === 'rerank' || modifierKey === 'aiMemo') {
            continue;
        }

        const modifierValue = modifiers[modifierKey];
        if (modifierValue === undefined) {
            continue;
        }

        const modifierStartedAt = Date.now();
        const inputCount = currentItems.length;

        if (modifierKey === 'timeDecay') {
            currentItems = applyTimeDecay(currentItems, modifierValue);
        } else if (modifierKey === 'roleValve') {
            const roleValveConfig = parseRoleValveConfig(modifierValue);
            if (roleValveConfig.mode === 'expression') {
                continue;
            }
            const rvResult = applyRoleValve(currentItems, modifierValue, options);
            currentItems = rvResult.items;
            modifierDetails.push({
                modifier: modifierKey,
                durationMs: Date.now() - modifierStartedAt,
                inputCount,
                outputCount: currentItems.length,
                expression: rvResult.expression,
                matchedCount: rvResult.matchedCount
            });
            continue;
        } else if (modifierKey === 'base64Memo') {
            const result = applyBase64Memo(currentItems, modifierValue);
            currentItems = result.items;
            accumulatedAttachments = accumulatedAttachments.concat(result.attachments);
        } else if (modifierKey === 'truncate') {
            const truncateLimit = parseModifierValue('truncate', modifierValue);
            currentItems = applyTruncate(currentItems, truncateLimit);
        }

        modifierDetails.push({
            modifier: modifierKey,
            durationMs: Date.now() - modifierStartedAt,
            inputCount,
            outputCount: currentItems.length
        });
    }

    return { items: currentItems, attachments: accumulatedAttachments, modifierDetails };
}

// --- Budget post-processing (S02 profile-level) ---

function applyBudgetPostProcessing(items, resolved) {
    const tokenBudget = resolved?.tokenBudget;
    const maxTokenRatio = resolved?.maxTokenRatio;
    const minScore = resolved?.minScore;

    if (tokenBudget === undefined && maxTokenRatio === undefined && minScore === undefined) {
        return { items, skipped: true, consumedTokens: 0, inputItemCount: items.length, outputItemCount: items.length };
    }

    const maxInjectedTokens = tokenBudget !== undefined && maxTokenRatio !== undefined
        ? Math.max(1, Math.floor(tokenBudget * maxTokenRatio))
        : undefined;

    let eligibleItems = items;
    if (minScore !== undefined) {
        eligibleItems = items.filter((item) => typeof item?.score === 'number' && Number.isFinite(item.score) && item.score >= minScore);
    }

    let consumedTokens = 0;
    const selectedItems = [];
    let truncatedCount = 0;

    for (const item of eligibleItems) {
        const itemTokens = estimateTokenCount(item?.text);
        if (maxInjectedTokens !== undefined && consumedTokens > 0 && consumedTokens + itemTokens > maxInjectedTokens) {
            continue;
        }
        if (maxInjectedTokens !== undefined && itemTokens > maxInjectedTokens) {
            const remainingTokens = Math.max(1, maxInjectedTokens - consumedTokens);
            const truncatedText = truncateTextByTokens(item?.text, remainingTokens);
            if (!truncatedText) {
                continue;
            }
            selectedItems.push({
                ...item,
                text: truncatedText
            });
            consumedTokens += estimateTokenCount(truncatedText);
            truncatedCount += 1;
            break;
        }
        selectedItems.push(item);
        consumedTokens += itemTokens;
    }

    return {
        items: selectedItems,
        skipped: false,
        consumedTokens,
        truncatedCount,
        inputItemCount: items.length,
        outputItemCount: selectedItems.length,
        minScoreApplied: minScore !== undefined,
        tokenBudgetApplied: tokenBudget !== undefined,
        maxTokenRatioApplied: maxTokenRatio !== undefined
    };
}

// --- Result processing ---

function deduplicateItems(items) {
    const seen = new Map();
    for (const item of items) {
        const key = [
            normalizeString(item?.sourceDiary),
            normalizeString(item?.sourceFile || item?.source_file),
            normalizeString(item?.text)
        ].join('::');
        const existing = seen.get(key);
        if (!existing || (item?.score || 0) > (existing?.score || 0)) {
            seen.set(key, item);
        }
    }
    return Array.from(seen.values());
}

function sortItemsByScore(items) {
    return [...items].sort((left, right) => (right?.score || 0) - (left?.score || 0));
}

function applyTruncate(items, truncateLimit) {
    if (typeof truncateLimit !== 'number' || !Number.isFinite(truncateLimit) || truncateLimit <= 0) {
        return items;
    }
    return items.slice(0, truncateLimit);
}

function createRecallBlock(item) {
    return {
        text: normalizeString(item?.text),
        score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
        sourceDiary: normalizeString(item?.sourceDiary),
        sourceFile: normalizeString(item?.sourceFile || item?.source_file),
        timestamp: item?.timestamp || null,
        tags: normalizeStringArray(item?.tags || item?.matchedTags)
    };
}

function aggregateDeduplicateItems(items, aggregateStrategy = 'max') {
    const seen = new Map();
    for (const item of items) {
        const key = [
            normalizeString(item?.sourceDiary),
            normalizeString(item?.sourceFile || item?.source_file),
            normalizeString(item?.text)
        ].join('::');
        const entry = seen.get(key);
        const score = typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0;
        if (!entry) {
            seen.set(key, { item, scores: [score] });
        } else {
            entry.scores.push(score);
        }
    }
    return Array.from(seen.values()).map(({ item, scores }) => {
        let aggregatedScore;
        switch (aggregateStrategy) {
            case 'sum':
                aggregatedScore = scores.reduce((a, b) => a + b, 0);
                break;
            case 'mean':
                aggregatedScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                break;
            case 'max':
            default:
                aggregatedScore = Math.max(...scores);
                break;
        }
        return {
            ...item,
            score: aggregatedScore
        };
    });
}

function interleaveItems(ruleItemsArrays) {
    const normalizedArrays = Array.isArray(ruleItemsArrays)
        ? ruleItemsArrays.filter(Array.isArray)
        : [];
    if (normalizedArrays.length === 0) {
        return [];
    }
    const result = [];
    const maxLen = Math.max(...normalizedArrays.map((arr) => arr.length));
    for (let i = 0; i < maxLen; i += 1) {
        for (const ruleItems of normalizedArrays) {
            if (i < ruleItems.length) {
                result.push(ruleItems[i]);
            }
        }
    }
    return result;
}

function buildRecallResult({ success, agentId, profileName, items, diagnostics, error, code, status }) {
    return {
        success: success !== false,
        agentId: agentId || null,
        profileName: profileName || null,
        items: Array.isArray(items) ? items : [],
        diagnostics: diagnostics || { totalDurationMs: 0, rules: [], pipelineStages: [], profileMeta: null },
        error: error || null,
        code: code || null,
        status: status || (success !== false ? 200 : 500)
    };
}

function mapResolvedRecallFailure(resolved, normalizedAgentId, requestedProfileName) {
    const rawCode = normalizeString(resolved?.code);
    if (rawCode === 'RECALL_FORBIDDEN' || rawCode === AGW_ERROR_CODES.RECALL_FORBIDDEN) {
        const forbiddenProfileName = resolved?.profileName || requestedProfileName || null;
        return {
            code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
            error: forbiddenProfileName
                ? `Recall profile "${forbiddenProfileName}" is not allowed for agent "${normalizedAgentId}"`
                : `Recall access denied for agent "${normalizedAgentId}"`,
            status: 403
        };
    }
    if (rawCode === 'RECALL_INVALID_PROFILE' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_PROFILE) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_PROFILE,
            error: resolved?.details?.message || `Invalid recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_RULE' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_RULE) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_RULE,
            error: resolved?.details?.message || `Invalid rule in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_MODIFIER' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_MODIFIER) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_MODIFIER,
            error: resolved?.details?.message || `Invalid modifier in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_DIARY' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_DIARY) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_DIARY,
            error: resolved?.details?.message || `Invalid diary access in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    return {
        code: AGW_ERROR_CODES.RECALL_NO_PROFILE,
        error: `No recall profile resolved for agent "${normalizedAgentId}"`,
        status: 404
    };
}

/**
 * Recall Runtime Service — 编译并执行预置召回配置。
 *
 * 工厂函数接收依赖注入：
 *   - pluginManager          插件总线（用于 collectRagItems 定位 RAGDiaryPlugin / KnowledgeBaseManager）
 *   - contextRuntimeService   上下文运行时服务（提供 collectRagItems）
 *   - recallProfileResolver   配置文件解析器（resolveForAgent）
 *   - embeddingUtilsLoader    Embedding 工具加载器（可选，用于 gated_rag 向量计算）
 */
function createRecallRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    const profileResolver = deps.recallProfileResolver;
    const defaultAgentPolicyResolver = deps.agentPolicyResolver || null;
    const embeddingUtilsLoader = deps.embeddingUtilsLoader || deps.ragRetrieverPort?.embeddingUtilsLoader;
    const aiMemoConfigLoader = deps.aiMemoConfigLoader || defaultAiMemoConfigLoader;
    const fullTextRetriever = typeof deps.fullTextRetriever === 'function'
        ? deps.fullTextRetriever
        : (params) => defaultFullTextRetriever({ ...params, deps });

    if (!profileResolver) {
        throw new Error('[RecallRuntimeService] recallProfileResolver is required');
    }

    async function executeRecall({
        agentId,
        query,
        profileName,
        requestContext,
        inlineRule,
        authContext,
        agentPolicyResolver,
        adapterAppliedDefaultDiaryPolicy,
        messages
    }) {
        const startedAt = Date.now();
        const pipelineStages = [];
        const normalizedAgentId = normalizeString(agentId);
        const normalizedQuery = normalizeString(query);
        // Prefer the per-request override, but fall back to the shared bundle resolver
        // so direct recall entry points do not silently bypass MCP diary policy.
        const effectiveAgentPolicyResolver = agentPolicyResolver || defaultAgentPolicyResolver;

        if (!normalizedAgentId) {
            return buildRecallResult({
                success: false,
                code: AGW_ERROR_CODES.RECALL_INVALID_QUERY,
                error: 'agentId is required',
                status: 400
            });
        }
        if (!normalizedQuery) {
            return buildRecallResult({
                success: false,
                agentId: normalizedAgentId,
                code: AGW_ERROR_CODES.RECALL_INVALID_QUERY,
                error: 'query is required',
                status: 400
            });
        }

        const resolveStartedAt = Date.now();
        let resolved;
        if (inlineRule && typeof inlineRule === 'object') {
            resolved = {
                resolved: true,
                rules: [inlineRule],
                profileName: '_inline_'
            };
        } else {
            resolved = profileResolver.resolveForAgent(normalizedAgentId, profileName);
        }
        if (!resolved.resolved) {
            const failure = mapResolvedRecallFailure(resolved, normalizedAgentId, profileName);
            return buildRecallResult({
                success: false,
                agentId: normalizedAgentId,
                profileName: resolved.profileName || profileName || null,
                code: failure.code,
                error: failure.error,
                status: failure.status,
                diagnostics: { totalDurationMs: Date.now() - startedAt, rules: [] }
            });
        }
        pipelineStages.push({
            name: 'resolveProfile',
            durationMs: Date.now() - resolveStartedAt,
            status: 'ok',
            detail: { profileName: resolved.profileName, ruleCount: resolved.rules.length }
        });

        // Pre-compute query vector once for all gated evaluations
        // Skip for inlineRule path since gated rules are not applicable there
        const vectorStartedAt = Date.now();
        let queryVector = null;
        let vectorFetchError = null;
        if (!inlineRule) {
            try {
                const knowledgeBaseManager = getKnowledgeBaseManager(deps, pluginManager);
                const ragPlugin = getRagPlugin(deps, pluginManager);
                queryVector = await getQueryVector(normalizedQuery, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader);
            } catch (error) {
                vectorFetchError = error;
            }
        }
        pipelineStages.push({
            name: 'precomputeVector',
            durationMs: Date.now() - vectorStartedAt,
            status: vectorFetchError ? 'error' : 'ok',
            detail: { vectorPrecomputed: Array.isArray(queryVector) && queryVector.length > 0, skipped: Boolean(inlineRule) }
        });

        const roleValveMessages = resolveRoleValveMessages({
            messages,
            requestContext,
            authContext
        });
        const ruleDiagnostics = [];
        const ruleItemsArrays = [];
        const allAttachments = [];

        for (let ruleIndex = 0; ruleIndex < resolved.rules.length; ruleIndex += 1) {
            const rule = resolved.rules[ruleIndex];
            const ruleStartedAt = Date.now();
            const ruleType = resolveRuleType(rule);
            const targetSemantics = resolveRuleTargetMode(rule);
            const ruleDiaries = targetSemantics.diaries;
            const ruleProjection = resolveRuleProjection(rule);
            const ruleAggregate = targetSemantics.aggregate;
            const ruleDiagnostic = {
                ruleIndex,
                type: ruleType,
                baseMode: ruleType,
                status: 'pending',
                durationMs: 0,
                itemCount: 0
            };
            if (ruleProjection) {
                ruleDiagnostic.projection = ruleProjection;
            }
            if (ruleAggregate) {
                ruleDiagnostic.targetAggregate = true;
            }
            ruleDiagnostic.targetMode = targetSemantics.mode;
            if (targetSemantics.inferredFromLegacy) {
                ruleDiagnostic.targetAggregateInferred = true;
            }

            try {
                if (!targetSemantics.supported) {
                    ruleDiagnostic.status = 'error';
                    ruleDiagnostic.errorCode = AGW_ERROR_CODES.RECALL_EXECUTION_ERROR;
                    ruleDiagnostic.errorMessage = targetSemantics.error;
                    ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                    ruleDiagnostics.push(ruleDiagnostic);
                    pipelineStages.push({
                        name: 'ruleExecution',
                        ruleIndex,
                        type: ruleType,
                        durationMs: ruleDiagnostic.durationMs,
                        status: ruleDiagnostic.status
                    });
                    continue;
                }

                const preModifierDetails = [];
                const roleValveModifier = rule.modifiers?.roleValve;
                const roleValveConfig = parseRoleValveConfig(roleValveModifier);
                if (roleValveModifier !== undefined && roleValveConfig.mode === 'expression' && roleValveConfig.enabled !== false) {
                    const roleValveStartedAt = Date.now();
                    const roleValveResult = evaluateRoleValveExpression(roleValveConfig.expression, roleValveMessages);
                    const roleValveDetail = {
                        modifier: 'roleValve',
                        durationMs: Date.now() - roleValveStartedAt,
                        inputCount: roleValveMessages.length,
                        outputCount: roleValveResult.passed ? roleValveMessages.length : 0,
                        expression: roleValveResult.expression,
                        passed: roleValveResult.passed,
                        roleCounts: roleValveResult.roleCounts,
                        stage: 'pre'
                    };
                    preModifierDetails.push(roleValveDetail);
                    ruleDiagnostic.roleValvePassed = roleValveResult.passed;
                    ruleDiagnostic.roleCounts = roleValveResult.roleCounts;

                    if (!roleValveResult.passed) {
                        ruleDiagnostic.status = 'gated';
                        ruleDiagnostic.modifierDetails = preModifierDetails;
                        ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                        ruleDiagnostics.push(ruleDiagnostic);
                        pipelineStages.push({
                            name: 'ruleExecution',
                            ruleIndex,
                            type: ruleType,
                            durationMs: ruleDiagnostic.durationMs,
                            status: ruleDiagnostic.status
                        });
                        continue;
                    }
                }

                // --- Gate evaluation for gated_rag / gated_full_text ---
                // Skip gate evaluation for inlineRule path (no precomputed vector)
                if (!inlineRule && GATED_RULE_TYPES.has(ruleType)) {
                    const ctxService = deps.contextRuntimeService;
                    const ragPlugin = ctxService?.getRagPlugin
                        ? ctxService.getRagPlugin(pluginManager)
                        : null;

                    const gateResult = evaluateGate(
                        rule,
                        queryVector,
                        ragPlugin
                    );
                    ruleDiagnostic.gatePassed = gateResult.passed;
                    ruleDiagnostic.gateSimilarity = gateResult.similarity;

                    if (!gateResult.passed) {
                        ruleDiagnostic.status = 'gated';
                        ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                        ruleDiagnostics.push(ruleDiagnostic);
                        pipelineStages.push({
                            name: 'ruleExecution',
                            ruleIndex,
                            type: ruleType,
                            durationMs: ruleDiagnostic.durationMs,
                            status: ruleDiagnostic.status
                        });
                        continue;
                    }
                }

                const isFullText = FULL_TEXT_RULE_TYPES.has(ruleType);
                let retrievalResult;
                let ragModifierDetails = [];

                if (isFullText) {
                    retrievalResult = await fullTextRetriever({
                        pluginManager,
                        query: normalizedQuery,
                        requestedDiaries: ruleDiaries,
                        agentId: normalizedAgentId,
                        authContext: authContext || requestContext,
                        agentPolicyResolver: effectiveAgentPolicyResolver,
                        adapterAppliedDefaultDiaryPolicy: adapterAppliedDefaultDiaryPolicy || false,
                        rule
                    });
                } else {
                    const effectiveK = Math.max(1, Math.round(5 * resolveRuleKMultiplier(rule)));
                    const { options: ragOptions } = buildRagOptionsFromModifiers(rule.modifiers, effectiveK);

                    if (rule.modifiers && typeof rule.modifiers === 'object' && !Array.isArray(rule.modifiers)) {
                        if (rule.modifiers.tagMemo !== undefined) {
                            const tagMemoDetail = {
                                modifier: 'tagMemo',
                                durationMs: 0,
                                inputCount: 0,
                                outputCount: 0,
                                applied: Boolean(ragOptions.tagMemo)
                            };
                            if (typeof ragOptions.tagMemoWeight === 'number') {
                                tagMemoDetail.weight = ragOptions.tagMemoWeight;
                            }
                            if (ragOptions.tagMemoGeodesic === true) {
                                tagMemoDetail.geodesic = true;
                            }
                            ragModifierDetails.push(tagMemoDetail);
                        }
                        if (rule.modifiers.rerank !== undefined) {
                            const rerankDetail = {
                                modifier: 'rerank',
                                durationMs: 0,
                                inputCount: 0,
                                outputCount: 0,
                                applied: Boolean(ragOptions.rerank)
                            };
                            if (typeof ragOptions.rerankWeight === 'number') {
                                rerankDetail.weight = ragOptions.rerankWeight;
                            }
                            ragModifierDetails.push(rerankDetail);
                        }
                    }

                    retrievalResult = await collectRagItems({
                        pluginManager,
                        query: normalizedQuery,
                        requestedDiaries: ruleDiaries,
                        adapterAppliedDefaultDiaryPolicy: adapterAppliedDefaultDiaryPolicy || false,
                        agentId: normalizedAgentId,
                        authContext: authContext || requestContext,
                        ragOptions,
                        embeddingUtilsLoader,
                        ragRetrieverPort: deps.ragRetrieverPort,
                        agentPolicyResolver: effectiveAgentPolicyResolver
                    });
                }

                if (!retrievalResult.success) {
                    ruleDiagnostic.status = 'error';
                    ruleDiagnostic.errorCode = retrievalResult.code;
                    ruleDiagnostic.errorMessage = retrievalResult.error;
                    ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                    ruleDiagnostics.push(ruleDiagnostic);
                    pipelineStages.push({
                        name: 'ruleExecution',
                        ruleIndex,
                        type: ruleType,
                        durationMs: ruleDiagnostic.durationMs,
                        status: ruleDiagnostic.status
                    });
                    continue;
                }

                let ruleItems = Array.isArray(retrievalResult.items) ? retrievalResult.items : [];

                // Enrich diagnostics from the selected base mode without coupling the shape
                // of full-text retrieval to the RAG candidate pipeline.
                ruleDiagnostic.targetDiaries = retrievalResult.targetDiaries || [];
                ruleDiagnostic.timeRangesCount = retrievalResult.timeRanges?.length || 0;
                ruleDiagnostic.activatedGroupCount = retrievalResult.activatedGroups?.size || 0;
                ruleDiagnostic.rerankApplied = retrievalResult.rerankApplied || false;
                ruleDiagnostic.tagMemoCount = retrievalResult.coreTags?.length || 0;
                ruleDiagnostic.coreTags = retrievalResult.coreTags || [];

                // --- Apply S02 post-processing modifiers ---
                const s02Result = applyS02Modifiers(ruleItems, rule.modifiers, {
                    messages: roleValveMessages
                });
                ruleItems = s02Result.items;
                ruleDiagnostic.modifierDetails = [...preModifierDetails, ...ragModifierDetails, ...s02Result.modifierDetails];
                const truncateDetail = s02Result.modifierDetails.find((m) => m.modifier === 'truncate');
                if (truncateDetail) {
                    ruleDiagnostic.truncateInputCount = truncateDetail.inputCount;
                    ruleDiagnostic.truncateOutputCount = truncateDetail.outputCount;
                }
                if (s02Result.attachments.length > 0) {
                    allAttachments.push(...s02Result.attachments);
                    ruleDiagnostic.attachmentCount = s02Result.attachments.length;
                }

                // --- Per-rule aiMemo ---
                const ruleAiMemoModifier = !inlineRule ? rule.modifiers?.aiMemo : undefined;
                const ruleAiMemo = ruleAiMemoModifier ? parseModifierValue('aiMemo', ruleAiMemoModifier) : false;
                if (ruleAiMemo) {
                    const aiMemoConfig = aiMemoConfigLoader();
                    const preset = (ruleAiMemoModifier && typeof ruleAiMemoModifier === 'object' && !Array.isArray(ruleAiMemoModifier))
                        ? normalizeString(ruleAiMemoModifier.preset)
                        : '';
                    const aiMemoResult = await applyAIMemo(ruleItems, {
                        ...(aiMemoConfig || {}),
                        preset: preset || undefined
                    }, deps.llmCompletionPort);
                    if (aiMemoResult.modifierDetail) {
                        ruleDiagnostic.modifierDetails.push(aiMemoResult.modifierDetail);
                        ruleDiagnostic.aiMemoSummary = aiMemoResult.summary;
                    }
                }

                ruleItemsArrays.push(ruleItems);

                ruleDiagnostic.status = 'ok';
                ruleDiagnostic.itemCount = ruleItems.length;
                ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                ruleDiagnostics.push(ruleDiagnostic);
                pipelineStages.push({
                    name: 'ruleExecution',
                    ruleIndex,
                    type: ruleType,
                    durationMs: ruleDiagnostic.durationMs,
                    status: ruleDiagnostic.status
                });
            } catch (error) {
                ruleDiagnostic.status = 'error';
                ruleDiagnostic.errorCode = AGW_ERROR_CODES.RECALL_EXECUTION_ERROR;
                ruleDiagnostic.errorMessage = error.message;
                ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                ruleDiagnostics.push(ruleDiagnostic);
                pipelineStages.push({
                    name: 'ruleExecution',
                    ruleIndex,
                    type: ruleType,
                    durationMs: ruleDiagnostic.durationMs,
                    status: ruleDiagnostic.status
                });
            }
        }

        // --- Merge results ---
        const mergeStartedAt = Date.now();
        const mergeStrategy = resolved.merge;
        const aggregateStrategy = resolved.aggregate;
        const profileTruncateTo = resolved.truncateTo;

        let mergedItems;
        const mergeDetail = {
            strategy: mergeStrategy || 'default',
            aggregate: aggregateStrategy || 'max',
            inputRuleCount: ruleItemsArrays.length,
            inputItemCount: ruleItemsArrays.flat().length,
            outputItemCount: 0
        };

        if (mergeStrategy === 'interleave') {
            // Deduplicate across all rules with aggregate strategy, then
            // group surviving items back by originating rule for round-robin.
            const flatItems = ruleItemsArrays.flat();
            const deduped = aggregateDeduplicateItems(flatItems, aggregateStrategy);
            const dedupedKeySet = new Set();
            for (const item of deduped) {
                const key = [
                    normalizeString(item?.sourceDiary),
                    normalizeString(item?.sourceFile || item?.source_file),
                    normalizeString(item?.text)
                ].join('::');
                dedupedKeySet.add(key);
            }

            const seenKeys = new Set();
            const itemsByRule = ruleItemsArrays.map(() => []);
            for (let ri = 0; ri < ruleItemsArrays.length; ri += 1) {
                for (const item of ruleItemsArrays[ri]) {
                    const key = [
                        normalizeString(item?.sourceDiary),
                        normalizeString(item?.sourceFile || item?.source_file),
                        normalizeString(item?.text)
                    ].join('::');
                    if (!seenKeys.has(key) && dedupedKeySet.has(key)) {
                        seenKeys.add(key);
                        const match = deduped.find((d) => [
                            normalizeString(d?.sourceDiary),
                            normalizeString(d?.sourceFile || d?.source_file),
                            normalizeString(d?.text)
                        ].join('::') === key);
                        if (match) {
                            itemsByRule[ri].push(match);
                        }
                    }
                }
            }
            const sortedByRule = itemsByRule.map((arr) => sortItemsByScore(arr));
            mergedItems = interleaveItems(sortedByRule);
            mergeDetail.interleavedRuleCount = sortedByRule.filter((arr) => arr.length > 0).length;
            mergeDetail.outputItemCount = mergedItems.length;
        } else {
            const flatItems = ruleItemsArrays.flat();
            mergedItems = aggregateDeduplicateItems(flatItems, aggregateStrategy);
            mergedItems = sortItemsByScore(mergedItems);
            mergeDetail.deduplicatedCount = mergedItems.length;
            mergeDetail.outputItemCount = mergedItems.length;
        }

        // Apply profile-level truncateTo if set.
        const truncateLimit = profileTruncateTo !== undefined ? profileTruncateTo : null;
        mergedItems = applyTruncate(mergedItems, truncateLimit);
        mergedItems = mergedItems.map((item) => createRecallBlock(item));
        mergeDetail.outputItemCount = mergedItems.length;

        pipelineStages.push({
            name: 'mergeResults',
            durationMs: Date.now() - mergeStartedAt,
            status: 'ok',
            detail: mergeDetail
        });

        // --- Budget post-processing ---
        const budgetStartedAt = Date.now();
        const budgetResult = applyBudgetPostProcessing(mergedItems, resolved);
        mergedItems = budgetResult.items;
        if (!budgetResult.skipped) {
            pipelineStages.push({
                name: 'budgetFilter',
                durationMs: Date.now() - budgetStartedAt,
                status: 'ok',
                detail: {
                    inputItemCount: budgetResult.inputItemCount,
                    outputItemCount: budgetResult.outputItemCount,
                    minScoreApplied: budgetResult.minScoreApplied,
                    tokenBudgetApplied: budgetResult.tokenBudgetApplied,
                    maxTokenRatioApplied: budgetResult.maxTokenRatioApplied,
                    tokensConsumed: budgetResult.consumedTokens
                }
            });
        }

        // --- Profile-level AIMemo ---
        let aiMemoSummary = null;
        const profileAiMemo = !inlineRule ? resolved.aiMemo : undefined;
        if (profileAiMemo) {
            const aiMemoConfig = aiMemoConfigLoader();
            const preset = (profileAiMemo && typeof profileAiMemo === 'object' && !Array.isArray(profileAiMemo))
                ? normalizeString(profileAiMemo.preset)
                : '';
            const aiMemoResult = await applyAIMemo(mergedItems, {
                ...(aiMemoConfig || {}),
                preset: preset || undefined
            }, deps.llmCompletionPort);
            if (aiMemoResult.modifierDetail) {
                pipelineStages.push({
                    name: 'aiMemo',
                    durationMs: aiMemoResult.modifierDetail.durationMs,
                    status: aiMemoResult.summary ? 'ok'
                        : (aiMemoResult.modifierDetail.error ? 'error' : 'skipped'),
                    detail: {
                        inputCount: aiMemoResult.modifierDetail.inputCount,
                        skipped: aiMemoResult.modifierDetail.skipped,
                        summaryLength: aiMemoResult.modifierDetail.summaryLength,
                        error: aiMemoResult.modifierDetail.error || undefined
                    }
                });
            }
            aiMemoSummary = aiMemoResult.summary;
        }

        const totalDurationMs = Date.now() - startedAt;

        return buildRecallResult({
            success: true,
            agentId: normalizedAgentId,
            profileName: resolved.profileName,
            items: mergedItems,
            diagnostics: {
                totalDurationMs,
                rules: ruleDiagnostics,
                pipelineStages,
                profileMeta: (() => {
                    const meta = {
                        profileName: resolved.profileName,
                        ruleCount: resolved.rules.length,
                        modifierKeys: [...new Set(resolved.rules.flatMap((r) => Object.keys(r.modifiers || {})))]
                    };
                    if (resolved.truncateTo !== undefined) {
                        meta.truncateTo = resolved.truncateTo;
                    }
                    if (resolved.merge !== undefined) {
                        meta.merge = resolved.merge;
                    }
                    if (resolved.aggregate !== undefined) {
                        meta.aggregate = resolved.aggregate;
                    }
                    if (resolved.projection !== undefined) {
                        meta.projection = resolved.projection;
                    }
                    if (resolved.tokenBudget !== undefined) {
                        meta.tokenBudget = resolved.tokenBudget;
                    }
                    if (resolved.maxTokenRatio !== undefined) {
                        meta.maxTokenRatio = resolved.maxTokenRatio;
                    }
                    if (resolved.minScore !== undefined) {
                        meta.minScore = resolved.minScore;
                    }
                    if (resolved.aiMemo !== undefined) {
                        meta.aiMemo = resolved.aiMemo;
                    }
                    return meta;
                })(),
                attachments: allAttachments.length > 0 ? allAttachments : undefined,
                vectorPrecomputed: Array.isArray(queryVector) && queryVector.length > 0,
                vectorPrecomputeError: vectorFetchError ? vectorFetchError.message : null,
                summary: aiMemoSummary || undefined
            }
        });
    }

    return {
        executeRecall
    };
}

module.exports = {
    createRecallRuntimeService,
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    evaluateGate,
    deduplicateItems,
    sortItemsByScore,
    applyTruncate,
    createRecallBlock,
    buildRecallResult,
    mapResolvedRecallFailure,
    applyTimeDecay,
    applyRoleValve,
    parseRoleValveConfig,
    evaluateRoleValveExpression,
    applyBase64Memo,
    applyAIMemo,
    applyS02Modifiers,
    applyBudgetPostProcessing,
    defaultAiMemoConfigLoader,
    AIMEMO_PROMPT,
    AIMEMO_PRESETS,
    MODIFIER_PIPELINE_ORDER,
    MODIFIER_TO_RAG_OPTION,
    GATED_RULE_TYPES,
    FULL_TEXT_RULE_TYPES,
    aggregateDeduplicateItems,
    interleaveItems
};
