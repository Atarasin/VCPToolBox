const {
    normalizeRequestContext
} = require('../contracts/requestContext');
const {
    OPENCLAW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    mapOpenClawToolExecutionError
} = require('../infra/errorMapper');

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
            diary: args.diary
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

function createToolRuntimeContext(deps = {}) {
    const toolInvokerPort = deps.toolInvokerPort;
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
        : { logToolInvoke() {} };
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
    return {
        toolInvokerPort,
        schemaRegistry,
        memoryRuntimeService,
        auditLogger,
        mapToolExecutionError,
        memoryBridgeToolName,
        authContextResolver,
        agentPolicyResolver,
        toolScopeGuard,
        jobRuntimeService: deps.jobRuntimeService || null,
        invocationStore: new Map()
    };
}

function normalizeToolInvocation(state, input) {
    const { toolName, body, startedAt, clientIp, defaultSource } = input;
    const normalizedToolName = normalizeToolRuntimeString(toolName);
    const requestContext = normalizeToolRuntimeRequestContext(body?.requestContext, defaultSource);
    const authContext = state.authContextResolver
        ? state.authContextResolver({ authContext: body?.authContext, requestContext, adapter: requestContext.runtime })
        : requestContext;
    const options = body?.options && typeof body.options === 'object' ? body.options : {};
    const idempotencyKey = normalizeToolRuntimeString(options.idempotencyKey || body?.idempotencyKey);
    const invocationStore = state.invocationStore;
    return {
        state, body, startedAt, clientIp, normalizedToolName, args: body?.args,
        requestContext, authContext, requestId: requestContext.requestId,
        agentId: requestContext.agentId, sessionId: requestContext.sessionId,
        source: requestContext.source, invocationStore,
        invocationStoreKey: createToolInvocationStoreKey(normalizedToolName, idempotencyKey)
    };
}

function invalidInvocation(ctx) {
    if (!ctx.normalizedToolName) {
        return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 400,
            code: OPENCLAW_ERROR_CODES.INVALID_REQUEST, error: 'toolName is required', details: { field: 'toolName' } };
    }
    if (!ctx.args || typeof ctx.args !== 'object' || Array.isArray(ctx.args)) {
        return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 400,
            code: OPENCLAW_ERROR_CODES.TOOL_INVALID_ARGS, error: 'args must be an object',
            details: { toolName: ctx.normalizedToolName } };
    }
    if (!ctx.agentId || !ctx.sessionId) {
        return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 400,
            code: OPENCLAW_ERROR_CODES.INVALID_REQUEST,
            error: 'requestContext.agentId and requestContext.sessionId are required',
            details: { toolName: ctx.normalizedToolName } };
    }
    return null;
}

function replayInvocation(ctx) {
    if (!ctx.invocationStoreKey || !ctx.invocationStore.has(ctx.invocationStoreKey)) return null;
    ctx.state.auditLogger.logToolInvoke('invoke.duplicate', {
        requestId: ctx.requestId, toolName: ctx.normalizedToolName, source: ctx.source,
        agentId: ctx.agentId, sessionId: ctx.sessionId
    }, ctx.startedAt);
    return cloneToolInvocationResult(ctx.invocationStore.get(ctx.invocationStoreKey), ctx.requestId);
}

async function invokeMemoryBridge(ctx) {
    if (ctx.normalizedToolName !== ctx.state.memoryBridgeToolName) return null;
    const bridgeResult = await ctx.state.memoryRuntimeService.writeMemory({
        body: createBridgeRequestBody(ctx.args, ctx.requestContext, ctx.state.memoryBridgeToolName),
        startedAt: ctx.startedAt, clientIp: ctx.clientIp, defaultSource: 'openclaw-memory-write'
    });
    if (!bridgeResult.success) {
        return { success: false, status: 'failed', requestId: bridgeResult.requestId,
            httpStatus: bridgeResult.status, code: bridgeResult.code, error: bridgeResult.error,
            details: bridgeResult.details };
    }
    return { success: true, status: 'completed', requestId: bridgeResult.requestId,
        data: { toolName: ctx.normalizedToolName, result: bridgeResult.data,
            audit: { approvalUsed: false, distributed: false } } };
}

function resolveInvocationPlugin(ctx) {
    const plugin = ctx.state.toolInvokerPort?.getTool?.(ctx.normalizedToolName) || null;
    if (plugin && isBridgeablePlugin(plugin)) return { plugin };
    return { failure: { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 404,
        code: OPENCLAW_ERROR_CODES.TOOL_NOT_FOUND, error: 'Tool not found',
        details: { toolName: ctx.normalizedToolName } } };
}

async function authorizeInvocation(ctx) {
    if (!ctx.state.agentPolicyResolver || !ctx.state.toolScopeGuard) return null;
    try {
        const policy = await ctx.state.agentPolicyResolver.resolvePolicy({ authContext: ctx.authContext });
        ctx.state.toolScopeGuard({ policy, toolName: ctx.normalizedToolName, authContext: ctx.authContext });
        return null;
    } catch (error) {
        return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 403,
            code: OPENCLAW_ERROR_CODES.TOOL_FORBIDDEN,
            error: 'Requested tool is not allowed for this agent',
            details: { toolName: ctx.normalizedToolName, canonicalCode: error.code || '' } };
    }
}

function buildApprovalResult(ctx, plugin) {
    const requiresApproval = ctx.state.toolInvokerPort?.requiresApproval?.(ctx.normalizedToolName) || false;
    if (!requiresApproval) return null;
    const job = ctx.state.jobRuntimeService?.createWaitingApprovalJob({
        operation: 'tool.invoke', authContext: ctx.authContext,
        target: { type: 'tool', id: ctx.normalizedToolName }, metadata: { toolName: ctx.normalizedToolName }
    }) || null;
    ctx.state.auditLogger.logToolInvoke('approval_required', {
        requestId: ctx.requestId, toolName: ctx.normalizedToolName, source: ctx.source,
        agentId: ctx.agentId, sessionId: ctx.sessionId
    });
    return { success: true, status: 'waiting_approval', requestId: ctx.requestId, httpStatus: 202,
        data: { toolName: ctx.normalizedToolName, job,
            runtime: { deferred: true, status: 'waiting_approval' },
            audit: { approvalUsed: true, distributed: Boolean(plugin.isDistributed) } },
        details: { toolName: ctx.normalizedToolName, job },
        code: OPENCLAW_ERROR_CODES.TOOL_APPROVAL_REQUIRED, error: 'Tool approval required' };
}

function validateInvocationSchema(ctx, plugin) {
    const issues = validateToolSchemaValue(ctx.state.schemaRegistry.getToolInputSchema(plugin), ctx.args);
    if (issues.length === 0) return null;
    return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: 400,
        code: OPENCLAW_ERROR_CODES.TOOL_INVALID_ARGS, error: 'Tool arguments do not match input schema',
        details: { toolName: ctx.normalizedToolName, issues } };
}

async function executeInvocation(ctx, plugin) {
    const audit = { requestId: ctx.requestId, toolName: ctx.normalizedToolName, source: ctx.source,
        agentId: ctx.agentId, sessionId: ctx.sessionId, distributed: Boolean(plugin.isDistributed) };
    ctx.state.auditLogger.logToolInvoke('invoke.started', audit);
    const invocationArgs = { ...ctx.args,
        __agentGatewayContext: createAgentGatewayContext(ctx.requestContext, { toolName: ctx.normalizedToolName }),
        __openclawContext: createLegacyOpenClawContext(ctx.requestContext) };
    try {
        const result = await ctx.state.toolInvokerPort.invoke(
            ctx.normalizedToolName, invocationArgs, ctx.clientIp
        );
        ctx.state.auditLogger.logToolInvoke('invoke.completed', audit, ctx.startedAt);
        const completed = { success: true, status: 'completed', requestId: ctx.requestId,
            data: { toolName: ctx.normalizedToolName, result,
                audit: { approvalUsed: false, distributed: Boolean(plugin.isDistributed) } } };
        if (ctx.invocationStoreKey) ctx.invocationStore.set(ctx.invocationStoreKey, completed);
        return completed;
    } catch (error) {
        const mapped = ctx.state.mapToolExecutionError(ctx.normalizedToolName, error);
        ctx.state.auditLogger.logToolInvoke('invoke.failed', { ...audit, code: mapped.code }, ctx.startedAt);
        return { success: false, status: 'failed', requestId: ctx.requestId, httpStatus: mapped.status,
            code: mapped.code, error: mapped.error, details: mapped.details };
    }
}

async function invokeTool(state, input) {
    const ctx = normalizeToolInvocation(state, input);
    const immediate = invalidInvocation(ctx) || replayInvocation(ctx);
    if (immediate) return immediate;
    const bridgeResult = await invokeMemoryBridge(ctx);
    if (bridgeResult) return bridgeResult;
    const { plugin, failure } = resolveInvocationPlugin(ctx);
    if (failure) return failure;
    const forbidden = await authorizeInvocation(ctx);
    if (forbidden) return forbidden;
    const approval = buildApprovalResult(ctx, plugin);
    if (approval) return approval;
    const invalidArgs = validateInvocationSchema(ctx, plugin);
    return invalidArgs || executeInvocation(ctx, plugin);
}

/** ToolRuntimeService 统一接管普通 tool invoke 与 memory bridge 的执行入口。 */
function createToolRuntimeService(deps = {}) {
    const state = createToolRuntimeContext(deps);
    return { invokeTool: (input) => invokeTool(state, input) };
}

module.exports = {
    createToolRuntimeService
};
