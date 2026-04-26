'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const WebSocket = require('ws');

const { normalizeRequestContext, sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const { WebSocketTransport, validateMcpTransport } = require('./transport');
const {
    createJsonRpcErrorResponse,
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('./mcpStdioServer');

const DEFAULT_ENDPOINT_PATH = '/mcp';
const DEFAULT_PING_INTERVAL_MS = 30000;
const DEFAULT_MAX_BATCH_SIZE = 20;
const MAX_BATCH_SIZE_ENV = 'VCP_MCP_WS_MAX_BATCH_SIZE';
const DEFAULT_SOURCE = 'agent-gateway-mcp-ws';
const DEFAULT_RUNTIME = 'mcp-websocket';

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolvePositiveInteger(value) {
    const normalizedValue = Number.parseInt(value, 10);
    return Number.isFinite(normalizedValue) && normalizedValue > 0
        ? normalizedValue
        : null;
}

function createInvalidRequestError(data) {
    return createJsonRpcErrorResponse(null, -32600, 'Invalid request', data);
}

function writeStderr(stderr, message) {
    if (!stderr || typeof stderr.write !== 'function') {
        return;
    }

    stderr.write(`${message}\n`);
}

function logTransportError(stderr, message, error) {
    const details = error && error.message ? error.message : String(error || 'Unknown error');
    writeStderr(stderr, `${message}: ${details}`);
}

function buildPathname(requestUrl) {
    try {
        return new URL(requestUrl || '/', 'http://127.0.0.1').pathname;
    } catch (_error) {
        return '';
    }
}

function createConnectionContext(auth, options) {
    const connectionPrefix = sanitizeRequestContextValue(options.connectionIdPrefix, 32) || 'mcpws';
    const sessionPrefix = sanitizeRequestContextValue(options.sessionIdPrefix, 32) || 'mcpws';
    const source = sanitizeRequestContextValue(options.source, 128) || DEFAULT_SOURCE;
    const runtime = sanitizeRequestContextValue(options.runtime, 128) || DEFAULT_RUNTIME;
    const gatewayId = sanitizeRequestContextValue(auth?.gatewayId, 256);
    const authMode = sanitizeRequestContextValue(auth?.authMode, 64);
    const authSource = sanitizeRequestContextValue(auth?.authSource, 128);
    const roles = Array.isArray(auth?.roles)
        ? auth.roles.map((role) => sanitizeRequestContextValue(role, 128)).filter(Boolean)
        : [];

    return {
        connectionId: `${connectionPrefix}_${crypto.randomUUID()}`,
        sessionId: `${sessionPrefix}_${crypto.randomUUID()}`,
        source,
        runtime,
        gatewayId,
        authMode,
        authSource,
        roles
    };
}

function resolveMaxBatchSize(options = {}) {
    return resolvePositiveInteger(options.maxBatchSize)
        || resolvePositiveInteger(process.env[MAX_BATCH_SIZE_ENV])
        || DEFAULT_MAX_BATCH_SIZE;
}

function injectConnectionContext(request, connectionContext, options = {}) {
    const requestObject = isPlainObject(request) ? request : {};
    const params = isPlainObject(requestObject.params) ? { ...requestObject.params } : {};
    const clientRequestContext = isPlainObject(params.requestContext) ? params.requestContext : {};
    const requestIdPrefix = sanitizeRequestContextValue(options.requestIdPrefix, 16) || 'agwmcp';
    const topLevelAgentId = sanitizeRequestContextValue(params.agentId, 256);

    const normalizedRequestContext = normalizeRequestContext({
        requestId: clientRequestContext.requestId,
        agentId: clientRequestContext.agentId || topLevelAgentId,
        source: clientRequestContext.source || connectionContext.source,
        runtime: clientRequestContext.runtime || connectionContext.runtime,
        sessionId: connectionContext.sessionId
    }, {
        defaultSource: connectionContext.source,
        defaultRuntime: connectionContext.runtime,
        requestIdPrefix
    });

    return {
        ...requestObject,
        params: {
            ...params,
            ...(topLevelAgentId || normalizedRequestContext.agentId
                ? { agentId: topLevelAgentId || normalizedRequestContext.agentId }
                : {}),
            // The canonical websocket session identity always comes from the server.
            sessionId: connectionContext.sessionId,
            requestContext: {
                ...normalizedRequestContext,
                ...(connectionContext.gatewayId ? { gatewayId: connectionContext.gatewayId } : {})
            },
            authContext: {
                ...(connectionContext.gatewayId ? { gatewayId: connectionContext.gatewayId } : {}),
                sessionId: connectionContext.sessionId,
                ...(connectionContext.authMode ? { authMode: connectionContext.authMode } : {}),
                ...(connectionContext.authSource ? { authSource: connectionContext.authSource } : {}),
                ...(connectionContext.roles.length > 0 ? { roles: [...connectionContext.roles] } : {})
            }
        }
    };
}

function createMcpWebSocketServer(options = {}) {
    const stderr = options.stderr || process.stderr;
    const endpointPath = sanitizeRequestContextValue(options.path, 128) || DEFAULT_ENDPOINT_PATH;
    const pingIntervalMs = Number.isFinite(options.pingIntervalMs) && options.pingIntervalMs > 0
        ? options.pingIntervalMs
        : DEFAULT_PING_INTERVAL_MS;
    const maxBatchSize = resolveMaxBatchSize(options);
    const initializeRuntime = options.initializeRuntime || initializeBackendProxyMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownBackendProxyMcpRuntime;
    const wss = new WebSocket.Server({
        noServer: true,
        clientTracking: false
    });

    const connections = new Map();
    let attachedServer = null;
    let upgradeListener = null;
    let closePromise = null;
    let runtimeContext = null;
    let runtimePromise = null;
    let ownsRuntime = false;

    async function resolveHarness() {
        if (options.harness && typeof options.harness.handleRequest === 'function') {
            return options.harness;
        }

        if (runtimeContext?.harness && typeof runtimeContext.harness.handleRequest === 'function') {
            return runtimeContext.harness;
        }

        if (!runtimePromise) {
            runtimePromise = Promise.resolve(initializeRuntime(options))
                .then((context) => {
                    runtimeContext = context || null;
                    ownsRuntime = true;

                    if (!runtimeContext?.harness || typeof runtimeContext.harness.handleRequest !== 'function') {
                        throw new Error('MCP websocket transport requires a harness with handleRequest(request).');
                    }

                    return runtimeContext;
                })
                .catch((error) => {
                    runtimePromise = null;
                    throw error;
                });
        }

        const context = await runtimePromise;
        return context.harness;
    }

    function startHeartbeat(connection) {
        connection.isAlive = true;
        connection.heartbeatTimer = setInterval(() => {
            if (connection.cleanedUp) {
                return;
            }

            if (connection.ws.readyState !== WebSocket.OPEN) {
                void cleanupConnection(connection, 'socket-not-open');
                return;
            }

            if (!connection.isAlive) {
                connection.ws.terminate();
                void cleanupConnection(connection, 'heartbeat-timeout');
                return;
            }

            connection.isAlive = false;
            try {
                connection.ws.ping();
            } catch (error) {
                logTransportError(stderr, '[MCPTransport] WebSocket ping failed', error);
                void cleanupConnection(connection, 'heartbeat-ping-failed');
            }
        }, pingIntervalMs);

        if (typeof connection.heartbeatTimer.unref === 'function') {
            connection.heartbeatTimer.unref();
        }
    }

    async function cleanupConnection(connection, _reason = 'cleanup') {
        if (!connection) {
            return;
        }

        if (connection.cleanupPromise) {
            return connection.cleanupPromise;
        }

        connection.cleanedUp = true;
        connections.delete(connection.connectionId);

        if (connection.heartbeatTimer) {
            clearInterval(connection.heartbeatTimer);
            connection.heartbeatTimer = null;
        }

        connection.cleanupPromise = (async () => {
            try {
                await Promise.resolve(connection.queue).catch(() => {});
            } catch (_error) {
                // Ignore queue failures during shutdown; they are already logged.
            }

            try {
                await connection.transport.close();
            } catch (_error) {
                // Ignore close races with ws.close()/ws.terminate().
            }

            try {
                await connection.transport.finished;
            } catch (_error) {
                // Transport finished is promise-like and should not reject, but stay defensive.
            }
        })();

        return connection.cleanupPromise;
    }

    async function handleClientMessage(connection, rawMessage) {
        const messageText = typeof rawMessage === 'string' ? rawMessage.trim() : '';
        if (!messageText) {
            return;
        }

        let request;
        try {
            request = JSON.parse(messageText);
        } catch (error) {
            connection.transport.send(JSON.stringify(createJsonRpcErrorResponse(null, -32700, 'Parse error', {
                details: error.message
            })));
            return;
        }

        let harnessPromise = null;
        const getHarness = async () => {
            if (!harnessPromise) {
                harnessPromise = resolveHarness();
            }
            return harnessPromise;
        };
        const dispatchRequest = async (requestItem, errorData) => {
            if (!isPlainObject(requestItem)) {
                return createInvalidRequestError(errorData);
            }

            const requestWithContext = injectConnectionContext(requestItem, connection.context, options);
            const expectsResponse = hasOwn(requestWithContext, 'id');
            const harness = await getHarness();

            try {
                const response = await harness.handleRequest(requestWithContext);
                return expectsResponse && response ? response : null;
            } catch (error) {
                if (!expectsResponse) {
                    logTransportError(stderr, '[MCPTransport] Notification handling failed', error);
                    return null;
                }

                return createJsonRpcErrorResponse(
                    requestWithContext.id,
                    -32603,
                    'Internal error',
                    { details: error.message }
                );
            }
        };

        if (Array.isArray(request)) {
            if (request.length === 0) {
                connection.transport.send(JSON.stringify(createInvalidRequestError({
                    field: 'request',
                    reason: 'empty_batch'
                })));
                return;
            }

            if (request.length > maxBatchSize) {
                connection.transport.send(JSON.stringify(createInvalidRequestError({
                    field: 'request',
                    reason: 'batch_limit_exceeded',
                    limit: maxBatchSize,
                    actual: request.length
                })));
                return;
            }

            const responses = [];
            for (let index = 0; index < request.length; index += 1) {
                const response = await dispatchRequest(request[index], {
                    field: 'request',
                    reason: 'invalid_batch_member',
                    batchIndex: index
                });
                if (response) {
                    responses.push(response);
                }
            }

            if (responses.length > 0) {
                connection.transport.send(JSON.stringify(responses));
            }
            return;
        }

        if (!isPlainObject(request)) {
            connection.transport.send(JSON.stringify(createInvalidRequestError({
                field: 'request'
            })));
            return;
        }

        const response = await dispatchRequest(request, {
            field: 'request'
        });
        if (response) {
            connection.transport.send(JSON.stringify(response));
        }
    }

    function registerConnection(ws, request, auth) {
        const context = createConnectionContext(auth, options);
        const transport = validateMcpTransport(new WebSocketTransport(ws, options.transportOptions));
        const connection = {
            ws,
            transport,
            context,
            connectionId: context.connectionId,
            isAlive: true,
            cleanedUp: false,
            cleanupPromise: null,
            heartbeatTimer: null,
            queue: Promise.resolve()
        };

        connections.set(connection.connectionId, connection);
        startHeartbeat(connection);

        transport.setErrorHandler((error) => {
            logTransportError(stderr, '[MCPTransport] WebSocket transport error', error);
            void cleanupConnection(connection, 'transport-error');
        });

        transport.setMessageHandler((message) => {
            connection.queue = connection.queue
                .then(() => handleClientMessage(connection, message))
                .catch((error) => {
                    logTransportError(stderr, '[MCPTransport] Request handling failed', error);
                });
        });

        ws.on('pong', () => {
            connection.isAlive = true;
        });

        ws.on('close', () => {
            void cleanupConnection(connection, 'close');
        });

        ws.on('error', (error) => {
            logTransportError(stderr, '[MCPTransport] WebSocket connection error', error);
            void cleanupConnection(connection, 'error');
        });

        wss.emit('connection', ws, request);
    }

    async function handleUpgrade(request, socket, head) {
        if (buildPathname(request.url) !== endpointPath) {
            return;
        }

        const auth = resolveDedicatedGatewayAuth({
            headers: request.headers,
            pluginManager: options.pluginManager
        });

        if (!auth.provided || !auth.authenticated) {
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            registerConnection(ws, request, auth);
        });
    }

    function attach(httpServer) {
        if (!httpServer || typeof httpServer.on !== 'function') {
            throw new Error('createMcpWebSocketServer.attach(httpServer) requires an HTTP server instance.');
        }

        if (attachedServer === httpServer && upgradeListener) {
            return;
        }

        if (attachedServer && upgradeListener) {
            attachedServer.off('upgrade', upgradeListener);
        }

        attachedServer = httpServer;
        upgradeListener = (request, socket, head) => {
            Promise.resolve(handleUpgrade(request, socket, head)).catch((error) => {
                logTransportError(stderr, '[MCPTransport] Upgrade handling failed', error);
                socket.destroy();
            });
        };

        // Keep `/mcp` on an isolated upgrade path instead of mixing it into the legacy mesh.
        attachedServer.on('upgrade', upgradeListener);
    }

    async function close() {
        if (closePromise) {
            return closePromise;
        }

        closePromise = (async () => {
            if (attachedServer && upgradeListener) {
                attachedServer.off('upgrade', upgradeListener);
            }

            attachedServer = null;
            upgradeListener = null;

            await Promise.all(Array.from(connections.values(), (connection) => cleanupConnection(connection, 'server-close')));

            await new Promise((resolve) => {
                wss.close(() => resolve());
            });

            if (ownsRuntime && options.shutdownOnClose !== false) {
                try {
                    await shutdownRuntime();
                } catch (error) {
                    logTransportError(stderr, '[MCPTransport] Shutdown failed', error);
                }
            }

            runtimeContext = null;
            runtimePromise = null;
            ownsRuntime = false;
        })();

        return closePromise;
    }

    return {
        attach,
        initialize: attach,
        close,
        getConnectionCount() {
            return connections.size;
        }
    };
}

module.exports = {
    createMcpWebSocketServer
};
