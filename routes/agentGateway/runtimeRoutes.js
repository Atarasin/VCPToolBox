'use strict';

const { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot } = require('./shared');

function registerToolRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/tools/:toolName/invoke', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-tool');
        const governedBody = createGovernedRequestBody(req, pluginManager, requestContext);
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: governedBody.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: governedBody.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'tool.invoke',
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
            errorMessage: 'Failed to execute native gateway tool invocation',
            handler: async () => {
                const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
                const result = await toolRuntimeService.invokeTool({
                    toolName: req.params.toolName,
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
                    defaultSource: 'agent-gateway-tool'
                });

                if (
                    result.status === 'completed' ||
                    result.status === 'accepted' ||
                    result.status === 'waiting_approval'
                ) {
                    return sendNativeSuccessWithOperation(res, {
                        status: result.httpStatus || (result.status === 'completed' ? 200 : 202),
                        requestId: result.requestId,
                        startedAt,
                        data: result.data,
                        authContext,
                        operationControl,
                        extraMeta: {
                            toolStatus: result.status
                        }
                    });
                }

                return sendNativeErrorWithOperation(res, {
                    status: result.httpStatus,
                    requestId: result.requestId,
                    startedAt,
                    code: result.code,
                    error: result.error,
                    details: {
                        ...(result.details || {}),
                        toolStatus: result.status
                    },
                    authContext,
                    operationControl
                });
            }
        });
    });
}

function registerJobReadRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/jobs/:jobId', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            sessionId: req.query.sessionId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-job');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.query.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'jobs.read',
            requestContext,
            authContext,
            payload: {
                ...req.query,
                jobId: req.params.jobId
            }
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
            errorMessage: 'Failed to poll native gateway job',
            handler: async () => {
                const result = jobRuntimeService.pollJob(req.params.jobId, authContext);

                if (!result.success) {
                    return sendNativeErrorWithOperation(res, {
                        status: result.status,
                        requestId: requestContext.requestId,
                        startedAt,
                        code: result.code,
                        error: result.error,
                        details: result.details,
                        authContext,
                        operationControl
                    });
                }

                return sendNativeSuccessWithOperation(res, {
                    requestId: requestContext.requestId,
                    startedAt,
                    data: result.data,
                    authContext,
                    operationControl
                });
            }
        });
    });
}

function registerJobCancelRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.post('/jobs/:jobId/cancel', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-job-cancel');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.body?.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'jobs.cancel',
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
            errorMessage: 'Failed to cancel native gateway job',
            handler: async () => {
                const result = jobRuntimeService.cancelJob(req.params.jobId, authContext);

                if (!result.success) {
                    return sendNativeErrorWithOperation(res, {
                        status: result.status,
                        requestId: requestContext.requestId,
                        startedAt,
                        code: result.code,
                        error: result.error,
                        details: result.details,
                        authContext,
                        operationControl
                    });
                }

                return sendNativeSuccessWithOperation(res, {
                    requestId: requestContext.requestId,
                    startedAt,
                    data: result.data,
                    authContext,
                    operationControl
                });
            }
        });
    });
}

function registerEventsRoute(router, context) {
    const { pluginManager, authContextResolver, capabilityService, agentRegistryService,
        jobRuntimeService, memoryRuntimeService, contextRuntimeService, toolRuntimeService,
        operabilityService, agentPolicyResolver, recallRuntimeService, recallProjectionService } = context;
    router.get('/events/stream', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            sessionId: req.query.sessionId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-events');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth,
            maid: req.query.maid
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'events.stream',
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
        return executeNativeOperationSafely({
            res,
            startedAt,
            requestContext,
            authContext,
            operationControl,
            errorMessage: 'Failed to stream native gateway events',
            handler: async () => {
                const result = jobRuntimeService.listEvents({
                    authContext,
                    filters: createNativeStreamFilters(req.query)
                });

                if (!result.success) {
                    return sendNativeErrorWithOperation(res, {
                        status: result.status,
                        requestId: requestContext.requestId,
                        startedAt,
                        code: result.code,
                        error: result.error,
                        details: result.details,
                        authContext,
                        operationControl
                    });
                }

                res.status(200);
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Agent-Gateway-Version', NATIVE_GATEWAY_VERSION);
                if (operationControl?.traceId) {
                    res.setHeader(AGENT_GATEWAY_HEADERS.TRACE_ID, operationControl.traceId);
                }
                res.flushHeaders?.();

                // 先发送稳定的 meta 事件，便于调用方在首帧就拿到 request/gateway 上下文。
                writeNativeSseEvent(res, 'gateway.meta', {
                    requestId: requestContext.requestId,
                    gatewayVersion: NATIVE_GATEWAY_VERSION,
                    traceId: operationControl?.traceId,
                    operationName: operationControl?.operationName,
                    authMode: authContext.authMode,
                    authSource: authContext.authSource,
                    gatewayId: authContext.gatewayId
                });

                result.data.events.forEach((event) => {
                    writeNativeSseEvent(res, event.eventType, event);
                });

                operationControl?.finish?.({ outcome: 'success' });
                return res.end();
            }
        });
    });
}

module.exports = { registerToolRoute, registerJobReadRoute, registerJobCancelRoute, registerEventsRoute };
