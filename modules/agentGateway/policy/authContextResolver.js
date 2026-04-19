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

function buildAgentAliases(agentId, maid) {
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
    addAlias(maid);
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
    const maid = normalizeAuthString(
        providedAuthContext.maid || input.maid || requestContext.maid,
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

    return {
        requestId,
        sessionId,
        agentId,
        maid,
        source,
        runtime,
        adapter,
        gatewayId,
        authMode,
        authSource,
        roles,
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
            maid,
            aliases: buildAgentAliases(agentId, maid)
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
