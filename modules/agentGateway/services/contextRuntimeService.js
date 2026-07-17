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

function mapAgwToOcwError(code, type = 'search') {
    const mapped = {
        [AGW_ERROR_CODES.RECALL_NO_PROFILE]: OPENCLAW_ERROR_CODES.RECALL_NO_PROFILE,
        [AGW_ERROR_CODES.RECALL_FORBIDDEN]: OPENCLAW_ERROR_CODES.RECALL_FORBIDDEN,
        [AGW_ERROR_CODES.RECALL_INVALID_QUERY]: OPENCLAW_ERROR_CODES.RECALL_INVALID_QUERY,
        [AGW_ERROR_CODES.RECALL_INVALID_PROFILE]: OPENCLAW_ERROR_CODES.RECALL_INVALID_PROFILE,
        [AGW_ERROR_CODES.RECALL_INVALID_RULE]: OPENCLAW_ERROR_CODES.RECALL_INVALID_RULE,
        [AGW_ERROR_CODES.RECALL_INVALID_MODIFIER]: OPENCLAW_ERROR_CODES.RECALL_INVALID_MODIFIER,
        [AGW_ERROR_CODES.RECALL_INVALID_DIARY]: OPENCLAW_ERROR_CODES.RECALL_INVALID_DIARY
    };
    if (code === AGW_ERROR_CODES.RECALL_EXECUTION_ERROR) {
        return type === 'search' ? OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR : OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR;
    }
    return mapped[code] || code;
}

function resolveRecallFailureStatus(code) {
    if ([OPENCLAW_ERROR_CODES.RECALL_FORBIDDEN, OPENCLAW_ERROR_CODES.RAG_TARGET_FORBIDDEN].includes(code)) return 403;
    if (code === OPENCLAW_ERROR_CODES.RECALL_NO_PROFILE) return 404;
    if ([OPENCLAW_ERROR_CODES.RECALL_INVALID_QUERY, OPENCLAW_ERROR_CODES.RECALL_INVALID_PROFILE,
        OPENCLAW_ERROR_CODES.RECALL_INVALID_RULE, OPENCLAW_ERROR_CODES.RECALL_INVALID_MODIFIER,
        OPENCLAW_ERROR_CODES.RECALL_INVALID_DIARY, OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY].includes(code)) return 400;
    return 500;
}

function buildInlineRule(diaries, options) {
    const targets = Array.isArray(diaries) ? diaries : [];
    return { baseMode: 'rag', targets: { diaries: targets, ...(targets.length > 1 ? { aggregate: true } : {}), kMultiplier: 1 },
        modifiers: { time: options.timeAware, group: options.groupAware, rerank: options.rerank,
            tagMemo: options.tagMemo, truncate: options.k }, gateThreshold: null };
}

function adaptRecallResult(recallResult, requestedDiaries) {
    const diag = recallResult.diagnostics?.rules?.[0] || {};
    const groups = new Map();
    for (let index = 0; index < (diag.activatedGroupCount || 0); index += 1) groups.set(`group-${index}`, {});
    return { targetDiaries: diag.targetDiaries || requestedDiaries, items: recallResult.items,
        timeRanges: Array.from({ length: diag.timeRangesCount || 0 }), activatedGroups: groups,
        rerankApplied: diag.rerankApplied || false, coreTags: diag.coreTags || [], scoredCandidates: recallResult.items };
}

function createContextRuntimeState(deps) {
    if (!deps.pluginManager) throw new Error('[ContextRuntimeService] pluginManager is required');
    if (typeof deps.getRecallRuntimeService !== 'function') {
        throw new Error('[ContextRuntimeService] getRecallRuntimeService is required');
    }
    return { auditLogger: deps.auditLogger || { logSearch() {}, logContext() {} },
        authContextResolver: typeof deps.authContextResolver === 'function' ? deps.authContextResolver : null,
        agentPolicyResolver: deps.agentPolicyResolver?.resolvePolicy ? deps.agentPolicyResolver : null,
        getRecallRuntimeService: deps.getRecallRuntimeService };
}

function resolveAuthContext(state, body, requestContext) {
    return state.authContextResolver
        ? state.authContextResolver({ authContext: body?.authContext, requestContext, adapter: requestContext.runtime })
        : requestContext;
}

function normalizeSearchInput(state, input) {
    const body = input.body;
    const requestContext = normalizeContextRequestContext(body?.requestContext, input.defaultSource);
    const selection = resolveDiarySelection(body);
    const rawK = body?.k;
    return { state, ...input, diaryPolicy: input.diaryPolicy || {}, body, requestContext,
        authContext: resolveAuthContext(state, body, requestContext),
        requestId: requestContext.requestId, agentId: requestContext.agentId, sessionId: requestContext.sessionId,
        source: requestContext.source, query: normalizeContextString(body?.query), diary: selection.diary,
        requestedDiaries: selection.diaries, ragOptions: extractRagOptions(body), rawK,
        hasExplicitK: rawK !== undefined && rawK !== null && rawK !== '' };
}

function validateSearch(ctx) {
    if (!ctx.query) return { success: false, requestId: ctx.requestId, status: 400,
        code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY, error: 'query is required', details: { field: 'query' } };
    if (!ctx.agentId || !ctx.sessionId) return { success: false, requestId: ctx.requestId, status: 400,
        code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
        error: 'requestContext.agentId and requestContext.sessionId are required', details: { field: 'requestContext' } };
    if (!ctx.ragOptions.mode) return { success: false, requestId: ctx.requestId, status: 400,
        code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY, error: 'mode must be one of rag, hybrid, auto',
        details: { field: 'mode' } };
    return null;
}

async function runRecall(ctx) {
    const profileName = normalizeContextString(ctx.body?.profile) || undefined;
    const args = { agentId: ctx.agentId, query: ctx.query, requestContext: ctx.requestContext,
        authContext: ctx.authContext, agentPolicyResolver: ctx.state.agentPolicyResolver,
        adapterAppliedDefaultDiaryPolicy: ctx.diaryPolicy.appliedDefault === true ||
            ctx.body?.__defaultDiaryPolicyApplied === true };
    const recallResult = await ctx.state.getRecallRuntimeService().executeRecall(profileName
        ? { ...args, profileName }
        : { ...args, inlineRule: buildInlineRule(ctx.requestedDiaries, ctx.ragOptions) });
    if (profileName && ctx.hasExplicitK && recallResult.items?.length > 0) {
        recallResult.items = recallResult.items.slice(0, parseContextInteger(ctx.rawK, DEFAULT_RAG_K, 1, MAX_RAG_K));
    }
    return recallResult;
}

function recallFailure(ctx, recallResult, type) {
    const ruleDiag = recallResult.diagnostics?.rules?.[0] || {};
    if (recallResult.success && ruleDiag.status !== 'error') return null;
    const code = mapAgwToOcwError(recallResult.success ? ruleDiag.errorCode : recallResult.code, type);
    return { success: false, requestId: ctx.requestId, status: resolveRecallFailureStatus(code), code,
        error: (recallResult.success ? ruleDiag.errorMessage : recallResult.error) || 'Recall execution failed',
        details: { agentId: ctx.agentId, query: ctx.query } };
}

function completeSearch(ctx, recallResult) {
    const result = adaptRecallResult(recallResult, ctx.requestedDiaries);
    const scored = result.items.filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
    ctx.state.auditLogger.logSearch('completed', { requestId: ctx.requestId, source: ctx.source,
        agentId: ctx.agentId, sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries,
        resultCount: result.items.length, filteredByResultWindow: Math.max(0, result.scoredCandidates.length - scored.length),
        scoreStats: { candidates: summarizeScoreStats(result.scoredCandidates.map((item) => item.score)),
            returned: summarizeScoreStats(scored.map((item) => item.score)) } }, ctx.startedAt);
    return { success: true, requestId: ctx.requestId, data: { items: projectSearchItems(result.items), diagnostics: {
        mode: ctx.ragOptions.mode, targetDiaries: result.targetDiaries, resultCount: result.items.length,
        timeAwareApplied: ctx.ragOptions.timeAware && result.timeRanges.length > 0,
        groupAwareApplied: ctx.ragOptions.groupAware && result.activatedGroups.size > 0,
        rerankApplied: result.rerankApplied, tagMemoApplied: ctx.ragOptions.tagMemo && result.coreTags.length > 0,
        coreTags: result.coreTags, durationMs: recallResult.diagnostics?.totalDurationMs || 0 } } };
}

async function search(state, input) {
    const ctx = normalizeSearchInput(state, input);
    const invalid = validateSearch(ctx);
    if (invalid) return invalid;
    state.auditLogger.logSearch('started', { requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
        sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries, mode: ctx.ragOptions.mode });
    try {
        const recallResult = await runRecall(ctx);
        return recallFailure(ctx, recallResult, 'search') || completeSearch(ctx, recallResult);
    } catch (error) {
        console.error('[AgentGatewayContextRuntime] Error searching gateway RAG:', error);
        state.auditLogger.logSearch('failed', { requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
            sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries,
            code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR }, ctx.startedAt);
        return { success: false, requestId: ctx.requestId, status: 500, code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR,
            error: 'Failed to execute RAG search', details: { message: error.message } };
    }
}

function normalizeContextInput(state, input) {
    const body = input.body;
    const requestContext = normalizeContextRequestContext(body?.requestContext, input.defaultSource);
    const selection = resolveDiarySelection(body);
    const maxBlocks = parseContextInteger(body?.maxBlocks, DEFAULT_CONTEXT_MAX_BLOCKS, 1, MAX_RAG_K);
    const ragOptions = { ...extractRagOptions({ ...body, k: Math.max(maxBlocks * 2, DEFAULT_RAG_K),
        mode: body?.mode || 'hybrid' }), timeAware: parseContextBoolean(body?.timeAware, true),
        groupAware: parseContextBoolean(body?.groupAware, true), rerank: parseContextBoolean(body?.rerank, true),
        tagMemo: parseContextBoolean(body?.tagMemo, true) };
    return { state, ...input, diaryPolicy: input.diaryPolicy || {}, body, requestContext,
        authContext: resolveAuthContext(state, body, requestContext),
        requestId: requestContext.requestId, agentId: normalizeContextString(body?.agentId || requestContext.agentId),
        sessionId: normalizeContextString(body?.sessionId || requestContext.sessionId), source: requestContext.source,
        diary: selection.diary, requestedDiaries: selection.diaries, query: buildRecallQuery(body), maxBlocks, ragOptions };
}

function validateContext(ctx) {
    if (!ctx.agentId || !ctx.sessionId) return { success: false, requestId: ctx.requestId, status: 400,
        code: OPENCLAW_ERROR_CODES.INVALID_REQUEST, error: 'agentId and sessionId are required',
        details: { field: 'agentId/sessionId' } };
    if (!ctx.query) return { success: false, requestId: ctx.requestId, status: 400,
        code: OPENCLAW_ERROR_CODES.RAG_INVALID_QUERY, error: 'query or recentMessages is required',
        details: { field: 'query/recentMessages' } };
    return null;
}

function resolveBudgetPolicy(body, profileMeta) {
    const tokenBudget = parseContextInteger(body?.tokenBudget !== undefined ? body.tokenBudget : profileMeta.tokenBudget,
        DEFAULT_CONTEXT_TOKEN_BUDGET, 1, MAX_CONTEXT_TOKEN_BUDGET);
    const ratioCandidate = typeof body?.maxTokenRatio === 'number' && Number.isFinite(body.maxTokenRatio)
        ? body.maxTokenRatio : (typeof profileMeta.maxTokenRatio === 'number' && Number.isFinite(profileMeta.maxTokenRatio)
            ? profileMeta.maxTokenRatio : DEFAULT_CONTEXT_MAX_TOKEN_RATIO);
    const minScore = typeof body?.minScore === 'number' && Number.isFinite(body.minScore) ? body.minScore
        : (typeof profileMeta.minScore === 'number' && Number.isFinite(profileMeta.minScore)
            ? profileMeta.minScore : DEFAULT_CONTEXT_MIN_SCORE);
    return { tokenBudget, maxTokenRatio: Math.min(1, Math.max(0.1, ratioCandidate)), minScore,
        profileSourced: { tokenBudget: body?.tokenBudget === undefined && profileMeta.tokenBudget !== undefined,
            maxTokenRatio: body?.maxTokenRatio === undefined && profileMeta.maxTokenRatio !== undefined,
            minScore: body?.minScore === undefined && profileMeta.minScore !== undefined, maxBlocks: false } };
}

function completeContext(ctx, recallResult) {
    const result = adaptRecallResult(recallResult, ctx.requestedDiaries);
    const policy = resolveBudgetPolicy(ctx.body, recallResult.diagnostics?.profileMeta || {});
    const scored = result.items.filter((item) => typeof item.score === 'number' && Number.isFinite(item.score));
    const projection = projectBudgetedContextBlocks(deduplicateContextItems(scored), {
        tokenBudget: policy.tokenBudget, maxTokenRatio: policy.maxTokenRatio,
        minScore: policy.minScore, maxBlocks: ctx.maxBlocks });
    const eligible = scored.filter((item) => item.score >= policy.minScore);
    ctx.state.auditLogger.logContext('completed', { requestId: ctx.requestId, source: ctx.source,
        agentId: ctx.agentId, sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries,
        resultCount: projection.blocks.length, filteredByMinScore: Math.max(0, scored.length - eligible.length),
        scoreStats: { candidates: summarizeScoreStats(scored.map((item) => item.score)),
            eligible: summarizeScoreStats(eligible.map((item) => item.score)),
            recalled: summarizeScoreStats(projection.blocks.map((block) => block?.metadata?.score)) } }, ctx.startedAt);
    return { success: true, requestId: ctx.requestId, data: { recallBlocks: projection.blocks,
        estimatedTokens: projection.consumedTokens, appliedPolicy: { tokenBudget: policy.tokenBudget,
            maxTokenRatio: policy.maxTokenRatio, maxInjectedTokens: projection.appliedPolicy.maxInjectedTokens,
            maxBlocks: ctx.maxBlocks, minScore: policy.minScore, mode: ctx.ragOptions.mode,
            timeAware: ctx.ragOptions.timeAware, groupAware: ctx.ragOptions.groupAware,
            rerank: ctx.ragOptions.rerank, tagMemo: ctx.ragOptions.tagMemo,
            targetDiaries: result.targetDiaries, profileSourced: policy.profileSourced } } };
}

async function buildRecallContext(state, input) {
    const ctx = normalizeContextInput(state, input);
    const invalid = validateContext(ctx);
    if (invalid) return invalid;
    state.auditLogger.logContext('started', { requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
        sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries });
    try {
        const recallResult = await runRecall(ctx);
        return recallFailure(ctx, recallResult, 'context') || completeContext(ctx, recallResult);
    } catch (error) {
        console.error('[AgentGatewayContextRuntime] Error building gateway recall context:', error);
        state.auditLogger.logContext('failed', { requestId: ctx.requestId, source: ctx.source, agentId: ctx.agentId,
            sessionId: ctx.sessionId, diary: ctx.diary, diaries: ctx.requestedDiaries,
            code: OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR }, ctx.startedAt);
        return { success: false, requestId: ctx.requestId, status: 500, code: OPENCLAW_ERROR_CODES.RAG_CONTEXT_ERROR,
            error: 'Failed to build recall context', details: { message: error.message } };
    }
}

function createContextRuntimeService(deps = {}) {
    const state = createContextRuntimeState(deps);
    return { search: (input) => search(state, input), buildRecallContext: (input) => buildRecallContext(state, input) };
}

module.exports = {
    createContextRuntimeService,
    collectRagItems
};
