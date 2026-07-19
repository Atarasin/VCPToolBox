const { normalizeRequestContext, sanitizeRequestContextValue } = require('../../contracts/requestContext');
const { resolveTraceId } = require('../../infra/trace');
const {
    attachPresentedCredential,
    getPresentedCredential
} = require('../../policy/trustedCredentialContext');
const { DISCOVERY_SNAPSHOT_HOLDER } = require('../../policy/discoverySnapshot');

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
    normalized.traceId = resolveTraceId(clientContext.traceId, 'agwop');
    // transport 私有通道：session/connection context 中的 presented credential
    // 经 Symbol 属性传给 executor（不进 JSON 序列化，params 中的伪造值被忽略）。
    const presentedCredential = getPresentedCredential(context);
    const injectedParams = { ...params };
    if (presentedCredential) {
        attachPresentedCredential(injectedParams, presentedCredential);
    }
    if (context[DISCOVERY_SNAPSHOT_HOLDER]) {
        injectedParams[DISCOVERY_SNAPSHOT_HOLDER] = context[DISCOVERY_SNAPSHOT_HOLDER];
    }
    return {
        ...requestObject,
        params: {
            ...injectedParams,
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
