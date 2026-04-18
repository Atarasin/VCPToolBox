const { AGW_ERROR_CODES, OPENCLAW_ERROR_CODES } = require('../contracts/errorCodes');

function parsePluginError(error) {
    const rawMessage = error?.message || 'Unknown execution error';
    try {
        const parsed = JSON.parse(rawMessage);
        if (parsed && typeof parsed === 'object') {
            return parsed;
        }
    } catch (parseError) {
    }

    return {
        plugin_error: rawMessage
    };
}

function normalizePluginErrorMessage(error) {
    const parsedError = parsePluginError(error);
    return String(
        parsedError.plugin_error ||
        parsedError.plugin_execution_error ||
        parsedError.error ||
        error?.message ||
        'Unknown execution error'
    ).trim();
}

function mapErrorByCategory(category, details = {}) {
    if (category === 'validation') {
        return {
            status: 400,
            code: AGW_ERROR_CODES.VALIDATION_ERROR,
            error: 'Validation failed',
            details
        };
    }
    if (category === 'forbidden') {
        return {
            status: 403,
            code: AGW_ERROR_CODES.FORBIDDEN,
            error: 'Forbidden',
            details
        };
    }
    if (category === 'timeout') {
        return {
            status: 504,
            code: AGW_ERROR_CODES.TIMEOUT,
            error: 'Operation timed out',
            details
        };
    }
    return {
        status: 500,
        code: AGW_ERROR_CODES.INTERNAL_ERROR,
        error: 'Internal error',
        details
    };
}

function mapOpenClawMemoryWriteError(error) {
    const pluginError = normalizePluginErrorMessage(error);
    if (/missing|required|invalid|must be|security/i.test(pluginError)) {
        return {
            status: 400,
            code: OPENCLAW_ERROR_CODES.MEMORY_INVALID_PAYLOAD,
            error: 'Memory payload is invalid',
            details: { pluginError }
        };
    }

    return {
        status: 500,
        code: OPENCLAW_ERROR_CODES.MEMORY_WRITE_ERROR,
        error: 'Failed to persist memory',
        details: { pluginError }
    };
}

function mapOpenClawToolExecutionError(toolName, error) {
    const pluginError = normalizePluginErrorMessage(error);
    if (/not found/i.test(pluginError)) {
        return {
            status: 404,
            code: OPENCLAW_ERROR_CODES.TOOL_NOT_FOUND,
            error: 'Tool not found',
            details: { toolName, pluginError }
        };
    }
    if (/approval/i.test(pluginError) && /reject|required|cannot/i.test(pluginError)) {
        return {
            status: 403,
            code: OPENCLAW_ERROR_CODES.TOOL_APPROVAL_REQUIRED,
            error: 'Tool approval required',
            details: { toolName, pluginError }
        };
    }
    if (/timed out|timeout/i.test(pluginError)) {
        return {
            status: 504,
            code: OPENCLAW_ERROR_CODES.TOOL_TIMEOUT,
            error: 'Tool execution timed out',
            details: { toolName, pluginError }
        };
    }

    return {
        status: 500,
        code: OPENCLAW_ERROR_CODES.TOOL_EXECUTION_ERROR,
        error: 'Tool execution failed',
        details: { toolName, pluginError }
    };
}

module.exports = {
    parsePluginError,
    normalizePluginErrorMessage,
    mapErrorByCategory,
    mapOpenClawMemoryWriteError,
    mapOpenClawToolExecutionError
};
