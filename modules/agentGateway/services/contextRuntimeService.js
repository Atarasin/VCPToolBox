const path = require('path');
const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    AGW_ERROR_CODES,
    OPENCLAW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    normalizeDiaryCanonicalName,
    resolveDiaryAliasesToAvailable
} = require('../policy/mcpAgentMemoryPolicy');
const {
    createAuditLogger
} = require('../infra/auditLogger');
const {
    projectSearchItems,
    projectContextBlocks,
    projectBudgetedContextBlocks,
    estimateTokenCount
} = require('./recallProjectionService');

const {
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
} = require('../core/recall/ragRetriever');

function createContextRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[ContextRuntimeService] pluginManager is required');
    }
    if (!deps.getRecallRuntimeService || typeof deps.getRecallRuntimeService !== 'function') {
        throw new Error('[ContextRuntimeService] getRecallRuntimeService is required');
    }

    const auditLogger = deps.auditLogger || createAuditLogger();
    const embeddingUtilsLoader = deps.getEmbeddingUtils || deps.ragRetrieverPort?.embeddingUtilsLoader;
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;
    const getRecallRuntimeService = deps.getRecallRuntimeService;

    function mapAgwToOcwError(agwCode, contextType = 'search') {
        switch (agwCode) {
            case AGW_ERROR_CODES.RECALL_NO_PROFILE:
                return OPENCLAW_ERROR_CODES.RECALL_NO_PROFILE;
            case AGW_ERROR_CODES.RECALL_FORBIDDEN:
                return OPENCLAW_ERROR_CODES.RECALL_FORBIDDEN;
            case AGW_ERROR_CODES.RECALL_INVALID_QUERY:
                return OPENCLAW_ERROR_CODES.RECALL_INVALID_QUERY;
            case AGW_ERROR_CODES.RECALL_INVALID_PROFILE:
                return OPENCLAW_ERROR_CODES.RECALL_INVALID_PROFILE;
            case AGW_ERROR_CODES.RECALL_INVALID_RULE:
                return OPENCLAW_ERROR_CODES.RECALL_INVALID_RULE;
            case AGW_ERROR_CODES.RECALL_INVALID_MODIFIER:
                return OPENCLAW_ERROR_CODES.RECALL_INVALID_MODIFIER;
            case AGW_ERROR_CODES.RECALL_INVALID_DIARY:
                return OPENCLAW_ERROR_CODES.RECALL_INVALID_DIARY;
            case AGW_ERROR_CODES.RECALL_EXECUTION_ERROR:
                return contextType === 'search'
                    ? OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR
                    : OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR;
            default:
                return agwCode;
        }
    }

    function resolveRecallFailureStatus(mappedCode) {
        switch (mappedCode) {
            case OPENCLAW_ERROR_CODES.RECALL_FORBIDDEN:
            case OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN:
                return 403;
            case OPENCLAW_ERROR_CODES.RECALL_NO_PROFILE:
                return 404;
            case OPENCLAW_ERROR_CODES.RECALL_INVALID_QUERY:
            case OPENCLAW_ERROR_CODES.RECALL_INVALID_PROFILE:
            case OPENCLAW_ERROR_CODES.RECALL_INVALID_RULE:
            case OPENCLAW_ERROR_CODES.RECALL_INVALID_MODIFIER:
            case OPENCLAW_ERROR_CODES.RECALL_INVALID_DIARY:
            case OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY:
                return 400;
            default:
                return 500;
        }
    }

    function buildInlineRule(requestedDiaries, ragOptions) {
        const normalizedDiaries = Array.isArray(requestedDiaries) ? requestedDiaries : [];
        return {
            baseMode: 'rag',
            targets: {
                diaries: normalizedDiaries,
                ...(normalizedDiaries.length > 1 ? { aggregate: true } : {}),
                kMultiplier: 1.0
            },
            modifiers: {
                time: ragOptions.timeAware,
                group: ragOptions.groupAware,
                rerank: ragOptions.rerank,
                tagMemo: ragOptions.tagMemo,
                truncate: ragOptions.k
            },
            gateThreshold: null
        };
    }

    function adaptRecallResultToRagResult(recallResult, requestedDiaries) {
        const ruleDiag = recallResult.diagnostics?.rules?.[0] || {};
        const activatedGroups = new Map();
        for (let i = 0; i < (ruleDiag.activatedGroupCount || 0); i += 1) {
            activatedGroups.set(`group-${i}`, {});
        }
        return {
            success: true,
            targetDiaries: ruleDiag.targetDiaries || requestedDiaries,
            items: recallResult.items,
            timeRanges: Array.from({ length: ruleDiag.timeRangesCount || 0 }),
            activatedGroups,
            rerankApplied: ruleDiag.rerankApplied || false,
            coreTags: ruleDiag.coreTags || [],
            scoredCandidates: recallResult.items
        };
    }

    return {
        async search({ body, startedAt, defaultSource, diaryPolicy = {} }) {
            const query = normalizeContextString(body?.query);
            const { diary, diaries: requestedDiaries } = resolveDiarySelection(body);
            const requestContext = normalizeContextRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = requestContext.agentId;
            const sessionId = requestContext.sessionId;
            const source = requestContext.source;
            const explicitKRaw = body?.k;
            const hasExplicitK = explicitKRaw !== undefined && explicitKRaw !== null && explicitKRaw !== '';
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
                const profileName = normalizeContextString(body?.profile) || undefined;
                let recallResult;
                if (profileName) {
                    recallResult = await getRecallRuntimeService().executeRecall({
                        agentId,
                        query,
                        profileName,
                        requestContext,
                        authContext,
                        agentPolicyResolver,
                        adapterAppliedDefaultDiaryPolicy: diaryPolicy.appliedDefault === true || body?.__defaultDiaryPolicyApplied === true
                    });
                    if (hasExplicitK && recallResult.items && recallResult.items.length > 0) {
                        const kOverride = parseContextInteger(explicitKRaw, DEFAULT_RAG_K, 1, MAX_RAG_K);
                        if (recallResult.items.length > kOverride) {
                            recallResult.items = recallResult.items.slice(0, kOverride);
                        }
                    }
                } else {
                    const inlineRule = buildInlineRule(requestedDiaries, ragOptions);
                    recallResult = await getRecallRuntimeService().executeRecall({
                        agentId,
                        query,
                        inlineRule,
                        requestContext,
                        authContext,
                        agentPolicyResolver,
                        adapterAppliedDefaultDiaryPolicy: diaryPolicy.appliedDefault === true || body?.__defaultDiaryPolicyApplied === true
                    });
                }
                if (!recallResult.success) {
                    const mappedCode = mapAgwToOcwError(recallResult.code, 'search');
                    const status = resolveRecallFailureStatus(mappedCode);
                    return {
                        success: false,
                        requestId,
                        status,
                        code: mappedCode,
                        error: recallResult.error || 'Recall execution failed',
                        details: { agentId, query }
                    };
                }
                const ruleDiag = recallResult.diagnostics?.rules?.[0] || {};
                if (ruleDiag.status === 'error') {
                    const mappedCode = mapAgwToOcwError(ruleDiag.errorCode, 'search');
                    const status = resolveRecallFailureStatus(mappedCode);
                    return {
                        success: false,
                        requestId,
                        status,
                        code: mappedCode,
                        error: ruleDiag.errorMessage || 'Recall execution failed',
                        details: { agentId, query }
                    };
                }
                const result = adaptRecallResultToRagResult(recallResult, requestedDiaries);

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
                        items: projectSearchItems(result.items),
                        diagnostics: {
                            mode: ragOptions.mode,
                            targetDiaries: result.targetDiaries,
                            resultCount: result.items.length,
                            timeAwareApplied: ragOptions.timeAware && result.timeRanges.length > 0,
                            groupAwareApplied: ragOptions.groupAware && result.activatedGroups.size > 0,
                            rerankApplied: result.rerankApplied,
                            tagMemoApplied: ragOptions.tagMemo && result.coreTags.length > 0,
                            coreTags: result.coreTags,
                            durationMs: recallResult.diagnostics?.totalDurationMs || 0
                        }
                    }
                };
            } catch (error) {
                console.error('[AgentGatewayContextRuntime] Error searching gateway RAG:', error);
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
        async buildRecallContext({ body, startedAt, defaultSource, diaryPolicy = {} }) {
            const requestContext = normalizeContextRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = normalizeContextString(body?.agentId || requestContext.agentId);
            const sessionId = normalizeContextString(body?.sessionId || requestContext.sessionId);
            const source = requestContext.source;
            const { diary, diaries: requestedDiaries } = resolveDiarySelection(body);
            const query = buildRecallQuery(body);
            const maxBlocks = parseContextInteger(body?.maxBlocks, DEFAULT_CONTEXT_MAX_BLOCKS, 1, MAX_RAG_K);
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
                const profileName = normalizeContextString(body?.profile) || undefined;
                let recallResult;
                if (profileName) {
                    recallResult = await getRecallRuntimeService().executeRecall({
                        agentId,
                        query,
                        profileName,
                        requestContext,
                        authContext,
                        agentPolicyResolver,
                        adapterAppliedDefaultDiaryPolicy: diaryPolicy.appliedDefault === true || body?.__defaultDiaryPolicyApplied === true
                    });
                } else {
                    const inlineRule = buildInlineRule(requestedDiaries, ragOptions);
                    recallResult = await getRecallRuntimeService().executeRecall({
                        agentId,
                        query,
                        inlineRule,
                        requestContext,
                        authContext,
                        agentPolicyResolver,
                        adapterAppliedDefaultDiaryPolicy: diaryPolicy.appliedDefault === true || body?.__defaultDiaryPolicyApplied === true
                    });
                }
                if (!recallResult.success) {
                    const mappedCode = mapAgwToOcwError(recallResult.code, 'context');
                    const status = resolveRecallFailureStatus(mappedCode);
                    return {
                        success: false,
                        requestId,
                        status,
                        code: mappedCode,
                        error: recallResult.error || 'Recall execution failed',
                        details: { agentId, query }
                    };
                }
                const ruleDiag = recallResult.diagnostics?.rules?.[0] || {};
                if (ruleDiag.status === 'error') {
                    const mappedCode = mapAgwToOcwError(ruleDiag.errorCode, 'context');
                    const status = resolveRecallFailureStatus(mappedCode);
                    return {
                        success: false,
                        requestId,
                        status,
                        code: mappedCode,
                        error: ruleDiag.errorMessage || 'Recall execution failed',
                        details: { agentId, query }
                    };
                }
                const result = adaptRecallResultToRagResult(recallResult, requestedDiaries);

                const profileMeta = recallResult.diagnostics?.profileMeta || {};

                const explicitTokenBudget = body?.tokenBudget;
                const explicitMaxTokenRatio = body?.maxTokenRatio;
                const explicitMinScore = body?.minScore;

                const effectiveTokenBudget = parseContextInteger(
                    explicitTokenBudget !== undefined ? explicitTokenBudget : profileMeta.tokenBudget,
                    DEFAULT_CONTEXT_TOKEN_BUDGET,
                    1,
                    MAX_CONTEXT_TOKEN_BUDGET
                );
                const effectiveMaxTokenRatio = Math.min(
                    1,
                    Math.max(
                        0.1,
                        typeof explicitMaxTokenRatio === 'number' && Number.isFinite(explicitMaxTokenRatio)
                            ? explicitMaxTokenRatio
                            : (typeof profileMeta.maxTokenRatio === 'number' && Number.isFinite(profileMeta.maxTokenRatio)
                                ? profileMeta.maxTokenRatio
                                : DEFAULT_CONTEXT_MAX_TOKEN_RATIO)
                    )
                );
                const effectiveMinScore = typeof explicitMinScore === 'number' && Number.isFinite(explicitMinScore)
                    ? explicitMinScore
                    : (typeof profileMeta.minScore === 'number' && Number.isFinite(profileMeta.minScore)
                        ? profileMeta.minScore
                        : DEFAULT_CONTEXT_MIN_SCORE);

                const profileSourced = {
                    tokenBudget: explicitTokenBudget === undefined && profileMeta.tokenBudget !== undefined,
                    maxTokenRatio: explicitMaxTokenRatio === undefined && profileMeta.maxTokenRatio !== undefined,
                    minScore: explicitMinScore === undefined && profileMeta.minScore !== undefined,
                    maxBlocks: false
                };

                const scoredItems = result.items
                    .filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
                const deduplicatedItems = deduplicateContextItems(scoredItems);

                const { blocks: recallBlocks, consumedTokens, appliedPolicy: budgetPolicy } = projectBudgetedContextBlocks(
                    deduplicatedItems,
                    {
                        tokenBudget: effectiveTokenBudget,
                        maxTokenRatio: effectiveMaxTokenRatio,
                        minScore: effectiveMinScore,
                        maxBlocks
                    }
                );

                const eligibleItems = scoredItems.filter((item) => item.score >= effectiveMinScore);

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
                            tokenBudget: effectiveTokenBudget,
                            maxTokenRatio: effectiveMaxTokenRatio,
                            maxInjectedTokens: budgetPolicy.maxInjectedTokens,
                            maxBlocks,
                            minScore: effectiveMinScore,
                            mode: ragOptions.mode,
                            timeAware: ragOptions.timeAware,
                            groupAware: ragOptions.groupAware,
                            rerank: ragOptions.rerank,
                            tagMemo: ragOptions.tagMemo,
                            targetDiaries: result.targetDiaries,
                            profileSourced
                        }
                    }
                };
            } catch (error) {
                console.error('[AgentGatewayContextRuntime] Error building gateway recall context:', error);
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
    createContextRuntimeService,
    collectRagItems
};
