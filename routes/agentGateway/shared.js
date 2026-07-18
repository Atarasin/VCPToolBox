const express = require('express');
const {
    sendSuccessResponse,
    sendErrorResponse
} = require('../../modules/agentGateway/contracts/responseEnvelope');
const {
    AGW_ERROR_CODES,
    OPENCLAW_TO_AGENT_GATEWAY_CODE
} = require('../../modules/agentGateway/contracts/errorCodes');
const {
    AGENT_GATEWAY_HEADERS,
    NATIVE_GATEWAY_VERSION,
    NATIVE_GATEWAY_VERSION_KEY,
    applyGovernedCapabilitySections,
    resolveDedicatedGatewayAuth,
    resolveGovernedIdempotencyKey,
    resolveNativeRequestContext
} = require('../../modules/agentGateway/contracts/protocolGovernance');
const {
    getGatewayServiceBundle
} = require('../../modules/agentGateway/createGatewayServiceBundle');

function normalizeNativeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function parseNativeBoolean(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') {
            return true;
        }
        if (normalized === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function createNativeRequestContext(req, input, defaultSource) {
    return resolveNativeRequestContext(input, {
        headers: req.headers,
        query: req.query,
        defaultSource,
        defaultRuntime: 'native',
        requestIdPrefix: 'agw'
    });
}

function mapNativeErrorCode(code) {
    return OPENCLAW_TO_AGENT_GATEWAY_CODE[code] || code || AGW_ERROR_CODES.INTERNAL_ERROR;
}

function sendNativeSuccess(res, { status = 200, requestId, startedAt, data, extraHeaders, extraMeta }) {
    return sendSuccessResponse(res, {
        status,
        requestId,
        startedAt,
        data,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
        extraHeaders,
        extraMeta
    });
}

function sendNativeError(res, { status = 500, requestId, startedAt, code, error, details, extraHeaders, extraMeta }) {
    return sendErrorResponse(res, {
        status,
        requestId,
        startedAt,
        code: mapNativeErrorCode(code),
        error,
        details,
        versionValue: NATIVE_GATEWAY_VERSION,
        versionKey: NATIVE_GATEWAY_VERSION_KEY,
        extraHeaders,
        extraMeta
    });
}

function buildNativeResponseMeta(authContext, extraMeta = {}) {
    const normalizedExtraMeta = extraMeta && typeof extraMeta === 'object' ? extraMeta : {};
    if (!authContext || typeof authContext !== 'object') {
        return normalizedExtraMeta;
    }

    return {
        authMode: authContext.authMode,
        authSource: authContext.authSource,
        gatewayId: authContext.gatewayId,
        ...normalizedExtraMeta
    };
}

function estimateNativePayloadBytes(body) {
    if (!body || typeof body !== 'object') {
        return 0;
    }
    try {
        return Buffer.byteLength(JSON.stringify(body), 'utf8');
    } catch (error) {
        return 0;
    }
}

function buildNativeOperationMeta(operationControl, extraMeta = {}) {
    return {
        ...(operationControl?.traceId ? { traceId: operationControl.traceId } : {}),
        ...(operationControl?.operationName ? { operationName: operationControl.operationName } : {}),
        ...(extraMeta && typeof extraMeta === 'object' ? extraMeta : {})
    };
}

function buildNativeOperationHeaders(operationControl, extraHeaders = {}) {
    const headers = {
        ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {})
    };

    if (operationControl?.traceId) {
        headers[AGENT_GATEWAY_HEADERS.TRACE_ID] = operationControl.traceId;
    }
    if (operationControl?.rejection?.headers && typeof operationControl.rejection.headers === 'object') {
        Object.assign(headers, operationControl.rejection.headers);
    }

    return headers;
}

function beginNativeOperation(operabilityService, {
    operationName,
    requestContext,
    authContext,
    payload
}) {
    if (!operabilityService || typeof operabilityService.beginRequest !== 'function') {
        return null;
    }

    return operabilityService.beginRequest({
        operationName,
        requestContext,
        authContext,
        payloadBytes: estimateNativePayloadBytes(payload)
    });
}

function sendNativeOperationRejection(res, {
    startedAt,
    requestContext,
    authContext,
    operationControl
}) {
    return sendNativeError(res, {
        status: operationControl.rejection.httpStatus,
        requestId: requestContext.requestId,
        startedAt,
        code: operationControl.rejection.code,
        error: operationControl.rejection.error,
        details: operationControl.rejection.details,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(
            authContext,
            buildNativeOperationMeta(operationControl, {
                retryAfterMs: operationControl.rejection.details?.retryAfterMs || 0
            })
        )
    });
}

function sendNativeSuccessWithOperation(res, {
    status = 200,
    requestId,
    startedAt,
    data,
    authContext,
    operationControl,
    extraMeta
}) {
    operationControl?.finish?.({ outcome: 'success' });
    return sendNativeSuccess(res, {
        status,
        requestId,
        startedAt,
        data,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(authContext, buildNativeOperationMeta(operationControl, extraMeta))
    });
}

function sendNativeErrorWithOperation(res, {
    status = 500,
    requestId,
    startedAt,
    code,
    error,
    details,
    authContext,
    operationControl,
    extraMeta
}) {
    operationControl?.finish?.({ outcome: 'failure', code });
    return sendNativeError(res, {
        status,
        requestId,
        startedAt,
        code,
        error,
        details,
        extraHeaders: buildNativeOperationHeaders(operationControl),
        extraMeta: buildNativeResponseMeta(authContext, buildNativeOperationMeta(operationControl, extraMeta))
    });
}

function sendNativeServiceResult(res, {
    result,
    startedAt,
    authContext,
    operationControl
}) {
    if (!result?.success) {
        return sendNativeErrorWithOperation(res, {
            status: result?.status || 500,
            requestId: result?.requestId || '',
            startedAt,
            code: result?.code,
            error: result?.error,
            details: result?.details,
            authContext,
            operationControl
        });
    }

    const isDeferred = result.status === 'accepted' || result.status === 'waiting_approval';
    return sendNativeSuccessWithOperation(res, {
        status: result.httpStatus || (isDeferred ? 202 : 200),
        requestId: result.requestId,
        startedAt,
        data: result.data,
        authContext,
        operationControl,
        extraMeta: isDeferred
            ? {
                operationStatus: result.status
            }
            : undefined
    });
}

async function executeNativeOperationSafely({
    res,
    startedAt,
    requestContext,
    authContext,
    operationControl,
    errorCode = AGW_ERROR_CODES.INTERNAL_ERROR,
    errorMessage = 'Unexpected native gateway failure',
    buildErrorDetails,
    handler
}) {
    try {
        return await handler();
    } catch (error) {
        const details = typeof buildErrorDetails === 'function'
            ? buildErrorDetails(error)
            : { message: error.message };
        return sendNativeErrorWithOperation(res, {
            status: 500,
            requestId: requestContext.requestId,
            startedAt,
            code: errorCode,
            error: errorMessage,
            details,
            authContext,
            operationControl
        });
    }
}

function buildNativeAuthContext({
    authContextResolver,
    requestContext,
    providedAuthContext,
    dedicatedAuth,
    maid
}) {
    return authContextResolver({
        authContext: {
            ...(providedAuthContext && typeof providedAuthContext === 'object' ? providedAuthContext : {}),
            authMode: dedicatedAuth?.authMode,
            authSource: dedicatedAuth?.authSource,
            gatewayId: dedicatedAuth?.gatewayId,
            roles: dedicatedAuth?.roles
        },
        requestContext,
        agentId: requestContext.agentId,
        maid,
        adapter: 'native'
    });
}

function createGovernedRequestBody(req, pluginManager, requestContext) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const options = body.options && typeof body.options === 'object' ? body.options : {};
    const idempotencyKey = resolveGovernedIdempotencyKey({
        body,
        headers: req.headers,
        pluginManager
    });

    return {
        ...body,
        requestContext,
        idempotencyKey: idempotencyKey || normalizeNativeString(body.idempotencyKey),
        options: idempotencyKey
            ? {
                ...options,
                idempotencyKey
            }
            : options
    };
}

function createNativeStreamFilters(query = {}) {
    return {
        jobId: normalizeNativeString(query.jobId),
        agentId: normalizeNativeString(query.agentId),
        sessionId: normalizeNativeString(query.sessionId)
    };
}

function writeNativeSseEvent(res, eventName, payload) {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildNativeHealthSnapshot(pluginManager) {
    const pluginManagerReady = Boolean(
        pluginManager &&
        pluginManager.plugins &&
        typeof pluginManager.getPlugin === 'function'
    );
    const knowledgeBaseReady = Boolean(
        pluginManager &&
        pluginManager.vectorDBManager &&
        typeof pluginManager.vectorDBManager.listDiaryNames === 'function'
    );

    return {
        status: pluginManagerReady && knowledgeBaseReady ? 'ok' : 'degraded',
        serverTime: new Date().toISOString(),
        pluginManagerReady,
        knowledgeBaseReady,
        gatewayVersion: NATIVE_GATEWAY_VERSION
    };
}

/**
 * Native Agent Gateway beta adapter。
 * 路由层只负责协议适配，所有核心能力都委托给共享 Gateway Core services。
 */
module.exports = { AGW_ERROR_CODES, AGENT_GATEWAY_HEADERS, NATIVE_GATEWAY_VERSION, applyGovernedCapabilitySections, resolveDedicatedGatewayAuth, normalizeNativeString, parseNativeBoolean, createNativeRequestContext, sendNativeError, buildNativeResponseMeta, buildNativeOperationMeta, buildNativeOperationHeaders, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, sendNativeServiceResult, executeNativeOperationSafely, buildNativeAuthContext, createGovernedRequestBody, createNativeStreamFilters, writeNativeSseEvent, buildNativeHealthSnapshot };
