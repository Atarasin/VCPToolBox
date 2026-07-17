const {
    getGatewayServiceBundle
} = require('../../createGatewayServiceBundle');
const {
    normalizeRequestContext,
    sanitizeRequestContextValue
} = require('../../contracts/requestContext');
const {
    OPENCLAW_TO_AGENT_GATEWAY_CODE,
    OPENCLAW_ERROR_CODES,
    AGW_ERROR_CODES
} = require('../../contracts/errorCodes');
const {
    beginGatewayManagedOperation,
    buildGatewayManagedClientPayload,
    buildGatewayManagedOperationRejection,
    buildOperabilityMetadata,
    finishGatewayManagedOperation
} = require('./operability');
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
} = require('./descriptors');
const { createMcpHarness } = require('./harness');
const {
    createMcpError,
    createMcpPromptTextMessage,
    createMcpTextContent,
    serializeMcpValue
} = require('./resultShapes');
const { mapGatewayFailureToMcpErrorCode } = require('./errorMapping');
const { MCP_ERROR_CODES } = require('./constants');
const { applyDiaryPolicyGate } = require('./diaryPolicyGate');
const { getGatewayOperation } = require('./operations');
const { IN_PROCESS_OPERATION_HANDLERS, attachRequestId, mapAgentRegistryError } = require('./inProcessOperations');
const { createReadResourceHandler } = require('./resourceHandlers');
const { resolveTraceId } = require('../../infra/trace');

function normalizeMcpString(value, maxLength = 128) {
    return sanitizeRequestContextValue(value, maxLength);
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
    if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP && data && typeof data.renderedPrompt === 'string') {
        return createMcpTextContent(data.renderedPrompt);
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
        authContext: input.authContext || args.authContext
    };
}

function buildMcpContexts(bundle, input = {}, defaultSource) {
    const requestInput = input.requestContext && typeof input.requestContext === 'object'
        ? input.requestContext
        : {};
    const agentId = normalizeMcpString(input.agentId || requestInput.agentId);
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
    requestContext.traceId = resolveTraceId(requestInput.traceId, 'agwop');
    const authContext = bundle.authContextResolver({
        authContext: input.authContext,
        requestContext,
        agentId: requestContext.agentId,
        adapter: 'mcp'
    });

    return {
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

async function executeGatewayManagedOperation({
    bundle,
    name,
    operationName,
    args,
    clientPayloadArgs = args,
    input,
    source,
    requiresAgentOnly = false,
    requiresJobIdentity = false,
    execute
}) {
    const contextInput = buildManagedToolContextInput(input, args);
    const { requestContext, authContext } = buildMcpContexts(bundle, contextInput, source);
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
        payload: buildGatewayManagedClientPayload(input, clientPayloadArgs)
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
            requestContext,
            authContext,
            operationControl,
            diaryPolicy: input.diaryPolicy || { appliedDefault: false }
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
    const operation = getGatewayOperation(name);
    const handler = operation && IN_PROCESS_OPERATION_HANDLERS[operation.executor];
    if (!handler) {
        throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
            field: 'name',
            name
        });
    }

    return handler({
        bundle,
        name,
        args,
        input,
        operation,
        executeManaged: executeGatewayManagedOperation,
        mapManagedResult: mapGatewayManagedResultToMcp
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
        toolRuntimeService,
        jobRuntimeService,
        recallRuntimeService,
        recallProjectionService
    } = bundle;
    const gatewayManagedTools = createGatewayManagedToolDescriptors();
    const gatewayManagedPrompts = createGatewayManagedPromptDescriptors();
    const readResource = createReadResourceHandler(bundle, {
        attachRequestId,
        buildMcpContexts,
        ensureAgentId,
        ensureJobIdentity
    });

    return {
        supportedResourceTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES,
        supportedPromptNames: gatewayManagedPrompts.map((prompt) => prompt.name),
        async listTools(input = {}) {
            const scopedInput = applyDiscoveryAgentId(input, resolveDiscoveryAgentId(input, pluginManager));
            const { requestContext, authContext } = buildMcpContexts(bundle, scopedInput, 'mcp-tools-list');
            let publishedTools = [...gatewayManagedTools];

            if (requestContext.agentId) {
                const capabilities = await capabilityService.getCapabilities({
                    agentId: requestContext.agentId,
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
                    jobRuntimeService,
                    recallRuntimeService,
                    recallProjectionService
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

        readResource
    };
}

function createMcpServerHarness(pluginManager, options = {}) {
    const adapter = options.adapter || createMcpAdapter(pluginManager, options);
    return createMcpHarness({ adapter });
}

module.exports = {
    MCP_ERROR_CODES,
    MCP_RESOURCE_KINDS,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    createMcpAdapter,
    createMcpServerHarness,
    createInProcessExecutor: createMcpAdapter
};
