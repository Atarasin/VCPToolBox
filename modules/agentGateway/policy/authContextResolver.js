const {
    sanitizeRequestContextValue
} = require('../contracts/requestContext');
const {
    AGENT_GATEWAY_AUTH_MODES
} = require('../contracts/protocolGovernance');

function normalizeAuthString(value, maxLength = 128) {
    return sanitizeRequestContextValue(value, maxLength);
}

function normalizeAuthStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeAuthString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function buildAgentAliases(agentId) {
    const aliases = new Set();
    const addAlias = (value) => {
        const normalizedValue = normalizeAuthString(value);
        if (!normalizedValue) {
            return;
        }
        aliases.add(normalizedValue);
        normalizedValue
            .split(/[./:\\]/)
            .map((segment) => segment.trim())
            .filter(Boolean)
            .forEach((segment) => aliases.add(segment));
    };

    addAlias(agentId);
    return Array.from(aliases);
}

/**
 * 将 requestContext 提升为统一 authContext。
 * 兼容过渡期 shared-admin-auth，同时允许 dedicated gateway-auth 输入。
 */
function resolveAuthContext(input = {}, options = {}) {
    const requestContext = input.requestContext && typeof input.requestContext === 'object'
        ? input.requestContext
        : {};
    const providedAuthContext = input.authContext && typeof input.authContext === 'object'
        ? input.authContext
        : {};

    const requestId = normalizeAuthString(
        providedAuthContext.requestId || requestContext.requestId,
        128
    );
    const agentId = normalizeAuthString(
        providedAuthContext.agentId || input.agentId || requestContext.agentId,
        128
    );
    const sessionId = normalizeAuthString(
        providedAuthContext.sessionId || input.sessionId || requestContext.sessionId,
        128
    );
    const source = normalizeAuthString(
        providedAuthContext.source || requestContext.source || options.defaultSource || 'agent-gateway',
        128
    );
    const runtime = normalizeAuthString(
        providedAuthContext.runtime || requestContext.runtime || options.defaultRuntime || 'gateway',
        64
    );
    const adapter = normalizeAuthString(
        providedAuthContext.adapter || input.adapter || runtime || options.adapter || 'gateway',
        64
    );
    const gatewayId = normalizeAuthString(
        providedAuthContext.gatewayId || input.gatewayId || options.gatewayId || 'vcp-gateway',
        128
    );
    const authMode = normalizeAuthString(
        providedAuthContext.authMode ||
        input.authMode ||
        options.authMode ||
        AGENT_GATEWAY_AUTH_MODES.ADMIN_TRANSITION,
        64
    );
    const authSource = normalizeAuthString(
        providedAuthContext.authSource || input.authSource || options.authSource || 'shared-admin-auth',
        128
    );
    const defaultRoles = authMode === AGENT_GATEWAY_AUTH_MODES.GATEWAY_KEY
        ? ['gateway_client']
        : ['admin_transition'];
    const roles = normalizeAuthStringArray(
        providedAuthContext.roles || input.roles || options.roles || defaultRoles
    );

    // M1.S6：服务端注入的 credential 身份字段透传（由 authInjection/transport
    // 组装根写入 providedAuthContext；客户端 body 中的同名字段在统一决议入口
    // 已被丢弃，见 gatewayRequestContext）。
    const credentialIdentity = {};
    for (const field of ['credentialId', 'credentialSubject', 'credentialRevision', 'effectiveAgentId', 'trustedSessionId', 'credentialRecord', 'ownerSessionState']) {
        if (providedAuthContext[field] !== undefined) {
            credentialIdentity[field] = providedAuthContext[field];
        }
    }

    return {
        requestId,
        sessionId,
        agentId,
        source,
        runtime,
        adapter,
        gatewayId,
        authMode,
        authSource,
        roles,
        ...credentialIdentity,
        isTransitionalAuth: authMode === AGENT_GATEWAY_AUTH_MODES.ADMIN_TRANSITION,
        isDedicatedGatewayAuth: authMode === AGENT_GATEWAY_AUTH_MODES.GATEWAY_KEY,
        gatewayIdentity: {
            id: gatewayId,
            adapter,
            source,
            runtime,
            authMode,
            authSource
        },
        agentIdentity: {
            id: agentId,
            aliases: buildAgentAliases(agentId)
        },
        sessionIdentity: {
            id: sessionId,
            requestId
        }
    };
}

module.exports = {
    buildAgentAliases,
    resolveAuthContext
};
