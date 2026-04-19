const {
    normalizeRequestContext,
    sanitizeRequestContextValue
} = require('./requestContext');

const NATIVE_GATEWAY_VERSION = 'v1';
const NATIVE_GATEWAY_VERSION_KEY = 'gatewayVersion';
const NATIVE_GATEWAY_RELEASE_STAGE = 'ga';
const PUBLISHED_NATIVE_GATEWAY_PATHS = Object.freeze([
    '/agent_gateway/capabilities',
    '/agent_gateway/agents',
    '/agent_gateway/agents/{agentId}',
    '/agent_gateway/agents/{agentId}/render',
    '/agent_gateway/memory/targets',
    '/agent_gateway/memory/search',
    '/agent_gateway/memory/write',
    '/agent_gateway/context/assemble',
    '/agent_gateway/tools/{toolName}/invoke',
    '/agent_gateway/jobs/{jobId}',
    '/agent_gateway/jobs/{jobId}/cancel',
    '/agent_gateway/events/stream'
]);

const AGENT_GATEWAY_HEADERS = Object.freeze({
    REQUEST_ID: 'x-request-id',
    AGENT_ID: 'x-agent-id',
    SESSION_ID: 'x-agent-session-id',
    SOURCE: 'x-agent-gateway-source',
    RUNTIME: 'x-agent-gateway-runtime',
    GATEWAY_ID: 'x-agent-gateway-id',
    GATEWAY_KEY: 'x-agent-gateway-key',
    IDEMPOTENCY_KEY: 'idempotency-key'
});

const AGENT_GATEWAY_AUTH_MODES = Object.freeze({
    ADMIN_TRANSITION: 'admin_transition',
    GATEWAY_KEY: 'gateway_key'
});

const GATEWAY_CAPABILITY_SECTIONS = Object.freeze([
    'tools',
    'memory',
    'context',
    'jobs',
    'events'
]);

function normalizeGovernanceString(value, maxLength = 256) {
    return sanitizeRequestContextValue(value, maxLength);
}

function getHeaderValue(headers = {}, headerName) {
    if (!headerName || !headers || typeof headers !== 'object') {
        return '';
    }

    const directValue = headers[headerName] ?? headers[String(headerName).toLowerCase()];
    if (Array.isArray(directValue)) {
        return normalizeGovernanceString(directValue[0]);
    }
    return normalizeGovernanceString(directValue);
}

function getBearerToken(headers = {}) {
    const authorization = getHeaderValue(headers, 'authorization');
    if (!authorization) {
        return '';
    }

    const matched = authorization.match(/^Bearer\s+(.+)$/i);
    return matched ? normalizeGovernanceString(matched[1]) : '';
}

function getProtocolGovernanceConfig(pluginManager) {
    const config = pluginManager?.agentGatewayProtocolConfig ||
        pluginManager?.agentGatewayAuthConfig ||
        pluginManager?.openClawBridgeConfig?.agentGateway ||
        {};
    const authConfig = config.auth && typeof config.auth === 'object' ? config.auth : {};

    return {
        gatewayKey: normalizeGovernanceString(
            process.env.AGENT_GATEWAY_KEY ||
            authConfig.gatewayKey ||
            config.gatewayKey
        ),
        gatewayId: normalizeGovernanceString(
            process.env.AGENT_GATEWAY_ID ||
            authConfig.gatewayId ||
            config.gatewayId ||
            'vcp-gateway'
        ),
        gatewayKeyHeader: normalizeGovernanceString(
            authConfig.gatewayKeyHeader ||
            config.gatewayKeyHeader ||
            AGENT_GATEWAY_HEADERS.GATEWAY_KEY,
            64
        ) || AGENT_GATEWAY_HEADERS.GATEWAY_KEY,
        idempotencyHeader: normalizeGovernanceString(
            config.idempotencyHeader || AGENT_GATEWAY_HEADERS.IDEMPOTENCY_KEY,
            64
        ) || AGENT_GATEWAY_HEADERS.IDEMPOTENCY_KEY
    };
}

function resolveNativeRequestContext(input, options = {}) {
    const query = options.query && typeof options.query === 'object' ? options.query : {};
    const headers = options.headers && typeof options.headers === 'object' ? options.headers : {};
    const context = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

    return normalizeRequestContext({
        requestId: context.requestId || query.requestId || getHeaderValue(headers, AGENT_GATEWAY_HEADERS.REQUEST_ID),
        sessionId: context.sessionId || query.sessionId || getHeaderValue(headers, AGENT_GATEWAY_HEADERS.SESSION_ID),
        agentId: context.agentId || query.agentId || getHeaderValue(headers, AGENT_GATEWAY_HEADERS.AGENT_ID),
        source: context.source || query.source || getHeaderValue(headers, AGENT_GATEWAY_HEADERS.SOURCE),
        runtime: context.runtime || query.runtime || getHeaderValue(headers, AGENT_GATEWAY_HEADERS.RUNTIME)
    }, {
        defaultSource: options.defaultSource,
        defaultRuntime: options.defaultRuntime || 'native',
        requestIdPrefix: options.requestIdPrefix || 'agw'
    });
}

function resolveGovernedIdempotencyKey({ body, headers, pluginManager } = {}) {
    const normalizedBody = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const options = normalizedBody.options && typeof normalizedBody.options === 'object'
        ? normalizedBody.options
        : {};
    const config = getProtocolGovernanceConfig(pluginManager);

    return normalizeGovernanceString(
        options.idempotencyKey ||
        normalizedBody.idempotencyKey ||
        getHeaderValue(headers, config.idempotencyHeader)
    );
}

function resolveDedicatedGatewayAuth({ headers, pluginManager } = {}) {
    const config = getProtocolGovernanceConfig(pluginManager);
    const providedGatewayKey = getHeaderValue(headers, config.gatewayKeyHeader) || getBearerToken(headers);
    const authSource = getHeaderValue(headers, config.gatewayKeyHeader)
        ? config.gatewayKeyHeader
        : (getBearerToken(headers) ? 'authorization-bearer' : '');
    const providedGatewayId = getHeaderValue(headers, AGENT_GATEWAY_HEADERS.GATEWAY_ID) || config.gatewayId;

    if (!providedGatewayKey) {
        return {
            provided: false,
            authenticated: false,
            authMode: AGENT_GATEWAY_AUTH_MODES.ADMIN_TRANSITION,
            authSource: 'shared-admin-auth',
            gatewayId: providedGatewayId || 'vcp-gateway',
            roles: ['admin_transition']
        };
    }

    return {
        provided: true,
        authenticated: Boolean(config.gatewayKey) && providedGatewayKey === config.gatewayKey,
        authMode: AGENT_GATEWAY_AUTH_MODES.GATEWAY_KEY,
        authSource: authSource || config.gatewayKeyHeader,
        gatewayId: providedGatewayId || 'vcp-gateway',
        roles: ['gateway_client']
    };
}

function applyGovernedCapabilitySections(payload, options = {}) {
    const capabilityPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const authContext = options.authContext && typeof options.authContext === 'object'
        ? options.authContext
        : null;

    return {
        ...capabilityPayload,
        sections: [...GATEWAY_CAPABILITY_SECTIONS],
        tools: Array.isArray(capabilityPayload.tools) ? capabilityPayload.tools : [],
        memory: capabilityPayload.memory && typeof capabilityPayload.memory === 'object'
            ? capabilityPayload.memory
            : { targets: [], features: {} },
        context: capabilityPayload.context && typeof capabilityPayload.context === 'object'
            ? capabilityPayload.context
            : { features: {} },
        jobs: capabilityPayload.jobs && typeof capabilityPayload.jobs === 'object'
            ? capabilityPayload.jobs
            : { supported: false },
        events: capabilityPayload.events && typeof capabilityPayload.events === 'object'
            ? capabilityPayload.events
            : { supported: false },
        auth: authContext ? {
            authMode: normalizeGovernanceString(authContext.authMode, 64),
            authSource: normalizeGovernanceString(authContext.authSource, 128),
            gatewayId: normalizeGovernanceString(authContext.gatewayId, 128)
        } : undefined
    };
}

module.exports = {
    AGENT_GATEWAY_AUTH_MODES,
    AGENT_GATEWAY_HEADERS,
    GATEWAY_CAPABILITY_SECTIONS,
    NATIVE_GATEWAY_RELEASE_STAGE,
    NATIVE_GATEWAY_VERSION,
    NATIVE_GATEWAY_VERSION_KEY,
    PUBLISHED_NATIVE_GATEWAY_PATHS,
    applyGovernedCapabilitySections,
    getHeaderValue,
    getProtocolGovernanceConfig,
    resolveDedicatedGatewayAuth,
    resolveGovernedIdempotencyKey,
    resolveNativeRequestContext
};
