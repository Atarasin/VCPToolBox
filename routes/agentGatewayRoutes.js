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

function sendNativeSuccess(res, { status = 200, requestId, startedAt, data, extraMeta }) {
    return sendSuccessResponse(res, {
        status,
        requestId,
        startedAt,
        data,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
        extraMeta
    });
}

function sendNativeError(res, { status = 500, requestId, startedAt, code, error, details, extraMeta }) {
    return sendErrorResponse(res, {
        status,
        requestId,
        startedAt,
        code: mapNativeErrorCode(code),
        error,
        details,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
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
        toolRuntimeService
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

        if (!agentId) {
            return sendNativeError(res, {
                status: 400,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INVALID_REQUEST,
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const capabilities = await capabilityService.getCapabilities({
                agentId,
                maid,
                includeMemoryTargets,
                authContext
            });
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: applyGovernedCapabilitySections(capabilities, {
                    authContext
                }),
                extraMeta: buildNativeResponseMeta(authContext)
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to build native gateway capabilities',
                details: { message: error.message },
                extraMeta: buildNativeResponseMeta(authContext)
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

        try {
            const agents = await agentRegistryService.listAgents();
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    agents
                },
                extraMeta: buildNativeResponseMeta(authContext)
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent registry',
                details: { message: error.message },
                extraMeta: buildNativeResponseMeta(authContext)
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

        try {
            const agent = await agentRegistryService.getAgentDetail(req.params.agentId);
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: agent,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeError(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    extraMeta: buildNativeResponseMeta(authContext)
                });
            }
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent detail',
                details: { message: error.message },
                extraMeta: buildNativeResponseMeta(authContext)
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

        try {
            const rendered = await agentRegistryService.renderAgent(req.params.agentId, {
                variables: req.body?.variables,
                model: req.body?.model,
                maxLength: req.body?.maxLength,
                context: req.body?.context,
                messages: req.body?.messages
            });
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: rendered,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeError(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details,
                    extraMeta: buildNativeResponseMeta(authContext)
                });
            }
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to render agent',
                details: { message: error.message },
                extraMeta: buildNativeResponseMeta(authContext)
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

        if (!agentId) {
            return sendNativeError(res, {
                status: 400,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INVALID_REQUEST,
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const targets = await capabilityService.getMemoryTargets({
                agentId,
                maid,
                authContext
            });
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    targets
                },
                extraMeta: buildNativeResponseMeta(authContext)
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load memory targets',
                details: { message: error.message },
                extraMeta: buildNativeResponseMeta(authContext)
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
        const result = await contextRuntimeService.search({
            body: {
                ...req.body,
                authContext,
                requestContext
            },
            startedAt,
            defaultSource: 'agent-gateway-memory-search'
        });

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data,
            extraMeta: buildNativeResponseMeta(authContext)
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

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data,
            extraMeta: buildNativeResponseMeta(authContext)
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
        const result = await contextRuntimeService.buildRecallContext({
            body: {
                ...req.body,
                authContext,
                requestContext
            },
            startedAt,
            defaultSource: 'agent-gateway-context'
        });

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: result.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data,
            extraMeta: buildNativeResponseMeta(authContext)
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
            return sendNativeSuccess(res, {
                status: result.httpStatus || (result.status === 'completed' ? 200 : 202),
                requestId: result.requestId,
                startedAt,
                data: result.data,
                extraMeta: buildNativeResponseMeta(authContext, {
                    toolStatus: result.status
                })
            });
        }

        return sendNativeError(res, {
            status: result.httpStatus,
            requestId: result.requestId,
            startedAt,
            code: result.code,
            error: result.error,
            details: {
                ...(result.details || {}),
                toolStatus: result.status
            },
            extraMeta: buildNativeResponseMeta(authContext)
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
        const result = jobRuntimeService.pollJob(req.params.jobId, authContext);

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: requestContext.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        return sendNativeSuccess(res, {
            requestId: requestContext.requestId,
            startedAt,
            data: result.data,
            extraMeta: buildNativeResponseMeta(authContext)
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
        const result = jobRuntimeService.cancelJob(req.params.jobId, authContext);

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: requestContext.requestId,
                startedAt,
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        return sendNativeSuccess(res, {
            requestId: requestContext.requestId,
            startedAt,
            data: result.data,
            extraMeta: buildNativeResponseMeta(authContext)
        });
    });

    router.get('/events/stream', async (req, res) => {
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
        const result = jobRuntimeService.listEvents({
            authContext,
            filters: createNativeStreamFilters(req.query)
        });

        if (!result.success) {
            return sendNativeError(res, {
                status: result.status,
                requestId: requestContext.requestId,
                startedAt: Date.now(),
                code: result.code,
                error: result.error,
                details: result.details,
                extraMeta: buildNativeResponseMeta(authContext)
            });
        }

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Agent-Gateway-Version', NATIVE_GATEWAY_VERSION);
        res.flushHeaders?.();

        // 先发送稳定的 meta 事件，便于调用方在首帧就拿到 request/gateway 上下文。
        writeNativeSseEvent(res, 'gateway.meta', {
            requestId: requestContext.requestId,
            gatewayVersion: NATIVE_GATEWAY_VERSION,
            authMode: authContext.authMode,
            authSource: authContext.authSource,
            gatewayId: authContext.gatewayId
        });

        result.data.events.forEach((event) => {
            writeNativeSseEvent(res, event.eventType, event);
        });

        return res.end();
    });

    return router;
};
