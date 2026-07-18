'use strict';

const { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot } = require('./shared');

function registerMemoryTargetsRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/memory/targets', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-memory');
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
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'memory.targets',
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
            const targets = await capabilityService.getMemoryTargets({
                agentId,
                maid,
                authContext
            });
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    targets
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
                error: 'Failed to load memory targets',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerMemorySearchRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/memory/search', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-memory-search');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.body?.maid,
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'memory.search',
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
        return executeNativeOperationSafely({
            res,
            startedAt,
            requestContext,
            authContext,
            operationControl,
            errorMessage: 'Failed to execute gateway memory search',
            handler: async () => {
                const result = await contextRuntimeService.search({
                    body: {
                        ...req.body,
                        authContext,
                        requestContext
                    },
                    startedAt,
                    defaultSource: 'agent-gateway-memory-search'
                });

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

function registerMemoryWriteRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/memory/write', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-memory-write');
        const governedBody = createGovernedRequestBody(req, pluginManager, requestContext);
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: governedBody.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: governedBody.target?.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'memory.write',
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
        return executeNativeOperationSafely({
            res,
            startedAt,
            requestContext,
            authContext,
            operationControl,
            errorMessage: 'Failed to execute gateway memory write',
            handler: async () => {
                const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
                const result = await memoryRuntimeService.writeMemory({
                    body: {
                        ...governedBody,
                        authContext,
                        requestContext,
                        options: {
                            ...(governedBody.options || {}),
                            idempotencyKey: governedBody.options?.idempotencyKey || governedBody.idempotencyKey
                        }
                    },
                    startedAt,
                    clientIp,
                    defaultSource: 'agent-gateway-memory-write'
                });

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

function registerContextRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/context/assemble', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-context');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.body?.maid,
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'context.assemble',
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
        return executeNativeOperationSafely({
            res,
            startedAt,
            requestContext,
            authContext,
            operationControl,
            errorMessage: 'Failed to assemble gateway recall context',
            handler: async () => {
                const result = await contextRuntimeService.buildRecallContext({
                    body: {
                        ...req.body,
                        authContext,
                        requestContext
                    },
                    startedAt,
                    defaultSource: 'agent-gateway-context'
                });

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

function registerRecallRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/recall/run', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-recall');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.body?.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'recall.run',
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

        const agentId = normalizeNativeString(req.body?.agentId || requestContext.agentId);
        const query = normalizeNativeString(req.body?.query);
        const profile = normalizeNativeString(req.body?.profile);

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

        if (!query) {
            return sendNativeErrorWithOperation(res, {
                status: 400,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INVALID_REQUEST,
                error: 'query is required',
                details: { field: 'query' },
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
            errorCode: AGW_ERROR_CODES.INTERNAL_ERROR,
            errorMessage: 'Failed to execute gateway recall',
            handler: async () => {
                const recallResult = await recallRuntimeService.executeRecall({
                    agentId,
                    query,
                    profileName: profile || undefined,
                    requestContext,
                    authContext,
                    agentPolicyResolver,
                    messages: Array.isArray(req.body?.messages) ? req.body.messages : undefined
                });

                const projected = recallProjectionService.projectFullResult(
                    recallResult,
                    requestContext.requestId
                );

                return sendNativeServiceResult(res, {
                    result: {
                        success: projected.success,
                        requestId: requestContext.requestId,
                        startedAt,
                        data: projected,
                        status: projected.status || 200,
                        code: projected.code,
                        error: projected.error,
                        details: projected.error ? { message: projected.error } : undefined
                    },
                    startedAt,
                    authContext,
                    operationControl
                });
            }
        });
    });
}

module.exports = { registerMemoryTargetsRoute, registerMemorySearchRoute, registerMemoryWriteRoute, registerContextRoute, registerRecallRoute };
