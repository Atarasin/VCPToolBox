const {
    getGatewayServiceBundle
} = require('../createGatewayServiceBundle');
const {
    normalizeRequestContext,
    sanitizeRequestContextValue
} = require('../contracts/requestContext');
const {
    OPENCLAW_TO_AGENT_GATEWAY_CODE,
    OPENCLAW_ERROR_CODES,
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    beginGatewayManagedOperation,
    buildGatewayManagedClientPayload,
    buildGatewayManagedOperationRejection,
    buildOperabilityMetadata,
    finishGatewayManagedOperation
} = require('./mcpGatewayOperability');
const {
    MCP_RESOURCE_KINDS,
    MCP_GATEWAY_TOOL_NAMES,
    MCP_GATEWAY_PROMPT_NAMES,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    buildMcpToolDescriptor,
    createGatewayManagedPromptDescriptors,
    createGatewayManagedToolDescriptors,
    buildJobEventsResourceUri,
    buildResourceUri,
    parseResourceUri,
    createCapabilitiesResource,
    createMemoryTargetsResource,
    createAgentProfileResource,
    createAgentPromptTemplateResource,
    createJobEventsResource
} = require('./mcpDescriptorRegistry');
const packageMetadata = require('../../../package.json');

const MCP_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'MCP_INVALID_REQUEST',
    INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
    FORBIDDEN: 'MCP_FORBIDDEN',
    NOT_FOUND: 'MCP_NOT_FOUND',
    TIMEOUT: 'MCP_TIMEOUT',
    RUNTIME_ERROR: 'MCP_RUNTIME_ERROR',
    RESOURCE_UNSUPPORTED: 'MCP_RESOURCE_UNSUPPORTED'
});

function normalizeMcpString(value, maxLength = 128) {
    return sanitizeRequestContextValue(value, maxLength);
}

function createMcpError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

function serializeMcpValue(value) {
    if (typeof value === 'string') {
        return value;
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch (error) {
        return String(value);
    }
}

function createMcpTextContent(value) {
    return [{
        type: 'text',
        text: serializeMcpValue(value)
    }];
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


function mapGatewayFailureToMcpErrorCode(code) {
    const canonicalCode = OPENCLAW_TO_AGENT_GATEWAY_CODE[code] || code || AGW_ERROR_CODES.INTERNAL_ERROR;
    switch (canonicalCode) {
    case AGW_ERROR_CODES.INVALID_REQUEST:
        return MCP_ERROR_CODES.INVALID_REQUEST;
    case AGW_ERROR_CODES.VALIDATION_ERROR:
        return MCP_ERROR_CODES.INVALID_ARGUMENTS;
    case AGW_ERROR_CODES.FORBIDDEN:
        return MCP_ERROR_CODES.FORBIDDEN;
    case AGW_ERROR_CODES.NOT_FOUND:
        return MCP_ERROR_CODES.NOT_FOUND;
    case AGW_ERROR_CODES.TIMEOUT:
        return MCP_ERROR_CODES.TIMEOUT;
    default:
        return MCP_ERROR_CODES.RUNTIME_ERROR;
    }
}

function createFailureResult(result, options = {}) {
    const operability = options.operability && typeof options.operability === 'object'
        ? options.operability
        : {};

    return {
        isError: true,
        status: 'failed',
        error: {
            code: mapGatewayFailureToMcpErrorCode(result?.code),
            message: result?.error || 'MCP tool call failed',
            details: {
                canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result?.code] || result?.code || '',
                gatewayCode: result?.code || '',
                requestId: result?.requestId || '',
                gatewayStatus: typeof result?.status === 'number' ? result.status : undefined,
                ...(operability.traceId ? { traceId: operability.traceId } : {}),
                ...(operability.operationName ? { operationName: operability.operationName } : {}),
                ...(operability.retryAfterMs > 0 ? { retryAfterMs: operability.retryAfterMs } : {}),
                ...(operability.category ? { rejectionCategory: operability.category } : {}),
                ...(operability.category ? { retryable: operability.retryable } : {}),
                ...((result?.details && typeof result.details === 'object') ? result.details : {})
            }
        },
        content: createMcpTextContent({
            error: result?.error || 'MCP tool call failed',
            code: mapGatewayFailureToMcpErrorCode(result?.code),
            requestId: result?.requestId || '',
            details: {
                gatewayStatus: typeof result?.status === 'number' ? result.status : undefined,
                ...(operability.traceId ? { traceId: operability.traceId } : {}),
                ...(operability.operationName ? { operationName: operability.operationName } : {}),
                ...(operability.retryAfterMs > 0 ? { retryAfterMs: operability.retryAfterMs } : {}),
                ...(operability.category ? { rejectionCategory: operability.category } : {}),
                ...(operability.category ? { retryable: operability.retryable } : {}),
                ...(result?.details || {})
            }
        })
    };
}

function createSuccessResult(result, options = {}) {
    const operability = options.operability && typeof options.operability === 'object'
        ? options.operability
        : {};
    return {
        isError: false,
        status: 'completed',
        structuredContent: {
            status: 'completed',
            requestId: result.requestId,
            toolName: result.data.toolName,
            result: result.data.result,
            audit: result.data.audit,
            operability
        },
        content: createMcpTextContent(result.data.result)
    };
}

function createDeferredResult(result) {
    return createDeferredResultEnvelope({
        requestId: result.requestId,
        status: result.status,
        toolName: result.data?.toolName || '',
        runtime: result.data?.runtime || {},
        job: result.data?.job || null,
        audit: result.data?.audit || {},
        operability: {}
    });
}

function buildDeferredRuntime(runtime, job) {
    const normalizedRuntime = runtime && typeof runtime === 'object'
        ? { ...runtime }
        : {};
    const eventResourceUri = job?.jobId ? buildJobEventsResourceUri(job.jobId) : '';

    return {
        ...normalizedRuntime,
        deferred: true,
        status: normalizedRuntime.status || normalizeMcpString(job?.status, 64),
        ...(eventResourceUri ? { eventResourceUri } : {})
    };
}

function createDeferredResultEnvelope({
    requestId,
    status,
    toolName,
    runtime,
    job,
    audit,
    operability
}) {
    const shapedRuntime = buildDeferredRuntime(runtime, job);
    const shapedOperability = operability && typeof operability === 'object'
        ? operability
        : {};

    return {
        isError: false,
        status,
        deferred: true,
        structuredContent: {
            status,
            requestId,
            toolName,
            runtime: shapedRuntime,
            job: job || null,
            audit: audit || {},
            operability: shapedOperability
        },
        content: createMcpTextContent({
            status,
            requestId,
            job: job || null,
            runtime: shapedRuntime,
            message: status === 'waiting_approval'
                ? 'Tool approval is required before execution can continue.'
                : 'Tool execution was accepted for deferred processing.',
            ...(shapedOperability.traceId ? { traceId: shapedOperability.traceId } : {})
        })
    };
}

function createGatewayManagedContent(name, data) {
    if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER && data && typeof data.renderedPrompt === 'string') {
        return createMcpTextContent(data.renderedPrompt);
    }
    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING && data && typeof data.committedMemory === 'string') {
        return createMcpTextContent(data.committedMemory);
    }
    if (name === MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING && data && typeof data.codingContext === 'string') {
        return createMcpTextContent(data.codingContext);
    }
    return createMcpTextContent(data);
}

function createGatewayManagedSuccessResult(name, result, options = {}) {
    const operability = options.operability && typeof options.operability === 'object'
        ? options.operability
        : {};
    return {
        isError: false,
        status: 'completed',
        structuredContent: {
            status: 'completed',
            requestId: result.requestId,
            toolName: name,
            result: result.data,
            audit: result.audit || {},
            operability
        },
        content: createGatewayManagedContent(name, result.data)
    };
}

function createGatewayManagedDeferredResult(name, result, options = {}) {
    const operability = options.operability && typeof options.operability === 'object'
        ? options.operability
        : {};
    return createDeferredResultEnvelope({
        requestId: result.requestId,
        status: result.status,
        toolName: name,
        runtime: result.data?.runtime || {},
        job: result.data?.job || null,
        audit: result.audit || {},
        operability
    });
}

function createPromptErrorDetails(result, operability = {}) {
    return {
        canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result?.code] || result?.code || '',
        gatewayCode: result?.code || '',
        requestId: result?.requestId || '',
        gatewayStatus: typeof result?.status === 'number' ? result.status : undefined,
        ...(operability.traceId ? { traceId: operability.traceId } : {}),
        ...(operability.operationName ? { operationName: operability.operationName } : {}),
        ...(operability.retryAfterMs > 0 ? { retryAfterMs: operability.retryAfterMs } : {}),
        ...(operability.category ? { rejectionCategory: operability.category } : {}),
        ...(operability.category ? { retryable: operability.retryable } : {}),
        ...((result?.details && typeof result.details === 'object') ? result.details : {})
    };
}

function throwGatewayManagedMcpError(result, operationControl = null) {
    const operability = buildOperabilityMetadata(operationControl, result);
    throw createMcpError(
        mapGatewayFailureToMcpErrorCode(result?.code),
        result?.error || 'MCP prompt request failed',
        createPromptErrorDetails(result, operability)
    );
}

function mapToolRuntimeResultToMcp(result) {
    if (!result || typeof result !== 'object') {
        return createFailureResult({
            error: 'Tool runtime returned an invalid result',
            code: OPENCLAW_ERROR_CODES.TOOL_EXECUTION_ERROR
        });
    }

    if (result.success && result.status === 'completed') {
        return createSuccessResult(result);
    }

    if (result.success && (result.status === 'waiting_approval' || result.status === 'accepted')) {
        return createDeferredResult(result);
    }

    return createFailureResult(result);
}

function mapGatewayManagedResultToMcp(name, result, operationControl = null) {
    if (!result || typeof result !== 'object') {
        return createFailureResult({
            error: 'Gateway runtime returned an invalid result',
            code: OPENCLAW_ERROR_CODES.INTERNAL_ERROR
        });
    }

    const operability = buildOperabilityMetadata(operationControl, result);

    if (result.success && (result.status === 'waiting_approval' || result.status === 'accepted')) {
        return createGatewayManagedDeferredResult(name, result, {
            operability
        });
    }

    if (result.success) {
        return createGatewayManagedSuccessResult(name, result, {
            operability
        });
    }

    return createFailureResult(result, {
        operability
    });
}

function normalizeMcpArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return null;
    }
    return args;
}

function isGatewayManagedTool(name) {
    return Object.values(MCP_GATEWAY_TOOL_NAMES).includes(name);
}

function buildManagedToolContextInput(input, args) {
    return {
        ...input,
        agentId: input.agentId || args.agentId || args.target?.agentId || input.requestContext?.agentId,
        sessionId: input.sessionId || args.sessionId || input.requestContext?.sessionId,
        requestContext: (args.requestContext && typeof args.requestContext === 'object')
            ? {
                ...args.requestContext,
                ...((input.requestContext && typeof input.requestContext === 'object') ? input.requestContext : {})
            }
            : input.requestContext,
        authContext: input.authContext || args.authContext,
        maid: input.maid || args.maid || args.target?.maid || input.requestContext?.maid
    };
}

function mapAgentRegistryError(error, requestContext) {
    if (error?.code === 'AGENT_NOT_FOUND') {
        return {
            success: false,
            status: 404,
            code: AGW_ERROR_CODES.NOT_FOUND,
            error: error.message,
            requestId: requestContext.requestId,
            details: error.details || {}
        };
    }

    return {
        success: false,
        status: 500,
        code: AGW_ERROR_CODES.INTERNAL_ERROR,
        error: 'Failed to render agent',
        requestId: requestContext.requestId,
        details: {
            message: error?.message || 'Unknown render failure'
        }
    };
}

function buildMcpContexts(bundle, input = {}, defaultSource) {
    const requestInput = input.requestContext && typeof input.requestContext === 'object'
        ? input.requestContext
        : {};
    const agentId = normalizeMcpString(input.agentId || requestInput.agentId);
    const maid = normalizeMcpString(input.maid || requestInput.maid || agentId);
    const sessionId = normalizeMcpString(input.sessionId || requestInput.sessionId);
    const requestContext = normalizeRequestContext({
        ...requestInput,
        agentId: agentId || requestInput.agentId,
        sessionId: sessionId || requestInput.sessionId,
        source: normalizeMcpString(input.source || requestInput.source) || defaultSource,
        runtime: 'mcp'
    }, {
        defaultSource,
        defaultRuntime: 'mcp',
        requestIdPrefix: 'mcp'
    });
    const authContext = bundle.authContextResolver({
        authContext: input.authContext,
        requestContext,
        agentId: requestContext.agentId,
        maid,
        adapter: 'mcp'
    });

    return {
        maid,
        requestContext,
        authContext
    };
}

function ensureAgentId(requestContext, operation) {
    if (!requestContext.agentId) {
        throw createMcpError(
            MCP_ERROR_CODES.INVALID_REQUEST,
            `${operation} requires agentId`,
            { field: 'agentId' }
        );
    }
}

function getSinglePublishedAgentId(pluginManager) {
    if (!(pluginManager?.agentManager?.agentMap instanceof Map)) {
        return '';
    }

    const aliases = Array.from(pluginManager.agentManager.agentMap.keys())
        .map((alias) => normalizeMcpString(alias))
        .filter(Boolean);

    return aliases.length === 1 ? aliases[0] : '';
}

function resolveDiscoveryAgentId(input, pluginManager) {
    const explicitAgentId = normalizeMcpString(input?.agentId || input?.requestContext?.agentId);
    if (explicitAgentId) {
        return explicitAgentId;
    }

    const configuredAgentId = normalizeMcpString(process.env.VCP_MCP_DEFAULT_AGENT_ID);
    if (configuredAgentId) {
        return configuredAgentId;
    }

    return getSinglePublishedAgentId(pluginManager);
}

function applyDiscoveryAgentId(input, agentId) {
    const normalizedAgentId = normalizeMcpString(agentId);
    if (!normalizedAgentId) {
        return input;
    }

    const nextRequestContext = input?.requestContext && typeof input.requestContext === 'object'
        ? {
            ...input.requestContext,
            agentId: input.requestContext.agentId || normalizedAgentId
        }
        : {
            agentId: normalizedAgentId
        };

    return {
        ...(input && typeof input === 'object' ? input : {}),
        agentId: normalizeMcpString(input?.agentId) || normalizedAgentId,
        requestContext: nextRequestContext
    };
}

function ensureAgentAndSession(requestContext, operation) {
    ensureAgentId(requestContext, operation);
    if (!requestContext.sessionId) {
        throw createMcpError(
            MCP_ERROR_CODES.INVALID_REQUEST,
            `${operation} requires sessionId`,
            { field: 'sessionId' }
        );
    }
}

function ensureJobIdentity(requestContext, authContext, operation) {
    const resolvedAgentId = normalizeMcpString(requestContext?.agentId || authContext?.agentId);
    const resolvedSessionId = normalizeMcpString(requestContext?.sessionId || authContext?.sessionId);
    const resolvedGatewayId = normalizeMcpString(requestContext?.gatewayId || authContext?.gatewayId);

    if (resolvedAgentId || resolvedSessionId || resolvedGatewayId) {
        return;
    }

    throw createMcpError(
        MCP_ERROR_CODES.INVALID_REQUEST,
        `${operation} requires canonical job visibility identity`,
        {
            fields: ['agentId', 'sessionId', 'gatewayId']
        }
    );
}

function attachRequestId(result, requestId) {
    if (!result || typeof result !== 'object') {
        return result;
    }
    return {
        ...result,
        requestId: result.requestId || requestId || ''
    };
}

async function executeGatewayManagedOperation({
    bundle,
    name,
    operationName,
    args,
    input,
    source,
    requiresAgentOnly = false,
    requiresJobIdentity = false,
    execute
}) {
    const contextInput = buildManagedToolContextInput(input, args);
    const { maid, requestContext, authContext } = buildMcpContexts(bundle, contextInput, source);
    if (requiresJobIdentity) {
        ensureJobIdentity(requestContext, authContext, `tools/call:${name}`);
    } else if (requiresAgentOnly) {
        ensureAgentId(requestContext, `tools/call:${name}`);
    } else {
        ensureAgentAndSession(requestContext, `tools/call:${name}`);
    }

    const body = {
        ...args,
        authContext,
        requestContext,
        maid,
        options: {
            ...((args.options && typeof args.options === 'object') ? args.options : {}),
            ...((input.options && typeof input.options === 'object') ? input.options : {})
        }
    };
    const operationControl = beginGatewayManagedOperation(bundle.operabilityService, {
        operationName,
        requestContext,
        authContext,
        // Align payload governance with native routes by measuring the client-visible MCP payload,
        // not the adapter-enriched internal body.
        payload: buildGatewayManagedClientPayload(input, args)
    });

    if (operationControl && !operationControl.allowed) {
        return mapGatewayManagedResultToMcp(
            name,
            buildGatewayManagedOperationRejection(operationControl, requestContext.requestId),
            operationControl
        );
    }

    let result;
    try {
        result = await execute({
            body,
            maid,
            requestContext,
            authContext,
            operationControl
        });
    } catch (error) {
        result = {
            success: false,
            requestId: requestContext.requestId,
            status: 500,
            code: AGW_ERROR_CODES.INTERNAL_ERROR,
            error: 'Gateway-managed MCP operation failed',
            details: {
                message: error?.message || 'Unknown gateway-managed MCP operation failure'
            }
        };
    }

    finishGatewayManagedOperation(operationControl, result);
    return mapGatewayManagedResultToMcp(name, result, operationControl);
}

async function executeGatewayManagedPromptGet({
    bundle,
    name,
    args,
    input = {}
}) {
    if (name !== MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER) {
        throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported MCP prompt', {
            field: 'name',
            name
        });
    }

    const contextInput = buildManagedToolContextInput(input, args);
    const { requestContext, authContext } = buildMcpContexts(bundle, contextInput, 'mcp-prompts-get');
    ensureAgentId(requestContext, `prompts/get:${name}`);

    const operationControl = beginGatewayManagedOperation(bundle.operabilityService, {
        operationName: 'agents.render',
        requestContext,
        authContext,
        payload: buildGatewayManagedClientPayload(input, args)
    });

    if (operationControl && !operationControl.allowed) {
        throwGatewayManagedMcpError(
            buildGatewayManagedOperationRejection(operationControl, requestContext.requestId),
            operationControl
        );
    }

    let renderResult;
    try {
        renderResult = await bundle.agentRegistryService.renderAgent(requestContext.agentId, {
            variables: args.variables,
            model: args.model,
            maxLength: args.maxLength,
            context: args.context,
            messages: args.messages
        });
    } catch (error) {
        const mapped = mapAgentRegistryError(error, requestContext);
        finishGatewayManagedOperation(operationControl, mapped);
        throwGatewayManagedMcpError(mapped, operationControl);
    }

    const successResult = {
        success: true,
        requestId: requestContext.requestId,
        data: renderResult
    };
    finishGatewayManagedOperation(operationControl, successResult);

    return {
        name,
        description: 'Final rendered Agent Gateway prompt published through the MCP prompt surface.',
        messages: [
            createMcpPromptTextMessage(renderResult.renderedPrompt)
        ],
        meta: {
            requestId: requestContext.requestId,
            agentId: requestContext.agentId,
            renderMeta: renderResult.renderMeta,
            warnings: renderResult.warnings,
            unresolved: renderResult.unresolved,
            truncated: renderResult.truncated,
            operability: buildOperabilityMetadata(operationControl, successResult)
        }
    };
}

async function executeGatewayManagedTool(bundle, name, args, input = {}) {
    const source = {
        [MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER]: 'mcp-agent-render',
        [MCP_GATEWAY_TOOL_NAMES.JOB_GET]: 'mcp-job-get',
        [MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL]: 'mcp-job-cancel',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH]: 'mcp-memory-search',
        [MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE]: 'mcp-context-assemble',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE]: 'mcp-memory-write',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING]: 'mcp-coding-memory-writeback',
        [MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING]: 'mcp-coding-recall'
    }[name] || 'mcp';

    // Render remains the high-level MCP entry point and reuses the shared registry contract.
    if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'agents.render',
            args,
            input,
            source,
            requiresAgentOnly: true,
            async execute({ requestContext }) {
                try {
                    const renderResult = await bundle.agentRegistryService.renderAgent(requestContext.agentId, {
                        variables: args.variables,
                        model: args.model,
                        maxLength: args.maxLength,
                        context: args.context,
                        messages: args.messages
                    });

                    if (renderResult?.success && (renderResult.status === 'accepted' || renderResult.status === 'waiting_approval')) {
                        return attachRequestId(renderResult, requestContext.requestId);
                    }

                    return {
                        success: true,
                        requestId: requestContext.requestId,
                        data: renderResult,
                        audit: {
                            runtime: requestContext.runtime,
                            source: requestContext.source
                        }
                    };
                } catch (error) {
                    return mapAgentRegistryError(error, requestContext);
                }
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.JOB_GET) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'jobs.read',
            args,
            input,
            source,
            requiresJobIdentity: true,
            async execute({ requestContext, authContext }) {
                return attachRequestId(
                    bundle.jobRuntimeService.pollJob(args.jobId, authContext),
                    requestContext.requestId
                );
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'jobs.cancel',
            args,
            input,
            source,
            requiresJobIdentity: true,
            async execute({ requestContext, authContext }) {
                return attachRequestId(
                    bundle.jobRuntimeService.cancelJob(args.jobId, authContext),
                    requestContext.requestId
                );
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'memory.search',
            args,
            input,
            source,
            async execute({ body }) {
                return bundle.contextRuntimeService.search({
                    body,
                    startedAt: Date.now(),
                    defaultSource: source
                });
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'context.assemble',
            args,
            input,
            source,
            async execute({ body }) {
                return bundle.contextRuntimeService.buildRecallContext({
                    body,
                    startedAt: Date.now(),
                    defaultSource: source
                });
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'memory.write',
            args,
            input,
            source,
            async execute({ body }) {
                return bundle.memoryRuntimeService.writeMemory({
                    body: {
                        ...body,
                        idempotencyKey: body.options?.idempotencyKey || args.idempotencyKey || body.idempotencyKey,
                        options: {
                            ...body.options,
                            idempotencyKey: body.options?.idempotencyKey || args.idempotencyKey || body.idempotencyKey
                        }
                    },
                    startedAt: Date.now(),
                    clientIp: normalizeMcpString(input.clientIp, 64) || '127.0.0.1',
                    defaultSource: source
                });
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'coding.memory_writeback',
            args,
            input,
            source,
            async execute({ body }) {
                return bundle.codingMemoryWritebackService.commitForCoding({
                    body,
                    startedAt: Date.now(),
                    clientIp: normalizeMcpString(input.clientIp, 64) || '127.0.0.1',
                    defaultSource: source
                });
            }
        });
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING) {
        return executeGatewayManagedOperation({
            bundle,
            name,
            operationName: 'coding.recall',
            args,
            input,
            source,
            async execute({ body }) {
                return bundle.codingRecallService.recallForCoding({
                    body,
                    startedAt: Date.now(),
                    defaultSource: source
                });
            }
        });
    }

    throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
        field: 'name',
        name
    });
}

function createMcpAdapter(pluginManager, options = {}) {
    if (!pluginManager) {
        throw new Error('[McpAdapter] pluginManager is required');
    }

    const bundle = options.gatewayServiceBundle || getGatewayServiceBundle(pluginManager);
    const {
        capabilityService,
        agentRegistryService,
        contextRuntimeService,
        memoryRuntimeService,
        codingMemoryWritebackService,
        codingRecallService,
        toolRuntimeService,
        jobRuntimeService
    } = bundle;
    const gatewayManagedTools = createGatewayManagedToolDescriptors();
    const gatewayManagedPrompts = createGatewayManagedPromptDescriptors();

    return {
        supportedResourceTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES,
        supportedPromptNames: gatewayManagedPrompts.map((prompt) => prompt.name),
        async listTools(input = {}) {
            const scopedInput = applyDiscoveryAgentId(input, resolveDiscoveryAgentId(input, pluginManager));
            const { maid, requestContext, authContext } = buildMcpContexts(bundle, scopedInput, 'mcp-tools-list');
            let publishedTools = [...gatewayManagedTools];

            if (requestContext.agentId) {
                const capabilities = await capabilityService.getCapabilities({
                    agentId: requestContext.agentId,
                    maid,
                    includeMemoryTargets: false,
                    authContext
                });

                publishedTools = [
                    ...(capabilities.tools || []).map(buildMcpToolDescriptor),
                    ...gatewayManagedTools
                ];
            }

            return {
                tools: publishedTools.sort((left, right) => left.name.localeCompare(right.name)),
                meta: {
                    requestId: requestContext.requestId,
                    ...(requestContext.agentId ? { agentId: requestContext.agentId } : {})
                }
            };
        },

        async listPrompts(input = {}) {
            const { requestContext } = buildMcpContexts(bundle, input, 'mcp-prompts-list');

            return {
                prompts: gatewayManagedPrompts,
                meta: {
                    requestId: requestContext.requestId,
                    ...(requestContext.agentId ? { agentId: requestContext.agentId } : {})
                }
            };
        },

        async getPrompt(input = {}) {
            const name = normalizeMcpString(input.name);
            const args = normalizeMcpArguments(input.arguments);

            if (!name) {
                throw createMcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'prompts/get requires prompt name', {
                    field: 'name'
                });
            }
            if (!args) {
                throw createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENTS, 'prompts/get requires an arguments object', {
                    field: 'arguments'
                });
            }

            return executeGatewayManagedPromptGet({
                bundle: {
                    ...bundle,
                    agentRegistryService
                },
                name,
                args,
                input
            });
        },

        async callTool(input = {}) {
            const name = normalizeMcpString(input.name);
            const args = normalizeMcpArguments(input.arguments);

            if (!name) {
                throw createMcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'tools/call requires tool name', {
                    field: 'name'
                });
            }
            if (!args) {
                throw createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENTS, 'tools/call requires an arguments object', {
                    field: 'arguments'
                });
            }
            if (isGatewayManagedTool(name)) {
                return executeGatewayManagedTool({
                    ...bundle,
                    agentRegistryService,
                    contextRuntimeService,
                    memoryRuntimeService,
                    codingMemoryWritebackService,
                    codingRecallService,
                    jobRuntimeService
                }, name, args, input);
            }

            const { requestContext, authContext } = buildMcpContexts(bundle, input, 'mcp-tools-call');
            ensureAgentAndSession(requestContext, 'tools/call');

            const result = await toolRuntimeService.invokeTool({
                toolName: name,
                body: {
                    args,
                    requestContext,
                    authContext,
                    maid: input.maid,
                    options: input.options
                },
                startedAt: Date.now(),
                clientIp: normalizeMcpString(input.clientIp, 64) || '127.0.0.1',
                defaultSource: 'mcp'
            });

            return mapToolRuntimeResultToMcp(result);
        },

        async listResources(input = {}) {
            const scopedInput = applyDiscoveryAgentId(input, resolveDiscoveryAgentId(input, pluginManager));
            const { requestContext } = buildMcpContexts(bundle, scopedInput, 'mcp-resources-list');

            if (!requestContext.agentId) {
                return {
                    resources: [],
                    meta: {
                        requestId: requestContext.requestId
                    }
                };
            }

            return {
                resources: [
                    createCapabilitiesResource(requestContext.agentId),
                    createMemoryTargetsResource(requestContext.agentId),
                    createAgentProfileResource(requestContext.agentId),
                    createAgentPromptTemplateResource(requestContext.agentId)
                ],
                meta: {
                    requestId: requestContext.requestId,
                    agentId: requestContext.agentId
                }
            };
        },

        async readResource(input = {}) {
            const parsed = parseResourceUri(input.uri);
            if (!parsed) {
                throw createMcpError(
                    MCP_ERROR_CODES.RESOURCE_UNSUPPORTED,
                    'Unsupported resource URI',
                    {
                        uri: input.uri || '',
                        supportedTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES
                    }
                );
            }

            const resourceAgentId = parsed.agentId || input.agentId || input.requestContext?.agentId;
            const { kind, agentId, jobId } = parsed;
            const { maid, requestContext, authContext } = buildMcpContexts(bundle, {
                ...input,
                ...(resourceAgentId ? { agentId: resourceAgentId } : {})
            }, 'mcp-resources-read');
            if (kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
                ensureJobIdentity(requestContext, authContext, 'resources/read');
            } else {
                ensureAgentId(requestContext, 'resources/read');
            }

            let payload;
            try {
                if (kind === MCP_RESOURCE_KINDS.CAPABILITIES) {
                    payload = await capabilityService.getCapabilities({
                        agentId,
                        maid,
                        includeMemoryTargets: true,
                        authContext
                    });
                } else if (kind === MCP_RESOURCE_KINDS.MEMORY_TARGETS) {
                    payload = await capabilityService.getMemoryTargets({
                        agentId,
                        maid,
                        authContext
                    });
                } else if (kind === MCP_RESOURCE_KINDS.AGENT_PROFILE) {
                    payload = await agentRegistryService.getAgentProfile(agentId, {
                        maid,
                        authContext
                    });
                } else if (kind === MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE) {
                    payload = await agentRegistryService.getPromptTemplatePreview(agentId, {
                        maid,
                        authContext
                    });
                } else if (kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
                    const jobResult = attachRequestId(
                        jobRuntimeService.pollJob(jobId, authContext),
                        requestContext.requestId
                    );
                    if (!jobResult.success) {
                        throw createMcpError(
                            mapGatewayFailureToMcpErrorCode(jobResult.code),
                            jobResult.error || 'Failed to read Gateway job runtime events',
                            {
                                canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[jobResult.code] || jobResult.code || '',
                                gatewayCode: jobResult.code || '',
                                requestId: jobResult.requestId || requestContext.requestId,
                                ...(jobResult.details && typeof jobResult.details === 'object' ? jobResult.details : {})
                            }
                        );
                    }
                    const eventResult = attachRequestId(
                        jobRuntimeService.listEvents({
                            authContext,
                            filters: {
                                jobId
                            }
                        }),
                        requestContext.requestId
                    );
                    if (!eventResult.success) {
                        throw createMcpError(
                            mapGatewayFailureToMcpErrorCode(eventResult.code),
                            eventResult.error || 'Failed to list Gateway job runtime events',
                            {
                                canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[eventResult.code] || eventResult.code || '',
                                gatewayCode: eventResult.code || '',
                                requestId: eventResult.requestId || requestContext.requestId,
                                ...(eventResult.details && typeof eventResult.details === 'object' ? eventResult.details : {})
                            }
                        );
                    }
                    payload = {
                        jobId,
                        job: jobResult.data?.job || null,
                        events: eventResult.data?.events || []
                    };
                } else {
                    throw createMcpError(
                        MCP_ERROR_CODES.RESOURCE_UNSUPPORTED,
                        'Unsupported resource URI',
                        {
                            uri: input.uri,
                            supportedTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES
                        }
                    );
                }
            } catch (error) {
                if (error?.code === 'AGENT_NOT_FOUND') {
                    throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, error.message, {
                        canonicalCode: AGW_ERROR_CODES.NOT_FOUND,
                        requestId: requestContext.requestId,
                        ...(error.details && typeof error.details === 'object' ? error.details : {})
                    });
                }
                throw error;
            }

            return {
                contents: [{
                    uri: kind === MCP_RESOURCE_KINDS.JOB_EVENTS
                        ? createJobEventsResource(jobId).uri
                        : buildResourceUri(kind, agentId),
                    mimeType: 'application/json',
                    text: serializeMcpValue(payload)
                }],
                meta: {
                    requestId: requestContext.requestId,
                    ...(agentId ? { agentId } : {}),
                    ...(jobId ? { jobId } : {})
                }
            };
        }
    };
}

function buildJsonRpcError(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
            code,
            message,
            data
        }
    };
}

function buildMcpInitializeResult(params = {}) {
    const requestedProtocolVersion = typeof params.protocolVersion === 'string'
        ? params.protocolVersion.trim()
        : '';

    return {
        protocolVersion: requestedProtocolVersion || '2025-06-18',
        capabilities: {
            prompts: {
                listChanged: false
            },
            resources: {
                listChanged: false
            },
            tools: {
                listChanged: false
            }
        },
        serverInfo: {
            name: 'vcp-agent-gateway',
            version: packageMetadata.version
        },
        instructions: 'Use the published Agent Gateway prompts, tools, and resources over MCP stdio.'
    };
}

function createMcpServerHarness(pluginManager, options = {}) {
    const adapter = options.adapter || createMcpAdapter(pluginManager, options);

    return {
        adapter,
        async handleRequest(message = {}) {
            const request = message && typeof message === 'object' ? message : {};
            const params = request.params && typeof request.params === 'object' ? request.params : {};

            try {
                let result;
                switch (request.method) {
                case 'initialize':
                    result = buildMcpInitializeResult(params);
                    break;
                case 'notifications/initialized':
                    result = null;
                    break;
                case 'ping':
                    result = {};
                    break;
                case 'prompts/list':
                    result = await adapter.listPrompts(params);
                    break;
                case 'prompts/get':
                    result = await adapter.getPrompt(params);
                    break;
                case 'tools/list':
                    result = await adapter.listTools(params);
                    break;
                case 'tools/call':
                    result = await adapter.callTool(params);
                    break;
                case 'resources/list':
                    result = await adapter.listResources(params);
                    break;
                case 'resources/read':
                    result = await adapter.readResource(params);
                    break;
                default:
                    return buildJsonRpcError(request.id, -32601, 'Method not found', {
                        method: request.method || ''
                    });
                }

                return {
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result
                };
            } catch (error) {
                return buildJsonRpcError(
                    request.id,
                    -32000,
                    error.message || 'MCP adapter request failed',
                    {
                        code: error.code || MCP_ERROR_CODES.RUNTIME_ERROR,
                        ...(error.details && typeof error.details === 'object' ? error.details : {})
                    }
                );
            }
        }
    };
}

module.exports = {
    MCP_ERROR_CODES,
    MCP_RESOURCE_KINDS,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    createMcpAdapter,
    createMcpServerHarness
};
