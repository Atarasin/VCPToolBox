const express = require('express');
const crypto = require('crypto');
const packageJson = require('../package.json');

const OPENCLAW_BRIDGE_VERSION = 'v1';
const OPENCLAW_AUDIT_LOG_PREFIX = '[OpenClawBridgeAudit]';

function normalizeOpenClawString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function createOpenClawRequestId(providedRequestId) {
    const normalizedRequestId = normalizeOpenClawString(providedRequestId);
    if (normalizedRequestId) {
        return normalizedRequestId.slice(0, 128);
    }
    if (typeof crypto.randomUUID === 'function') {
        return `ocw_${crypto.randomUUID()}`;
    }
    return `ocw_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function setOpenClawBridgeHeaders(res, requestId) {
    res.set('x-request-id', requestId);
    res.set('x-openclaw-bridge-version', OPENCLAW_BRIDGE_VERSION);
}

function createOpenClawMeta(requestId, startedAt) {
    return {
        requestId,
        bridgeVersion: OPENCLAW_BRIDGE_VERSION,
        durationMs: Math.max(0, Date.now() - startedAt)
    };
}

function sendOpenClawSuccess(res, { status = 200, requestId, startedAt, data }) {
    setOpenClawBridgeHeaders(res, requestId);
    return res.status(status).json({
        success: true,
        data,
        meta: createOpenClawMeta(requestId, startedAt)
    });
}

function sendOpenClawError(res, { status, requestId, startedAt, code, error, details }) {
    setOpenClawBridgeHeaders(res, requestId);
    return res.status(status).json({
        success: false,
        error,
        code,
        details,
        meta: createOpenClawMeta(requestId, startedAt)
    });
}

function parseOpenClawBooleanQuery(value, defaultValue = false) {
    if (value === undefined) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalizedValue = value.trim().toLowerCase();
        if (normalizedValue === 'true') {
            return true;
        }
        if (normalizedValue === 'false') {
            return false;
        }
    }
    return defaultValue;
}

function isOpenClawBridgeablePlugin(plugin) {
    if (!plugin || typeof plugin !== 'object') {
        return false;
    }
    if (plugin.isDistributed) {
        return true;
    }
    if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
        return true;
    }
    return (
        (plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') &&
        plugin.communication?.protocol === 'stdio'
    );
}

function getOpenClawToolTimeoutMs(plugin) {
    const timeoutMs = plugin?.communication?.timeout ?? plugin?.entryPoint?.timeout ?? 0;
    return Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 0;
}

function parseInvocationCommandExample(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return [];
    }
    const params = new Set();
    const paramRegex = /([\w_]+)\s*:\s*「始」([\s\S]*?)「末」/g;
    let match;
    while ((match = paramRegex.exec(text)) !== null) {
        const key = normalizeOpenClawString(match[1]);
        if (key && key !== 'tool_name') {
            params.add(key);
        }
    }
    return Array.from(params);
}

function extractInvocationParameterHints(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return new Map();
    }
    const hints = new Map();
    const parameterRegex = /-\s*`([\w_]+)`\s*:\s*([^\n]+)/g;
    let match;
    while ((match = parameterRegex.exec(text)) !== null) {
        const key = normalizeOpenClawString(match[1]);
        const descriptor = normalizeOpenClawString(match[2]);
        if (!key) {
            continue;
        }
        const hint = hints.get(key) || { type: 'string', required: false };
        if (/固定为|必需|必须|required/i.test(descriptor)) {
            hint.required = true;
        }
        const fixedValueMatch = descriptor.match(/固定为\s*`([^`]+)`/);
        if (fixedValueMatch) {
            hint.const = fixedValueMatch[1];
        }
        if (/布尔|boolean/i.test(descriptor)) {
            hint.type = 'boolean';
        } else if (/数组|array/i.test(descriptor)) {
            hint.type = 'array';
        } else if (/整数|number|数值|float|int/i.test(descriptor)) {
            hint.type = 'number';
        }
        hints.set(key, hint);
    }
    return hints;
}

function buildOpenClawInvocationVariantSchema(invocationCommand) {
    if (!invocationCommand || typeof invocationCommand !== 'object') {
        return null;
    }
    const combinedText = [invocationCommand.description, invocationCommand.example].filter(Boolean).join('\n');
    const exampleParams = parseInvocationCommandExample(combinedText);
    const parameterHints = extractInvocationParameterHints(combinedText);
    const properties = {};
    const required = new Set();

    for (const parameterName of exampleParams) {
        properties[parameterName] = { type: 'string' };
        required.add(parameterName);
    }

    for (const [parameterName, hint] of parameterHints.entries()) {
        const property = properties[parameterName] || {};
        property.type = hint.type || property.type || 'string';
        if (hint.const !== undefined) {
            property.const = hint.const;
        }
        properties[parameterName] = property;
        if (hint.required) {
            required.add(parameterName);
        }
    }

    if (typeof invocationCommand.command === 'string' && invocationCommand.command.trim()) {
        properties.command = {
            type: 'string',
            const: invocationCommand.command.trim()
        };
        required.add('command');
    }

    const propertyNames = Object.keys(properties);
    if (propertyNames.length === 0) {
        return null;
    }

    const schema = {
        type: 'object',
        additionalProperties: true,
        properties
    };
    if (required.size > 0) {
        schema.required = Array.from(required);
    }
    return schema;
}

function getOpenClawToolInputSchema(plugin) {
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    const variantSchemas = invocationCommands
        .map((command) => buildOpenClawInvocationVariantSchema(command))
        .filter(Boolean);

    if (variantSchemas.length > 1) {
        return {
            oneOf: variantSchemas
        };
    }
    if (variantSchemas.length === 1) {
        return variantSchemas[0];
    }
    return {
        type: 'object',
        additionalProperties: true
    };
}

function summarizeOpenClawToolDescription(plugin) {
    const description = normalizeOpenClawString(plugin?.description);
    if (description) {
        return description;
    }
    const invocationCommands = Array.isArray(plugin?.capabilities?.invocationCommands)
        ? plugin.capabilities.invocationCommands
        : [];
    for (const invocationCommand of invocationCommands) {
        const invocationDescription = normalizeOpenClawString(invocationCommand?.description);
        if (invocationDescription) {
            return invocationDescription.split('\n')[0];
        }
    }
    return `${plugin?.displayName || plugin?.name || 'Unknown tool'} bridge`;
}

function createOpenClawToolDescriptor(plugin, pluginManager) {
    return {
        name: plugin.name,
        displayName: plugin.displayName || plugin.name,
        pluginType: plugin.pluginType || (plugin.isDistributed ? 'distributed' : 'unknown'),
        distributed: Boolean(plugin.isDistributed),
        approvalRequired: Boolean(pluginManager?.toolApprovalManager?.shouldApprove?.(plugin.name)),
        timeoutMs: getOpenClawToolTimeoutMs(plugin),
        description: summarizeOpenClawToolDescription(plugin),
        inputSchema: getOpenClawToolInputSchema(plugin)
    };
}

function createOpenClawMemoryDescriptor(includeTargets) {
    return {
        targets: includeTargets ? [] : [],
        features: {
            timeAware: false,
            groupAware: false,
            rerank: false,
            tagMemo: false,
            writeBack: false
        }
    };
}

function validateOpenClawSchemaValue(schema, value, pathName = 'args') {
    if (!schema || typeof schema !== 'object') {
        return [];
    }
    if (Array.isArray(schema.oneOf)) {
        const variantErrors = schema.oneOf
            .map((candidate) => validateOpenClawSchemaValue(candidate, value, pathName));
        if (variantErrors.some((errors) => errors.length === 0)) {
            return [];
        }
        return variantErrors[0] || [`${pathName} does not match any supported input shape`];
    }
    if (schema.const !== undefined && value !== schema.const) {
        return [`${pathName} must equal ${JSON.stringify(schema.const)}`];
    }
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return [`${pathName} must be an object`];
        }
        const errors = [];
        const required = Array.isArray(schema.required) ? schema.required : [];
        for (const key of required) {
            if (!(key in value)) {
                errors.push(`${pathName}.${key} is required`);
            }
        }
        const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                errors.push(...validateOpenClawSchemaValue(propertySchema, value[key], `${pathName}.${key}`));
            }
        }
        return errors;
    }
    if (schema.type === 'string' && typeof value !== 'string') {
        return [`${pathName} must be a string`];
    }
    if (schema.type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
        return [`${pathName} must be a number`];
    }
    if (schema.type === 'boolean' && typeof value !== 'boolean') {
        return [`${pathName} must be a boolean`];
    }
    if (schema.type === 'array' && !Array.isArray(value)) {
        return [`${pathName} must be an array`];
    }
    return [];
}

function parseOpenClawPluginError(error) {
    const rawMessage = error?.message || 'Unknown tool execution error';
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

function mapOpenClawToolExecutionError(toolName, error) {
    const parsedError = parseOpenClawPluginError(error);
    const pluginError = normalizeOpenClawString(
        parsedError.plugin_error ||
        parsedError.plugin_execution_error ||
        parsedError.error ||
        error?.message ||
        'Unknown tool execution error'
    );
    if (/not found/i.test(pluginError)) {
        return {
            status: 404,
            code: 'OCW_TOOL_NOT_FOUND',
            error: 'Tool not found',
            details: { toolName, pluginError }
        };
    }
    if (/approval/i.test(pluginError) && /reject|required|cannot/i.test(pluginError)) {
        return {
            status: 403,
            code: 'OCW_TOOL_APPROVAL_REQUIRED',
            error: 'Tool approval required',
            details: { toolName, pluginError }
        };
    }
    if (/timed out|timeout/i.test(pluginError)) {
        return {
            status: 504,
            code: 'OCW_TOOL_TIMEOUT',
            error: 'Tool execution timed out',
            details: { toolName, pluginError }
        };
    }
    return {
        status: 500,
        code: 'OCW_TOOL_EXECUTION_ERROR',
        error: 'Tool execution failed',
        details: { toolName, pluginError }
    };
}

function logOpenClawAudit(event, payload) {
    console.log(`${OPENCLAW_AUDIT_LOG_PREFIX} ${JSON.stringify({ event, ...payload })}`);
}

module.exports = function createOpenClawBridgeRoutes(pluginManager) {
    if (!pluginManager) {
        throw new Error('[OpenClawBridgeRoutes] pluginManager is required');
    }

    const router = express.Router();

    router.get('/openclaw/capabilities', async (req, res) => {
        const startedAt = Date.now();
        const agentId = normalizeOpenClawString(req.query.agentId);
        const requestId = createOpenClawRequestId(req.query.requestId);
        const includeMemoryTargets = parseOpenClawBooleanQuery(req.query.includeMemoryTargets, true);

        if (!agentId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'agentId is required',
                details: { field: 'agentId' }
            });
        }

        try {
            const tools = Array.from(pluginManager.plugins.values())
                .filter((plugin) => isOpenClawBridgeablePlugin(plugin))
                .sort((left, right) => left.name.localeCompare(right.name))
                .map((plugin) => createOpenClawToolDescriptor(plugin, pluginManager));

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    server: {
                        name: 'VCPToolBox',
                        version: packageJson.version,
                        bridgeVersion: OPENCLAW_BRIDGE_VERSION
                    },
                    tools,
                    memory: createOpenClawMemoryDescriptor(includeMemoryTargets)
                }
            });
        } catch (error) {
            console.error('[OpenClawBridgeRoutes] Error building OpenClaw capabilities:', error);
            return sendOpenClawError(res, {
                status: 500,
                requestId,
                startedAt,
                code: 'OCW_INTERNAL_ERROR',
                error: 'Failed to build bridge capabilities',
                details: { message: error.message }
            });
        }
    });

    router.post('/openclaw/tools/:toolName', async (req, res) => {
        const startedAt = Date.now();
        const toolName = normalizeOpenClawString(req.params.toolName);
        const args = req.body?.args;
        const requestContext = req.body?.requestContext;
        const requestId = createOpenClawRequestId(requestContext?.requestId);
        const agentId = normalizeOpenClawString(requestContext?.agentId);
        const sessionId = normalizeOpenClawString(requestContext?.sessionId);
        const source = normalizeOpenClawString(requestContext?.source) || 'openclaw';
        const clientIp = req.ip && req.ip.startsWith('::ffff:') ? req.ip.slice(7) : req.ip;

        if (!toolName) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'toolName is required',
                details: { field: 'toolName' }
            });
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_TOOL_INVALID_ARGS',
                error: 'args must be an object',
                details: { toolName }
            });
        }
        if (!agentId || !sessionId) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_INVALID_REQUEST',
                error: 'requestContext.agentId and requestContext.sessionId are required',
                details: { toolName }
            });
        }

        const plugin = pluginManager.getPlugin(toolName);
        if (!plugin || !isOpenClawBridgeablePlugin(plugin)) {
            return sendOpenClawError(res, {
                status: 404,
                requestId,
                startedAt,
                code: 'OCW_TOOL_NOT_FOUND',
                error: 'Tool not found',
                details: { toolName }
            });
        }

        if (pluginManager.toolApprovalManager?.shouldApprove?.(toolName)) {
            logOpenClawAudit('tool.approval_required', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId
            });
            return sendOpenClawError(res, {
                status: 403,
                requestId,
                startedAt,
                code: 'OCW_TOOL_APPROVAL_REQUIRED',
                error: 'Tool approval required',
                details: { toolName }
            });
        }

        const inputSchema = getOpenClawToolInputSchema(plugin);
        const validationErrors = validateOpenClawSchemaValue(inputSchema, args);
        if (validationErrors.length > 0) {
            return sendOpenClawError(res, {
                status: 400,
                requestId,
                startedAt,
                code: 'OCW_TOOL_INVALID_ARGS',
                error: 'Tool arguments do not match input schema',
                details: {
                    toolName,
                    issues: validationErrors
                }
            });
        }

        logOpenClawAudit('tool.invoke.started', {
            requestId,
            toolName,
            source,
            agentId,
            sessionId,
            distributed: Boolean(plugin.isDistributed)
        });

        try {
            const result = await pluginManager.processToolCall(toolName, {
                ...args,
                __openclawContext: {
                    source,
                    agentId,
                    sessionId,
                    requestId
                }
            }, clientIp);

            logOpenClawAudit('tool.invoke.completed', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId,
                distributed: Boolean(plugin.isDistributed),
                durationMs: Math.max(0, Date.now() - startedAt)
            });

            return sendOpenClawSuccess(res, {
                requestId,
                startedAt,
                data: {
                    toolName,
                    result,
                    audit: {
                        approvalUsed: false,
                        distributed: Boolean(plugin.isDistributed)
                    }
                }
            });
        } catch (error) {
            const mappedError = mapOpenClawToolExecutionError(toolName, error);
            logOpenClawAudit('tool.invoke.failed', {
                requestId,
                toolName,
                source,
                agentId,
                sessionId,
                distributed: Boolean(plugin.isDistributed),
                durationMs: Math.max(0, Date.now() - startedAt),
                code: mappedError.code
            });
            return sendOpenClawError(res, {
                status: mappedError.status,
                requestId,
                startedAt,
                code: mappedError.code,
                error: mappedError.error,
                details: mappedError.details
            });
        }
    });

    return router;
};
