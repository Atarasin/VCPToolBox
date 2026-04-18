const {
    createRequestId,
    sanitizeRequestContextValue
} = require('../contracts/requestContext');

function reuseRequestId(providedRequestId, options = {}) {
    const prefix = sanitizeRequestContextValue(options.prefix, 16) || 'agw';
    return createRequestId(providedRequestId, prefix);
}

function getDurationMs(startedAt) {
    return typeof startedAt === 'number' ? Math.max(0, Date.now() - startedAt) : 0;
}

function createTraceMeta({ requestId, startedAt, versionKey, versionValue, extraMeta } = {}) {
    const meta = {
        requestId: sanitizeRequestContextValue(requestId, 128),
        durationMs: getDurationMs(startedAt)
    };

    if (versionKey && versionValue) {
        meta[versionKey] = versionValue;
    }
    if (extraMeta && typeof extraMeta === 'object') {
        Object.assign(meta, extraMeta);
    }

    return meta;
}

module.exports = {
    reuseRequestId,
    getDurationMs,
    createTraceMeta
};
