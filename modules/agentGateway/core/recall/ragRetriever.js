const {
    normalizeRequestContext
} = require('../../contracts/requestContext');
const {
    AGW_ERROR_CODES,
    OPENCLAW_ERROR_CODES
} = require('../../contracts/errorCodes');
const { resolveDiaryAccess } = require('./diaryAccess');
const {
    createAuditLogger
} = require('../../infra/auditLogger');
const {
    projectSearchItems,
    projectContextBlocks,
    projectBudgetedContextBlocks,
    estimateTokenCount
} = require('../../services/recallProjectionService');

const DEFAULT_RAG_K = 5;
const MAX_RAG_K = 20;
const TAG_BOOST = 0.15;
const DEFAULT_CONTEXT_MAX_BLOCKS = 4;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 1200;
const MAX_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MIN_SCORE = 0.3;
const DEFAULT_CONTEXT_MAX_TOKEN_RATIO = 0.6;
const MAX_CONTEXT_MESSAGES = 12;

function normalizeContextString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeContextStringArray(value) {
    if (Array.isArray(value)) {
        return value
            .map((item) => normalizeContextString(item))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
}

function normalizeContextContentText(content) {
    if (typeof content === 'string') {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((entry) => {
                if (typeof entry === 'string') {
                    return entry.trim();
                }
                if (entry && typeof entry === 'object') {
                    return normalizeContextString(entry.text || entry.content || entry.value);
                }
                return '';
            })
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object') {
        return normalizeContextString(content.text || content.content || content.value);
    }
    return '';
}

function normalizeContextRequestContext(input, defaultSource) {
    return normalizeRequestContext(input, {
        defaultSource,
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });
}

function resolvePolicyAuthContext(authContext, fallbackContext, fallbackAgentId = '') {
    const baseAuthContext = authContext && typeof authContext === 'object' && !Array.isArray(authContext)
        ? authContext
        : {};
    const baseFallbackContext = fallbackContext && typeof fallbackContext === 'object' && !Array.isArray(fallbackContext)
        ? fallbackContext
        : {};
    const resolvedAgentId = normalizeContextString(
        baseAuthContext.agentId || baseFallbackContext.agentId || fallbackAgentId
    );

    if (!resolvedAgentId) {
        return Object.keys(baseAuthContext).length > 0 ? baseAuthContext : baseFallbackContext;
    }

    if (resolvedAgentId === normalizeContextString(baseAuthContext.agentId)) {
        return baseAuthContext;
    }

    return {
        ...baseFallbackContext,
        ...baseAuthContext,
        agentId: resolvedAgentId
    };
}

function parseContextBoolean(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function parseContextInteger(value, defaultValue, minValue = 1, maxValue = Number.MAX_SAFE_INTEGER) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) {
        return defaultValue;
    }
    return Math.min(maxValue, Math.max(minValue, parsedValue));
}

function parseContextJsonObject(value, fallbackValue = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return fallbackValue;
    }
    try {
        const parsedValue = JSON.parse(value);
        return parsedValue && typeof parsedValue === 'object' && !Array.isArray(parsedValue)
            ? parsedValue
            : fallbackValue;
    } catch (error) {
        return fallbackValue;
    }
}

function getBridgeConfig(pluginManager) {
    return pluginManager?.openClawBridgeConfig ||
        pluginManager?.openClawBridge?.config ||
        pluginManager?.openClawBridge ||
        {};
}

function getRagConfig(pluginManager) {
    const bridgeConfig = getBridgeConfig(pluginManager);
    const ragConfig = parseContextJsonObject(bridgeConfig.rag, bridgeConfig.rag || {});
    const configuredAgentDiaryMap = parseContextJsonObject(ragConfig.agentDiaryMap, {});
    const envAgentDiaryMap = parseContextJsonObject(process.env.OPENCLAW_RAG_AGENT_DIARY_MAP, {});
    const rawAllowCrossRoleAccess = ragConfig.allowCrossRoleAccess !== undefined
        ? ragConfig.allowCrossRoleAccess
        : process.env.OPENCLAW_RAG_ALLOW_CROSS_ROLE_ACCESS;
    const defaultDiaries = normalizeContextStringArray(
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
        allowCrossRoleAccess: parseContextBoolean(rawAllowCrossRoleAccess, false),
        hasExplicitPolicy: (
            Object.keys(agentDiaryMap).length > 0 ||
            defaultDiaries.length > 0 ||
            rawAllowCrossRoleAccess !== undefined
        )
    };
}

function buildAgentAliases(agentId) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeContextString(value);
        if (!normalizedValue) {
            return;
        }
        aliases.add(normalizedValue);
        normalizedValue
            .split(/[./:\\]/)
            .map((segment) => segment.trim())
            .filter(Boolean)
            .forEach((segment) => aliases.add(segment));
    };

    addAlias(agentId);
    return aliases;
}

function collectConfiguredDiaries(agentId, ragConfig) {
    const agentAliases = buildAgentAliases(agentId);
    const configuredDiaries = new Set();

    for (const alias of agentAliases) {
        normalizeContextStringArray(ragConfig.agentDiaryMap?.[alias])
            .forEach((diaryName) => configuredDiaries.add(diaryName));
    }
    normalizeContextStringArray(ragConfig.agentDiaryMap?.['*'])
        .forEach((diaryName) => configuredDiaries.add(diaryName));
    normalizeContextStringArray(ragConfig.defaultDiaries)
        .forEach((diaryName) => configuredDiaries.add(diaryName));

    return {
        agentAliases,
        configuredDiaries
    };
}

function resolveAllowedDiaries({ agentId, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeContextStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, ragConfig);
    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return [];
}

function resolveDiarySelection(body) {
    const diary = normalizeContextString(body?.diary);
    const diaries = normalizeContextStringArray(body?.diaries);
    if (diary && !diaries.includes(diary)) {
        diaries.unshift(diary);
    }
    return {
        diary,
        diaries
    };
}

function getKnowledgeBaseManager(pluginManager, ragRetrieverPort) {
    if (ragRetrieverPort?.knowledgeBaseManager) return ragRetrieverPort.knowledgeBaseManager;
    if (pluginManager?.vectorDBManager) {
        return pluginManager.vectorDBManager;
    }
    if (pluginManager?.knowledgeBaseManager) {
        return pluginManager.knowledgeBaseManager;
    }
    if (pluginManager?.openClawBridge?.knowledgeBaseManager) {
        return pluginManager.openClawBridge.knowledgeBaseManager;
    }
    return null;
}

function getRagPlugin(pluginManager, ragRetrieverPort) {
    if (ragRetrieverPort?.ragPlugin) return ragRetrieverPort.ragPlugin;
    const pluginManagerRagPlugin = pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
    if (pluginManagerRagPlugin) {
        return pluginManagerRagPlugin;
    }
    if (pluginManager?.openClawBridge?.ragPlugin) {
        return pluginManager.openClawBridge.ragPlugin;
    }
    return null;
}

async function listDiaryTargets(knowledgeBaseManager) {
    if (typeof knowledgeBaseManager?.listDiaryNames === 'function') {
        const diaryNames = await Promise.resolve(knowledgeBaseManager.listDiaryNames());
        return normalizeContextStringArray(diaryNames);
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return [];
    }

    const rows = knowledgeBaseManager.db
        .prepare('SELECT DISTINCT diary_name FROM files ORDER BY diary_name COLLATE NOCASE')
        .all();

    return rows
        .map((row) => normalizeContextString(row.diary_name))
        .filter(Boolean);
}

function normalizeRagMode(mode) {
    const normalizedMode = normalizeContextString(mode).toLowerCase();
    if (!normalizedMode) {
        return 'rag';
    }
    if (['rag', 'hybrid', 'auto'].includes(normalizedMode)) {
        return normalizedMode;
    }
    return null;
}

function extractRagOptions(body) {
    const mode = normalizeRagMode(body?.mode);
    const bodyOptions = body?.options && typeof body.options === 'object' && !Array.isArray(body.options)
        ? body.options
        : {};
    const defaults = mode === 'hybrid'
        ? { timeAware: true, groupAware: true, rerank: false, tagMemo: true }
        : { timeAware: false, groupAware: false, rerank: false, tagMemo: false };

    return {
        mode,
        k: parseContextInteger(body?.k, DEFAULT_RAG_K, 1, MAX_RAG_K),
        timeAware: parseContextBoolean(body?.timeAware ?? bodyOptions.timeAware, defaults.timeAware),
        groupAware: parseContextBoolean(body?.groupAware ?? bodyOptions.groupAware, defaults.groupAware),
        rerank: parseContextBoolean(body?.rerank ?? bodyOptions.rerank, defaults.rerank),
        tagMemo: parseContextBoolean(body?.tagMemo ?? bodyOptions.tagMemo, defaults.tagMemo)
    };
}

const {
    computeCosineSimilarity,
    deduplicateRagCandidates,
    deriveTimestampFromPath,
    extractCoreTags,
    getCachedFileMetadata,
    getFileMetadata,
    getQueryVector,
    normalizeRagItem,
    normalizeTimestampValue
} = require('./ragItemNormalizer');

function normalizeConversationMessages(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }
    return messages
        .map((message) => {
            if (!message || typeof message !== 'object') {
                return null;
            }
            const role = normalizeContextString(message.role || message.author || message.type || 'user') || 'user';
            const text = normalizeContextContentText(message.content || message.text || message.message);
            if (!text) {
                return null;
            }
            return { role, text };
        })
        .filter(Boolean)
        .slice(-MAX_CONTEXT_MESSAGES);
}

function buildRecallQuery(body) {
    const explicitQuery = normalizeContextString(body?.query);
    if (explicitQuery) {
        return explicitQuery;
    }

    const messages = normalizeConversationMessages(
        body?.recentMessages ||
        body?.messages ||
        body?.conversation ||
        body?.conversationMessages
    );
    if (messages.length === 0) {
        return '';
    }

    return messages
        .map((message) => `${message.role}: ${message.text}`)
        .join('\n')
        .slice(0, 4000);
}

function deduplicateContextItems(items) {
    const deduplicatedItems = new Map();
    for (const item of items) {
        const key = [
            normalizeContextString(item?.sourceDiary),
            normalizeContextString(item?.sourceFile),
            normalizeContextString(item?.text)
        ].join('::');
        const existingItem = deduplicatedItems.get(key);
        if (!existingItem || (item?.score || 0) > (existingItem?.score || 0)) {
            deduplicatedItems.set(key, item);
        }
    }
    return Array.from(deduplicatedItems.values());
}

function summarizeScoreStats(values) {
    const scores = Array.isArray(values)
        ? values.filter((value) => typeof value === 'number' && Number.isFinite(value))
        : [];
    if (scores.length === 0) {
        return {
            count: 0,
            max: null,
            min: null,
            avg: null
        };
    }
    const total = scores.reduce((sum, score) => sum + score, 0);
    return {
        count: scores.length,
        max: Math.max(...scores),
        min: Math.min(...scores),
        avg: total / scores.length
    };
}

async function resolveRagAccess(params, knowledgeBaseManager) {
    const availableDiaries = await listDiaryTargets(knowledgeBaseManager);
    const policyAuthContext = resolvePolicyAuthContext(params.authContext, null, params.agentId);
    return resolveDiaryAccess({
        requestedDiaries: params.requestedDiaries,
        availableDiaries,
        agentId: params.agentId,
        authContext: policyAuthContext,
        policyResolver: params.agentPolicyResolver,
        fallbackAllowedDiaries: resolveAllowedDiaries({
            agentId: params.agentId,
            availableDiaries,
            ragConfig: getRagConfig(params.pluginManager)
        }),
        appliedDefaultPolicy: params.adapterAppliedDefaultDiaryPolicy,
        forbiddenCode: OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN
    });
}

async function prepareRagVectors({ query, ragOptions, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader }) {
    const queryVector = await getQueryVector(query, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader);
    if (!Array.isArray(queryVector) || !queryVector.length) throw new Error('Failed to build query embedding');
    let finalQueryVector = queryVector;
    let activatedGroups = new Map();
    if (ragOptions.groupAware && ragPlugin?.semanticGroups?.detectAndActivateGroups && ragPlugin?.semanticGroups?.getEnhancedVector) {
        activatedGroups = ragPlugin.semanticGroups.detectAndActivateGroups(query);
        const enhanced = await ragPlugin.semanticGroups.getEnhancedVector(query, activatedGroups, queryVector);
        if (Array.isArray(enhanced) && enhanced.length) finalQueryVector = enhanced;
    }
    let scoringVector = finalQueryVector;
    let coreTags = [];
    const effectiveTagBoost = ragOptions.tagMemoWeight || TAG_BOOST;
    if (ragOptions.tagMemo && typeof knowledgeBaseManager?.applyTagBoost === 'function') {
        const boost = knowledgeBaseManager.applyTagBoost(new Float32Array(finalQueryVector), effectiveTagBoost);
        if (boost?.vector) scoringVector = Array.from(boost.vector);
        coreTags = extractCoreTags(boost?.info);
    }
    return { activatedGroups, coreTags, effectiveTagBoost, finalQueryVector, scoringVector };
}

/**
 * 共享 search/context 的检索主流程，避免在 adapter 内复制实现。
 */
async function collectRagItems(params) {
    const { pluginManager, query, ragOptions, embeddingUtilsLoader, ragRetrieverPort } = params;
    const knowledgeBaseManager = getKnowledgeBaseManager(pluginManager, ragRetrieverPort);
    const ragPlugin = getRagPlugin(pluginManager, ragRetrieverPort);
    // Diary selectors are access-control inputs, not existence checks. VCP can
    // lazily materialize a diary later, so unresolved-but-allowed targets should
    // continue as empty search/context results instead of failing with not-found.
    const access = await resolveRagAccess(params, knowledgeBaseManager);
    if (!access.success) return access;
    const targetDiaries = access.targetDiaries;
    const vectors = await prepareRagVectors({ query, ragOptions, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader });
    const { activatedGroups, coreTags, effectiveTagBoost, finalQueryVector, scoringVector } = vectors;

    const semanticSearchK = ragOptions.rerank
        ? Math.max(ragOptions.k * 2, 10)
        : Math.max(ragOptions.k, DEFAULT_RAG_K);
    const semanticSearchOptions = ragOptions.tagMemoGeodesic
        ? { geodesicRerank: true }
        : null;
    const semanticResults = await Promise.all(
        targetDiaries.map(async (targetDiary) => {
            const results = await Promise.resolve(
                knowledgeBaseManager.search(
                    targetDiary,
                    finalQueryVector,
                    semanticSearchK,
                    ragOptions.tagMemo ? effectiveTagBoost : 0,
                    coreTags,
                    1.33,
                    semanticSearchOptions
                )
            );
            return Array.isArray(results)
                ? results.map((result) => ({
                    ...result,
                    sourceDiary: normalizeContextString(result.sourceDiary || targetDiary),
                    source: 'rag'
                }))
                : [];
        })
    );

    let timeRanges = [];
    if (ragOptions.timeAware && ragPlugin?.timeParser?.parse) {
        timeRanges = ragPlugin.timeParser.parse(query);
    }

    let timeResults = [];
    if (
        timeRanges.length > 0 &&
        ragPlugin?._getTimeRangeFilePaths &&
        typeof knowledgeBaseManager?.getChunksByFilePaths === 'function'
    ) {
        const targetFilePathGroups = await Promise.all(
            targetDiaries.map(async (targetDiary) => {
                const filePaths = await Promise.all(
                    timeRanges.map((timeRange) => Promise.resolve(ragPlugin._getTimeRangeFilePaths(targetDiary, timeRange)))
                );
                return filePaths.flat();
            })
        );
        const timeFilePaths = [...new Set(targetFilePathGroups.flat())];
        const timeChunks = timeFilePaths.length > 0
            ? await Promise.resolve(knowledgeBaseManager.getChunksByFilePaths(timeFilePaths))
            : [];
        timeResults = Array.isArray(timeChunks)
            ? timeChunks.map((chunk) => ({
                ...chunk,
                score: ragPlugin?.cosineSimilarity
                    ? ragPlugin.cosineSimilarity(scoringVector, Array.from(chunk.vector || []))
                    : computeCosineSimilarity(scoringVector, Array.from(chunk.vector || [])),
                sourceDiary: normalizeContextString(
                    chunk.sourceDiary || normalizeContextString(chunk.sourceFile).split('/')[0]
                ),
                source: 'time'
            }))
            : [];
    }

    let candidates = deduplicateRagCandidates([...semanticResults.flat(), ...timeResults]);
    if (typeof knowledgeBaseManager?.deduplicateResults === 'function' && candidates.length > 1) {
        candidates = await Promise.resolve(knowledgeBaseManager.deduplicateResults(candidates, finalQueryVector));
    }
    const scoredCandidates = candidates.filter((candidate) => typeof candidate?.score === 'number' && Number.isFinite(candidate.score));

    let rerankApplied = false;
    if (ragOptions.rerank && candidates.length > 0 && ragPlugin?._rerankDocuments) {
        const rrfOptions = typeof ragOptions.rerankWeight === 'number' && Number.isFinite(ragOptions.rerankWeight)
            ? { weight: ragOptions.rerankWeight }
            : null;
        candidates = await Promise.resolve(ragPlugin._rerankDocuments(query, candidates, ragOptions.k, rrfOptions));
        rerankApplied = true;
    } else {
        candidates.sort((left, right) => (right.score || 0) - (left.score || 0));
        candidates = candidates.slice(0, ragOptions.k);
    }

    const metadataCache = new Map();
    const items = await Promise.all(
        candidates
            .filter((candidate) => normalizeContextString(candidate?.text))
            .slice(0, ragOptions.k)
            .map((candidate) => normalizeRagItem(
                candidate,
                normalizeContextString(candidate?.sourceDiary),
                knowledgeBaseManager,
                metadataCache
            ))
    );

    return {
        success: true,
        knowledgeBaseManager,
        ragPlugin,
        targetDiaries,
        items,
        activatedGroups,
        coreTags,
        rerankApplied,
        scoredCandidates,
        timeRanges
    };
}

/**
 * ContextRuntimeService 统一接管 rag/search 与 rag/context 的检索主流程。
 */
module.exports = {
    DEFAULT_RAG_K,
    MAX_RAG_K,
    TAG_BOOST,
    DEFAULT_CONTEXT_MAX_BLOCKS,
    DEFAULT_CONTEXT_TOKEN_BUDGET,
    MAX_CONTEXT_TOKEN_BUDGET,
    DEFAULT_CONTEXT_MIN_SCORE,
    DEFAULT_CONTEXT_MAX_TOKEN_RATIO,
    MAX_CONTEXT_MESSAGES,
    normalizeContextString,
    normalizeContextStringArray,
    normalizeContextContentText,
    normalizeContextRequestContext,
    resolvePolicyAuthContext,
    parseContextBoolean,
    parseContextInteger,
    parseContextJsonObject,
    getBridgeConfig,
    getRagConfig,
    buildAgentAliases,
    collectConfiguredDiaries,
    resolveAllowedDiaries,
    resolveDiarySelection,
    getKnowledgeBaseManager,
    getRagPlugin,
    listDiaryTargets,
    normalizeRagMode,
    extractRagOptions,
    computeCosineSimilarity,
    getQueryVector,
    extractCoreTags,
    normalizeTimestampValue,
    deriveTimestampFromPath,
    getFileMetadata,
    getCachedFileMetadata,
    normalizeRagItem,
    deduplicateRagCandidates,
    normalizeConversationMessages,
    buildRecallQuery,
    deduplicateContextItems,
    summarizeScoreStats,
    collectRagItems
};
