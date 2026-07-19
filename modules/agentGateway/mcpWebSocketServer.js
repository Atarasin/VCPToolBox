'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const WebSocket = require('ws');

const {
    AGW_ERROR_CODES
} = require('./contracts/errorCodes');
const { sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const { createProtocolConfigSnapshot } = require('./composition/vcpPortBindings');
const { WebSocketTransport, validateMcpTransport } = require('./transport');
const {
    attachPresentedCredential,
    clearPresentedCredential,
    getPresentedCredential
} = require('./policy/trustedCredentialContext');
const { extractPresentedCredential } = require('./policy/gatewayRequestContext');
const {
    DISCOVERY_SNAPSHOT_HOLDER,
    createDiscoverySnapshotHolder
} = require('./policy/discoverySnapshot');
const { createRevocationWatcher } = require('./policy/revocationWatcher');
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

function createWebSocketState(options) {
    options = {
        ...options,
        protocolConfig: options.protocolConfig || createProtocolConfigSnapshot(options.pluginManager)
    };
    const maxPayloadBytes = resolveConfiguredPositiveInteger(options.maxPayloadBytes, MAX_PAYLOAD_BYTES_ENV,
        DEFAULT_MAX_PAYLOAD_BYTES);
    const state = { options, stderr: options.stderr || process.stderr,
        endpointPath: sanitizeRequestContextValue(options.path, 128) || DEFAULT_ENDPOINT_PATH,
        pingIntervalMs: Number.isFinite(options.pingIntervalMs) && options.pingIntervalMs > 0
            ? options.pingIntervalMs : DEFAULT_PING_INTERVAL_MS,
        maxBatchSize: resolveMaxBatchSize(options),
        maxConnections: resolveConfiguredPositiveInteger(options.maxConnections, MAX_CONNECTIONS_ENV,
            DEFAULT_MAX_CONNECTIONS), maxPayloadBytes,
        upgradeAuthTimeoutMs: resolveConfiguredPositiveInteger(options.upgradeAuthTimeoutMs,
            UPGRADE_AUTH_TIMEOUT_MS_ENV, DEFAULT_UPGRADE_AUTH_TIMEOUT_MS),
        rateLimitMessages: resolveConfiguredPositiveInteger(options.rateLimitMessages, RATE_LIMIT_MESSAGES_ENV,
            DEFAULT_RATE_LIMIT_MESSAGES),
        rateLimitWindowMs: resolveConfiguredPositiveInteger(options.rateLimitWindowMs, RATE_LIMIT_WINDOW_MS_ENV,
            DEFAULT_RATE_LIMIT_WINDOW_MS),
        idleTimeoutMs: resolvePositiveInteger(options.idleTimeoutMs) ||
            resolvePositiveInteger(process.env[IDLE_TIMEOUT_MS_ENV]) || 0,
        initializeRuntime: options.initializeRuntime || ((runtimeOptions) => initializeBackendProxyMcpRuntime({ ...runtimeOptions, discoveryDefaultAgentEnabled: false })),
        shutdownRuntime: options.shutdownRuntime || shutdownBackendProxyMcpRuntime,
        resolveAuth: options.resolveAuth || resolveDedicatedGatewayAuth,
        wss: new WebSocket.Server({ noServer: true, clientTracking: false, maxPayload: maxPayloadBytes }),
        connections: new Map(), attachedServer: null, upgradeListener: null, closePromise: null,
        runtimeContext: null, runtimePromise: null, ownsRuntime: false };
    state.wss.on('error', (error) => logTransportError(state.stderr, '[MCPTransport] WebSocket server error', error));
    return state;
}

async function resolveHarness(state) {
    if (state.options.harness?.handleRequest) return state.options.harness;
    if (state.runtimeContext?.harness?.handleRequest) return state.runtimeContext.harness;
    if (!state.runtimePromise) {
        state.runtimePromise = Promise.resolve(state.initializeRuntime(state.options)).then((context) => {
            state.runtimeContext = context || null;
            if (!state.runtimeContext?.harness?.handleRequest) {
                throw new Error('MCP websocket transport requires a harness with handleRequest(request).');
            }
            state.ownsRuntime = true;
            return state.runtimeContext;
        }).catch((error) => {
            state.runtimePromise = null;
            throw error;
        });
    }
    return (await state.runtimePromise).harness;
}

function startHeartbeat(state, connection) {
        connection.isAlive = true;
        connection.heartbeatTimer = setInterval(() => {
            if (connection.cleanedUp) {
                return;
            }

            if (connection.ws.readyState !== WebSocket.OPEN) {
                void cleanupConnection(state, connection, 'socket-not-open');
                return;
            }

            if (!connection.isAlive) {
                connection.ws.terminate();
                void cleanupConnection(state, connection, 'heartbeat-timeout');
                return;
            }

            connection.isAlive = false;
            try {
                connection.ws.ping();
            } catch (error) {
                logTransportError(state.stderr, '[MCPTransport] WebSocket ping failed', error);
                void cleanupConnection(state, connection, 'heartbeat-ping-failed');
            }
        }, state.pingIntervalMs);

        if (typeof connection.heartbeatTimer.unref === 'function') {
            connection.heartbeatTimer.unref();
        }
}

function touchConnection(state, connection) {
        connection.lastActivityAt = Date.now();
        if (connection.idleTimer) clearTimeout(connection.idleTimer);
        if (state.idleTimeoutMs <= 0) return;
        connection.idleTimer = setTimeout(() => {
            connection.ws.terminate();
            void cleanupConnection(state, connection, 'idle-timeout');
        }, state.idleTimeoutMs);
        if (typeof connection.idleTimer.unref === 'function') connection.idleTimer.unref();
}

async function cleanupConnection(state, connection, _reason = 'cleanup') {
        if (!connection) {
            return;
        }

        if (connection.cleanupPromise) {
            return connection.cleanupPromise;
        }

        connection.cleanedUp = true;
        state.connections.delete(connection.connectionId);
        // 销毁时清除对 presented token 的引用（§3.3）
        clearPresentedCredential(connection.context);
        if (connection.revocationWatcher) {
            connection.revocationWatcher.stop();
            connection.revocationWatcher = null;
        }

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

async function handleClientMessage(state, connection, rawMessage) {
        const parsed = parseJsonRpcPayload(rawMessage, {
            batchPolicy: 'allow',
            maxBatchSize: state.maxBatchSize
        });
        if (parsed.error) {
            connection.transport.send(JSON.stringify(parsed.error));
            return;
        }

        if (!connection.harnessPromise) {
            connection.harnessPromise = resolveHarness(state).catch((error) => {
                connection.harnessPromise = null;
                throw error;
            });
        }
        const harness = await connection.harnessPromise;
        const response = await dispatchJsonRpc({
            ...parsed,
            harness,
            inject: (request) => injectConnectionContext(request, connection.context, state.options),
            onNotificationError: (error) => {
                logTransportError(state.stderr, '[MCPTransport] Notification handling failed', error);
            }
        });
        if (response) {
            connection.transport.send(JSON.stringify(response));
        }
}

function dispatchConnectionMessage(state, connection, message) {
    const rateLimitResult = checkRateLimit(connection);
    if (!rateLimitResult.allowed) {
        const payload = buildRateLimitRejectionPayload(message, rateLimitResult);
        if (payload) {
            connection.transport.send(payload);
        }
        return Promise.resolve();
    }
    return handleClientMessage(state, connection, message).catch((error) => {
        try {
            logTransportError(state.stderr, '[MCPTransport] Request handling failed', error);
        } catch (_logError) { /* noop */ }
    });
}

function registerConnection(state, ws, auth) {
        const context = createConnectionContext(auth, state.options);
        context[DISCOVERY_SNAPSHOT_HOLDER] = createDiscoverySnapshotHolder();
        attachPresentedCredential(context, getPresentedCredential(auth));
        clearPresentedCredential(auth);
        const connectionCredentialId = auth?.credentialContext?.credentialId || '';
        const transport = validateMcpTransport(new WebSocketTransport(ws, state.options.transportOptions));
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
            rateLimit: createSlidingWindowRateLimit({ limit: state.rateLimitMessages, windowMs: state.rateLimitWindowMs }),
            credentialId: connectionCredentialId,
            revocationWatcher: null
        };

        // §3.6 / M1.S6.T5：空闲连接 30s 周期重校验，吊销 close(4401)，
        // 配置不可用 close(1013)；≤60s 承诺。
        if (state.options.checkConnectionCredential && connectionCredentialId) {
            connection.revocationWatcher = createRevocationWatcher({
                checkStatus: () => state.options.checkConnectionCredential(connectionCredentialId),
                intervalMs: state.options.credentialRevalidationIntervalMs || 30_000,
                onRevoked: () => { try { ws.close(4401, 'credential revoked'); } catch (_e) { /* closed */ } },
                onUnavailable: () => { try { ws.close(1013, 'security configuration unavailable'); } catch (_e) { /* closed */ } }
            });
            connection.revocationWatcher.start();
        }

        state.connections.set(connection.connectionId, connection);
        startHeartbeat(state, connection);
        touchConnection(state, connection);

        transport.setErrorHandler((error) => {
            logTransportError(state.stderr, '[MCPTransport] WebSocket transport error', error);
            void cleanupConnection(state, connection, 'transport-error');
        });

        transport.setMessageHandler((message) => {
            touchConnection(state, connection);
            // §3.6 / M1.S6.T5：每条消息轻量重校验 credential 当前状态
            const credentialCheck = state.options.checkConnectionCredential || null;
            if (credentialCheck && connection.credentialId) {
                connection.queue = connection.queue
                    .then(() => credentialCheck(connection.credentialId))
                    .then((status) => {
                        if (status?.ok) {
                            return dispatchConnectionMessage(state, connection, message);
                        }
                        const closeCode = status?.code === 'AGW_CONFIG_UNAVAILABLE' ? 1013 : 4401;
                        try { connection.ws.close(closeCode, 'credential no longer valid'); } catch (_e) { /* closed */ }
                        return undefined;
                    })
                    .catch((error) => {
                        try { logTransportError(state.stderr, '[MCPTransport] Credential revalidation failed', error); } catch (_e) { /* noop */ }
                        try { connection.ws.close(1013, 'credential revalidation failed'); } catch (_e) { /* closed */ }
                    });
                return;
            }
            const rateLimitResult = checkRateLimit(connection);
            if (!rateLimitResult.allowed) {
                const payload = buildRateLimitRejectionPayload(message, rateLimitResult);
                if (payload) {
                    connection.transport.send(payload);
                }
                return;
            }

            connection.queue = connection.queue
                .then(() => handleClientMessage(state, connection, message))
                .catch((error) => {
                    try {
                        logTransportError(state.stderr, '[MCPTransport] Request handling failed', error);
                    } catch (_logError) {
                        // Logging itself failed — swallow to avoid killing the queue.
                    }
                });
        });

        ws.on('pong', () => {
            connection.isAlive = true;
            touchConnection(state, connection);
        });

        ws.on('close', () => {
            void cleanupConnection(state, connection, 'close');
        });

        ws.on('error', (error) => {
            logTransportError(state.stderr, '[MCPTransport] WebSocket connection error', error);
            void cleanupConnection(state, connection, 'error');
        });
}

async function resolveUpgradeAuth(state, request, socket) {
    let timeout = null;
    let cleanup = null;
    const aborted = new Promise((_, reject) => {
        const rejectOnAbort = () => { const error = new Error('Socket closed before websocket upgrade authentication completed');
            error.code = 'MCP_WS_UPGRADE_SOCKET_ABORTED'; reject(error); };
        socket.once('close', rejectOnAbort); socket.once('error', rejectOnAbort);
        cleanup = () => { socket.off('close', rejectOnAbort); socket.off('error', rejectOnAbort); };
    });
    try {
        return await Promise.race([
            Promise.resolve().then(() => state.resolveAuth({ headers: request.headers,
                config: state.options.protocolConfig })), aborted,
            new Promise((_, reject) => { timeout = setTimeout(() => { const error = new Error(
                `WebSocket upgrade authentication timed out after ${state.upgradeAuthTimeoutMs}ms`);
                error.code = 'MCP_WS_UPGRADE_TIMEOUT'; reject(error); }, state.upgradeAuthTimeoutMs);
            if (typeof timeout.unref === 'function') timeout.unref(); })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
        if (cleanup) cleanup();
    }
}

async function handleUpgrade(state, request, socket, head) {
        if (buildPathname(request.url) !== state.endpointPath) {
            return;
        }

        if (state.connections.size >= state.maxConnections) {
            destroySocket(socket);
            writeStderr(state.stderr, `[MCPTransport] Connection rejected: maxConnections (${state.maxConnections}) reached.`);
            return;
        }

        let auth;
        try {
            auth = await resolveUpgradeAuth(state, request, socket);
        } catch (error) {
            if (error?.code === 'MCP_WS_UPGRADE_SOCKET_ABORTED') {
                return;
            }

            if (error?.code === 'MCP_WS_UPGRADE_TIMEOUT') {
                writeStderr(state.stderr, `[MCPTransport] ${error.message}`);
            } else {
                logTransportError(state.stderr, '[MCPTransport] Upgrade authentication failed', error);
            }
            destroySocket(socket);
            return;
        }

        if (!auth.provided || !auth.authenticated) {
            destroySocket(socket);
            return;
        }

        // presented token 存入 transport 私有通道（Symbol），供逐消息透传 backend
        {
            const extracted = extractPresentedCredential(request.headers);
            if (!extracted.conflict && extracted.token) {
                attachPresentedCredential(auth, extracted.token);
            }
        }

        try {
            state.wss.handleUpgrade(request, socket, head, (ws) => {
                registerConnection(state, ws, auth);
            });
        } catch (error) {
            logTransportError(state.stderr, '[MCPTransport] WebSocket upgrade failed', error);
            destroySocket(socket);
        }
}

function attach(state, httpServer) {
        if (!httpServer || typeof httpServer.on !== 'function') {
            throw new Error('createMcpWebSocketServer.attach(httpServer) requires an HTTP server instance.');
        }

        if (state.attachedServer === httpServer && state.upgradeListener) {
            return;
        }

        if (state.attachedServer && state.upgradeListener) {
            state.attachedServer.off('upgrade', state.upgradeListener);
        }

        state.attachedServer = httpServer;
        state.upgradeListener = (request, socket, head) => {
            Promise.resolve(handleUpgrade(state, request, socket, head)).catch((error) => {
                logTransportError(state.stderr, '[MCPTransport] Upgrade handling failed', error);
                socket.destroy();
            });
        };

        // Keep `/mcp` on an isolated upgrade path instead of mixing it into the legacy mesh.
        state.attachedServer.on('upgrade', state.upgradeListener);
}

async function close(state) {
        if (state.closePromise) {
            return state.closePromise;
        }

        state.closePromise = (async () => {
            if (state.attachedServer && state.upgradeListener) {
                state.attachedServer.off('upgrade', state.upgradeListener);
            }

            state.attachedServer = null;
            state.upgradeListener = null;

            await Promise.all(Array.from(state.connections.values(),
                (connection) => cleanupConnection(state, connection, 'server-close')));

            await new Promise((resolve) => {
                state.wss.close(() => resolve());
            });

            const options = state.options;
            const injectedRuntime = options.backendClient || options.backendUrl || options.initializeRuntime;
            if (state.ownsRuntime && (options.shutdownOnClose === true || typeof options.shutdownRuntime === 'function' || injectedRuntime)) {
                try {
                    await state.shutdownRuntime();
                } catch (error) {
                    logTransportError(state.stderr, '[MCPTransport] Shutdown failed', error);
                }
            }

            state.runtimeContext = null;
            state.runtimePromise = null;
            state.ownsRuntime = false;
        })();

        return state.closePromise;
}

function createMcpWebSocketServer(options = {}) {
    const state = createWebSocketState(options);
    return {
        attach: (server) => attach(state, server),
        initialize: (server) => attach(state, server),
        close: () => close(state),
        getConnectionCount() {
            return state.connections.size;
        }
    };
}

module.exports = {
    createMcpWebSocketServer
};
