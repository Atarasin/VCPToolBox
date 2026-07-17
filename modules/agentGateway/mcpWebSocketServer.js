'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const WebSocket = require('ws');

const {
    AGW_ERROR_CODES
} = require('./contracts/errorCodes');
const { sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const { WebSocketTransport, validateMcpTransport } = require('./transport');
const {
    createJsonRpcErrorResponse,
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('./mcpStdioServer');
const {
    checkSlidingWindowRateLimit,
    createSlidingWindowRateLimit,
    dispatchJsonRpc,
    injectMcpContext,
    parseJsonRpcPayload
} = require('./transport/shared');

const DEFAULT_ENDPOINT_PATH = '/mcp';
const DEFAULT_PING_INTERVAL_MS = 30000;
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_MAX_CONNECTIONS = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_UPGRADE_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_MESSAGES = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const MAX_BATCH_SIZE_ENV = 'VCP_MCP_WS_MAX_BATCH_SIZE';
const MAX_CONNECTIONS_ENV = 'VCP_MCP_WS_MAX_CONNECTIONS';
const MAX_PAYLOAD_BYTES_ENV = 'VCP_MCP_WS_MAX_PAYLOAD_BYTES';
const UPGRADE_AUTH_TIMEOUT_MS_ENV = 'VCP_MCP_WS_UPGRADE_AUTH_TIMEOUT_MS';
const RATE_LIMIT_MESSAGES_ENV = 'VCP_MCP_WS_RATE_LIMIT_MESSAGES';
const RATE_LIMIT_WINDOW_MS_ENV = 'VCP_MCP_WS_RATE_LIMIT_WINDOW_MS';
const IDLE_TIMEOUT_MS_ENV = 'VCP_MCP_WS_IDLE_TIMEOUT_MS';
const DEFAULT_SOURCE = 'agent-gateway-mcp-ws';
const DEFAULT_RUNTIME = 'mcp-websocket';
const JSON_RPC_SERVER_ERROR_CODE = -32000;

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

function resolveConfiguredPositiveInteger(optionValue, envName, fallbackValue) {
    return resolvePositiveInteger(optionValue)
        || resolvePositiveInteger(process.env[envName])
        || fallbackValue;
}

function destroySocket(socket) {
    if (!socket || socket.destroyed) {
        return;
    }

    try {
        socket.destroy();
    } catch (_error) {
        // Ignore destroy races during upgrade rejection paths.
    }
}

function createRateLimitErrorResponse(id, rateLimit) {
    return createJsonRpcErrorResponse(
        id,
        JSON_RPC_SERVER_ERROR_CODE,
        'Request rate limit exceeded for this websocket connection',
        {
            canonicalCode: AGW_ERROR_CODES.RATE_LIMITED,
            gatewayCode: AGW_ERROR_CODES.RATE_LIMITED,
            reason: 'rate_limited',
            retryAfterMs: rateLimit.retryAfterMs,
            limit: rateLimit.limit,
            windowMs: rateLimit.windowMs,
            rejectionCategory: 'rate_limit',
            retryable: true
        }
    );
}

function buildRateLimitRejectionPayload(rawMessage, rateLimit) {
    let request;
    try {
        request = JSON.parse(rawMessage);
    } catch (_error) {
        return null;
    }

    if (Array.isArray(request)) {
        const responses = request
            .filter((entry) => isPlainObject(entry) && hasOwn(entry, 'id'))
            .map((entry) => createRateLimitErrorResponse(entry.id, rateLimit));

        return responses.length > 0 ? JSON.stringify(responses) : null;
    }

    if (!isPlainObject(request) || !hasOwn(request, 'id')) {
        return null;
    }

    return JSON.stringify(createRateLimitErrorResponse(request.id, rateLimit));
}

function checkRateLimit(connection, timestamp = Date.now()) {
    return checkSlidingWindowRateLimit(connection.rateLimit, timestamp);
}

function injectConnectionContext(request, connectionContext, options = {}) {
    return injectMcpContext(request, connectionContext, options);
}

function createMcpWebSocketServer(options = {}) {
    const stderr = options.stderr || process.stderr;
    const endpointPath = sanitizeRequestContextValue(options.path, 128) || DEFAULT_ENDPOINT_PATH;
    const pingIntervalMs = Number.isFinite(options.pingIntervalMs) && options.pingIntervalMs > 0
        ? options.pingIntervalMs
        : DEFAULT_PING_INTERVAL_MS;
    const maxBatchSize = resolveMaxBatchSize(options);
    const maxConnections = resolveConfiguredPositiveInteger(
        options.maxConnections,
        MAX_CONNECTIONS_ENV,
        DEFAULT_MAX_CONNECTIONS
    );
    const maxPayloadBytes = resolveConfiguredPositiveInteger(
        options.maxPayloadBytes,
        MAX_PAYLOAD_BYTES_ENV,
        DEFAULT_MAX_PAYLOAD_BYTES
    );
    const upgradeAuthTimeoutMs = resolveConfiguredPositiveInteger(
        options.upgradeAuthTimeoutMs,
        UPGRADE_AUTH_TIMEOUT_MS_ENV,
        DEFAULT_UPGRADE_AUTH_TIMEOUT_MS
    );
    const rateLimitMessages = resolveConfiguredPositiveInteger(
        options.rateLimitMessages,
        RATE_LIMIT_MESSAGES_ENV,
        DEFAULT_RATE_LIMIT_MESSAGES
    );
    const rateLimitWindowMs = resolveConfiguredPositiveInteger(
        options.rateLimitWindowMs,
        RATE_LIMIT_WINDOW_MS_ENV,
        DEFAULT_RATE_LIMIT_WINDOW_MS
    );
    const idleTimeoutMs = resolvePositiveInteger(options.idleTimeoutMs)
        || resolvePositiveInteger(process.env[IDLE_TIMEOUT_MS_ENV])
        || 0;
    const initializeRuntime = options.initializeRuntime || initializeBackendProxyMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownBackendProxyMcpRuntime;
    const resolveAuth = options.resolveAuth || resolveDedicatedGatewayAuth;
    const wss = new WebSocket.Server({
        noServer: true,
        clientTracking: false,
        maxPayload: maxPayloadBytes
    });

    wss.on('error', (error) => {
        logTransportError(stderr, '[MCPTransport] WebSocket server error', error);
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

                    if (!runtimeContext?.harness || typeof runtimeContext.harness.handleRequest !== 'function') {
                        throw new Error('MCP websocket transport requires a harness with handleRequest(request).');
                    }

                    ownsRuntime = true;
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

    function touchConnection(connection) {
        connection.lastActivityAt = Date.now();
        if (connection.idleTimer) clearTimeout(connection.idleTimer);
        if (idleTimeoutMs <= 0) return;
        connection.idleTimer = setTimeout(() => {
            connection.ws.terminate();
            void cleanupConnection(connection, 'idle-timeout');
        }, idleTimeoutMs);
        if (typeof connection.idleTimer.unref === 'function') connection.idleTimer.unref();
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
        if (connection.idleTimer) {
            clearTimeout(connection.idleTimer);
            connection.idleTimer = null;
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
        const parsed = parseJsonRpcPayload(rawMessage, {
            batchPolicy: 'allow',
            maxBatchSize
        });
        if (parsed.error) {
            connection.transport.send(JSON.stringify(parsed.error));
            return;
        }

        if (!connection.harnessPromise) {
            connection.harnessPromise = resolveHarness().catch((error) => {
                connection.harnessPromise = null;
                throw error;
            });
        }
        const harness = await connection.harnessPromise;
        const response = await dispatchJsonRpc({
            ...parsed,
            harness,
            inject: (request) => injectConnectionContext(request, connection.context, options),
            onNotificationError: (error) => {
                logTransportError(stderr, '[MCPTransport] Notification handling failed', error);
            }
        });
        if (response) {
            connection.transport.send(JSON.stringify(response));
        }
    }

    function registerConnection(ws, auth) {
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
            idleTimer: null,
            lastActivityAt: Date.now(),
            queue: Promise.resolve(),
            harnessPromise: null,
            rateLimit: createSlidingWindowRateLimit({ limit: rateLimitMessages, windowMs: rateLimitWindowMs })
        };

        connections.set(connection.connectionId, connection);
        startHeartbeat(connection);
        touchConnection(connection);

        transport.setErrorHandler((error) => {
            logTransportError(stderr, '[MCPTransport] WebSocket transport error', error);
            void cleanupConnection(connection, 'transport-error');
        });

        transport.setMessageHandler((message) => {
            touchConnection(connection);
            const rateLimitResult = checkRateLimit(connection);
            if (!rateLimitResult.allowed) {
                const payload = buildRateLimitRejectionPayload(message, rateLimitResult);
                if (payload) {
                    connection.transport.send(payload);
                }
                return;
            }

            connection.queue = connection.queue
                .then(() => handleClientMessage(connection, message))
                .catch((error) => {
                    try {
                        logTransportError(stderr, '[MCPTransport] Request handling failed', error);
                    } catch (_logError) {
                        // Logging itself failed — swallow to avoid killing the queue.
                    }
                });
        });

        ws.on('pong', () => {
            connection.isAlive = true;
            touchConnection(connection);
        });

        ws.on('close', () => {
            void cleanupConnection(connection, 'close');
        });

        ws.on('error', (error) => {
            logTransportError(stderr, '[MCPTransport] WebSocket connection error', error);
            void cleanupConnection(connection, 'error');
        });
    }

    async function handleUpgrade(request, socket, head) {
        if (buildPathname(request.url) !== endpointPath) {
            return;
        }

        if (connections.size >= maxConnections) {
            destroySocket(socket);
            writeStderr(stderr, `[MCPTransport] Connection rejected: maxConnections (${maxConnections}) reached.`);
            return;
        }

        let auth;
        let upgradeTimeout = null;
        let cleanupSocketAbortListeners = null;
        const socketAbortPromise = new Promise((_, reject) => {
            const rejectOnAbort = () => {
                const error = new Error('Socket closed before websocket upgrade authentication completed');
                error.code = 'MCP_WS_UPGRADE_SOCKET_ABORTED';
                reject(error);
            };

            socket.once('close', rejectOnAbort);
            socket.once('error', rejectOnAbort);
            cleanupSocketAbortListeners = () => {
                socket.off('close', rejectOnAbort);
                socket.off('error', rejectOnAbort);
            };
        });

        try {
            auth = await Promise.race([
                Promise.resolve().then(() => resolveAuth({
                    headers: request.headers,
                    pluginManager: options.pluginManager
                })),
                socketAbortPromise,
                new Promise((_, reject) => {
                    // Bound the full auth resolution path so a stalled upgrade cannot pin a socket forever.
                    upgradeTimeout = setTimeout(() => {
                        const error = new Error(`WebSocket upgrade authentication timed out after ${upgradeAuthTimeoutMs}ms`);
                        error.code = 'MCP_WS_UPGRADE_TIMEOUT';
                        reject(error);
                    }, upgradeAuthTimeoutMs);

                    if (typeof upgradeTimeout.unref === 'function') {
                        upgradeTimeout.unref();
                    }
                })
            ]);
        } catch (error) {
            if (error?.code === 'MCP_WS_UPGRADE_SOCKET_ABORTED') {
                return;
            }

            if (error?.code === 'MCP_WS_UPGRADE_TIMEOUT') {
                writeStderr(stderr, `[MCPTransport] ${error.message}`);
            } else {
                logTransportError(stderr, '[MCPTransport] Upgrade authentication failed', error);
            }
            destroySocket(socket);
            return;
        } finally {
            if (upgradeTimeout) {
                clearTimeout(upgradeTimeout);
            }
            if (typeof cleanupSocketAbortListeners === 'function') {
                cleanupSocketAbortListeners();
            }
        }

        if (!auth.provided || !auth.authenticated) {
            destroySocket(socket);
            return;
        }

        try {
            wss.handleUpgrade(request, socket, head, (ws) => {
                registerConnection(ws, auth);
            });
        } catch (error) {
            logTransportError(stderr, '[MCPTransport] WebSocket upgrade failed', error);
            destroySocket(socket);
        }
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

            const injectedRuntime = options.backendClient || options.backendUrl || options.initializeRuntime;
            if (ownsRuntime && (options.shutdownOnClose === true || typeof options.shutdownRuntime === 'function' || injectedRuntime)) {
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
