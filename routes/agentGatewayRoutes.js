const express = require('express');
const {
    sendSuccessResponse,
    sendErrorResponse
} = require('../modules/agentGateway/contracts/responseEnvelope');
const {
    AGW_ERROR_CODES,
    OPENCLAW_TO_AGENT_GATEWAY_CODE
} = require('../modules/agentGateway/contracts/errorCodes');
const {
    AGENT_GATEWAY_HEADERS,
    NATIVE_GATEWAY_VERSION,
    NATIVE_GATEWAY_VERSION_KEY,
    applyGovernedCapabilitySections,
    resolveDedicatedGatewayAuth,
    resolveGovernedIdempotencyKey,
    resolveNativeRequestContext
} = require('../modules/agentGateway/contracts/protocolGovernance');
const {
    getGatewayServiceBundle
} = require('../modules/agentGateway/createGatewayServiceBundle');

function normalizeNativeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseNativeBoolean(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function createNativeRequestContext(req, input, defaultSource) {
    return resolveNativeRequestContext(input, {
        headers: req.headers,
        query: req.query,
        defaultSource,
        defaultRuntime: 'native',
        requestIdPrefix: 'agw'
    });
}

function mapNativeErrorCode(code) {
    return OPENCLAW_TO_AGENT_GATEWAY_CODE[code] || code || AGW_ERROR_CODES.INTERNAL_ERROR;
}

function sendNativeSuccess(res, { status = 200, requestId, startedAt, data, extraHeaders, extraMeta }) {
    return sendSuccessResponse(res, {
        status,
        requestId,
        startedAt,
        data,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
        extraHeaders,
        extraMeta
    });
}

function sendNativeError(res, { status = 500, requestId, startedAt, code, error, details, extraHeaders, extraMeta }) {
    return sendErrorResponse(res, {
        status,
        requestId,
        startedAt,
        code: mapNativeErrorCode(code),
        error,
        details,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
        extraHeaders,
        extraMeta
    });
}

function buildNativeResponseMeta(authContext, extraMeta = {}) {
    const normalizedExtraMeta = extraMeta && typeof extraMeta === 'object' ? extraMeta : {};
    if (!authContext || typeof authContext !== 'object') {
        return normalizedExtraMeta;
    }

    return {
        authMode: authContext.authMode,
        authSource: authContext.authSource,
        gatewayId: authContext.gatewayId,
        ...normalizedExtraMeta
    };
}

function estimateNativePayloadBytes(body) {
    if (!body || typeof body !== 'object') {
        return 0;
    }
    try {
        return Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch (error) {
        return 0;
    }
}

function buildNativeOperationMeta(operationControl, extraMeta = {}) {
    return {
        ...(operationControl?.traceId ? { traceId: operationControl.traceId } : {}),
        ...(operationControl?.operationName ? { operationName: operationControl.operationName } : {}),
        ...(extraMeta && typeof extraMeta === 'object' ? extraMeta : {})
    };
}

function buildNativeOperationHeaders(operationControl, extraHeaders = {}) {
    const headers = {
        ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
    };

    if (operationControl?.traceId) {
        headers[AGENT_GATEWAY_HEADERS.TRACE_ID] = operationControl.traceId;
    }
    if (operationControl?.rejection?.headers && typeof operationControl.rejection.headers === 'object') {
        Object.assign(headers, operationControl.rejection.headers);
    }

    return headers;
}

function beginNativeOperation(operabilityService, {
    operationName,
    requestContext,
    authContext,
    payload
}) {
    if (!operabilityService || typeof operabilityService.beginRequest !== 'function') {
        return null;
    }

    return operabilityService.beginRequest({
        operationName,
        requestContext,
        authContext,
        payloadBytes: estimateNativePayloadBytes(payload)
    });
}

function sendNativeOperationRejection(res, {
    startedAt,
    requestContext,
    authContext,
    operationControl
}) {
    return sendNativeError(res, {
        status: operationControl.rejection.httpStatus,
        requestId: requestContext.requestId,
        startedAt,
        code: operationControl.rejection.code,
        error: operationControl.rejection.error,
        details: operationControl.rejection.details,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(
            authContext,
            buildNativeOperationMeta(operationControl, {
                retryAfterMs: operationControl.rejection.details?.retryAfterMs || 0
            })
        )
    });
}

function sendNativeSuccessWithOperation(res, {
    status = 200,
    requestId,
    startedAt,
    data,
    authContext,
    operationControl,
    extraMeta
}) {
    operationControl?.finish?.({ outcome: 'success' });
    return sendNativeSuccess(res, {
        status,
        requestId,
        startedAt,
        data,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(authContext, buildNativeOperationMeta(operationControl, extraMeta))
    });
}

function sendNativeErrorWithOperation(res, {
    status = 500,
    requestId,
    startedAt,
    code,
    error,
    details,
    authContext,
    operationControl,
    extraMeta
}) {
    operationControl?.finish?.({ outcome: 'failure', code });
    return sendNativeError(res, {
        status,
        requestId,
        startedAt,
        code,
        error,
        details,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(authContext, buildNativeOperationMeta(operationControl, extraMeta))
    });
}

function sendNativeServiceResult(res, {
    result,
    startedAt,
    authContext,
    operationControl
}) {
    if (!result?.success) {
        return sendNativeErrorWithOperation(res, {
            status: result?.status || 500,
            requestId: result?.requestId || '',
            startedAt,
            code: result?.code,
            error: result?.error,
            details: result?.details,
            authContext,
            operationControl
        });
    }

    const isDeferred = result.status === 'accepted' || result.status === 'waiting_approval';
    return sendNativeSuccessWithOperation(res, {
        status: result.httpStatus || (isDeferred ? 202 : 200),
        requestId: result.requestId,
        startedAt,
        data: result.data,
        authContext,
        operationControl,
        extraMeta: isDeferred
            ? {
                operationStatus: result.status
            }
            : undefined
    });
}

async function executeNativeOperationSafely({
    res,
    startedAt,
    requestContext,
    authContext,
    operationControl,
    errorCode = AGW_ERROR_CODES.INTERNAL_ERROR,
    errorMessage = 'Unexpected native gateway failure',
    buildErrorDetails,
    handler
}) {
    try {
        return await handler();
    } catch (error) {
        const details = typeof buildErrorDetails === 'function'
            ? buildErrorDetails(error)
            : { message: error.message };
        return sendNativeErrorWithOperation(res, {
            status: 500,
            requestId: requestContext.requestId,
            startedAt,
            code: errorCode,
            error: errorMessage,
            details,
            authContext,
            operationControl
        });
    }
}

function buildNativeAuthContext({
    authContextResolver,
    requestContext,
    providedAuthContext,
    dedicatedAuth,
    maid
}) {
    return authContextResolver({
        authContext: {
            ...(providedAuthContext && typeof providedAuthContext === 'object' ? providedAuthContext : {}),
            authMode: dedicatedAuth?.authMode,
            authSource: dedicatedAuth?.authSource,
            gatewayId: dedicatedAuth?.gatewayId,
            roles: dedicatedAuth?.roles
        },
        requestContext,
        agentId: requestContext.agentId,
        maid,
        adapter: 'native'
    });
}

function createGovernedRequestBody(req, pluginManager, requestContext) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const options = body.options && typeof body.options === 'object' ? body.options : {};
    const idempotencyKey = resolveGovernedIdempotencyKey({
        body,
        headers: req.headers,
        pluginManager
    });

    return {
        ...body,
        requestContext,
        idempotencyKey: idempotencyKey || normalizeNativeString(body.idempotencyKey),
        options: idempotencyKey
            ? {
                ...options,
                idempotencyKey
            }
            : options
    };
}

function createNativeStreamFilters(query = {}) {
    return {
        jobId: normalizeNativeString(query.jobId),
        agentId: normalizeNativeString(query.agentId),
        sessionId: normalizeNativeString(query.sessionId)
    };
}

function writeNativeSseEvent(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Native Agent Gateway beta adapter。
 * 路由层只负责协议适配，所有核心能力都委托给共享 Gateway Core services。
 */
module.exports = function createAgentGatewayRoutes(pluginManager) {
    if (!pluginManager) {
        throw new Error('[AgentGatewayRoutes] pluginManager is required');
    }

    const router = express.Router();
    const {
        authContextResolver,
        capabilityService,
        agentRegistryService,
        jobRuntimeService,
        memoryRuntimeService,
        contextRuntimeService,
        toolRuntimeService,
        operabilityService
    } = getGatewayServiceBundle(pluginManager, {
        gatewayVersion: NATIVE_GATEWAY_VERSION
    });

    router.use((req, res, next) => {
        const dedicatedAuth = resolveDedicatedGatewayAuth({
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
                extraMeta: buildNativeResponseMeta(dedicatedAuth)
            });
        }

        return next();
    });

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

    router.get('/agents', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.list',
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
            const agents = await agentRegistryService.listAgents();
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    agents
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
                error: 'Failed to load agent registry',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });

    router.get('/agents/:agentId', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.detail',
            requestContext,
            authContext,
            payload: {
                ...req.query,
                agentId: req.params.agentId
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

        try {
            const agent = await agentRegistryService.getAgentDetail(req.params.agentId);
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: agent,
                authContext,
                operationControl
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeErrorWithOperation(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    authContext,
                    operationControl
                });
            }
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent detail',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });

    router.post('/agents/:agentId/render', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.body?.requestContext, 'agent-gateway-agent-render');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            providedAuthContext: req.body?.authContext,
            dedicatedAuth: req.agentGatewayDedicatedAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.render',
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

        try {
            const rendered = await agentRegistryService.renderAgent(req.params.agentId, {
                variables: req.body?.variables,
                model: req.body?.model,
                maxLength: req.body?.maxLength,
                context: req.body?.context,
                messages: req.body?.messages
            });
            if (
                rendered &&
                typeof rendered === 'object' &&
                rendered.success === true &&
                (
                    rendered.status === 'completed' ||
                    rendered.status === 'accepted' ||
                    rendered.status === 'waiting_approval'
                )
            ) {
                return sendNativeServiceResult(res, {
                    result: rendered,
                    startedAt,
                    authContext,
                    operationControl
                });
            }

            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: rendered,
                authContext,
                operationControl
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeErrorWithOperation(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    authContext,
                    operationControl
                });
            }
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to render agent',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });

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

    return router;
};
