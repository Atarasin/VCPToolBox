'use strict';

const {
    createNativeRequestContext,
    buildNativeAuthContext,
    beginNativeOperation,
    executeNativeOperationSafely,
    sendNativeSuccessWithOperation,
    sendNativeErrorWithOperation,
    sendNativeOperationRejection
} = require('./shared');
const {
    assertForgeToolAccess,
    assertForgeOrchestrationAccess,
    buildForgeCreateRequest,
    buildForgeConfirmRequest,
    buildForgeLearnRequest
} = require('../../modules/agentGateway/services/forge/toolAccess');

/**
 * forge 铸造族的 REST 处理面（backend-proxy 模式的 MCP 工具经此转发到主进程）：
 * - POST /agent_gateway/forge/experts        ← gateway_forge_create（仅 ForgeMaster）
 * - POST /agent_gateway/forge/jobs/:jobId/confirm ← gateway_forge_confirm（仅 ForgeMaster）
 * - POST /agent_gateway/forge/learn          ← gateway_forge_learn（仅 ForgeMaster）
 * - POST /agent_gateway/forge/gaps           ← gateway_gap_report（专家自报/ForgeMaster 代报）
 * - POST /agent_gateway/forge/retrial        ← 补试岗（REST-only 编排入口，仅 ForgeMaster：
 *                                              已注册专家只重跑 trial，不触发重名冲突）
 * 访问边界与 in-process MCP 面同一实现（assertForgeToolAccess / 编排口径），双面一致。
 */

function registerForgeRoutes(router, context) {
    const { authContextResolver, operabilityService, forgeRuntimeService } = context;
    if (!forgeRuntimeService) {
        return; // 主进程未完成 Gateway 初始化时不注册（与 agentGateway admin 路由同款惰性）
    }

    function buildContext(req, operationName) {
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, operationName);
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayAuth,
            maid: req.body?.maid
        });
        return { requestContext, authContext };
    }

    function guard(req, toolName, targetAgentId, authContext) {
        // REST 面调用者身份 = 凭据决议的 agentId；与 MCP 面同一守卫。
        try {
            assertForgeToolAccess({ toolName, requesterAgentId: authContext?.agentId, targetAgentId });
            return null;
        } catch (error) {
            return error;
        }
    }

    function guardOrchestration(action, authContext) {
        // REST-only 编排入口（无 MCP 工具名）：与编排三件套同口径，仅 ForgeMaster。
        try {
            assertForgeOrchestrationAccess({ requesterAgentId: authContext?.agentId, action });
            return null;
        } catch (error) {
            return error;
        }
    }

    router.post('/forge/experts', async (req, res) => {
        const startedAt = Date.now();
        const { requestContext, authContext } = buildContext(req, 'forge-create');
        const blocked = guard(req, 'gateway_forge_create', null, authContext);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'forge.create', requestContext, authContext, payload: req.body
        });
        if (blocked || (operationControl && !operationControl.allowed)) {
            if (blocked) {
                return sendNativeErrorWithOperation(res, {
                    status: blocked.status, requestId: requestContext.requestId, startedAt,
                    code: blocked.code, error: blocked.message, details: blocked.details,
                    authContext, operationControl
                });
            }
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }
        return executeNativeOperationSafely({
            res, startedAt, requestContext, authContext, operationControl,
            errorMessage: 'Failed to launch forge expert create',
            handler: async () => {
                try {
                    const result = await forgeRuntimeService.startExpertCreateJob({
                        ...buildForgeCreateRequest(req.body),
                        authContext
                    });
                    return sendNativeSuccessWithOperation(res, {
                        requestId: requestContext.requestId, startedAt,
                        data: { jobId: result.jobId, runDir: result.runRecord?.runDir || null },
                        authContext, operationControl
                    });
                } catch (error) {
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500, requestId: requestContext.requestId, startedAt,
                        code: error.code, error: error.message,
                        details: error.details, authContext, operationControl
                    });
                }
            }
        });
    });

    router.post('/forge/jobs/:jobId/confirm', async (req, res) => {
        const startedAt = Date.now();
        const { requestContext, authContext } = buildContext(req, 'forge-confirm');
        const blocked = guard(req, 'gateway_forge_confirm', null, authContext);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'forge.confirm', requestContext, authContext, payload: req.body
        });
        if (blocked || (operationControl && !operationControl.allowed)) {
            if (blocked) {
                return sendNativeErrorWithOperation(res, {
                    status: blocked.status, requestId: requestContext.requestId, startedAt,
                    code: blocked.code, error: blocked.message, details: blocked.details,
                    authContext, operationControl
                });
            }
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }
        return executeNativeOperationSafely({
            res, startedAt, requestContext, authContext, operationControl,
            errorMessage: 'Failed to confirm forge job',
            handler: async () => {
                try {
                    const result = await forgeRuntimeService.confirmBlueprint(
                        String(req.params.jobId || '').trim(),
                        { ...buildForgeConfirmRequest(req.body), authContext }
                    );
                    return sendNativeSuccessWithOperation(res, {
                        requestId: requestContext.requestId, startedAt, data: result,
                        authContext, operationControl
                    });
                } catch (error) {
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500, requestId: requestContext.requestId, startedAt,
                        code: error.code, error: error.message,
                        details: error.details, authContext, operationControl
                    });
                }
            }
        });
    });

    router.post('/forge/learn', async (req, res) => {
        const startedAt = Date.now();
        const { requestContext, authContext } = buildContext(req, 'forge-learn');
        const blocked = guard(req, 'gateway_forge_learn', null, authContext);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'forge.learn', requestContext, authContext, payload: req.body
        });
        if (blocked || (operationControl && !operationControl.allowed)) {
            if (blocked) {
                return sendNativeErrorWithOperation(res, {
                    status: blocked.status, requestId: requestContext.requestId, startedAt,
                    code: blocked.code, error: blocked.message, details: blocked.details,
                    authContext, operationControl
                });
            }
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }
        return executeNativeOperationSafely({
            res, startedAt, requestContext, authContext, operationControl,
            errorMessage: 'Failed to launch forge expert learn',
            handler: async () => {
                try {
                    const result = await forgeRuntimeService.startExpertLearnJob({
                        ...buildForgeLearnRequest(req.body),
                        authContext
                    });
                    return sendNativeSuccessWithOperation(res, {
                        requestId: requestContext.requestId, startedAt,
                        data: { jobId: result.jobId },
                        authContext, operationControl
                    });
                } catch (error) {
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500, requestId: requestContext.requestId, startedAt,
                        code: error.code, error: error.message,
                        details: error.details, authContext, operationControl
                    });
                }
            }
        });
    });

    router.post('/forge/retrial', async (req, res) => {
        const startedAt = Date.now();
        const { requestContext, authContext } = buildContext(req, 'forge-retrial');
        const blocked = guardOrchestration('forge.retrial', authContext);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'forge.retrial', requestContext, authContext, payload: req.body
        });
        if (blocked || (operationControl && !operationControl.allowed)) {
            if (blocked) {
                return sendNativeErrorWithOperation(res, {
                    status: blocked.status, requestId: requestContext.requestId, startedAt,
                    code: blocked.code, error: blocked.message, details: blocked.details,
                    authContext, operationControl
                });
            }
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }
        return executeNativeOperationSafely({
            res, startedAt, requestContext, authContext, operationControl,
            errorMessage: 'Failed to launch forge expert retrial',
            handler: async () => {
                try {
                    const budgetCny = Number.isFinite(Number(req.body?.budgetCny)) && Number(req.body.budgetCny) > 0
                        ? Number(req.body.budgetCny)
                        : null;
                    const result = await forgeRuntimeService.startExpertRetrialJob({
                        expertName: req.body?.expertName,
                        ...(budgetCny != null ? { budgetCny } : {}),
                        authContext
                    });
                    return sendNativeSuccessWithOperation(res, {
                        requestId: requestContext.requestId, startedAt,
                        data: { jobId: result.jobId, runDir: result.runRecord?.runDir || null },
                        authContext, operationControl
                    });
                } catch (error) {
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500, requestId: requestContext.requestId, startedAt,
                        code: error.code, error: error.message,
                        details: error.details, authContext, operationControl
                    });
                }
            }
        });
    });

    router.post('/forge/gaps', async (req, res) => {
        const startedAt = Date.now();
        const { requestContext, authContext } = buildContext(req, 'forge-gap-report');
        const targetAgentId = String(req.body?.expertName || authContext?.agentId || '').trim() || null;
        const blocked = guard(req, 'gateway_gap_report', targetAgentId, authContext);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'gap.report', requestContext, authContext, payload: req.body
        });
        if (blocked || (operationControl && !operationControl.allowed)) {
            if (blocked) {
                return sendNativeErrorWithOperation(res, {
                    status: blocked.status, requestId: requestContext.requestId, startedAt,
                    code: blocked.code, error: blocked.message, details: blocked.details,
                    authContext, operationControl
                });
            }
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }
        return executeNativeOperationSafely({
            res, startedAt, requestContext, authContext, operationControl,
            errorMessage: 'Failed to report forge gap',
            handler: async () => {
                try {
                    const result = await forgeRuntimeService.reportGap({
                        agentId: targetAgentId,
                        subskillId: req.body?.subskillId,
                        question: req.body?.question,
                        whyInsufficient: req.body?.whyInsufficient
                    }, authContext);
                    return sendNativeSuccessWithOperation(res, {
                        requestId: requestContext.requestId, startedAt, data: result,
                        authContext, operationControl
                    });
                } catch (error) {
                    return sendNativeErrorWithOperation(res, {
                        status: error.status || 500, requestId: requestContext.requestId, startedAt,
                        code: error.code, error: error.message,
                        details: error.details, authContext, operationControl
                    });
                }
            }
        });
    });
}

module.exports = { registerForgeRoutes };
