const path = require('path');
const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    OPENCLAW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    normalizeDiaryCanonicalName,
    resolveDiaryAliasesToAvailable
} = require('../policy/mcpAgentMemoryPolicy');
const {
    createAuditLogger
} = require('../infra/auditLogger');

const DEFAULT_RAG_K = 5;
const MAX_RAG_K = 20;
const TAG_BOOST = 0.15;
const DEFAULT_CONTEXT_MAX_BLOCKS = 4;
const DEFAULT_CONTEXT_TOKEN_BUDGET = 1200;
const MAX_CONTEXT_TOKEN_BUDGET = 4000;
const DEFAULT_CONTEXT_MIN_SCORE = 0.3;
const DEFAULT_CONTEXT_MAX_TOKEN_RATIO = 0.6;
const MAX_CONTEXT_MESSAGES = 12;

let cachedKnowledgeBaseManager = null;
let cachedRagPlugin = null;

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

function buildAgentAliases(agentId, maid) {
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
    addAlias(maid);
    return aliases;
}

function collectConfiguredDiaries(agentId, maid, ragConfig) {
    const agentAliases = buildAgentAliases(agentId, maid);
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

function resolveAllowedDiaries({ agentId, maid, availableDiaries, ragConfig }) {
    const normalizedDiaries = normalizeContextStringArray(availableDiaries);
    if (normalizedDiaries.length === 0) {
        return [];
    }
    if (ragConfig.allowCrossRoleAccess) {
        return normalizedDiaries;
    }

    const { agentAliases, configuredDiaries } = collectConfiguredDiaries(agentId, maid, ragConfig);
    if (configuredDiaries.size > 0) {
        return normalizedDiaries.filter((diaryName) => configuredDiaries.has(diaryName));
    }

    const aliasMatchedDiaries = normalizedDiaries.filter((diaryName) => agentAliases.has(diaryName));
    if (ragConfig.hasExplicitPolicy) {
        return aliasMatchedDiaries;
    }

    return normalizedDiaries;
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

function getKnowledgeBaseManager(pluginManager) {
    if (pluginManager?.vectorDBManager) {
        return pluginManager.vectorDBManager;
    }
    if (pluginManager?.knowledgeBaseManager) {
        return pluginManager.knowledgeBaseManager;
    }
    if (pluginManager?.openClawBridge?.knowledgeBaseManager) {
        return pluginManager.openClawBridge.knowledgeBaseManager;
    }
    if (!cachedKnowledgeBaseManager) {
        cachedKnowledgeBaseManager = require('../../../KnowledgeBaseManager');
    }
    return cachedKnowledgeBaseManager;
}

function getRagPlugin(pluginManager) {
    const pluginManagerRagPlugin = pluginManager?.messagePreprocessors?.get?.('RAGDiaryPlugin');
    if (pluginManagerRagPlugin) {
        return pluginManagerRagPlugin;
    }
    if (pluginManager?.openClawBridge?.ragPlugin) {
        return pluginManager.openClawBridge.ragPlugin;
    }
    if (!cachedRagPlugin) {
        try {
            cachedRagPlugin = require('../../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
        } catch (error) {
            cachedRagPlugin = null;
        }
    }
    return cachedRagPlugin;
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

function extractCoreTags(boostInfo) {
    const matchedTags = Array.isArray(boostInfo?.matchedTags) ? boostInfo.matchedTags : [];
    return matchedTags
        .map((tag) => {
            if (typeof tag === 'string') {
                return tag;
            }
            if (tag && typeof tag === 'object') {
                return normalizeContextString(tag.name);
            }
            return '';
        })
        .filter(Boolean);
}

function normalizeTimestampValue(value) {
    if (typeof value === 'string' && value.trim()) {
        const timestamp = Date.parse(value);
        if (!Number.isNaN(timestamp)) {
            return new Date(timestamp).toISOString();
        }
    }
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return new Date(value).toISOString();
    }
    return null;
}

function deriveTimestampFromPath(sourcePath) {
    const normalizedPath = normalizeContextString(sourcePath);
    if (!normalizedPath) {
        return null;
    }
    const match = path.basename(normalizedPath).match(/(\d{4}[-.]\d{2}[-.]\d{2})/);
    if (!match) {
        return null;
    }
    const normalizedDate = match[1].replace(/\./g, '-');
    const timestamp = Date.parse(`${normalizedDate}T00:00:00.000Z`);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

async function getFileMetadata(knowledgeBaseManager, sourcePath) {
    if (!sourcePath) {
        return null;
    }
    if (typeof knowledgeBaseManager?.getOpenClawFileMetadata === 'function') {
        return await Promise.resolve(knowledgeBaseManager.getOpenClawFileMetadata(sourcePath));
    }
    if (!knowledgeBaseManager?.db?.prepare) {
        return null;
    }
    const row = knowledgeBaseManager.db.prepare(`
        SELECT
            f.diary_name AS sourceDiary,
            f.path AS sourcePath,
            f.updated_at AS updatedAt,
            GROUP_CONCAT(t.name, '||') AS tags
        FROM files f
        LEFT JOIN file_tags ft ON ft.file_id = f.id
        LEFT JOIN tags t ON t.id = ft.tag_id
        WHERE f.path = ?
        GROUP BY f.id
    `).get(sourcePath);

    if (!row) {
        return null;
    }

    return {
        sourceDiary: normalizeContextString(row.sourceDiary),
        sourcePath: normalizeContextString(row.sourcePath),
        updatedAt: row.updatedAt,
        tags: row.tags ? row.tags.split('||').filter(Boolean) : []
    };
}

async function getCachedFileMetadata(metadataCache, knowledgeBaseManager, sourcePath) {
    const cacheKey = normalizeContextString(sourcePath);
    if (!cacheKey) {
        return null;
    }
    if (metadataCache.has(cacheKey)) {
        return metadataCache.get(cacheKey);
    }
    const metadata = await getFileMetadata(knowledgeBaseManager, cacheKey);
    metadataCache.set(cacheKey, metadata);
    return metadata;
}

async function normalizeRagItem(result, fallbackDiary, knowledgeBaseManager, metadataCache) {
    const sourcePath = normalizeContextString(
        result?.fullPath ||
        result?.sourcePath ||
        result?.source_file ||
        result?.sourceFile
    );
    const metadata = sourcePath
        ? await getCachedFileMetadata(metadataCache, knowledgeBaseManager, sourcePath)
        : null;
    const timestamp = normalizeTimestampValue(
        result?.timestamp ||
        result?.updatedAt ||
        result?.updated_at ||
        metadata?.timestamp ||
        metadata?.updatedAt
    ) || deriveTimestampFromPath(sourcePath);

    return {
        text: normalizeContextString(result?.text),
        score: typeof result?.score === 'number' && Number.isFinite(result.score) ? result.score : 0,
        sourceDiary: normalizeContextString(result?.sourceDiary || metadata?.sourceDiary || fallbackDiary),
        sourceFile: normalizeContextString(
            result?.sourceFile ? path.basename(result.sourceFile) : (sourcePath ? path.basename(sourcePath) : '')
        ),
        timestamp,
        tags: normalizeContextStringArray(result?.tags || result?.matchedTags || metadata?.tags)
    };
}

function deduplicateRagCandidates(candidates) {
    const deduplicatedCandidates = new Map();
    for (const candidate of candidates) {
        const key = [
            normalizeContextString(candidate?.sourceDiary),
            normalizeContextString(candidate?.fullPath || candidate?.sourcePath || candidate?.sourceFile),
            normalizeContextString(candidate?.text)
        ].join('::');
        const existingCandidate = deduplicatedCandidates.get(key);
        if (!existingCandidate || (candidate?.score || 0) > (existingCandidate?.score || 0)) {
            deduplicatedCandidates.set(key, candidate);
        }
    }
    return Array.from(deduplicatedCandidates.values());
}

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

function estimateTokenCount(text) {
    const normalizedText = normalizeContextString(text);
    if (!normalizedText) {
        return 0;
    }
    const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
    const nonCjkCount = normalizedText.length - cjkCount;
    return Math.max(1, cjkCount + Math.ceil(nonCjkCount / 4));
}

function truncateTextByTokens(text, maxTokens) {
    const normalizedText = normalizeContextString(text);
    if (!normalizedText || maxTokens <= 0) {
        return '';
    }
    let candidate = normalizedText;
    while (candidate && estimateTokenCount(candidate) > maxTokens) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    return candidate;
}

function createRecallBlock(item) {
    const text = normalizeContextString(item?.text);
    const sourceDiary = normalizeContextString(item?.sourceDiary);
    const sourceFile = normalizeContextString(item?.sourceFile);
    const tags = normalizeContextStringArray(item?.tags);
    const estimatedTokens = estimateTokenCount(text);

    return {
        text,
        metadata: {
            score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
            sourceDiary,
            sourceFile,
            timestamp: item?.timestamp || null,
            tags,
            estimatedTokens
        }
    };
}

function deduplicateRecallBlocks(blocks) {
    const deduplicatedBlocks = new Map();
    for (const block of blocks) {
        const key = [
            normalizeContextString(block?.metadata?.sourceDiary),
            normalizeContextString(block?.metadata?.sourceFile),
            normalizeContextString(block?.text)
        ].join('::');
        const existingBlock = deduplicatedBlocks.get(key);
        if (!existingBlock || (block?.metadata?.score || 0) > (existingBlock?.metadata?.score || 0)) {
            deduplicatedBlocks.set(key, block);
        }
    }
    return Array.from(deduplicatedBlocks.values());
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

/**
 * 共享 search/context 的检索主流程，避免在 adapter 内复制实现。
 */
async function collectRagItems({
    pluginManager,
    query,
    requestedDiaries,
    adapterAppliedDefaultDiaryPolicy = false,
    agentId,
    maid,
    authContext,
    ragOptions,
    embeddingUtilsLoader,
    agentPolicyResolver
}) {
    const knowledgeBaseManager = getKnowledgeBaseManager(pluginManager);
    const ragPlugin = getRagPlugin(pluginManager);
    const availableDiaries = await listDiaryTargets(knowledgeBaseManager);
    const resolvedPolicy = agentPolicyResolver
        ? await agentPolicyResolver.resolvePolicy({
            authContext,
            availableDiaries
        })
        : null;
    const allowedDiaries = resolvedPolicy
        ? resolvedPolicy.allowedDiaryNames
        : resolveAllowedDiaries({
            agentId,
            maid,
            availableDiaries,
            ragConfig: getRagConfig(pluginManager)
        });
    const defaultDiaries = resolvedPolicy?.defaultDiaryNames?.length > 0
        ? resolvedPolicy.defaultDiaryNames
        : allowedDiaries;
    // Diary selectors are access-control inputs, not existence checks. VCP can
    // lazily materialize a diary later, so unresolved-but-allowed targets should
    // continue as empty search/context results instead of failing with not-found.
    requestedDiaries = resolveDiaryAliasesToAvailable(requestedDiaries, availableDiaries)
        .map((requestedDiary) => normalizeDiaryCanonicalName(requestedDiary))
        .filter(Boolean);
    const forbiddenDiaries = requestedDiaries.filter((requestedDiary) => !allowedDiaries.includes(requestedDiary));
    if (forbiddenDiaries.length > 0) {
        if (adapterAppliedDefaultDiaryPolicy) {
            const filteredDefaultDiaries = requestedDiaries.filter((requestedDiary) => allowedDiaries.includes(requestedDiary));
            if (filteredDefaultDiaries.length > 0) {
                requestedDiaries = filteredDefaultDiaries;
            } else {
                return {
                    success: false,
                    status: 403,
                    code: OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN,
                    error: 'No default diary targets are configured for this agent',
                    details: {
                        agentId,
                        allowedDiaries,
                        defaultDiaries
                    }
                };
            }
        } else {
            return {
                success: false,
                status: 403,
                code: OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN,
                error: 'Requested diary target is not allowed for this agent',
                details: {
                    diary: forbiddenDiaries[0],
                    diaries: forbiddenDiaries,
                    agentId
                }
            };
        }
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
            code: OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN,
            error: 'No default diary targets are configured for this agent',
            details: {
                agentId,
                allowedDiaries,
                defaultDiaries
            }
        };
    }

    const queryVector = await getQueryVector(query, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader);
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
        throw new Error('Failed to build query embedding');
    }

    let finalQueryVector = queryVector;
    let activatedGroups = new Map();
    if (
        ragOptions.groupAware &&
        ragPlugin?.semanticGroups?.detectAndActivateGroups &&
        ragPlugin?.semanticGroups?.getEnhancedVector
    ) {
        activatedGroups = ragPlugin.semanticGroups.detectAndActivateGroups(query);
        const enhancedVector = await ragPlugin.semanticGroups.getEnhancedVector(query, activatedGroups, queryVector);
        if (Array.isArray(enhancedVector) && enhancedVector.length > 0) {
            finalQueryVector = enhancedVector;
        }
    }

    let scoringVector = finalQueryVector;
    let coreTags = [];
    if (ragOptions.tagMemo && typeof knowledgeBaseManager?.applyTagBoost === 'function') {
        const boostResult = knowledgeBaseManager.applyTagBoost(new Float32Array(finalQueryVector), TAG_BOOST);
        if (boostResult?.vector) {
            scoringVector = Array.from(boostResult.vector);
        }
        coreTags = extractCoreTags(boostResult?.info);
    }

    const semanticSearchK = ragOptions.rerank
        ? Math.max(ragOptions.k * 2, 10)
        : Math.max(ragOptions.k, DEFAULT_RAG_K);
    const semanticResults = await Promise.all(
        targetDiaries.map(async (targetDiary) => {
            const results = await Promise.resolve(
                knowledgeBaseManager.search(
                    targetDiary,
                    finalQueryVector,
                    semanticSearchK,
                    ragOptions.tagMemo ? TAG_BOOST : 0,
                    coreTags
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
        candidates = await Promise.resolve(ragPlugin._rerankDocuments(query, candidates, ragOptions.k));
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
function createContextRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[ContextRuntimeService] pluginManager is required');
    }

    const auditLogger = deps.auditLogger || createAuditLogger();
    const embeddingUtilsLoader = deps.getEmbeddingUtils || (() => require('../../../EmbeddingUtils'));
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;

    return {
        async search({ body, startedAt, defaultSource }) {
            const query = normalizeContextString(body?.query);
            const { diary, diaries: requestedDiaries } = resolveDiarySelection(body);
            const maid = normalizeContextString(body?.maid);
            const requestContext = normalizeContextRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    maid,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = requestContext.agentId;
            const sessionId = requestContext.sessionId;
            const source = requestContext.source;
            const ragOptions = extractRagOptions(body);

            if (!query) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY,
                    error: 'query is required',
                    details: { field: 'query' }
                };
            }
            if (!agentId || !sessionId) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                    error: 'requestContext.agentId and requestContext.sessionId are required',
                    details: { field: 'requestContext' }
                };
            }
            if (!ragOptions.mode) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY,
                    error: 'mode must be one of rag, hybrid, auto',
                    details: { field: 'mode' }
                };
            }

            auditLogger.logSearch('started', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries,
                mode: ragOptions.mode
            });

            try {
                const result = await collectRagItems({
                    pluginManager,
                    query,
                    requestedDiaries,
                    adapterAppliedDefaultDiaryPolicy: body?.__defaultDiaryPolicyApplied === true,
                    agentId,
                    maid,
                    authContext,
                    ragOptions,
                    embeddingUtilsLoader,
                    agentPolicyResolver
                });
                if (!result.success) {
                    return {
                        ...result,
                        requestId
                    };
                }

                const scoredItems = result.items
                    .filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
                auditLogger.logSearch('completed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary,
                    diaries: requestedDiaries,
                    resultCount: result.items.length,
                    filteredByResultWindow: Math.max(0, result.scoredCandidates.length - scoredItems.length),
                    scoreStats: {
                        candidates: summarizeScoreStats(result.scoredCandidates.map((candidate) => candidate.score)),
                        returned: summarizeScoreStats(scoredItems.map((item) => item.score))
                    }
                }, startedAt);

                return {
                    success: true,
                    requestId,
                    data: {
                        items: result.items,
                        diagnostics: {
                            mode: ragOptions.mode,
                            targetDiaries: result.targetDiaries,
                            resultCount: result.items.length,
                            timeAwareApplied: ragOptions.timeAware && result.timeRanges.length > 0,
                            groupAwareApplied: ragOptions.groupAware && result.activatedGroups.size > 0,
                            rerankApplied: result.rerankApplied,
                            tagMemoApplied: ragOptions.tagMemo && result.coreTags.length > 0,
                            coreTags: result.coreTags,
                            durationMs: Math.max(0, Date.now() - startedAt)
                        }
                    }
                };
            } catch (error) {
                console.error('[OpenClawBridgeRoutes] Error searching OpenClaw RAG:', error);
                auditLogger.logSearch('failed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary,
                    diaries: requestedDiaries,
                    code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR
                }, startedAt);
                return {
                    success: false,
                    requestId,
                    status: 500,
                    code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR,
                    error: 'Failed to execute RAG search',
                    details: { message: error.message }
                };
            }
        },
        async buildRecallContext({ body, startedAt, defaultSource }) {
            const requestContext = normalizeContextRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    maid: body?.maid,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = normalizeContextString(body?.agentId || requestContext.agentId);
            const sessionId = normalizeContextString(body?.sessionId || requestContext.sessionId);
            const source = requestContext.source;
            const maid = normalizeContextString(body?.maid);
            const { diary, diaries: requestedDiaries } = resolveDiarySelection(body);
            const query = buildRecallQuery(body);
            const maxBlocks = parseContextInteger(body?.maxBlocks, DEFAULT_CONTEXT_MAX_BLOCKS, 1, MAX_RAG_K);
            const tokenBudget = parseContextInteger(
                body?.tokenBudget,
                DEFAULT_CONTEXT_TOKEN_BUDGET,
                1,
                MAX_CONTEXT_TOKEN_BUDGET
            );
            const maxTokenRatio = Math.min(
                1,
                Math.max(
                    0.1,
                    typeof body?.maxTokenRatio === 'number' && Number.isFinite(body.maxTokenRatio)
                        ? body.maxTokenRatio
                        : DEFAULT_CONTEXT_MAX_TOKEN_RATIO
                )
            );
            const minScore = typeof body?.minScore === 'number' && Number.isFinite(body.minScore)
                ? body.minScore
                : DEFAULT_CONTEXT_MIN_SCORE;
            const ragOptions = {
                ...extractRagOptions({
                    ...body,
                    k: Math.max(maxBlocks * 2, DEFAULT_RAG_K),
                    mode: body?.mode || 'hybrid'
                }),
                timeAware: parseContextBoolean(body?.timeAware, true),
                groupAware: parseContextBoolean(body?.groupAware, true),
                rerank: parseContextBoolean(body?.rerank, true),
                tagMemo: parseContextBoolean(body?.tagMemo, true)
            };

            if (!agentId || !sessionId) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                    error: 'agentId and sessionId are required',
                    details: { field: 'agentId/sessionId' }
                };
            }
            if (!query) {
                return {
                    success: false,
                    requestId,
                    status: 400,
                    code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY,
                    error: 'query or recentMessages is required',
                    details: { field: 'query/recentMessages' }
                };
            }

            auditLogger.logContext('started', {
                requestId,
                source,
                agentId,
                sessionId,
                diary,
                diaries: requestedDiaries
            });

            try {
                const result = await collectRagItems({
                    pluginManager,
                    query,
                    requestedDiaries,
                    adapterAppliedDefaultDiaryPolicy: body?.__defaultDiaryPolicyApplied === true,
                    agentId,
                    maid,
                    authContext,
                    ragOptions,
                    embeddingUtilsLoader,
                    agentPolicyResolver
                });
                if (!result.success) {
                    return {
                        ...result,
                        requestId
                    };
                }

                const maxInjectedTokens = Math.max(1, Math.floor(tokenBudget * maxTokenRatio));
                const recallBlocks = [];
                let consumedTokens = 0;
                const scoredItems = result.items
                    .filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
                const eligibleItems = scoredItems.filter((item) => item.score >= minScore);
                const deduplicatedBlocks = deduplicateRecallBlocks(
                    eligibleItems.map((item) => createRecallBlock(item))
                );

                for (const block of deduplicatedBlocks) {
                    if (recallBlocks.length >= maxBlocks) {
                        break;
                    }
                    const blockTokens = block.metadata.estimatedTokens || estimateTokenCount(block.text);
                    if (consumedTokens > 0 && consumedTokens + blockTokens > maxInjectedTokens) {
                        continue;
                    }
                    if (blockTokens > maxInjectedTokens) {
                        const truncatedText = truncateTextByTokens(
                            block.text,
                            Math.max(1, maxInjectedTokens - consumedTokens)
                        );
                        if (!truncatedText) {
                            continue;
                        }
                        const truncatedTokens = estimateTokenCount(truncatedText);
                        recallBlocks.push({
                            text: truncatedText,
                            metadata: {
                                ...block.metadata,
                                estimatedTokens: truncatedTokens,
                                truncated: true
                            }
                        });
                        consumedTokens += truncatedTokens;
                        break;
                    }
                    recallBlocks.push(block);
                    consumedTokens += blockTokens;
                }

                auditLogger.logContext('completed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary,
                    diaries: requestedDiaries,
                    resultCount: recallBlocks.length,
                    filteredByMinScore: Math.max(0, scoredItems.length - eligibleItems.length),
                    scoreStats: {
                        candidates: summarizeScoreStats(scoredItems.map((item) => item.score)),
                        eligible: summarizeScoreStats(eligibleItems.map((item) => item.score)),
                        recalled: summarizeScoreStats(
                            recallBlocks.map((block) => block?.metadata?.score)
                        )
                    }
                }, startedAt);

                return {
                    success: true,
                    requestId,
                    data: {
                        recallBlocks,
                        estimatedTokens: consumedTokens,
                        appliedPolicy: {
                            tokenBudget,
                            maxTokenRatio,
                            maxInjectedTokens,
                            maxBlocks,
                            minScore,
                            mode: ragOptions.mode,
                            timeAware: ragOptions.timeAware,
                            groupAware: ragOptions.groupAware,
                            rerank: ragOptions.rerank,
                            tagMemo: ragOptions.tagMemo,
                            targetDiaries: result.targetDiaries
                        }
                    }
                };
            } catch (error) {
                console.error('[OpenClawBridgeRoutes] Error building OpenClaw recall context:', error);
                auditLogger.logContext('failed', {
                    requestId,
                    source,
                    agentId,
                    sessionId,
                    diary,
                    diaries: requestedDiaries,
                    code: OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR
                }, startedAt);
                return {
                    success: false,
                    requestId,
                    status: 500,
                    code: OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR,
                    error: 'Failed to build recall context',
                    details: { message: error.message }
                };
            }
        }
    };
}

module.exports = {
    createContextRuntimeService
};
