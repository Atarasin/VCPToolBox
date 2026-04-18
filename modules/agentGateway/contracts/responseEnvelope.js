function setResponseHeaders(res, {
    requestId,
    versionHeader = 'x-agent-gateway-version',
    versionValue,
    extraHeaders
} = {}) {
    if (!res || typeof res.set !== 'function') {
        return;
    }

    if (requestId) {
        res.set('x-request-id', requestId);
    }
    if (versionHeader && versionValue) {
        res.set(versionHeader, versionValue);
    }
    if (extraHeaders && typeof extraHeaders === 'object') {
        for (const [headerName, headerValue] of Object.entries(extraHeaders)) {
            if (headerValue !== undefined && headerValue !== null) {
                res.set(headerName, headerValue);
            }
        }
    }
}

function createResponseMeta({
    requestId,
    startedAt,
    versionKey = 'version',
    versionValue,
    extraMeta
} = {}) {
    const meta = {
        requestId: requestId || '',
        durationMs: typeof startedAt === 'number' ? Math.max(0, Date.now() - startedAt) : 0
    };

    if (versionKey && versionValue) {
        meta[versionKey] = versionValue;
    }
    if (extraMeta && typeof extraMeta === 'object') {
        Object.assign(meta, extraMeta);
    }

    return meta;
}

function createSuccessEnvelope({ data, meta }) {
    return {
        success: true,
        data,
        meta
    };
}

function createErrorEnvelope({ error, code, details, meta }) {
    return {
        success: false,
        error,
        code,
        details,
        meta
    };
}

function sendSuccessResponse(res, {
    status = 200,
    requestId,
    startedAt,
    data,
    versionHeader,
    versionValue,
    versionKey,
    extraHeaders,
    extraMeta
} = {}) {
    setResponseHeaders(res, { requestId, versionHeader, versionValue, extraHeaders });
    return res.status(status).json(createSuccessEnvelope({
        data,
        meta: createResponseMeta({ requestId, startedAt, versionKey, versionValue, extraMeta })
    }));
}

function sendErrorResponse(res, {
    status = 500,
    requestId,
    startedAt,
    error,
    code,
    details,
    versionHeader,
    versionValue,
    versionKey,
    extraHeaders,
    extraMeta
} = {}) {
    setResponseHeaders(res, { requestId, versionHeader, versionValue, extraHeaders });
    return res.status(status).json(createErrorEnvelope({
        error,
        code,
        details,
        meta: createResponseMeta({ requestId, startedAt, versionKey, versionValue, extraMeta })
    }));
}

module.exports = {
    setResponseHeaders,
    createResponseMeta,
    createSuccessEnvelope,
    createErrorEnvelope,
    sendSuccessResponse,
    sendErrorResponse
};
