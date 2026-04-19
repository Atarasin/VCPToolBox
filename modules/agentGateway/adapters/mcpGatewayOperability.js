const {
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');

function normalizePositiveInteger(value, fallbackValue = 0) {
    const normalizedValue = Number(value);
    return Number.isInteger(normalizedValue) && normalizedValue > 0 ? normalizedValue : fallbackValue;
}

function estimateMcpPayloadBytes(payload) {
    if (!payload || typeof payload !== 'object') {
        return 0;
    }
    try {
        return Buffer.byteLength(JSON.stringify(payload), 'utf8');
    } catch (error) {
        return 0;
    }
}

function buildGatewayManagedClientPayload(input = {}, args = {}) {
    const payload = {
        ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {})
    };

    if (input.requestContext && typeof input.requestContext === 'object' && !Array.isArray(input.requestContext)) {
        payload.requestContext = input.requestContext;
    }
    if (input.authContext && typeof input.authContext === 'object' && !Array.isArray(input.authContext)) {
        payload.authContext = input.authContext;
    }
    if (typeof input.maid === 'string' && input.maid.trim()) {
        payload.maid = input.maid.trim();
    }

    return payload;
}

function beginGatewayManagedOperation(operabilityService, {
    operationName,
    requestContext,
    authContext,
    payload
} = {}) {
    if (!operabilityService || typeof operabilityService.beginRequest !== 'function') {
        return null;
    }

    return operabilityService.beginRequest({
        operationName,
        requestContext,
        authContext,
        payloadBytes: estimateMcpPayloadBytes(payload)
    });
}

function getOperabilityCategory(code) {
    switch (code) {
    case AGW_ERROR_CODES.RATE_LIMITED:
        return 'rate_limit';
    case AGW_ERROR_CODES.CONCURRENCY_LIMITED:
        return 'concurrency_limit';
    case AGW_ERROR_CODES.PAYLOAD_TOO_LARGE:
        return 'payload_too_large';
    default:
        return '';
    }
}

function isRetryableOperabilityCode(code) {
    return code === AGW_ERROR_CODES.RATE_LIMITED || code === AGW_ERROR_CODES.CONCURRENCY_LIMITED;
}

function buildOperabilityMetadata(operationControl, result = {}) {
    const details = result?.details && typeof result.details === 'object' ? result.details : {};
    const code = result?.code || operationControl?.rejection?.code || '';
    const retryAfterMs = normalizePositiveInteger(
        details.retryAfterMs || operationControl?.rejection?.details?.retryAfterMs
    );
    const traceId = details.traceId || operationControl?.traceId || '';
    const operationName = details.operationName || operationControl?.operationName || '';
    const category = getOperabilityCategory(code);

    return {
        traceId,
        operationName,
        retryAfterMs,
        category,
        retryable: category ? isRetryableOperabilityCode(code) : false
    };
}

function buildGatewayManagedOperationRejection(operationControl, requestId) {
    return {
        success: false,
        requestId,
        status: operationControl?.rejection?.httpStatus || 500,
        code: operationControl?.rejection?.code || AGW_ERROR_CODES.INTERNAL_ERROR,
        error: operationControl?.rejection?.error || 'Gateway-managed MCP operation rejected',
        details: {
            ...((operationControl?.rejection?.details && typeof operationControl.rejection.details === 'object')
                ? operationControl.rejection.details
                : {}),
            retryAfterMs: normalizePositiveInteger(operationControl?.rejection?.details?.retryAfterMs)
        }
    };
}

function finishGatewayManagedOperation(operationControl, result = {}) {
    if (!operationControl || typeof operationControl.finish !== 'function') {
        return;
    }

    if (result?.success) {
        operationControl.finish({
            outcome: 'success'
        });
        return;
    }

    operationControl.finish({
        outcome: 'failure',
        code: result?.code || AGW_ERROR_CODES.INTERNAL_ERROR
    });
}

module.exports = {
    beginGatewayManagedOperation,
    buildGatewayManagedClientPayload,
    buildGatewayManagedOperationRejection,
    buildOperabilityMetadata,
    finishGatewayManagedOperation
};
