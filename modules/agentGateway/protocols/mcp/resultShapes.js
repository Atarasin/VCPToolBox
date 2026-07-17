const {
    MCP_ERROR_CODES,
    MCP_ERROR_CODE_SET,
    MCP_STRING_LIMITS
} = require('./constants');

const MAX_SANITIZATION_DEPTH = 8;

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeMcpString(value, maxLength = MCP_STRING_LIMITS.CONTEXT) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().slice(0, maxLength);
}

function sanitizeMcpErrorDetails(value, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_SANITIZATION_DEPTH) {
        return undefined;
    }
    if (Array.isArray(value)) {
        return value
            .map((entry) => sanitizeMcpErrorDetails(entry, depth + 1, seen))
            .filter((entry) => typeof entry !== 'undefined');
    }
    if (!isPlainObject(value)) {
        return value;
    }
    if (seen.has(value)) {
        return undefined;
    }
    seen.add(value);

    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key.toLowerCase() === 'stack') {
            continue;
        }
        const sanitizedEntry = sanitizeMcpErrorDetails(entry, depth + 1, seen);
        if (typeof sanitizedEntry !== 'undefined') {
            sanitized[key] = sanitizedEntry;
        }
    }
    return sanitized;
}

function serializeMcpValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (_error) {
        return String(value);
    }
}

function createMcpTextContent(value) {
    return [{ type: 'text', text: serializeMcpValue(value) }];
}

function createMcpPromptTextMessage(text) {
    return {
        role: 'system',
        content: [{
            type: 'text',
            text: typeof text === 'string' ? text : String(text || '')
        }]
    };
}

function createMcpError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function buildJsonRpcError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code, message, data }
    };
}

function shapeHarnessFailure(error) {
    const rawCode = normalizeMcpString(error?.code, MCP_STRING_LIMITS.CODE);
    if (!MCP_ERROR_CODE_SET.has(rawCode)) {
        return {
            message: 'Gateway backend request failed',
            data: {
                code: MCP_ERROR_CODES.RUNTIME_ERROR,
                ...(rawCode ? { sourceErrorCode: rawCode } : {})
            }
        };
    }

    const details = sanitizeMcpErrorDetails(error?.details);
    return {
        message: normalizeMcpString(error?.message, MCP_STRING_LIMITS.MESSAGE) || 'MCP adapter request failed',
        data: {
            code: rawCode,
            ...(isPlainObject(details) ? details : {})
        }
    };
}

module.exports = {
    buildJsonRpcError,
    createMcpError,
    createMcpPromptTextMessage,
    createMcpTextContent,
    normalizeMcpString,
    sanitizeMcpErrorDetails,
    serializeMcpValue,
    shapeHarnessFailure
};
