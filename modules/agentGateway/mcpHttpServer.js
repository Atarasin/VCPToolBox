'use strict';

const crypto = require('node:crypto');
const express = require('express');

const {
    AGW_ERROR_CODES
} = require('./contracts/errorCodes');
const { sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const {
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('./mcpStdioServer');
const {
    checkSlidingWindowRateLimit,
    createSlidingWindowRateLimit,
    injectMcpContext
} = require('./transport/shared');
const { createSessionStore } = require('./transport/http/sessionStore');
const {
    createPayloadTooLargeErrorResponse,
    createRateLimitErrorResponse,
    createSessionErrorResponse,
    createSessionLimitErrorResponse,
    createTimeoutErrorResponse,
    createTransportErrorResponse,
    createUnauthorizedErrorResponse,
    parseRawJsonRequest,
    requestAcceptsEventStream,
    writeEmptyResponse,
    writeJsonRpcResponse
} = require('./transport/http/httpJsonRpc');
const { createSseStreamController } = require('./transport/http/sseStream');

const DEFAULT_ENDPOINT_PATH = '/mcp';
const DEFAULT_SSE_ENDPOINT_PATH = '/mcp/sse';
const DEFAULT_SSE_MESSAGES_PATH = '/mcp/sse/messages';
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_MESSAGES = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_DISCOVERY_MAX_SESSIONS = 32;
const DEFAULT_DISCOVERY_SESSION_TTL_MS = 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const DEFAULT_SSE_BACKPRESSURE_TIMEOUT_MS = 30000;
const MAX_SESSIONS_ENV = 'VCP_MCP_HTTP_MAX_SESSIONS';
const MAX_PAYLOAD_BYTES_ENV = 'VCP_MCP_HTTP_MAX_PAYLOAD_BYTES';
const AUTH_TIMEOUT_MS_ENV = 'VCP_MCP_HTTP_AUTH_TIMEOUT_MS';
const RATE_LIMIT_MESSAGES_ENV = 'VCP_MCP_HTTP_RATE_LIMIT_MESSAGES';
const RATE_LIMIT_WINDOW_MS_ENV = 'VCP_MCP_HTTP_RATE_LIMIT_WINDOW_MS';
const SESSION_IDLE_MS_ENV = 'VCP_MCP_HTTP_SESSION_IDLE_MS';
const DISCOVERY_MAX_SESSIONS_ENV = 'VCP_MCP_HTTP_DISCOVERY_MAX_SESSIONS';
const DISCOVERY_SESSION_TTL_MS_ENV = 'VCP_MCP_HTTP_DISCOVERY_SESSION_TTL_MS';
const MCP_SESSION_HEADER = 'mcp-session-id';
const DEFAULT_SOURCE = 'agent-gateway-mcp-http';
const DEFAULT_RUNTIME = 'mcp-http';
const DEFAULT_SSE_SOURCE = 'agent-gateway-mcp-http-sse';
const DEFAULT_SSE_RUNTIME = 'mcp-http-sse';
const SELF_HEAL_DISCOVERY_METHODS = new Set([
    'tools/list',
    'prompts/list',
    'prompts/get',
    'resources/list'
]);

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

function resolveConfiguredPositiveInteger(optionValue, envName, fallbackValue) {
    return resolvePositiveInteger(optionValue)
        || resolvePositiveInteger(process.env[envName])
        || fallbackValue;
}

function isSuccessfulInitializeResponse(response) {
    return Boolean(
        response
        && typeof response === 'object'
        && !response.error
        && response.result
        && typeof response.result === 'object'
    );
}

function isSelfHealingDiscoveryMethod(methodName) {
    return SELF_HEAL_DISCOVERY_METHODS.has(sanitizeRequestContextValue(methodName, 128));
}

function createSessionContext(auth, options = {}, profile = {}) {
    const sessionPrefix = sanitizeRequestContextValue(options.sessionIdPrefix, 32) || 'mcphttp';
    const source = sanitizeRequestContextValue(profile.source, 128)
        || sanitizeRequestContextValue(options.source, 128)
        || DEFAULT_SOURCE;
    const runtime = sanitizeRequestContextValue(profile.runtime, 128)
        || sanitizeRequestContextValue(options.runtime, 128)
        || DEFAULT_RUNTIME;
    const gatewayId = sanitizeRequestContextValue(auth?.gatewayId, 256);
    const authMode = sanitizeRequestContextValue(auth?.authMode, 64);
    const authSource = sanitizeRequestContextValue(auth?.authSource, 128);
    const roles = Array.isArray(auth?.roles)
        ? auth.roles.map((role) => sanitizeRequestContextValue(role, 128)).filter(Boolean)
        : [];

    return {
        sessionId: `${sessionPrefix}_${crypto.randomUUID()}`,
        source,
        runtime,
        gatewayId,
        authMode,
        authSource,
        roles
    };
}

function injectSessionContext(request, session, options = {}) {
    return injectMcpContext(request, session.context, {
        requestIdPrefix: options.requestIdPrefix,
        signal: options.requestSignal instanceof AbortSignal ? options.requestSignal : null
    });
}

function checkRateLimit(session, timestamp = Date.now()) {
    return checkSlidingWindowRateLimit(session.rateLimit, timestamp);
}

function createMcpHttpServer(options = {}) {
    const stderr = options.stderr || process.stderr;
    const endpointPath = sanitizeRequestContextValue(options.path, 128) || DEFAULT_ENDPOINT_PATH;
    const sseEndpointPath = sanitizeRequestContextValue(options.ssePath, 128) || DEFAULT_SSE_ENDPOINT_PATH;
    const sseMessagesPath = sanitizeRequestContextValue(options.sseMessagesPath, 128) || DEFAULT_SSE_MESSAGES_PATH;
    const maxSessions = resolveConfiguredPositiveInteger(
        options.maxSessions,
        MAX_SESSIONS_ENV,
        DEFAULT_MAX_SESSIONS
    );
    const maxPayloadBytes = resolveConfiguredPositiveInteger(
        options.maxPayloadBytes,
        MAX_PAYLOAD_BYTES_ENV,
        DEFAULT_MAX_PAYLOAD_BYTES
    );
    const authTimeoutMs = resolveConfiguredPositiveInteger(
        options.authTimeoutMs,
        AUTH_TIMEOUT_MS_ENV,
        DEFAULT_AUTH_TIMEOUT_MS
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
    const sessionIdleMs = resolveConfiguredPositiveInteger(
        options.sessionIdleMs,
        SESSION_IDLE_MS_ENV,
        DEFAULT_SESSION_IDLE_MS
    );
    const discoveryMaxSessions = resolveConfiguredPositiveInteger(
        options.discoveryMaxSessions,
        DISCOVERY_MAX_SESSIONS_ENV,
        DEFAULT_DISCOVERY_MAX_SESSIONS
    );
    const discoverySessionTtlMs = resolveConfiguredPositiveInteger(
        options.discoverySessionTtlMs,
        DISCOVERY_SESSION_TTL_MS_ENV,
        DEFAULT_DISCOVERY_SESSION_TTL_MS
    );
    const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs) && options.heartbeatIntervalMs > 0
        ? options.heartbeatIntervalMs
        : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const backpressureTimeoutMs = Number.isFinite(options.backpressureTimeoutMs) && options.backpressureTimeoutMs > 0
        ? options.backpressureTimeoutMs
        : DEFAULT_SSE_BACKPRESSURE_TIMEOUT_MS;
    const initializeRuntime = options.initializeRuntime || initializeBackendProxyMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownBackendProxyMcpRuntime;
    const resolveAuth = options.resolveAuth || resolveDedicatedGatewayAuth;
    const rawBodyParser = express.raw({
        type: '*/*',
        limit: maxPayloadBytes
    });
    const router = express.Router();
    let attachedApp = null;
    let runtimeContext = null;
    let runtimePromise = null;
    let ownsRuntime = false;
    let closePromise = null;
    const sseStreams = createSseStreamController({
        heartbeatIntervalMs,
        backpressureTimeoutMs,
        messagesPath: sseMessagesPath,
        logError: (error) => logTransportError('[MCPTransport] HTTP stream write failed', error)
    });
    const sessionStore = createSessionStore({
        normalizeId: (value) => sanitizeRequestContextValue(value, 256),
        standardIdleMs: sessionIdleMs,
        discoveryTtlMs: discoverySessionTtlMs,
        discoveryMaxSessions,
        async onDestroy(session, reason) {
            abortInFlight(session, reason);
            sseStreams.close(session, reason);
            await Promise.resolve(session.streamQueue).catch(() => {});
        }
    });

    function writeStderr(message) {
        if (!stderr || typeof stderr.write !== 'function') {
            return;
        }
        stderr.write(`${message}\n`);
    }

    function logTransportError(message, error) {
        const details = error && error.message ? error.message : String(error || 'Unknown error');
        writeStderr(`${message}: ${details}`);
    }

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
                        throw new Error('MCP HTTP transport requires a harness with handleRequest(request).');
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

    function abortInFlight(session, reason = 'session_closed') {
        for (const controller of session.inflightControllers) {
            try { controller.abort(new Error(reason)); } catch (_error) { controller.abort(); }
        }
    }

    const findSession = sessionStore.find;
    const touchSession = sessionStore.touch;
    const destroySession = sessionStore.destroy;

    function registerInFlight(session, controller) {
        session.inflightControllers.add(controller);
        const cleanup = () => {
            session.inflightControllers.delete(controller);
        };
        controller.signal.addEventListener('abort', cleanup, { once: true });
        return cleanup;
    }

    const queueStreamFrame = sseStreams.queue;
    function openEventStream(req, res, session, streamOptions = {}) {
        return sseStreams.open(req, res, session, { ...streamOptions, touch: touchSession });
    }

    function createSession(auth, profile = {}) {
        const context = createSessionContext(auth, options, profile);
        const session = {
            cleanedUp: false,
            kind: profile.kind === 'discovery' ? 'discovery' : 'standard',
            context,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            rateLimit: createSlidingWindowRateLimit({ limit: rateLimitMessages, windowMs: rateLimitWindowMs }),
            inflightControllers: new Set(),
            activeStream: null,
            streamQueue: Promise.resolve(),
            idleTimer: null
        };
        return session.kind === 'discovery' ? session : sessionStore.add(session);
    }

    async function createDiscoverySession(auth, profile = {}) {
        const session = createSession(auth, { ...profile, kind: 'discovery' });
        return sessionStore.addDiscovery(session);
    }

    async function resolveRequestAuth(req, requestId = null) {
        let timeout = null;
        let cleanupAbortListeners = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                const error = new Error('HTTP MCP auth timed out');
                error.code = 'AUTH_TIMEOUT';
                reject(error);
            }, authTimeoutMs);
            if (typeof timeout.unref === 'function') {
                timeout.unref();
            }
        });
        const abortPromise = new Promise((_, reject) => {
            const rejectOnAbort = () => {
                const error = new Error('HTTP request aborted');
                error.code = 'REQUEST_ABORTED';
                reject(error);
            };
            req.once('aborted', rejectOnAbort);
            cleanupAbortListeners = () => {
                req.off('aborted', rejectOnAbort);
            };
        });

        try {
            const auth = await Promise.race([
                Promise.resolve(resolveAuth({
                    headers: req.headers,
                    pluginManager: options.pluginManager
                })),
                timeoutPromise,
                abortPromise
            ]);

            if (!auth || !auth.provided || !auth.authenticated) {
                return {
                    ok: false,
                    statusCode: 401,
                    payload: createUnauthorizedErrorResponse(requestId, sanitizeRequestContextValue(auth?.authSource, 128))
                };
            }

            return { ok: true, auth };
        } catch (error) {
            if (error?.code === 'AUTH_TIMEOUT') {
                return {
                    ok: false,
                    statusCode: 504,
                    payload: createTimeoutErrorResponse(requestId)
                };
            }
            if (error?.code === 'REQUEST_ABORTED') {
                return {
                    ok: false,
                    statusCode: 504,
                    payload: createTimeoutErrorResponse(requestId, 'request_aborted')
                };
            }
            throw error;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
            if (typeof cleanupAbortListeners === 'function') {
                cleanupAbortListeners();
            }
        }
    }

    function ensureSessionOwnership(session, auth, requestId = null) {
        if (!session) {
            return createSessionErrorResponse(requestId, 'unknown_session');
        }

        if (
            session.context.gatewayId
            && sanitizeRequestContextValue(auth?.gatewayId, 256)
            && session.context.gatewayId !== sanitizeRequestContextValue(auth.gatewayId, 256)
        ) {
            return createTransportErrorResponse(requestId, 'HTTP MCP session ownership mismatch', {
                canonicalCode: AGW_ERROR_CODES.FORBIDDEN,
                gatewayCode: AGW_ERROR_CODES.FORBIDDEN,
                reason: 'session_owner_mismatch'
            });
        }

        return null;
    }

    async function dispatchRequest(req, res, request, session, dispatchOptions = {}) {
        const expectsResponse = hasOwn(request, 'id');
        const requestId = expectsResponse ? request.id : null;

        if (!dispatchOptions.skipRateLimit) {
            const rateLimitResult = checkRateLimit(session);
            if (!rateLimitResult.allowed) {
                writeJsonRpcResponse(res, 429, createRateLimitErrorResponse(requestId, rateLimitResult));
                return;
            }
        }

        const abortController = new AbortController();
        const removeInFlight = registerInFlight(session, abortController);
        const abortRequest = () => {
            if (!abortController.signal.aborted) {
                abortController.abort(new Error('request_aborted'));
            }
        };

        req.once('aborted', abortRequest);
        req.once('close', abortRequest);

        touchSession(session);

        try {
            const harness = await resolveHarness();
            const requestWithContext = injectSessionContext(request, session, {
                ...options,
                requestSignal: abortController.signal
            });
            const response = await harness.handleRequest(requestWithContext);
            const initializeSucceeded = !dispatchOptions.isInitialize || isSuccessfulInitializeResponse(response);

            if (dispatchOptions.attachSessionHeader && initializeSucceeded) {
                res.setHeader('MCP-Session-Id', session.context.sessionId);
            }

            // Streamable HTTP notifications must acknowledge delivery without a JSON-RPC body.
            if (!expectsResponse) {
                if (dispatchOptions.destroySessionOnFailure && !initializeSucceeded) {
                    await destroySession(session, 'initialize_failed');
                }
                writeEmptyResponse(res, 202);
                return;
            }

            if (!response) {
                if (dispatchOptions.destroySessionOnFailure) {
                    await destroySession(session, 'initialize_failed');
                }
                writeEmptyResponse(res, 202);
                return;
            }

            if (dispatchOptions.streamOnly) {
                await queueStreamFrame(session, sseStreams.createSseFrame('message', response));
                writeEmptyResponse(res, 202);
                return;
            }

            if (session.activeStream && !dispatchOptions.isInitialize) {
                await queueStreamFrame(session, sseStreams.createSseFrame('message', response));
            }

            writeJsonRpcResponse(res, 200, response, dispatchOptions.attachSessionHeader && initializeSucceeded
                ? { 'MCP-Session-Id': session.context.sessionId }
                : {});

            if (!initializeSucceeded && dispatchOptions.destroySessionOnFailure) {
                await destroySession(session, 'initialize_failed');
            }
        } catch (error) {
            logTransportError('[MCPTransport] HTTP request handling failed', error);
            writeJsonRpcResponse(res, 500, createTransportErrorResponse(requestId, 'Internal error', {
                canonicalCode: AGW_ERROR_CODES.INTERNAL_ERROR,
                gatewayCode: AGW_ERROR_CODES.INTERNAL_ERROR
            }), dispatchOptions.attachSessionHeader && !dispatchOptions.destroySessionOnFailure
                ? { 'MCP-Session-Id': session.context.sessionId }
                : {});
            if (dispatchOptions.destroySessionOnFailure) {
                await destroySession(session, 'initialize_failed');
            }
        } finally {
            removeInFlight();
            req.off('aborted', abortRequest);
            req.off('close', abortRequest);
        }
    }

    async function handleCanonicalPost(req, res) {
        const parsed = parseRawJsonRequest(req.body);
        if (parsed.error) {
            writeJsonRpcResponse(res, parsed.error.error?.code === -32700 ? 400 : 422, parsed.error);
            return;
        }

        const request = parsed.request;
        const requestId = hasOwn(request, 'id') ? request.id : null;
        const authResult = await resolveRequestAuth(req, requestId);
        if (!authResult.ok) {
            writeJsonRpcResponse(res, authResult.statusCode || 401, authResult.payload);
            return;
        }

        const isInitialize = request.method === 'initialize';
        const isDiscoveryRequest = isSelfHealingDiscoveryMethod(request.method);
        const providedSessionId = sanitizeRequestContextValue(req.get(MCP_SESSION_HEADER), 256);

        if (isInitialize) {
            if (sessionStore.standardSize >= maxSessions) {
                writeJsonRpcResponse(res, 503, createSessionLimitErrorResponse(requestId, maxSessions));
                return;
            }

            const session = createSession(authResult.auth, {
                source: DEFAULT_SOURCE,
                runtime: DEFAULT_RUNTIME
            });
            await dispatchRequest(req, res, request, session, {
                attachSessionHeader: true,
                isInitialize: true,
                skipRateLimit: true,
                destroySessionOnFailure: true
            });
            return;
        }

        if (!providedSessionId) {
            if (isDiscoveryRequest) {
                const session = await createDiscoverySession(authResult.auth, {
                    source: DEFAULT_SOURCE,
                    runtime: DEFAULT_RUNTIME
                });
                await dispatchRequest(req, res, request, session, {
                    attachSessionHeader: true,
                    isInitialize: false
                });
                return;
            }
            writeJsonRpcResponse(res, 400, createSessionErrorResponse(requestId, 'missing_session_header'));
            return;
        }

        let session = findSession(providedSessionId);
        const ownershipError = ensureSessionOwnership(session, authResult.auth, requestId);
        if (ownershipError) {
            if (!session && isDiscoveryRequest) {
                session = await createDiscoverySession(authResult.auth, {
                    source: DEFAULT_SOURCE,
                    runtime: DEFAULT_RUNTIME
                });
            } else {
                writeJsonRpcResponse(res, session ? 403 : 404, ownershipError);
                return;
            }
        }

        await dispatchRequest(req, res, request, session, {
            attachSessionHeader: true,
            isInitialize: false
        });
    }

    async function handleCanonicalGet(req, res) {
        const authResult = await resolveRequestAuth(req);
        if (!authResult.ok) {
            writeJsonRpcResponse(res, authResult.statusCode || 401, authResult.payload);
            return;
        }

        const providedSessionId = sanitizeRequestContextValue(req.get(MCP_SESSION_HEADER), 256);
        if (!providedSessionId) {
            if (requestAcceptsEventStream(req)) {
                // Codex probes canonical GET /mcp as an SSE capability check before a session exists.
                writeEmptyResponse(res, 405, {
                    Allow: 'POST, GET, DELETE'
                });
                return;
            }
            writeJsonRpcResponse(res, 400, createSessionErrorResponse(null, 'missing_session_header'));
            return;
        }

        const session = findSession(providedSessionId);
        const ownershipError = ensureSessionOwnership(session, authResult.auth);
        if (ownershipError) {
            writeJsonRpcResponse(res, session ? 403 : 404, ownershipError);
            return;
        }

        openEventStream(req, res, session);
    }

    async function handleCanonicalDelete(req, res) {
        const authResult = await resolveRequestAuth(req);
        if (!authResult.ok) {
            writeJsonRpcResponse(res, authResult.statusCode || 401, authResult.payload);
            return;
        }

        const providedSessionId = sanitizeRequestContextValue(req.get(MCP_SESSION_HEADER), 256);
        if (!providedSessionId) {
            writeJsonRpcResponse(res, 400, createSessionErrorResponse(null, 'missing_session_header'));
            return;
        }

        const session = findSession(providedSessionId);
        const ownershipError = ensureSessionOwnership(session, authResult.auth);
        if (ownershipError) {
            writeJsonRpcResponse(res, session ? 403 : 404, ownershipError);
            return;
        }

        await destroySession(session, 'session_deleted');
        res.status(204).end();
    }

    async function handleCompatSseGet(req, res) {
        const authResult = await resolveRequestAuth(req);
        if (!authResult.ok) {
            writeJsonRpcResponse(res, authResult.statusCode || 401, authResult.payload);
            return;
        }

        if (sessionStore.standardSize >= maxSessions) {
            writeJsonRpcResponse(res, 503, createSessionLimitErrorResponse(null, maxSessions));
            return;
        }

        const session = createSession(authResult.auth, {
            source: DEFAULT_SSE_SOURCE,
            runtime: DEFAULT_SSE_RUNTIME
        });
        openEventStream(req, res, session, { compatibility: true });
    }

    async function handleCompatSsePost(req, res) {
        const parsed = parseRawJsonRequest(req.body);
        if (parsed.error) {
            writeJsonRpcResponse(res, parsed.error.error?.code === -32700 ? 400 : 422, parsed.error);
            return;
        }

        const request = parsed.request;
        const requestId = hasOwn(request, 'id') ? request.id : null;
        const authResult = await resolveRequestAuth(req, requestId);
        if (!authResult.ok) {
            writeJsonRpcResponse(res, authResult.statusCode || 401, authResult.payload);
            return;
        }

        const providedSessionId = sanitizeRequestContextValue(req.get(MCP_SESSION_HEADER), 256);
        if (!providedSessionId) {
            writeJsonRpcResponse(res, 400, createSessionErrorResponse(requestId, 'missing_session_header'));
            return;
        }

        const session = findSession(providedSessionId);
        const ownershipError = ensureSessionOwnership(session, authResult.auth, requestId);
        if (ownershipError) {
            writeJsonRpcResponse(res, session ? 403 : 404, ownershipError);
            return;
        }

        await dispatchRequest(req, res, request, session, {
            attachSessionHeader: true,
            isInitialize: request.method === 'initialize',
            streamOnly: true
        });
    }

    function attach(app) {
        if (!app || typeof app.use !== 'function') {
            throw new Error('createMcpHttpServer.attach(app) requires an Express app instance.');
        }

        if (attachedApp === app) {
            return;
        }

        attachedApp = app;

        router.post(endpointPath, rawBodyParser, (req, res, next) => {
            Promise.resolve(handleCanonicalPost(req, res)).catch(next);
        });
        router.get(endpointPath, (req, res, next) => {
            Promise.resolve(handleCanonicalGet(req, res)).catch(next);
        });
        router.delete(endpointPath, (req, res, next) => {
            Promise.resolve(handleCanonicalDelete(req, res)).catch(next);
        });
        router.get(sseEndpointPath, (req, res, next) => {
            Promise.resolve(handleCompatSseGet(req, res)).catch(next);
        });
        router.post(sseMessagesPath, rawBodyParser, (req, res, next) => {
            Promise.resolve(handleCompatSsePost(req, res)).catch(next);
        });
        router.use((error, _req, res, next) => {
            if (error && error.type === 'entity.too.large') {
                writeJsonRpcResponse(res, 413, createPayloadTooLargeErrorResponse());
                return;
            }

            if (error) {
                logTransportError('[MCPTransport] HTTP route failure', error);
                writeJsonRpcResponse(res, 500, createTransportErrorResponse(null, 'Internal error', {
                    canonicalCode: AGW_ERROR_CODES.INTERNAL_ERROR,
                    gatewayCode: AGW_ERROR_CODES.INTERNAL_ERROR
                }));
                return;
            }

            next();
        });

        app.use(router);
    }

    async function close() {
        if (closePromise) {
            return closePromise;
        }

        closePromise = (async () => {
            await sessionStore.closeAll('server_close');

            const injectedRuntime = options.backendClient || options.backendUrl || options.initializeRuntime;
            if (ownsRuntime && (options.shutdownOnClose === true || typeof options.shutdownRuntime === 'function' || injectedRuntime)) {
                try {
                    await shutdownRuntime();
                } catch (error) {
                    logTransportError('[MCPTransport] HTTP shutdown failed', error);
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
        getSessionCount() {
            return sessionStore.totalSize;
        },
        getStandardSessionCount() {
            return sessionStore.standardSize;
        },
        getDiscoverySessionCount() {
            return sessionStore.discoverySize;
        },
        getPaths() {
            return {
                endpointPath,
                sseEndpointPath,
                sseMessagesPath
            };
        }
    };
}

module.exports = {
    MCP_SESSION_HEADER,
    createMcpHttpServer
};
