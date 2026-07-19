'use strict';

const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { sanitizeRequestContextValue } = require('../../contracts/requestContext');
const { checkSlidingWindowRateLimit, createSlidingWindowRateLimit, injectMcpContext } = require('../shared');
const { createSessionStore } = require('./sessionStore');
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
} = require('./httpJsonRpc');
const { createSseStreamController } = require('./sseStream');

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

// Matches ids minted by createSessionContext: `${sanitizedPrefix}_${crypto.randomUUID()}`.
// Resurrection only accepts this shape so clients cannot pin arbitrary session ids.
const RESURRECTABLE_SESSION_ID_PATTERN =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isSuccessfulInitializeResponse(response) {
    return Boolean(response && typeof response === 'object' && !response.error &&
        response.result && typeof response.result === 'object');
}

class HttpServerRuntime {
    constructor(config) {
        Object.assign(this, config, { attachedApp: null, runtimeContext: null, runtimePromise: null,
            ownsRuntime: false, closePromise: null });
        this.sseStreams = createSseStreamController({
            heartbeatIntervalMs: config.heartbeatIntervalMs,
            backpressureTimeoutMs: config.backpressureTimeoutMs,
            messagesPath: config.sseMessagesPath,
            logError: (error) => this.logError('[MCPTransport] HTTP stream write failed', error)
        });
        this.sessionStore = createSessionStore({
            normalizeId: (value) => sanitizeRequestContextValue(value, 256),
            standardIdleMs: config.sessionIdleMs,
            discoveryTtlMs: config.discoverySessionTtlMs,
            discoveryMaxSessions: config.discoveryMaxSessions,
            onDestroy: (session, reason) => this.destroySessionResources(session, reason)
        });
    }

    logError(message, error) {
        if (!this.stderr?.write) return;
        const details = error?.message || String(error || 'Unknown error');
        this.stderr.write(`${message}: ${details}\n`);
    }

    async resolveHarness() {
        if (this.options.harness?.handleRequest) return this.options.harness;
        if (this.runtimeContext?.harness?.handleRequest) return this.runtimeContext.harness;
        if (!this.runtimePromise) {
            this.runtimePromise = Promise.resolve(this.initializeRuntime(this.options)).then((context) => {
                this.runtimeContext = context || null;
                if (!this.runtimeContext?.harness?.handleRequest) {
                    throw new Error('MCP HTTP transport requires a harness with handleRequest(request).');
                }
                this.ownsRuntime = true;
                return this.runtimeContext;
            }).catch((error) => {
                this.runtimePromise = null;
                throw error;
            });
        }
        return (await this.runtimePromise).harness;
    }

    abortInFlight(session, reason = 'session_closed') {
        for (const controller of session.inflightControllers) {
            try { controller.abort(new Error(reason)); } catch (_error) { controller.abort(); }
        }
    }

    async destroySessionResources(session, reason) {
        this.abortInFlight(session, reason);
        this.sseStreams.close(session, reason);
        await Promise.resolve(session.streamQueue).catch(() => {});
    }

    registerInFlight(session, controller) {
        session.inflightControllers.add(controller);
        const cleanup = () => session.inflightControllers.delete(controller);
        controller.signal.addEventListener('abort', cleanup, { once: true });
        return cleanup;
    }

    createSession(auth, profile = {}) {
        const context = this.createSessionContext(auth, this.options, profile);
        if (profile.sessionId) context.sessionId = profile.sessionId;
        const session = { cleanedUp: false, kind: profile.kind === 'discovery' ? 'discovery' : 'standard',
            context, createdAt: Date.now(), lastActivityAt: Date.now(),
            rateLimit: createSlidingWindowRateLimit({ limit: this.rateLimitMessages,
                windowMs: this.rateLimitWindowMs }), inflightControllers: new Set(),
            activeStream: null, streamQueue: Promise.resolve(), idleTimer: null };
        return session.kind === 'discovery' ? session : this.sessionStore.add(session);
    }

    // Transparently rebuild a session whose id was lost to idle expiry, LRU eviction, or a
    // gateway restart. Auth is verified per request, and explicitly terminated sessions stay
    // dead via the store's tombstones, so this never widens access — it only removes the
    // client-visible "unknown_session" failure on long-running tasks.
    resurrectSession(providedId, auth, profile = {}) {
        if (!RESURRECTABLE_SESSION_ID_PATTERN.test(providedId)) return null;
        if (this.sessionStore.isTerminated(providedId)) return null;
        if (this.sessionStore.standardSize >= this.maxSessions) return null;
        return this.createSession(auth, { ...profile, sessionId: providedId });
    }

    async createDiscoverySession(auth, profile = {}) {
        return this.sessionStore.addDiscovery(this.createSession(auth, { ...profile, kind: 'discovery' }));
    }

    async resolveRequestAuth(req, requestId = null) {
        let timeout = null;
        let cleanup = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => { const error = new Error('HTTP MCP auth timed out');
                error.code = 'AUTH_TIMEOUT'; reject(error); }, this.authTimeoutMs);
            if (typeof timeout.unref === 'function') timeout.unref();
        });
        const abortPromise = new Promise((_, reject) => {
            const rejectOnAbort = () => { const error = new Error('HTTP request aborted');
                error.code = 'REQUEST_ABORTED'; reject(error); };
            req.once('aborted', rejectOnAbort);
            cleanup = () => req.off('aborted', rejectOnAbort);
        });
        try {
            const auth = await Promise.race([Promise.resolve(this.resolveAuth({ headers: req.headers,
                config: this.options.protocolConfig })), timeoutPromise, abortPromise]);
            if (!auth?.provided || !auth?.authenticated) {
                return { ok: false, statusCode: 401,
                    payload: createUnauthorizedErrorResponse(requestId,
                        sanitizeRequestContextValue(auth?.authSource, 128)) };
            }
            return { ok: true, auth };
        } catch (error) {
            if (error?.code === 'AUTH_TIMEOUT') {
                return { ok: false, statusCode: 504, payload: createTimeoutErrorResponse(requestId) };
            }
            if (error?.code === 'REQUEST_ABORTED') {
                return { ok: false, statusCode: 504,
                    payload: createTimeoutErrorResponse(requestId, 'request_aborted') };
            }
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
            if (cleanup) cleanup();
        }
    }

    ensureSessionOwnership(session, auth, requestId = null) {
        if (!session) return createSessionErrorResponse(requestId, 'unknown_session');
        const gatewayId = sanitizeRequestContextValue(auth?.gatewayId, 256);
        if (session.context.gatewayId && gatewayId && session.context.gatewayId !== gatewayId) {
            return createTransportErrorResponse(requestId, 'HTTP MCP session ownership mismatch', {
                canonicalCode: AGW_ERROR_CODES.FORBIDDEN, gatewayCode: AGW_ERROR_CODES.FORBIDDEN,
                reason: 'session_owner_mismatch' });
        }
        return null;
    }

    async dispatchRequest(req, res, request, session, options = {}) {
        const expectsResponse = hasOwn(request, 'id');
        const requestId = expectsResponse ? request.id : null;
        if (!options.skipRateLimit) {
            const rate = checkSlidingWindowRateLimit(session.rateLimit, Date.now());
            if (!rate.allowed) {
                writeJsonRpcResponse(res, 429, createRateLimitErrorResponse(requestId, rate));
                return;
            }
        }
        const controller = new AbortController();
        const removeInFlight = this.registerInFlight(session, controller);
        const abortRequest = () => {
            if (!controller.signal.aborted) controller.abort(new Error('request_aborted'));
        };
        req.once('aborted', abortRequest);
        req.once('close', abortRequest);
        this.sessionStore.touch(session);
        try {
            const harness = await this.resolveHarness();
            const withContext = injectMcpContext(request, session.context, {
                requestIdPrefix: this.options.requestIdPrefix, signal: controller.signal });
            const response = await harness.handleRequest(withContext);
            await this.writeDispatchResult(res, response, session, expectsResponse, options);
        } catch (error) {
            this.logError('[MCPTransport] HTTP request handling failed', error);
            writeJsonRpcResponse(res, 500, createTransportErrorResponse(requestId, 'Internal error', {
                canonicalCode: AGW_ERROR_CODES.INTERNAL_ERROR, gatewayCode: AGW_ERROR_CODES.INTERNAL_ERROR
            }), options.attachSessionHeader && !options.destroySessionOnFailure
                ? { 'MCP-Session-Id': session.context.sessionId } : {});
            if (options.destroySessionOnFailure) await this.sessionStore.destroy(session, 'initialize_failed');
        } finally {
            removeInFlight();
            req.off('aborted', abortRequest);
            req.off('close', abortRequest);
        }
    }

    async writeDispatchResult(res, response, session, expectsResponse, options) {
        const initialized = !options.isInitialize || isSuccessfulInitializeResponse(response);
        if (options.attachSessionHeader && initialized) res.setHeader('MCP-Session-Id', session.context.sessionId);
        if (!expectsResponse || !response) {
            if (options.destroySessionOnFailure && !initialized) {
                await this.sessionStore.destroy(session, 'initialize_failed');
            }
            writeEmptyResponse(res, 202);
            return;
        }
        if (options.streamOnly) {
            await this.sseStreams.queue(session, this.sseStreams.createSseFrame('message', response));
            writeEmptyResponse(res, 202);
            return;
        }
        if (session.activeStream && !options.isInitialize) {
            await this.sseStreams.queue(session, this.sseStreams.createSseFrame('message', response));
        }
        writeJsonRpcResponse(res, 200, response, options.attachSessionHeader && initialized
            ? { 'MCP-Session-Id': session.context.sessionId } : {});
        if (!initialized && options.destroySessionOnFailure) {
            await this.sessionStore.destroy(session, 'initialize_failed');
        }
    }

    async handleCanonicalPost(req, res) {
        const parsed = parseRawJsonRequest(req.body);
        if (parsed.error) {
            writeJsonRpcResponse(res, parsed.error.error?.code === -32700 ? 400 : 422, parsed.error);
            return;
        }
        const request = parsed.request;
        const requestId = hasOwn(request, 'id') ? request.id : null;
        const auth = await this.resolveRequestAuth(req, requestId);
        if (!auth.ok) {
            writeJsonRpcResponse(res, auth.statusCode || 401, auth.payload);
            return;
        }
        const isInitialize = request.method === 'initialize';
        const isDiscovery = this.isSelfHealingDiscoveryMethod(request.method);
        const providedId = sanitizeRequestContextValue(req.get(this.sessionHeader), 256);
        if (isInitialize) {
            if (this.sessionStore.standardSize >= this.maxSessions) {
                writeJsonRpcResponse(res, 503, createSessionLimitErrorResponse(requestId, this.maxSessions));
                return;
            }
            const session = this.createSession(auth.auth, { source: this.defaultSource, runtime: this.defaultRuntime });
            await this.dispatchRequest(req, res, request, session, { attachSessionHeader: true,
                isInitialize: true, skipRateLimit: true, destroySessionOnFailure: true });
            return;
        }
        if (!providedId) {
            if (isDiscovery) {
                const session = await this.createDiscoverySession(auth.auth,
                    { source: this.defaultSource, runtime: this.defaultRuntime });
                await this.dispatchRequest(req, res, request, session,
                    { attachSessionHeader: true, isInitialize: false });
                return;
            }
            writeJsonRpcResponse(res, 400, createSessionErrorResponse(requestId, 'missing_session_header'));
            return;
        }
        let session = this.sessionStore.find(providedId);
        if (!session) {
            session = this.resurrectSession(providedId, auth.auth,
                { source: this.defaultSource, runtime: this.defaultRuntime });
        }
        const ownershipError = this.ensureSessionOwnership(session, auth.auth, requestId);
        if (ownershipError) {
            if (!session && isDiscovery) {
                session = await this.createDiscoverySession(auth.auth,
                    { source: this.defaultSource, runtime: this.defaultRuntime });
            } else {
                writeJsonRpcResponse(res, session ? 403 : 404, ownershipError);
                return;
            }
        }
        await this.dispatchRequest(req, res, request, session, { attachSessionHeader: true, isInitialize: false });
    }

    async handleCanonicalGet(req, res) {
        const auth = await this.resolveRequestAuth(req);
        if (!auth.ok) return writeJsonRpcResponse(res, auth.statusCode || 401, auth.payload);
        const providedId = sanitizeRequestContextValue(req.get(this.sessionHeader), 256);
        if (!providedId) {
            if (requestAcceptsEventStream(req)) return writeEmptyResponse(res, 405, { Allow: 'POST, GET, DELETE' });
            return writeJsonRpcResponse(res, 400, createSessionErrorResponse(null, 'missing_session_header'));
        }
        const session = this.sessionStore.find(providedId)
            || this.resurrectSession(providedId, auth.auth,
                { source: this.defaultSource, runtime: this.defaultRuntime });
        const error = this.ensureSessionOwnership(session, auth.auth);
        if (error) return writeJsonRpcResponse(res, session ? 403 : 404, error);
        this.sseStreams.open(req, res, session, { touch: this.sessionStore.touch });
    }

    async handleCanonicalDelete(req, res) {
        const auth = await this.resolveRequestAuth(req);
        if (!auth.ok) return writeJsonRpcResponse(res, auth.statusCode || 401, auth.payload);
        const providedId = sanitizeRequestContextValue(req.get(this.sessionHeader), 256);
        if (!providedId) return writeJsonRpcResponse(res, 400,
            createSessionErrorResponse(null, 'missing_session_header'));
        const session = this.sessionStore.find(providedId);
        const error = this.ensureSessionOwnership(session, auth.auth);
        if (error) return writeJsonRpcResponse(res, session ? 403 : 404, error);
        await this.sessionStore.destroy(session, 'session_deleted');
        res.status(204).end();
    }

    async handleCompatSseGet(req, res) {
        const auth = await this.resolveRequestAuth(req);
        if (!auth.ok) return writeJsonRpcResponse(res, auth.statusCode || 401, auth.payload);
        if (this.sessionStore.standardSize >= this.maxSessions) {
            return writeJsonRpcResponse(res, 503, createSessionLimitErrorResponse(null, this.maxSessions));
        }
        const session = this.createSession(auth.auth,
            { source: this.defaultSseSource, runtime: this.defaultSseRuntime });
        this.sseStreams.open(req, res, session, { compatibility: true, touch: this.sessionStore.touch });
    }

    async handleCompatSsePost(req, res) {
        const parsed = parseRawJsonRequest(req.body);
        if (parsed.error) return writeJsonRpcResponse(res,
            parsed.error.error?.code === -32700 ? 400 : 422, parsed.error);
        const request = parsed.request;
        const requestId = hasOwn(request, 'id') ? request.id : null;
        const auth = await this.resolveRequestAuth(req, requestId);
        if (!auth.ok) return writeJsonRpcResponse(res, auth.statusCode || 401, auth.payload);
        const providedId = sanitizeRequestContextValue(req.get(this.sessionHeader), 256);
        if (!providedId) return writeJsonRpcResponse(res, 400,
            createSessionErrorResponse(requestId, 'missing_session_header'));
        const session = this.sessionStore.find(providedId);
        const error = this.ensureSessionOwnership(session, auth.auth, requestId);
        if (error) return writeJsonRpcResponse(res, session ? 403 : 404, error);
        await this.dispatchRequest(req, res, request, session, { attachSessionHeader: true,
            isInitialize: request.method === 'initialize', streamOnly: true });
    }

    attach(app) {
        if (!app?.use) throw new Error('createMcpHttpServer.attach(app) requires an Express app instance.');
        if (this.attachedApp === app) return;
        this.attachedApp = app;
        const forward = (handler) => (req, res, next) => Promise.resolve(handler.call(this, req, res)).catch(next);
        this.router.post(this.endpointPath, this.rawBodyParser, forward(this.handleCanonicalPost));
        this.router.get(this.endpointPath, forward(this.handleCanonicalGet));
        this.router.delete(this.endpointPath, forward(this.handleCanonicalDelete));
        this.router.get(this.sseEndpointPath, forward(this.handleCompatSseGet));
        this.router.post(this.sseMessagesPath, this.rawBodyParser, forward(this.handleCompatSsePost));
        this.router.use((error, _req, res, next) => this.handleRouteError(error, res, next));
        app.use(this.router);
    }

    handleRouteError(error, res, next) {
        if (error?.type === 'entity.too.large') {
            writeJsonRpcResponse(res, 413, createPayloadTooLargeErrorResponse());
            return;
        }
        if (error) {
            this.logError('[MCPTransport] HTTP route failure', error);
            writeJsonRpcResponse(res, 500, createTransportErrorResponse(null, 'Internal error', {
                canonicalCode: AGW_ERROR_CODES.INTERNAL_ERROR, gatewayCode: AGW_ERROR_CODES.INTERNAL_ERROR }));
            return;
        }
        next();
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        this.closePromise = (async () => {
            await this.sessionStore.closeAll('server_close');
            const options = this.options;
            const injected = options.backendClient || options.backendUrl || options.initializeRuntime;
            if (this.ownsRuntime && (options.shutdownOnClose === true ||
                typeof options.shutdownRuntime === 'function' || injected)) {
                try { await this.shutdownRuntime(); } catch (error) {
                    this.logError('[MCPTransport] HTTP shutdown failed', error);
                }
            }
            this.runtimeContext = null;
            this.runtimePromise = null;
            this.ownsRuntime = false;
        })();
        return this.closePromise;
    }

    api() {
        return { attach: (app) => this.attach(app), initialize: (app) => this.attach(app),
            close: () => this.close(), getSessionCount: () => this.sessionStore.totalSize,
            getStandardSessionCount: () => this.sessionStore.standardSize,
            getDiscoverySessionCount: () => this.sessionStore.discoverySize,
            getPaths: () => ({ endpointPath: this.endpointPath, sseEndpointPath: this.sseEndpointPath,
                sseMessagesPath: this.sseMessagesPath }) };
    }
}

module.exports = { HttpServerRuntime };
