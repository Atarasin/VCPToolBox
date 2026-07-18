function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function createJsonRpcErrorResponse(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: typeof id === 'undefined' ? null : id,
        error: { code, message, ...(data && typeof data === 'object' ? { data } : {}) }
    };
}

function parseJsonRpcPayload(raw, { batchPolicy = 'reject', maxBatchSize = 20 } = {}) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8').trim() : String(raw || '').trim();
    if (!text) {
        return { error: createJsonRpcErrorResponse(null, -32600, 'Invalid request', { reason: 'empty_body' }) };
    }
    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return { error: createJsonRpcErrorResponse(null, -32700, 'Parse error', { details: error.message }) };
    }
    if (Array.isArray(value)) {
        if (batchPolicy !== 'allow') {
            return { error: createJsonRpcErrorResponse(null, -32600, 'Batch requests are not supported', { field: 'request', reason: 'batch_not_supported' }) };
        }
        if (value.length === 0) {
            return { error: createJsonRpcErrorResponse(null, -32600, 'Invalid request', { field: 'request', reason: 'empty_batch' }) };
        }
        if (value.length > maxBatchSize) {
            return { error: createJsonRpcErrorResponse(null, -32600, 'Invalid request', { field: 'request', reason: 'batch_limit_exceeded', limit: maxBatchSize, actual: value.length }) };
        }
        return { requests: value, batch: true };
    }
    if (!value || typeof value !== 'object') {
        return { error: createJsonRpcErrorResponse(null, -32600, 'Invalid request', { field: 'request' }) };
    }
    return { requests: [value], batch: false };
}

async function dispatchJsonRpc({ requests, batch, harness, inject = (value) => value, onNotificationError }) {
    const responses = [];
    for (let index = 0; index < requests.length; index += 1) {
        const request = requests[index];
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            responses.push(createJsonRpcErrorResponse(null, -32600, 'Invalid request', {
                field: 'request', reason: 'invalid_batch_member', batchIndex: index
            }));
            continue;
        }
        const injected = inject(request);
        const expectsResponse = hasOwn(injected, 'id');
        try {
            const response = await harness.handleRequest(injected);
            if (expectsResponse && response) responses.push(response);
        } catch (error) {
            if (expectsResponse) {
                responses.push(createJsonRpcErrorResponse(injected.id, -32603, 'Internal error', { details: error.message }));
            } else if (onNotificationError) {
                onNotificationError(error);
            }
        }
    }
    if (batch) return responses.length ? responses : null;
    return responses[0] || null;
}

module.exports = { createJsonRpcErrorResponse, dispatchJsonRpc, hasOwn, parseJsonRpcPayload };
