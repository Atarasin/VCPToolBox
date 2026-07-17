const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { sanitizeRequestContextValue } = require('../../contracts/requestContext');
const { createJsonRpcErrorResponse, parseJsonRpcPayload } = require('../shared/jsonRpcCodec');

const SERVER_ERROR = -32000;

function createTransportErrorResponse(id, message, data = {}) {
    return createJsonRpcErrorResponse(id, SERVER_ERROR, message, data);
}

function createInvalidRequestError(id, data = {}) {
    return createJsonRpcErrorResponse(id, -32600, 'Invalid request', data);
}

function createUnauthorizedErrorResponse(id, authSource = '') {
    return createTransportErrorResponse(id, 'Unauthorized', {
        canonicalCode: AGW_ERROR_CODES.UNAUTHORIZED,
        gatewayCode: AGW_ERROR_CODES.UNAUTHORIZED,
        authSource
    });
}

function createSessionErrorResponse(id, reason, details = {}) {
    return createTransportErrorResponse(id, 'HTTP MCP session is invalid', {
        canonicalCode: AGW_ERROR_CODES.INVALID_REQUEST,
        gatewayCode: AGW_ERROR_CODES.INVALID_REQUEST,
        reason,
        ...details
    });
}

function createRateLimitErrorResponse(id, rateLimit) {
    return createTransportErrorResponse(id, 'Request rate limit exceeded for this HTTP MCP session', {
        canonicalCode: AGW_ERROR_CODES.RATE_LIMITED,
        gatewayCode: AGW_ERROR_CODES.RATE_LIMITED,
        reason: 'rate_limited',
        retryAfterMs: rateLimit.retryAfterMs,
        limit: rateLimit.limit,
        windowMs: rateLimit.windowMs,
        rejectionCategory: 'rate_limit',
        retryable: true
    });
}

function createPayloadTooLargeErrorResponse() {
    return createTransportErrorResponse(null, 'Payload too large', {
        canonicalCode: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
        gatewayCode: AGW_ERROR_CODES.PAYLOAD_TOO_LARGE,
        reason: 'payload_too_large'
    });
}

function createTimeoutErrorResponse(id, reason = 'auth_timeout') {
    return createTransportErrorResponse(id, 'HTTP MCP request timed out', {
        canonicalCode: AGW_ERROR_CODES.TIMEOUT,
        gatewayCode: AGW_ERROR_CODES.TIMEOUT,
        reason
    });
}

function createSessionLimitErrorResponse(id, limit) {
    return createTransportErrorResponse(id, 'HTTP MCP session limit reached', {
        canonicalCode: AGW_ERROR_CODES.CONCURRENCY_LIMITED,
        gatewayCode: AGW_ERROR_CODES.CONCURRENCY_LIMITED,
        reason: 'session_limit_reached',
        limit
    });
}

function parseRawJsonRequest(rawBody) {
    const parsed = parseJsonRpcPayload(rawBody, { batchPolicy: 'reject' });
    return parsed.error ? { error: parsed.error } : { request: parsed.requests[0] };
}

function setHeaders(res, headers) {
    Object.entries(headers).forEach(([name, value]) => {
        if (value !== undefined && value !== null && value !== '') res.setHeader(name, value);
    });
}

function writeJsonRpcResponse(res, statusCode, payload, extraHeaders = {}) {
    if (res.headersSent || res.writableEnded) return;
    setHeaders(res, extraHeaders);
    res.status(statusCode).type('application/json').send(JSON.stringify(payload));
}

function writeEmptyResponse(res, statusCode, extraHeaders = {}) {
    if (res.headersSent || res.writableEnded) return;
    setHeaders(res, extraHeaders);
    res.status(statusCode).end();
}

function requestAcceptsEventStream(req) {
    return sanitizeRequestContextValue(req.get('accept'), 512).toLowerCase().includes('text/event-stream');
}

module.exports = {
    createInvalidRequestError,
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
};
