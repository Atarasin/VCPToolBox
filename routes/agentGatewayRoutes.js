const express = require('express');
const {
    normalizeRequestContext
} = require('../modules/agentGateway/contracts/requestContext');
const {
    sendSuccessResponse,
    sendErrorResponse
} = require('../modules/agentGateway/contracts/responseEnvelope');
const {
    AGW_ERROR_CODES,
    OPENCLAW_TO_AGENT_GATEWAY_CODE
} = require('../modules/agentGateway/contracts/errorCodes');
const {
    getGatewayServiceBundle
} = require('../modules/agentGateway/createGatewayServiceBundle');

const NATIVE_GATEWAY_VERSION = 'v1';

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

function createNativeRequestContext(input, defaultSource) {
    return normalizeRequestContext(input, {
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
        versionKey: 'gatewayVersion',
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
        versionKey: 'gatewayVersion',
        extraMeta
    });
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
        memoryRuntimeService,
        contextRuntimeService,
        toolRuntimeService
    } = getGatewayServiceBundle(pluginManager, {
        gatewayVersion: NATIVE_GATEWAY_VERSION
    });

    router.get('/capabilities', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext({
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-capabilities');
        const agentId = normalizeNativeString(req.query.agentId || requestContext.agentId);
        const maid = normalizeNativeString(req.query.maid);
        const authContext = authContextResolver({
            requestContext,
            agentId,
            maid,
            adapter: 'native'
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
                data: capabilities
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to build native gateway capabilities',
                details: { message: error.message }
            });
        }
    });

    router.get('/agents', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext({
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');

        try {
            const agents = await agentRegistryService.listAgents();
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    agents
                }
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent registry',
                details: { message: error.message }
            });
        }
    });

    router.get('/agents/:agentId', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext({
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-registry');

        try {
            const agent = await agentRegistryService.getAgentDetail(req.params.agentId);
            return sendNativeSuccess(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: agent
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeError(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details
                });
            }
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load agent detail',
                details: { message: error.message }
            });
        }
    });

    router.post('/agents/:agentId/render', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req.body?.requestContext, 'agent-gateway-agent-render');

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
                data: rendered
            });
        } catch (error) {
            if (error?.code === 'AGENT_NOT_FOUND') {
                return sendNativeError(res, {
                    status: 404,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.NOT_FOUND,
                    error: error.message,
                    details: error.details
                });
            }
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to render agent',
                details: { message: error.message }
            });
        }
    });

    router.get('/memory/targets', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext({
            requestId: req.query.requestId,
            agentId: req.query.agentId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-memory');
        const agentId = normalizeNativeString(req.query.agentId || requestContext.agentId);
        const maid = normalizeNativeString(req.query.maid);
        const authContext = authContextResolver({
            requestContext,
            agentId,
            maid,
            adapter: 'native'
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
                }
            });
        } catch (error) {
            return sendNativeError(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to load memory targets',
                details: { message: error.message }
            });
        }
    });

    router.post('/memory/search', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req.body?.requestContext, 'agent-gateway-memory-search');
        const authContext = authContextResolver({
            authContext: req.body?.authContext,
            requestContext,
            maid: req.body?.maid,
            adapter: 'native'
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
                details: result.details
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/memory/write', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req.body?.requestContext, 'agent-gateway-memory-write');
        const authContext = authContextResolver({
            authContext: req.body?.authContext,
            requestContext,
            maid: req.body?.target?.maid,
            adapter: 'native'
        });
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
        const result = await memoryRuntimeService.writeMemory({
            body: {
                ...req.body,
                authContext,
                requestContext
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
                details: result.details
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/context/assemble', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req.body?.requestContext, 'agent-gateway-context');
        const authContext = authContextResolver({
            authContext: req.body?.authContext,
            requestContext,
            maid: req.body?.maid,
            adapter: 'native'
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
                details: result.details
            });
        }

        return sendNativeSuccess(res, {
            requestId: result.requestId,
            startedAt,
            data: result.data
        });
    });

    router.post('/tools/:toolName/invoke', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req.body?.requestContext, 'agent-gateway-tool');
        const authContext = authContextResolver({
            authContext: req.body?.authContext,
            requestContext,
            maid: req.body?.maid,
            adapter: 'native'
        });
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;
        const result = await toolRuntimeService.invokeTool({
            toolName: req.params.toolName,
            body: {
                ...req.body,
                authContext,
                requestContext
            },
            startedAt,
            clientIp,
            defaultSource: 'agent-gateway-tool'
        });

        if (result.status === 'completed' || result.status === 'accepted') {
            return sendNativeSuccess(res, {
                status: result.httpStatus || (result.status === 'accepted' ? 202 : 200),
                requestId: result.requestId,
                startedAt,
                data: result.data,
                extraMeta: {
                    toolStatus: result.status
                }
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
            }
        });
    });

    return router;
};
