'use strict';

const crypto = require('node:crypto');
const { once } = require('node:events');
const express = require('express');

const {
    AGW_ERROR_CODES
} = require('./contracts/errorCodes');
const { normalizeRequestContext, sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const {
    createJsonRpcErrorResponse,
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('./mcpStdioServer');

const DEFAULT_ENDPOINT_PATH = '/mcp';
const DEFAULT_SSE_ENDPOINT_PATH = '/mcp/sse';
const DEFAULT_SSE_MESSAGES_PATH = '/mcp/sse/messages';
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_AUTH_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_MESSAGES = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 1000;
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;
const MAX_SESSIONS_ENV = 'VCP_MCP_HTTP_MAX_SESSIONS';
const MAX_PAYLOAD_BYTES_ENV = 'VCP_MCP_HTTP_MAX_PAYLOAD_BYTES';
const AUTH_TIMEOUT_MS_ENV = 'VCP_MCP_HTTP_AUTH_TIMEOUT_MS';
const RATE_LIMIT_MESSAGES_ENV = 'VCP_MCP_HTTP_RATE_LIMIT_MESSAGES';
const RATE_LIMIT_WINDOW_MS_ENV = 'VCP_MCP_HTTP_RATE_LIMIT_WINDOW_MS';
const SESSION_IDLE_MS_ENV = 'VCP_MCP_HTTP_SESSION_IDLE_MS';
const MCP_SESSION_HEADER = 'mcp-session-id';
const DEFAULT_SOURCE = 'agent-gateway-mcp-http';
const DEFAULT_RUNTIME = 'mcp-http';
const DEFAULT_SSE_SOURCE = 'agent-gateway-mcp-http-sse';
const DEFAULT_SSE_RUNTIME = 'mcp-http-sse';
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

function resolveConfiguredPositiveInteger(optionValue, envName, fallbackValue) {
    return resolvePositiveInteger(optionValue)
        || resolvePositiveInteger(process.env[envName])
        || fallbackValue;
}

function createTransportErrorResponse(id, message, data = {}) {
    return createJsonRpcErrorResponse(id, JSON_RPC_SERVER_ERROR_CODE, message, data);
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

function createInvalidRequestError(id, data = {}) {
    return createJsonRpcErrorResponse(id, -32600, 'Invalid request', data);
}

function createParseErrorResponse(details) {
    return createJsonRpcErrorResponse(null, -32700, 'Parse error', details ? { details } : undefined);
}

function createUnauthorizedErrorResponse(id, authSource = '') {
    return createTransportErrorResponse(id, 'Unauthorized', {
        canonicalCode: AGW_ERROR_CODES.UNAUTHORIZED,
        gatewayCode: AGW_ERROR_CODES.UNAUTHORIZED,
        authSource
    });
}

function createSessionErrorResponse(id, reason, details = {}) {
    return createTransportErrorResponse(id, 'HTTP MCP session is invalid', {
        canonicalCode: AGW_ERROR_CODES.INVALID_REQUEST,
        gatewayCode: AGW_ERROR_CODES.INVALID_REQUEST,
        reason,
        ...details
    });
}

function createRateLimitErrorResponse(id, rateLimit) {
    return createTransportErrorResponse(id, 'Request rate limit exceeded for this HTTP MCP session', {
        canonicalCode: AGW_ERROR_CODES.RATE_LIMITED,
        gatewayCode: AGW_ERROR_CODES.RATE_LIMITED,
        reason: 'rate_limited',
        retryAfterMs: rateLimit.retryAfterMs,
        limit: rateLimit.limit,
        windowMs: rateLimit.windowMs,
        rejectionCategory: 'rate_limit',
        retryable: true
    });
}

function createPayloadTooLargeErrorResponse() {
    return createTransportErrorResponse(null, 'Payload too large', {
        canonicalCode: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
        gatewayCode: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
        reason: 'payload_too_large'
    });
}

function createTimeoutErrorResponse(id, reason = 'auth_timeout') {
    return createTransportErrorResponse(id, 'HTTP MCP request timed out', {
        canonicalCode: AGW_ERROR_CODES.TIMEOUT,
        gatewayCode: AGW_ERROR_CODES.TIMEOUT,
        reason
    });
}

function createSessionLimitErrorResponse(id, limit) {
    return createTransportErrorResponse(id, 'HTTP MCP session limit reached', {
        canonicalCode: AGW_ERROR_CODES.CONCURRENCY_LIMITED,
        gatewayCode: AGW_ERROR_CODES.CONCURRENCY_LIMITED,
        reason: 'session_limit_reached',
        limit
    });
}

function createSseFrame(eventType, payload) {
    return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function createHeartbeatFrame() {
    return `: heartbeat ${Date.now()}\n\n`;
}

function parseRawJsonRequest(rawBody) {
    const source = Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8')
        : String(rawBody || '');
    const trimmed = source.trim();

    if (!trimmed) {
        return {
            error: createInvalidRequestError(null, {
                field: 'request',
                reason: 'empty_body'
            })
        };
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return {
                error: createInvalidRequestError(null, {
                    field: 'request',
                    reason: 'batch_not_supported'
                })
            };
        }
        if (!isPlainObject(parsed)) {
            return {
                error: createInvalidRequestError(null, {
                    field: 'request'
                })
            };
        }
        return {
            request: parsed
        };
    } catch (error) {
        return {
            error: createParseErrorResponse(error.message)
        };
    }
}

function writeJsonRpcResponse(res, statusCode, payload, extraHeaders = {}) {
    if (res.headersSent || res.writableEnded) {
        return;
    }

    Object.entries(extraHeaders).forEach(([headerName, headerValue]) => {
        if (headerValue === undefined || headerValue === null || headerValue === '') {
            return;
        }
        res.setHeader(headerName, headerValue);
    });

    res.status(statusCode).type('application/json').send(JSON.stringify(payload));
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
    const requestObject = isPlainObject(request) ? request : {};
    const params = isPlainObject(requestObject.params) ? { ...requestObject.params } : {};
    const clientRequestContext = isPlainObject(params.requestContext) ? params.requestContext : {};
    const requestIdPrefix = sanitizeRequestContextValue(options.requestIdPrefix, 16) || 'agwmcp';
    const topLevelAgentId = sanitizeRequestContextValue(params.agentId, 256);
    const requestSignal = options.requestSignal instanceof AbortSignal ? options.requestSignal : null;

    const normalizedRequestContext = normalizeRequestContext({
        requestId: clientRequestContext.requestId,
        agentId: clientRequestContext.agentId || topLevelAgentId,
        source: clientRequestContext.source || session.context.source,
        runtime: clientRequestContext.runtime || session.context.runtime,
        sessionId: session.context.sessionId
    }, {
        defaultSource: session.context.source,
        defaultRuntime: session.context.runtime,
        requestIdPrefix
    });

    return {
        ...requestObject,
        params: {
            ...params,
            ...(topLevelAgentId || normalizedRequestContext.agentId
                ? { agentId: topLevelAgentId || normalizedRequestContext.agentId }
                : {}),
            // The HTTP transport owns session identity and injects it for every follow-up call.
            sessionId: session.context.sessionId,
            // AbortSignal stays request-scoped so concurrent calls on one session do not share cancellation state.
            signal: requestSignal,
            requestContext: {
                ...normalizedRequestContext,
                ...(session.context.gatewayId ? { gatewayId: session.context.gatewayId } : {})
            },
            authContext: {
                ...(session.context.gatewayId ? { gatewayId: session.context.gatewayId } : {}),
                sessionId: session.context.sessionId,
                ...(session.context.authMode ? { authMode: session.context.authMode } : {}),
                ...(session.context.authSource ? { authSource: session.context.authSource } : {}),
                ...(session.context.roles.length > 0 ? { roles: [...session.context.roles] } : {})
            }
        }
    };
}

function checkRateLimit(session, timestamp = Date.now()) {
    const rateLimit = session.rateLimit;
    if (!rateLimit || rateLimit.limit <= 0 || rateLimit.windowMs <= 0) {
        return { allowed: true };
    }

    const cutoff = timestamp - rateLimit.windowMs;
    rateLimit.timestamps = rateLimit.timestamps.filter((entry) => entry > cutoff);

    if (rateLimit.timestamps.length >= rateLimit.limit) {
        return {
            allowed: false,
            retryAfterMs: Math.max(0, rateLimit.timestamps[0] + rateLimit.windowMs - timestamp),
            limit: rateLimit.limit,
            windowMs: rateLimit.windowMs
        };
    }

    rateLimit.timestamps.push(timestamp);
    return { allowed: true };
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
    const heartbeatIntervalMs = Number.isFinite(options.heartbeatIntervalMs) && options.heartbeatIntervalMs > 0
        ? options.heartbeatIntervalMs
        : DEFAULT_HEARTBEAT_INTERVAL_MS;
    const initializeRuntime = options.initializeRuntime || initializeBackendProxyMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownBackendProxyMcpRuntime;
    const resolveAuth = options.resolveAuth || resolveDedicatedGatewayAuth;
    const rawBodyParser = express.raw({
        type: '*/*',
        limit: maxPayloadBytes
    });
    const router = express.Router();
    const sessions = new Map();
    let attachedApp = null;
    let runtimeContext = null;
    let runtimePromise = null;
    let ownsRuntime = false;
    let closePromise = null;

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

    function findSession(sessionId) {
        const normalizedSessionId = sanitizeRequestContextValue(sessionId, 256);
        return normalizedSessionId ? sessions.get(normalizedSessionId) || null : null;
    }

    function clearIdleTimer(session) {
        if (!session.idleTimer) {
            return;
        }
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
    }

    function closeActiveStream(session, reason = 'stream_closed') {
        const stream = session.activeStream;
        if (!stream) {
            return;
        }

        session.activeStream = null;
        stream.closed = true;

        if (stream.heartbeatTimer) {
            clearInterval(stream.heartbeatTimer);
            stream.heartbeatTimer = null;
        }

        if (stream.cleanup) {
            stream.cleanup();
            stream.cleanup = null;
        }

        if (!stream.res.writableEnded && !stream.res.destroyed) {
            try {
                if (reason === 'session_deleted') {
                    stream.res.write(createSseFrame('endpoint_removed', {
                        sessionId: session.context.sessionId
                    }));
                }
                stream.res.end();
            } catch (_error) {
                // Ignore socket races during cleanup.
            }
        }
    }

    function abortInFlight(session, reason = 'session_closed') {
        for (const controller of session.inflightControllers) {
            try {
                controller.abort(new Error(reason));
            } catch (_error) {
                controller.abort();
            }
        }
    }

    function scheduleIdleExpiry(session) {
        clearIdleTimer(session);
        session.idleTimer = setTimeout(() => {
            void destroySession(session, 'idle_expired');
        }, sessionIdleMs);
        if (typeof session.idleTimer.unref === 'function') {
            session.idleTimer.unref();
        }
    }

    function touchSession(session) {
        session.lastActivityAt = Date.now();
        scheduleIdleExpiry(session);
    }

    async function destroySession(session, reason = 'session_deleted') {
        if (!session || session.cleanedUp) {
            return;
        }

        session.cleanedUp = true;
        sessions.delete(session.context.sessionId);
        clearIdleTimer(session);
        abortInFlight(session, reason);
        closeActiveStream(session, reason);
        await Promise.resolve(session.streamQueue).catch(() => {});
    }

    function registerInFlight(session, controller) {
        session.inflightControllers.add(controller);
        const cleanup = () => {
            session.inflightControllers.delete(controller);
        };
        controller.signal.addEventListener('abort', cleanup, { once: true });
        return cleanup;
    }

    async function queueStreamFrame(session, frame, { allowDrop = false } = {}) {
        const stream = session.activeStream;
        if (!stream || stream.closed || !frame) {
            return false;
        }

        if (allowDrop && (stream.writing || stream.res.writableNeedDrain)) {
            return false;
        }

        stream.queue = stream.queue
            .then(async () => {
                if (stream.closed || stream.res.writableEnded || stream.res.destroyed) {
                    return;
                }

                stream.writing = true;

                if (allowDrop && stream.res.writableNeedDrain) {
                    return;
                }

                const wrote = stream.res.write(frame);
                if (typeof stream.res.flush === 'function') {
                    stream.res.flush();
                }

                if (!wrote && !allowDrop) {
                    await once(stream.res, 'drain');
                }
            })
            .catch((error) => {
                logTransportError('[MCPTransport] HTTP stream write failed', error);
                closeActiveStream(session, 'stream_write_failed');
            })
            .finally(() => {
                stream.writing = false;
            });

        session.streamQueue = stream.queue;
        return true;
    }

    function beginHeartbeat(session) {
        const stream = session.activeStream;
        if (!stream) {
            return;
        }

        stream.heartbeatTimer = setInterval(() => {
            if (!session.activeStream || stream.closed) {
                return;
            }
            void queueStreamFrame(session, createHeartbeatFrame(), { allowDrop: true });
        }, heartbeatIntervalMs);

        if (typeof stream.heartbeatTimer.unref === 'function') {
            stream.heartbeatTimer.unref();
        }
    }

    function openEventStream(req, res, session, streamOptions = {}) {
        closeActiveStream(session, 'stream_replaced');

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('MCP-Session-Id', session.context.sessionId);
        if (typeof res.flushHeaders === 'function') {
            res.flushHeaders();
        }

        const stream = {
            req,
            res,
            queue: Promise.resolve(),
            writing: false,
            closed: false,
            heartbeatTimer: null,
            cleanup: null
        };
        session.activeStream = stream;
        session.streamQueue = stream.queue;
        touchSession(session);

        const handleClose = () => {
            if (session.activeStream === stream) {
                closeActiveStream(session, 'client_closed_stream');
            }
        };

        req.on('close', handleClose);
        req.on('aborted', handleClose);
        res.on('close', handleClose);
        stream.cleanup = () => {
            req.off('close', handleClose);
            req.off('aborted', handleClose);
            res.off('close', handleClose);
        };

        if (streamOptions.compatibility) {
            void queueStreamFrame(session, createSseFrame('endpoint', {
                endpoint: sseMessagesPath,
                sessionId: session.context.sessionId,
                deprecated: true
            }));
        } else {
            void queueStreamFrame(session, createHeartbeatFrame(), { allowDrop: false });
        }

        beginHeartbeat(session);
    }

    function createSession(auth, profile = {}) {
        const context = createSessionContext(auth, options, profile);
        const session = {
            cleanedUp: false,
            context,
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            rateLimit: {
                limit: rateLimitMessages,
                windowMs: rateLimitWindowMs,
                timestamps: []
            },
            inflightControllers: new Set(),
            activeStream: null,
            streamQueue: Promise.resolve(),
            idleTimer: null
        };
        sessions.set(context.sessionId, session);
        scheduleIdleExpiry(session);
        return session;
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

            if (!response) {
                if (dispatchOptions.destroySessionOnFailure) {
                    await destroySession(session, 'initialize_failed');
                }
                res.status(202).end();
                return;
            }

            if (dispatchOptions.streamOnly) {
                await queueStreamFrame(session, createSseFrame('message', response));
                res.status(202).end();
                return;
            }

            if (session.activeStream && !dispatchOptions.isInitialize) {
                await queueStreamFrame(session, createSseFrame('message', response));
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
        const providedSessionId = sanitizeRequestContextValue(req.get(MCP_SESSION_HEADER), 256);

        if (isInitialize) {
            if (sessions.size >= maxSessions) {
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

        if (sessions.size >= maxSessions) {
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
            await Promise.all(Array.from(sessions.values(), (session) => destroySession(session, 'server_close')));

            if (ownsRuntime && options.shutdownOnClose !== false) {
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
            return sessions.size;
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
