const { normalizeRequestContext, sanitizeRequestContextValue } = require('../../contracts/requestContext');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function injectMcpContext(request, context, options = {}) {
    const requestObject = isPlainObject(request) ? request : {};
    const params = isPlainObject(requestObject.params) ? { ...requestObject.params } : {};
    const clientContext = isPlainObject(params.requestContext) ? params.requestContext : {};
    const topLevelAgentId = sanitizeRequestContextValue(params.agentId, 256);
    const normalized = normalizeRequestContext({
        requestId: clientContext.requestId,
        agentId: clientContext.agentId || topLevelAgentId,
        source: clientContext.source || context.source,
        runtime: clientContext.runtime || context.runtime,
        sessionId: context.sessionId
    }, {
        defaultSource: context.source,
        defaultRuntime: context.runtime,
        requestIdPrefix: sanitizeRequestContextValue(options.requestIdPrefix, 16) || 'agwmcp'
    });
    return {
        ...requestObject,
        params: {
            ...params,
            ...(topLevelAgentId || normalized.agentId ? { agentId: topLevelAgentId || normalized.agentId } : {}),
            sessionId: context.sessionId,
            ...(options.signal ? { signal: options.signal } : {}),
            requestContext: { ...normalized, ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}) },
            authContext: {
                ...(context.gatewayId ? { gatewayId: context.gatewayId } : {}),
                sessionId: context.sessionId,
                ...(context.authMode ? { authMode: context.authMode } : {}),
                ...(context.authSource ? { authSource: context.authSource } : {}),
                ...(context.roles?.length ? { roles: [...context.roles] } : {})
            }
        }
    };
}

module.exports = { injectMcpContext, isPlainObject };
