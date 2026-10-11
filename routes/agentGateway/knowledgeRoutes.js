'use strict';

const {
    createNativeRequestContext,
    buildNativeAuthContext,
    beginNativeOperation,
    executeNativeOperationSafely,
    sendNativeSuccessWithOperation,
    sendNativeErrorWithOperation,
    sendNativeOperationRejection,
    sendNativeServiceResult,
    normalizeNativeString
} = require('./shared');

/**
 * 冷知识库（TDB）检索的 REST 处理面：
 * - POST /agent_gateway/knowledge/search ← gateway_knowledge_search
 *   （backend-proxy 模式的 MCP 工具经此转发到 knowledgeRuntimeService；
 *   权限边界 knowledgeScopeGuard 在 service 内按 agentId 执行。）
 * 2026-10-11 注册表收敛时补齐——M4 曾只铺了 in-process 面，proxy 模式下
 * gateway_knowledge_search 报 Unsupported gateway-managed tool。
 */

function registerKnowledgeSearchRoute(router, context) {
    const { authContextResolver, operabilityService, knowledgeRuntimeService } = context;

    router.post('/knowledge/search', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-knowledge-search');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayAuth,
            maid: req.body?.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'knowledge.search',
            requestContext,
            authContext,
            payload: req.body
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        if (!knowledgeRuntimeService || typeof knowledgeRuntimeService.search !== 'function') {
            return sendNativeErrorWithOperation(res, {
                status: 503,
                requestId: requestContext.requestId,
                startedAt,
                code: 'AGW_CONFIG_UNAVAILABLE',
                error: 'Knowledge runtime is not available',
                authContext,
                operationControl
            });
        }

        return executeNativeOperationSafely({
            res,
            startedAt,
            requestContext,
            authContext,
            operationControl,
            errorMessage: 'Failed to execute gateway knowledge search',
            handler: async () => {
                // agentId 决议顺序与 in-process managed-context 对齐：
                // 凭据绑定身份优先，客户端 body.agentId 仅作回退。
                const scopedRequestContext = {
                    ...requestContext,
                    agentId: normalizeNativeString(authContext?.agentId || req.body?.agentId || requestContext.agentId)
                };
                let result;
                try {
                    result = await knowledgeRuntimeService.search({
                        body: req.body,
                        requestContext: scopedRequestContext,
                        defaultSource: 'agent-gateway-knowledge-search'
                    });
                } catch (error) {
                    // knowledgeScopeGuard 抛出的 Forbidden/NotFound 带 status/code
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500,
                        requestId: requestContext.requestId,
                        startedAt,
                        code: error.code,
                        error: error.message,
                        details: error.details,
                        authContext,
                        operationControl
                    });
                }
                return sendNativeServiceResult(res, {
                    result,
                    startedAt,
                    authContext,
                    operationControl
                });
            }
        });
    });
}

module.exports = { registerKnowledgeSearchRoute };
