const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    OPENCLAW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    mapOpenClawToolExecutionError
} = require('../infra/errorMapper');
const {
    createAuditLogger
} = require('../infra/auditLogger');

const DEFAULT_MEMORY_BRIDGE_TOOL_NAME = 'vcp_memory_write';

function normalizeToolRuntimeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeToolRuntimeRequestContext(input, defaultSource) {
    return normalizeRequestContext(input, {
        defaultSource,
        defaultRuntime: 'openclaw',
        requestIdPrefix: 'ocw'
    });
}

function isBridgeablePlugin(plugin) {
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

function validateToolSchemaValue(schema, value, pathName = 'args') {
    if (!schema || typeof schema !== 'object') {
        return [];
    }

    if (Array.isArray(schema.oneOf)) {
        const variantErrors = schema.oneOf
            .map((candidate) => validateToolSchemaValue(candidate, value, pathName));
        if (variantErrors.some((errors) => errors.length === 0)) {
            return [];
        }
        return variantErrors[0] || [];
    }

    if (schema.const !== undefined) {
        return value === schema.const ? [] : [`${pathName} must be ${JSON.stringify(schema.const)}`];
    }

    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return [`${pathName} must be an object`];
        }

        const errors = [];
        const properties = schema.properties || {};
        const required = Array.isArray(schema.required) ? schema.required : [];

        required.forEach((key) => {
            if (!(key in value)) {
                errors.push(`${pathName}.${key} is required`);
            }
        });

        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                errors.push(...validateToolSchemaValue(propertySchema, value[key], `${pathName}.${key}`));
            }
        }

        return errors;
    }

    if (schema.type === 'array') {
        return Array.isArray(value) ? [] : [`${pathName} must be an array`];
    }
    if (schema.type === 'integer') {
        return Number.isInteger(value) ? [] : [`${pathName} must be an integer`];
    }
    if (schema.type === 'number') {
        return typeof value === 'number' && Number.isFinite(value) ? [] : [`${pathName} must be a number`];
    }
    if (schema.type === 'boolean') {
        return typeof value === 'boolean' ? [] : [`${pathName} must be a boolean`];
    }
    if (schema.type === 'string') {
        return typeof value === 'string' ? [] : [`${pathName} must be a string`];
    }

    return [];
}

function createLegacyOpenClawContext(requestContext) {
    return {
        source: requestContext.source,
        agentId: requestContext.agentId,
        sessionId: requestContext.sessionId,
        requestId: requestContext.requestId
    };
}

function createAgentGatewayContext(requestContext, extra = {}) {
    return {
        runtime: requestContext.runtime,
        source: requestContext.source,
        agentId: requestContext.agentId,
        sessionId: requestContext.sessionId,
        requestId: requestContext.requestId,
        ...extra
    };
}

function getToolInvocationStore(pluginManager) {
    if (!pluginManager.__agentGatewayToolInvocationStore) {
        pluginManager.__agentGatewayToolInvocationStore = new Map();
    }
    return pluginManager.__agentGatewayToolInvocationStore;
}

function createToolInvocationStoreKey(toolName, idempotencyKey) {
    const normalizedToolName = normalizeToolRuntimeString(toolName);
    const normalizedIdempotencyKey = normalizeToolRuntimeString(idempotencyKey);
    if (!normalizedToolName || !normalizedIdempotencyKey) {
        return '';
    }
    return `${normalizedToolName}::${normalizedIdempotencyKey}`;
}

function cloneToolInvocationResult(result, requestId) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    return {
        ...result,
        requestId,
        details: result.details && typeof result.details === 'object'
            ? { ...result.details }
            : result.details,
        data: result.data && typeof result.data === 'object'
            ? { ...result.data, idempotentReplay: true }
            : result.data
    };
}

function createBridgeRequestBody(args, requestContext, bridgeToolName) {
    return {
        target: {
            diary: args.diary,
            maid: args.maid
        },
        memory: {
            text: args.text,
            tags: args.tags,
            timestamp: args.timestamp,
            metadata: args.metadata
        },
        options: {
            idempotencyKey: args.idempotencyKey,
            deduplicate: args.deduplicate,
            bridgeToolName
        },
        requestContext
    };
}

/**
 * ToolRuntimeService 统一接管普通 tool invoke 与 memory bridge 的执行入口。
 */
function createToolRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    if (!pluginManager) {
        throw new Error('[ToolRuntimeService] pluginManager is required');
    }
    const schemaRegistry = deps.schemaRegistry;
    if (!schemaRegistry || typeof schemaRegistry.getToolInputSchema !== 'function') {
        throw new Error('[ToolRuntimeService] schemaRegistry is required');
    }
    const memoryRuntimeService = deps.memoryRuntimeService;
    if (!memoryRuntimeService || typeof memoryRuntimeService.writeMemory !== 'function') {
        throw new Error('[ToolRuntimeService] memoryRuntimeService is required');
    }

    const auditLogger = deps.auditLogger && typeof deps.auditLogger.logToolInvoke === 'function'
        ? deps.auditLogger
        : createAuditLogger();
    const mapToolExecutionError = typeof deps.mapToolExecutionError === 'function'
        ? deps.mapToolExecutionError
        : mapOpenClawToolExecutionError;
    const memoryBridgeToolName = normalizeToolRuntimeString(deps.memoryBridgeToolName) || DEFAULT_MEMORY_BRIDGE_TOOL_NAME;
    const authContextResolver = typeof deps.authContextResolver === 'function'
        ? deps.authContextResolver
        : null;
    const agentPolicyResolver = deps.agentPolicyResolver &&
        typeof deps.agentPolicyResolver.resolvePolicy === 'function'
        ? deps.agentPolicyResolver
        : null;
    const toolScopeGuard = typeof deps.toolScopeGuard === 'function'
        ? deps.toolScopeGuard
        : null;
    const jobRuntimeService = deps.jobRuntimeService || null;

    return {
        async invokeTool({ toolName, body, startedAt, clientIp, defaultSource }) {
            const normalizedToolName = normalizeToolRuntimeString(toolName);
            const args = body?.args;
            const requestContext = normalizeToolRuntimeRequestContext(body?.requestContext, defaultSource);
            const authContext = authContextResolver
                ? authContextResolver({
                    authContext: body?.authContext,
                    requestContext,
                    maid: body?.maid,
                    adapter: requestContext.runtime
                })
                : requestContext;
            const requestId = requestContext.requestId;
            const agentId = requestContext.agentId;
            const sessionId = requestContext.sessionId;
            const source = requestContext.source;
            const options = body?.options && typeof body.options === 'object' ? body.options : {};
            const idempotencyKey = normalizeToolRuntimeString(options.idempotencyKey || body?.idempotencyKey);
            const invocationStore = getToolInvocationStore(pluginManager);
            const invocationStoreKey = createToolInvocationStoreKey(normalizedToolName, idempotencyKey);

            if (!normalizedToolName) {
                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: 400,
                    code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                    error: 'toolName is required',
                    details: { field: 'toolName' }
                };
            }
            if (!args || typeof args !== 'object' || Array.isArray(args)) {
                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: 400,
                    code: OPENCLAW_ERROR_CODES.TOOL_INVALID_ARGS,
                    error: 'args must be an object',
                    details: { toolName: normalizedToolName }
                };
            }
            if (!agentId || !sessionId) {
                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: 400,
                    code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
                    error: 'requestContext.agentId and requestContext.sessionId are required',
                    details: { toolName: normalizedToolName }
                };
            }

            if (invocationStoreKey && invocationStore.has(invocationStoreKey)) {
                const previousResult = invocationStore.get(invocationStoreKey);
                auditLogger.logToolInvoke('invoke.duplicate', {
                    requestId,
                    toolName: normalizedToolName,
                    source,
                    agentId,
                    sessionId
                }, startedAt);
                return cloneToolInvocationResult(previousResult, requestId);
            }

            if (normalizedToolName === memoryBridgeToolName) {
                const bridgeResult = await memoryRuntimeService.writeMemory({
                    body: createBridgeRequestBody(args, requestContext, memoryBridgeToolName),
                    startedAt,
                    clientIp,
                    defaultSource: 'openclaw-memory-write'
                });

                if (!bridgeResult.success) {
                    return {
                        success: false,
                        status: 'failed',
                        requestId: bridgeResult.requestId,
                        httpStatus: bridgeResult.status,
                        code: bridgeResult.code,
                        error: bridgeResult.error,
                        details: bridgeResult.details
                    };
                }

                return {
                    success: true,
                    status: 'completed',
                    requestId: bridgeResult.requestId,
                    data: {
                        toolName: normalizedToolName,
                        result: bridgeResult.data,
                        audit: {
                            approvalUsed: false,
                            distributed: false
                        }
                    }
                };
            }

            const plugin = pluginManager.getPlugin?.(normalizedToolName) || pluginManager.plugins?.get?.(normalizedToolName);
            if (!plugin || !isBridgeablePlugin(plugin)) {
                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: 404,
                    code: OPENCLAW_ERROR_CODES.TOOL_NOT_FOUND,
                    error: 'Tool not found',
                    details: { toolName: normalizedToolName }
                };
            }

            if (agentPolicyResolver && toolScopeGuard) {
                try {
                    const policy = await agentPolicyResolver.resolvePolicy({
                        authContext
                    });
                    toolScopeGuard({
                        policy,
                        toolName: normalizedToolName,
                        authContext
                    });
                } catch (error) {
                    return {
                        success: false,
                        status: 'failed',
                        requestId,
                        httpStatus: 403,
                        code: OPENCLAW_ERROR_CODES.TOOL_FORBIDDEN,
                        error: 'Requested tool is not allowed for this agent',
                        details: {
                            toolName: normalizedToolName,
                            canonicalCode: error.code || ''
                        }
                    };
                }
            }

            if (pluginManager.toolApprovalManager?.shouldApprove?.(normalizedToolName)) {
                auditLogger.logToolInvoke('approval_required', {
                    requestId,
                    toolName: normalizedToolName,
                    source,
                    agentId,
                    sessionId
                });
                return {
                    success: false,
                    status: 'waiting_approval',
                    requestId,
                    httpStatus: 403,
                    code: OPENCLAW_ERROR_CODES.TOOL_APPROVAL_REQUIRED,
                    error: 'Tool approval required',
                    details: {
                        toolName: normalizedToolName,
                        job: jobRuntimeService
                            ? jobRuntimeService.createWaitingApprovalJob({
                                operation: 'tool.invoke',
                                authContext,
                                target: {
                                    type: 'tool',
                                    id: normalizedToolName
                                },
                                metadata: {
                                    toolName: normalizedToolName
                                }
                            })
                            : null
                    }
                };
            }

            const inputSchema = schemaRegistry.getToolInputSchema(plugin);
            const validationErrors = validateToolSchemaValue(inputSchema, args);
            if (validationErrors.length > 0) {
                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: 400,
                    code: OPENCLAW_ERROR_CODES.TOOL_INVALID_ARGS,
                    error: 'Tool arguments do not match input schema',
                    details: {
                        toolName: normalizedToolName,
                        issues: validationErrors
                    }
                };
            }

            auditLogger.logToolInvoke('invoke.started', {
                requestId,
                toolName: normalizedToolName,
                source,
                agentId,
                sessionId,
                distributed: Boolean(plugin.isDistributed)
            });

            const agentGatewayContext = createAgentGatewayContext(requestContext, {
                toolName: normalizedToolName
            });
            const openClawContext = createLegacyOpenClawContext(requestContext);

            try {
                const result = await pluginManager.processToolCall(normalizedToolName, {
                    ...args,
                    __agentGatewayContext: agentGatewayContext,
                    __openclawContext: openClawContext
                }, clientIp);

                auditLogger.logToolInvoke('invoke.completed', {
                    requestId,
                    toolName: normalizedToolName,
                    source,
                    agentId,
                    sessionId,
                    distributed: Boolean(plugin.isDistributed)
                }, startedAt);

                const completedResult = {
                    success: true,
                    status: 'completed',
                    requestId,
                    data: {
                        toolName: normalizedToolName,
                        result,
                        audit: {
                            approvalUsed: false,
                            distributed: Boolean(plugin.isDistributed)
                        }
                    }
                };
                if (invocationStoreKey) {
                    invocationStore.set(invocationStoreKey, completedResult);
                }
                return completedResult;
            } catch (error) {
                const mappedError = mapToolExecutionError(normalizedToolName, error);
                auditLogger.logToolInvoke('invoke.failed', {
                    requestId,
                    toolName: normalizedToolName,
                    source,
                    agentId,
                    sessionId,
                    distributed: Boolean(plugin.isDistributed),
                    code: mappedError.code
                }, startedAt);

                return {
                    success: false,
                    status: 'failed',
                    requestId,
                    httpStatus: mappedError.status,
                    code: mappedError.code,
                    error: mappedError.error,
                    details: mappedError.details
                };
            }
        }
    };
}

module.exports = {
    createToolRuntimeService
};
