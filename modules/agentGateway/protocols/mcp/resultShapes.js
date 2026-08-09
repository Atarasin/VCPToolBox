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

/**
 * render / bootstrap 的文本内容：宿主模型只读 `content`，`structuredContent`
 * 里的 `warnings` 多半永远到不了它眼前。渲染降级（例如检索 query 退化成
 * 通用兜底、提示词被截断）因此会表现为「一次看起来完全正常的失败」。
 *
 * 有 warning 时在提示词前置一段告示，让模型能读到并自行纠正（带上 `query`
 * 重新调用）；无 warning 时返回值与直接 `createMcpTextContent(renderedPrompt)`
 * 逐字节相同——不给正常路径增加任何噪声。
 *
 * 分隔符刻意不用 `<< >>`／`[[ ]]`：那是 VCP 占位符语法。
 */
function createRenderedPromptContent(data) {
    const renderedPrompt = typeof data?.renderedPrompt === 'string' ? data.renderedPrompt : '';
    const warnings = Array.isArray(data?.warnings)
        ? data.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
        : [];
    if (warnings.length === 0) {
        return createMcpTextContent(renderedPrompt);
    }
    return createMcpTextContent([
        'GATEWAY NOTICE — this render is degraded:',
        ...warnings.map((warning) => `  - ${warning}`),
        'END GATEWAY NOTICE — the agent prompt follows.',
        '',
        renderedPrompt
    ].join('\n'));
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
    createRenderedPromptContent,
    normalizeMcpString,
    sanitizeMcpErrorDetails,
    serializeMcpValue,
    shapeHarnessFailure
};
