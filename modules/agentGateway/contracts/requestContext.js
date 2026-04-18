const crypto = require('crypto');

function sanitizeRequestContextValue(value, maxLength = 128) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().slice(0, maxLength);
}

function createRequestId(providedRequestId, prefix = 'agw') {
    const normalizedRequestId = sanitizeRequestContextValue(providedRequestId, 128);
    if (normalizedRequestId) {
        return normalizedRequestId;
    }
    if (typeof crypto.randomUUID === 'function') {
        return `${prefix}_${crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRequestContext(input, options = {}) {
    const context = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const requestIdPrefix = sanitizeRequestContextValue(options.requestIdPrefix, 16) || 'agw';

    return {
        requestId: createRequestId(context.requestId, requestIdPrefix),
        sessionId: sanitizeRequestContextValue(context.sessionId),
        agentId: sanitizeRequestContextValue(context.agentId),
        source: sanitizeRequestContextValue(context.source) ||
            sanitizeRequestContextValue(options.defaultSource) ||
            'agent-gateway',
        runtime: sanitizeRequestContextValue(context.runtime) ||
            sanitizeRequestContextValue(options.defaultRuntime) ||
            'gateway'
    };
}

module.exports = {
    sanitizeRequestContextValue,
    createRequestId,
    normalizeRequestContext
};
