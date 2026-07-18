'use strict';

const crypto = require('node:crypto');
const express = require('express');

const {
    AGW_ERROR_CODES
} = require('./contracts/errorCodes');
const { sanitizeRequestContextValue } = require('./contracts/requestContext');
const { resolveDedicatedGatewayAuth } = require('./contracts/protocolGovernance');
const { createProtocolConfigSnapshot } = require('./composition/vcpPortBindings');
const {
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('./mcpStdioServer');
const {
    checkSlidingWindowRateLimit,
    createSlidingWindowRateLimit,
    injectMcpContext
} = require('./transport/shared');
const { HttpServerRuntime } = require('./transport/http/httpServerRuntime');

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

function createMcpHttpServer(options = {}) {
    options = {
        ...options,
        protocolConfig: options.protocolConfig || createProtocolConfigSnapshot(options.pluginManager)
    };
    const maxPayloadBytes = resolveConfiguredPositiveInteger(options.maxPayloadBytes,
        MAX_PAYLOAD_BYTES_ENV, DEFAULT_MAX_PAYLOAD_BYTES);
    const runtime = new HttpServerRuntime({
        options,
        stderr: options.stderr || process.stderr,
        endpointPath: sanitizeRequestContextValue(options.path, 128) || DEFAULT_ENDPOINT_PATH,
        sseEndpointPath: sanitizeRequestContextValue(options.ssePath, 128) || DEFAULT_SSE_ENDPOINT_PATH,
        sseMessagesPath: sanitizeRequestContextValue(options.sseMessagesPath, 128) || DEFAULT_SSE_MESSAGES_PATH,
        maxSessions: resolveConfiguredPositiveInteger(options.maxSessions, MAX_SESSIONS_ENV, DEFAULT_MAX_SESSIONS),
        authTimeoutMs: resolveConfiguredPositiveInteger(options.authTimeoutMs, AUTH_TIMEOUT_MS_ENV,
            DEFAULT_AUTH_TIMEOUT_MS),
        rateLimitMessages: resolveConfiguredPositiveInteger(options.rateLimitMessages, RATE_LIMIT_MESSAGES_ENV,
            DEFAULT_RATE_LIMIT_MESSAGES),
        rateLimitWindowMs: resolveConfiguredPositiveInteger(options.rateLimitWindowMs, RATE_LIMIT_WINDOW_MS_ENV,
            DEFAULT_RATE_LIMIT_WINDOW_MS),
        sessionIdleMs: resolveConfiguredPositiveInteger(options.sessionIdleMs, SESSION_IDLE_MS_ENV,
            DEFAULT_SESSION_IDLE_MS),
        discoveryMaxSessions: resolveConfiguredPositiveInteger(options.discoveryMaxSessions,
            DISCOVERY_MAX_SESSIONS_ENV, DEFAULT_DISCOVERY_MAX_SESSIONS),
        discoverySessionTtlMs: resolveConfiguredPositiveInteger(options.discoverySessionTtlMs,
            DISCOVERY_SESSION_TTL_MS_ENV, DEFAULT_DISCOVERY_SESSION_TTL_MS),
        heartbeatIntervalMs: Number.isFinite(options.heartbeatIntervalMs) && options.heartbeatIntervalMs > 0
            ? options.heartbeatIntervalMs : DEFAULT_HEARTBEAT_INTERVAL_MS,
        backpressureTimeoutMs: Number.isFinite(options.backpressureTimeoutMs) && options.backpressureTimeoutMs > 0
            ? options.backpressureTimeoutMs : DEFAULT_SSE_BACKPRESSURE_TIMEOUT_MS,
        initializeRuntime: options.initializeRuntime || initializeBackendProxyMcpRuntime,
        shutdownRuntime: options.shutdownRuntime || shutdownBackendProxyMcpRuntime,
        resolveAuth: options.resolveAuth || resolveDedicatedGatewayAuth,
        rawBodyParser: express.raw({ type: '*/*', limit: maxPayloadBytes }),
        router: express.Router(),
        createSessionContext,
        isSelfHealingDiscoveryMethod,
        sessionHeader: MCP_SESSION_HEADER,
        defaultSource: DEFAULT_SOURCE,
        defaultRuntime: DEFAULT_RUNTIME,
        defaultSseSource: DEFAULT_SSE_SOURCE,
        defaultSseRuntime: DEFAULT_SSE_RUNTIME
    });
    return runtime.api();
}

module.exports = {
    MCP_SESSION_HEADER,
    createMcpHttpServer
};
