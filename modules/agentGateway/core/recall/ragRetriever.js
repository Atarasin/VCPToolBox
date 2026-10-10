const {
    normalizeRequestContext
} = require('../../contracts/requestContext');
const {
    AGW_ERROR_CODES,
    OPENCLAW_ERROR_CODES
} = require('../../contracts/errorCodes');
const { resolveDiaryAccess } = require('./diaryAccess');
const { resolveGlobalRecallMode } = require('../../policy/recallProfileResolver');
const {
    projectSearchItems,
    projectContextBlocks,
    projectBudgetedContextBlocks,
    estimateTokenCount
} = require('../../services/recallProjectionService');

// 检索预算（D6·方案A 保守放开）：默认 k 5→8、上限 20→50；k/上限可经 recall
// profile 档案字段 targets.k 覆盖，tagBoost 经 modifiers.tagMemo.weight 覆盖。
const DEFAULT_RAG_K = 8;
const MAX_RAG_K = 50;
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
    getQueryVectorFromPort,
    normalizeRagItem,
    normalizeRagItemFromPort,
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

async function resolveRagAccess(params, ragRetrieverPort) {
    const availableDiaries = normalizeContextStringArray(
        await Promise.resolve(ragRetrieverPort.listDiaries())
    );
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
            ragConfig: params.ragConfig || {}
        }),
        appliedDefaultPolicy: params.adapterAppliedDefaultDiaryPolicy,
        forbiddenCode: OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN
    });
}

async function prepareRagVectors({ query, ragOptions, ragRetrieverPort }) {
    const queryVector = await getQueryVectorFromPort(query, ragRetrieverPort);
    if (!Array.isArray(queryVector) || !queryVector.length) throw new Error('Failed to build query embedding');
    let finalQueryVector = queryVector;
    let activatedGroups = new Map();
    if (ragOptions.groupAware && ragRetrieverPort.enhanceSemanticGroups) {
        const enhanced = await ragRetrieverPort.enhanceSemanticGroups(query, queryVector);
        activatedGroups = enhanced?.groups instanceof Map ? enhanced.groups : new Map();
        if (Array.isArray(enhanced?.vector) && enhanced.vector.length) finalQueryVector = enhanced.vector;
    }
    let scoringVector = finalQueryVector;
    let coreTags = [];
    let preparedMemoObservation = null;
    const effectiveTagBoost = ragOptions.tagMemoWeight || TAG_BOOST;
    if (ragOptions.tagMemo && ragRetrieverPort.applyTagBoost) {
        // queryText 必须传入：applyTagBoostAsync 以其构建 preparedMemoObservation 的
        // 标签激活 sensing，缺文本会让复用该观测的 river 查询路由失真。
        const boost = await ragRetrieverPort.applyTagBoost(finalQueryVector, effectiveTagBoost, { queryText: query });
        if (boost?.vector) scoringVector = Array.from(boost.vector);
        coreTags = extractCoreTags(boost?.info);
        // 复用 applyTagBoostAsync 已完成的 Rust sensing，river 查询免一次重复构造
        if (boost?.preparedMemoObservation && typeof boost.preparedMemoObservation === 'object') {
            preparedMemoObservation = boost.preparedMemoObservation;
        }
    }
    return { activatedGroups, coreTags, effectiveTagBoost, finalQueryVector, scoringVector, preparedMemoObservation };
}

// M3.S2：辅助向量条数与时间衰减（对齐 RAGDiaryPlugin 生产端 shotgun 历史段参数）
const SUPPLEMENTAL_MESSAGE_LIMIT = 3;
const SUPPLEMENTAL_DECAY_FACTOR = 0.85;

async function buildSupplementalQueryVectors({ recentMessages, ragRetrieverPort }) {
    const messages = (Array.isArray(recentMessages) ? recentMessages : [])
        .map((message) => normalizeContextContentText(message?.content ?? message?.text))
        .filter(Boolean)
        .slice(-SUPPLEMENTAL_MESSAGE_LIMIT);
    if (messages.length === 0 || typeof ragRetrieverPort?.embedQuery !== 'function') {
        return [];
    }
    const supplemental = [];
    for (let index = 0; index < messages.length; index += 1) {
        try {
            const vector = await Promise.resolve(ragRetrieverPort.embedQuery(messages[index]));
            if (!Array.isArray(vector) || vector.length === 0) continue;
            supplemental.push({
                vector,
                weight: Math.pow(SUPPLEMENTAL_DECAY_FACTOR, messages.length - index)
            });
        } catch (_error) {
            // 单条辅助向量失败不影响主查询
        }
    }
    return supplemental;
}

/**
 * M3.S3：river 混合计划的稀疏文件候选——BM25 候选与 time 命中文件按 path 合并，
 * 打法对齐 RAGDiaryPlugin 生产端（mergeNativeFileCandidate：分数取 max、time 来源优先）。
 */
async function buildRiverFileCandidates({ targetDiaries, query, ragOptions, ragRetrieverPort, semanticSearchK, timeRanges }) {
    const byPath = new Map();
    const merge = (candidate) => {
        const candidatePath = normalizeContextString(candidate?.path);
        if (!candidatePath) return;
        const existing = byPath.get(candidatePath) || {
            path: candidatePath,
            bm25Score: 0,
            normalizedBM25Score: 0,
            timeScore: 0,
            source: ''
        };
        existing.bm25Score = Math.max(existing.bm25Score, Number(candidate?.bm25Score) || 0);
        existing.normalizedBM25Score = Math.max(existing.normalizedBM25Score, Number(candidate?.normalizedBM25Score) || 0);
        existing.timeScore = Math.max(existing.timeScore, Number(candidate?.timeScore) || 0);
        const nextSource = normalizeContextString(candidate?.source);
        if (nextSource === 'time' || !existing.source || existing.source === 'rag') {
            existing.source = nextSource;
        }
        byPath.set(candidatePath, existing);
    };

    if (ragOptions.bm25 && typeof ragRetrieverPort.getBM25FileCandidates === 'function') {
        const bm25Limit = Math.max(
            semanticSearchK,
            ragOptions.k * (ragOptions.rerank ? 5 : 3)
        );
        try {
            const bm25 = await Promise.resolve(ragRetrieverPort.getBM25FileCandidates(
                targetDiaries,
                query,
                bm25Limit,
                ragOptions.bm25Mode === 'body' ? 'body' : 'tag',
                ragOptions.bm25Weight !== undefined ? ragOptions.bm25Weight : 0.6
            ));
            for (const file of Array.isArray(bm25?.files) ? bm25.files : []) {
                merge(file);
            }
        } catch (error) {
            // BM25 失败不阻断主查询，仅损失稀疏路
            console.warn(`[AgentGatewayRecall] BM25 file candidates unavailable: ${error.message}`);
        }
    }

    // timeLimits 透传：timeAware 命中的时间范围文件以 timeScore=1 并入候选
    if (timeRanges.length > 0 && typeof ragRetrieverPort.getTimeRangeFilePaths === 'function') {
        try {
            const filePaths = (await Promise.all(
                targetDiaries.map(async (targetDiary) => Promise.all(
                    timeRanges.map((timeRange) => Promise.resolve(
                        ragRetrieverPort.getTimeRangeFilePaths(targetDiary, timeRange)
                    ))
                ))
            )).flat(2);
            for (const filePath of new Set(filePaths.map((p) => normalizeContextString(p)).filter(Boolean))) {
                merge({ path: filePath, timeScore: 1, source: 'time' });
            }
        } catch (error) {
            console.warn(`[AgentGatewayRecall] Time file candidates unavailable: ${error.message}`);
        }
    }

    return Array.from(byPath.values());
}

/**
 * 共享 search/context 的检索主流程，避免在 adapter 内复制实现。
 */
async function collectRagItems(params) {
    const { query, ragOptions, ragRetrieverPort } = params;
    if (!ragRetrieverPort?.available) {
        return { success: false, status: 500, code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR,
            error: 'RAG retrieval is not available' };
    }
    // Diary selectors are access-control inputs, not existence checks. VCP can
    // lazily materialize a diary later, so unresolved-but-allowed targets should
    // continue as empty search/context results instead of failing with not-found.
    const access = await resolveRagAccess(params, ragRetrieverPort);
    if (!access.success) return access;
    const targetDiaries = access.targetDiaries;
    const vectors = await prepareRagVectors({ query, ragOptions, ragRetrieverPort });
    const { activatedGroups, coreTags, effectiveTagBoost, finalQueryVector, scoringVector, preparedMemoObservation } = vectors;

    // rerank 开启时候选池翻倍供重排消费；k 本身已由 extractRagOptions /
    // buildRagOptionsFromModifiers 注入默认值，此处不再设下限（显式小 k 应被尊重）。
    const semanticSearchK = ragOptions.rerank
        ? Math.max(ragOptions.k * 2, 10)
        : ragOptions.k;
    // 时间范围解析前置：river 混合计划需要把 time 命中文件并入 fileCandidates
    let timeRanges = [];
    if (ragOptions.timeAware && ragRetrieverPort.parseTimeRanges) {
        timeRanges = await Promise.resolve(ragRetrieverPort.parseTimeRanges(query));
    }
    // 语义检索引擎分支：全局开关（AGENT_GATEWAY_RECALL_MODE / recall_profiles.json 顶层
    // recallMode，热加载）。默认 river（2026-10-10 M3 混合检索后重评达标切回，重评报告见
    // docs/testing/）；river 失败降级已在端口绑定层包装（D1·方案A），此处拿到的
    // riverQuery 不会抛上游异常。
    const recallMode = resolveGlobalRecallMode();
    const riverEligible = recallMode === 'river' && typeof ragRetrieverPort.riverQuery === 'function';
    let riverEngine = null;
    let semanticResults;
    if (riverEligible) {
        // M3.S2：多查询向量——从 recentMessages 提取辅助向量（越新权重越高，衰减 0.85，
        // 对齐 RAGDiaryPlugin 生产端 shotgun 打法），作为 supplementalQueryVectors 参与
        // river 联合查询，扩大召回覆盖面。仅 river 路径消费（KNN 绑定无该参数面）。
        const supplementalQueryVectors = await buildSupplementalQueryVectors({
            recentMessages: params.recentMessages,
            ragRetrieverPort
        });
        // M3.S3：BM25 混合计划——稀疏文件候选（生产端 _getBM25FileCandidates 打法）
        // 与 timeLimits 命中文件融合为 hybridPlan.fileCandidates，Rust 联合层完成
        // Chunk 展开与向量融合。bm25Limit 对齐生产：max(k, finalK × (rerank?5:3))。
        const nativeFileCandidates = await buildRiverFileCandidates({
            targetDiaries,
            query,
            ragOptions,
            ragRetrieverPort,
            semanticSearchK,
            timeRanges
        });
        const hybridPlan = (nativeFileCandidates.length > 0 || supplementalQueryVectors.length > 0)
            ? {
                supplemental: {
                    perIndexK: Math.max(2, Math.round(semanticSearchK / 2))
                },
                fileCandidates: nativeFileCandidates,
                bm25Weight: ragOptions.bm25Weight !== undefined ? ragOptions.bm25Weight : 0.6,
                bm25Mode: ragOptions.bm25Mode === 'body' ? 'body' : 'tag'
            }
            : null;
        const riverResult = await Promise.resolve(ragRetrieverPort.riverQuery(
            { text: query, vector: finalQueryVector },
            {
                diaryNames: targetDiaries,
                preparedMemoObservation: preparedMemoObservation || undefined,
                topK: semanticSearchK,
                coreTags,
                supplementalQueryVectors,
                hybridPlan,
                sourceObservationConfig: {
                    baseTagBoost: ragOptions.tagMemo ? effectiveTagBoost : 0,
                    coreBoostFactor: 1.33
                },
                enabled: true
            }
        ));
        semanticResults = [(Array.isArray(riverResult?.results) ? riverResult.results : []).map((result) => ({
            ...result,
            sourceDiary: normalizeContextString(result.sourceDiary || result.diaryName),
            source: 'rag'
        }))];
        riverEngine = {
            mode: 'river',
            degraded: riverResult?.degraded || null,
            artifactSig: riverResult?.artifactSig || null,
            queryId: riverResult?.queryId || null
        };
        console.log(
            `[AgentGatewayRecall] 🌊 River retrieval: diaries=${targetDiaries.join('|')}, ` +
            `returned=${semanticResults[0].length}` +
            `${riverResult?.degraded ? `, degraded=${riverResult.degraded.engine}` : ''}.`
        );
    } else {
        if (recallMode === 'river') {
            console.warn('[AgentGatewayRecall] River mode is configured but the port lacks riverQuery; using KNN search.');
        }
        semanticResults = await Promise.all(
            targetDiaries.map(async (targetDiary) => {
                const results = await Promise.resolve(
                    ragRetrieverPort.searchDiary(targetDiary, finalQueryVector, {
                        k: semanticSearchK,
                        tagBoost: ragOptions.tagMemo ? effectiveTagBoost : 0,
                        coreTags,
                        geodesicRerank: ragOptions.tagMemoGeodesic === true
                    })
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
    }

    let timeResults = [];
    if (
        timeRanges.length > 0 &&
        ragRetrieverPort.getTimeRangeFilePaths &&
        ragRetrieverPort.getChunksByFilePaths
    ) {
        const targetFilePathGroups = await Promise.all(
            targetDiaries.map(async (targetDiary) => {
                const filePaths = await Promise.all(
                    timeRanges.map((timeRange) => Promise.resolve(
                        ragRetrieverPort.getTimeRangeFilePaths(targetDiary, timeRange)
                    ))
                );
                return filePaths.flat();
            })
        );
        const timeFilePaths = [...new Set(targetFilePathGroups.flat())];
        const timeChunks = timeFilePaths.length > 0
            ? await Promise.resolve(ragRetrieverPort.getChunksByFilePaths(timeFilePaths))
            : [];
        timeResults = Array.isArray(timeChunks)
            ? timeChunks.map((chunk) => ({
                ...chunk,
                score: ragRetrieverPort.cosineSimilarity
                    ? ragRetrieverPort.cosineSimilarity(scoringVector, Array.from(chunk.vector || []))
                    : computeCosineSimilarity(scoringVector, Array.from(chunk.vector || [])),
                sourceDiary: normalizeContextString(
                    chunk.sourceDiary || normalizeContextString(chunk.sourceFile).split('/')[0]
                ),
                source: 'time'
            }))
            : [];
    }

    let candidates = deduplicateRagCandidates([...semanticResults.flat(), ...timeResults]);
    if (ragRetrieverPort.deduplicateResults && candidates.length > 1) {
        candidates = await Promise.resolve(ragRetrieverPort.deduplicateResults(candidates, finalQueryVector));
    }
    const scoredCandidates = candidates.filter((candidate) => typeof candidate?.score === 'number' && Number.isFinite(candidate.score));

    let rerankApplied = false;
    if (ragOptions.rerank && candidates.length > 0 && ragRetrieverPort.rerank) {
        const rrfOptions = typeof ragOptions.rerankWeight === 'number' && Number.isFinite(ragOptions.rerankWeight)
            ? { weight: ragOptions.rerankWeight }
            : null;
        candidates = await Promise.resolve(ragRetrieverPort.rerank(query, candidates, ragOptions.k, rrfOptions));
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
            .map((candidate) => normalizeRagItemFromPort(
                candidate,
                normalizeContextString(candidate?.sourceDiary),
                ragRetrieverPort,
                metadataCache
            ))
    );

    return {
        success: true,
        targetDiaries,
        items,
        activatedGroups,
        coreTags,
        rerankApplied,
        scoredCandidates,
        timeRanges,
        riverEngine
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
    buildAgentAliases,
    collectConfiguredDiaries,
    resolveAllowedDiaries,
    resolveDiarySelection,
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
