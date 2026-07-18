'use strict';

const { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot } = require('./shared');

function registerAuthMiddleware(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.use((req, res, next) => {
        const dedicatedAuth = req.agentGatewayAuth || resolveDedicatedGatewayAuth({
            headers: req.headers,
            pluginManager
        });

        req.agentGatewayDedicatedAuth = dedicatedAuth;

        if (dedicatedAuth.provided && !dedicatedAuth.authenticated) {
            const requestContext = createNativeRequestContext(
                req,
                req.body?.requestContext || req.query,
                'agent-gateway-auth'
            );

            return sendNativeError(res, {
                status: 401,
                requestId: requestContext.requestId,
                startedAt: Date.now(),
                code: AGW_ERROR_CODES.UNAUTHORIZED,
                error: 'Invalid agent gateway credentials',
                details: {
                    authSource: dedicatedAuth.authSource
                },
                extraHeaders: { [AGENT_GATEWAY_HEADERS.TRACE_ID]: requestContext.traceId },
                extraMeta: buildNativeResponseMeta(dedicatedAuth, { traceId: requestContext.traceId })
            });
        }

        return next();
    });
}

function registerHealthRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
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
            dedicatedAuth: req.agentGatewayDedicatedAuth
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
                data: buildNativeHealthSnapshot(pluginManager),
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
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
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
            dedicatedAuth: req.agentGatewayDedicatedAuth,
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
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
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
            dedicatedAuth: req.agentGatewayDedicatedAuth
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
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: operabilityService?.getMetricsSnapshot?.() || {
                    totals: {
                        attempted: 0,
                        succeeded: 0,
                        failed: 0,
                        rejected: 0,
                        active: 0
                    },
                    operations: [],
                    recentRejections: []
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

module.exports = { registerAuthMiddleware, registerHealthRoute, registerCapabilitiesRoute, registerMetricsRoute };
