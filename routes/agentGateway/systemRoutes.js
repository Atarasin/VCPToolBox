'use strict';

const { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot } = require('./shared');
const { defaultAgentTargetTelemetry } = require('../../modules/agentGateway/policy/agentTargetTelemetry');

// 认证注入已收编到 routes/agentGateway/authInjection.js 的单一注入点，
// 由 createAgentGatewayRoutes 在所有 registrar 之前显式挂载（M1.S3.T7）。

function registerHealthRoute(router, context) {
    const { protocolConfig, healthSnapshot, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/health', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-health');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'health.read',
            requestContext,
            authContext,
            payload: req.query
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        try {
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: buildNativeHealthSnapshot(healthSnapshot),
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load gateway health snapshot',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerCapabilitiesRoute(router, context) {
    const { protocolConfig, healthSnapshot, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/capabilities', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-capabilities');
        const agentId = normalizeNativeString(req.query.agentId || requestContext.agentId);
        const maid = normalizeNativeString(req.query.maid);
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext: {
                ...requestContext,
                agentId
            },
            dedicatedAuth: req.agentGatewayAuth,
            maid
        });
        const includeMemoryTargets = parseNativeBoolean(req.query.includeMemoryTargets, true);
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'capabilities.read',
            requestContext: {
                ...requestContext,
                agentId
            },
            authContext,
            payload: req.query
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        if (!agentId) {
            return sendNativeErrorWithOperation(res, {
                status: 400,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INVALID_REQUEST,
                error: 'agentId is required',
                details: { field: 'agentId' },
                authContext,
                operationControl
            });
        }

        try {
            const capabilities = await capabilityService.getCapabilities({
                agentId,
                maid,
                includeMemoryTargets,
                authContext
            });
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: applyGovernedCapabilitySections(capabilities, {
                    authContext
                }),
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to build native gateway capabilities',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerMetricsRoute(router, context) {
    const { protocolConfig, healthSnapshot, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/metrics', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-metrics');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'metrics.read',
            requestContext,
            authContext,
            payload: req.query
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        try {
            const metricsSnapshot = operabilityService?.getMetricsSnapshot?.() || {
                totals: {
                    attempted: 0,
                    succeeded: 0,
                    failed: 0,
                    rejected: 0,
                    active: 0
                },
                operations: [],
                recentRejections: []
            };
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    ...metricsSnapshot,
                    // §5.4 / M3.S2.T2：显式 agentId 调用比例（绑定 credential 的
                    // 直接 agent-scoped 调用），供迁移完成后评估废弃时间表。
                    agentTarget: defaultAgentTargetTelemetry.snapshot()
                },
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load gateway metrics',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerCredentialContextRoute(router, context) {
    const { protocolConfig, healthSnapshot, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/credential/context', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-credential-context');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'credential.context.read',
            requestContext,
            authContext,
            payload: req.query
        });

        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, {
                startedAt,
                requestContext,
                authContext,
                operationControl
            });
        }

        // 凭据自省（§5.5 / L4）：只返回 authInjection 统一决议出的自身 credential
        // context，供 stdio 等无逐请求注入通道的宿主在启动时解析绑定身份。
        const credentialContext = req.agentGatewayAuth?.credentialContext;
        if (!credentialContext?.ok) {
            return sendNativeErrorWithOperation(res, {
                status: 401,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.UNAUTHORIZED,
                error: 'Agent gateway authentication required',
                details: { field: 'credential' },
                authContext,
                operationControl
            });
        }

        return sendNativeSuccessWithOperation(res, {
            requestId: requestContext.requestId,
            startedAt,
            data: {
                credentialId: normalizeNativeString(credentialContext.credentialId),
                credentialSubject: normalizeNativeString(credentialContext.credentialSubject),
                boundAgentId: normalizeNativeString(credentialContext.boundAgentId) || null,
                scopes: Array.isArray(credentialContext.scopes) ? credentialContext.scopes : [],
                status: normalizeNativeString(credentialContext.credential?.status),
                expiresAt: credentialContext.credential?.expiresAt || null,
                credentialRevision: normalizeNativeString(credentialContext.credentialRevision)
            },
            authContext,
            operationControl
        });
    });
}

module.exports = { registerHealthRoute, registerCapabilitiesRoute, registerMetricsRoute, registerCredentialContextRoute };
