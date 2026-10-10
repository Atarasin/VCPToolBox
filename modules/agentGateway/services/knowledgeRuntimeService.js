const { AGW_ERROR_CODES, OPENCLAW_ERROR_CODES } = require('../contracts/errorCodes');
const { resolveKnowledgeLibraryAccess, DEFAULT_POLICY_PATH } = require('../policy/knowledgeScopeGuard');
const { normalizeString, normalizeStringArray } = require('../policy/shared/normalize');

const DEFAULT_KNOWLEDGE_TOP_K = 8;
const MAX_KNOWLEDGE_TOP_K = 50;

function normalizeKnowledgeString(value, maxLength = 512) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.slice(0, maxLength);
}

function normalizeHit(hit, targetLibraries) {
    return {
        library: normalizeString(hit?.library),
        id: hit?.id ?? null,
        score: typeof hit?.score === 'number' && Number.isFinite(hit.score) ? hit.score : 0,
        text: typeof hit?.text === 'string' ? hit.text : '',
        sourceFile: normalizeString(hit?.sourceFile),
        chunkIndex: Number.isInteger(hit?.chunkIndex) ? hit.chunkIndex : null
    };
}

/**
 * M4：冷知识库（TDB）检索运行时——权限边界（knowledgeScopeGuard）+ 检索 + 投影。
 * MCP 工具 gateway_knowledge_search 的唯一后端。
 */
function createKnowledgeRuntimeService(deps = {}) {
    const knowledgeStorePort = deps.knowledgeStorePort || null;
    const auditLogger = deps.auditLogger || { log() {} };
    const policyPath = deps.knowledgePolicyPath || DEFAULT_POLICY_PATH;

    async function search({ body, requestContext, defaultSource = 'mcp-knowledge-search' } = {}) {
        const startedAt = Date.now();
        const requestId = normalizeString(requestContext?.requestId);
        const agentId = normalizeString(requestContext?.agentId || body?.agentId);
        const query = normalizeKnowledgeString(body?.query, 4096);
        if (!query) {
            return { success: false, requestId, status: 400,
                code: AGW_ERROR_CODES.VALIDATION_ERROR, error: 'query is required',
                details: { field: 'query' } };
        }
        if (!knowledgeStorePort?.available) {
            return { success: false, requestId, status: 503,
                code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE, error: 'Knowledge store is not available' };
        }

        const rawTopK = Number.parseInt(body?.topK ?? body?.k, 10);
        const topK = Number.isFinite(rawTopK)
            ? Math.min(MAX_KNOWLEDGE_TOP_K, Math.max(1, rawTopK))
            : DEFAULT_KNOWLEDGE_TOP_K;
        const expand = body?.expand !== false;
        const minScore = typeof body?.minScore === 'number' && Number.isFinite(body.minScore)
            ? Math.max(0, Math.min(1, body.minScore))
            : undefined;

        const availableLibraries = normalizeStringArray(
            await Promise.resolve(knowledgeStorePort.listLibraries())
        );
        let targetLibraries;
        try {
            const access = resolveKnowledgeLibraryAccess({
                requestedLibraries: normalizeStringArray(
                    body?.libraries !== undefined ? body?.libraries
                        : (body?.library !== undefined ? [body.library] : [])
                ),
                availableLibraries,
                agentId,
                policyPath
            });
            targetLibraries = access.targetLibraries;
        } catch (error) {
            auditLogger.log('knowledge.search.forbidden', {
                requestId, agentId, code: error.code, errorMessage: error.message
            }, startedAt);
            throw error;
        }

        if (targetLibraries.length === 0) {
            return { success: true, requestId, data: { items: [], libraries: [],
                resultCount: 0, diagnostics: { availableLibraries, durationMs: Date.now() - startedAt } } };
        }

        try {
            const hits = await Promise.resolve(knowledgeStorePort.search(query, {
                libraries: targetLibraries,
                topK,
                expand,
                ...(minScore !== undefined ? { minScore } : {})
            }));
            const items = (Array.isArray(hits) ? hits : []).map((hit) => normalizeHit(hit, targetLibraries));
            auditLogger.log('knowledge.search.completed', {
                requestId, agentId, source: defaultSource,
                libraries: targetLibraries, resultCount: items.length, topK
            }, startedAt);
            return {
                success: true,
                requestId,
                data: {
                    items,
                    libraries: targetLibraries,
                    resultCount: items.length,
                    diagnostics: { topK, expand, durationMs: Date.now() - startedAt }
                }
            };
        } catch (error) {
            console.error('[AgentGatewayKnowledgeRuntime] Error searching knowledge store:', error.message);
            auditLogger.log('knowledge.search.failed', {
                requestId, agentId, libraries: targetLibraries,
                code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR, errorMessage: error.message
            }, startedAt);
            return { success: false, requestId, status: 500,
                code: OPENCLAW_ERROR_CODES.RAG_SEARCH_ERROR, error: 'Failed to search knowledge store',
                details: { message: error.message } };
        }
    }

    return { search };
}

module.exports = {
    createKnowledgeRuntimeService,
    DEFAULT_KNOWLEDGE_TOP_K,
    MAX_KNOWLEDGE_TOP_K
};
