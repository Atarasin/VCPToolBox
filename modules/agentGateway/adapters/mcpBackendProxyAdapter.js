const packageMetadata = require('../../../package.json');
const {
    OPENCLAW_TO_AGENT_GATEWAY_CODE,
    AGW_ERROR_CODES
} = require('../contracts/errorCodes');
const {
    MCP_RESOURCE_KINDS,
    MCP_GATEWAY_TOOL_NAMES,
    MCP_GATEWAY_PROMPT_NAMES,
    MCP_DIARY_LOOP_RESOURCE_TEMPLATES,
    createGatewayManagedPromptDescriptors,
    createGatewayManagedToolDescriptors,
    buildJobEventsResourceUri,
    parseResourceUri,
    createMemoryTargetsResource
} = require('./mcpDescriptorRegistry');

const MCP_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'MCP_INVALID_REQUEST',
    INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
    FORBIDDEN: 'MCP_FORBIDDEN',
    NOT_FOUND: 'MCP_NOT_FOUND',
    TIMEOUT: 'MCP_TIMEOUT',
    RUNTIME_ERROR: 'MCP_RUNTIME_ERROR',
    RESOURCE_UNSUPPORTED: 'MCP_RESOURCE_UNSUPPORTED'
});

const DEFERRED_RESULT_TOOL_NAMES = new Set([
    MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER,
    MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
    MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE,
    MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE,
    MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING,
    MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING,
    MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL
]);

function normalizeMcpString(value, maxLength = 128) {
    if (typeof value !== 'string') {
        return '';
    }
    const normalized = value.trim();
    if (!normalized) {
        return '';
    }
    return normalized.slice(0, maxLength);
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
        instructions: 'Use the published Agent Gateway diary RAG prompts, tools, and resources over MCP stdio.'
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

function buildOperabilityMetadata(meta = {}) {
    return {
        ...(meta.traceId ? { traceId: meta.traceId } : {}),
        ...(meta.operationName ? { operationName: meta.operationName } : {}),
        ...(meta.retryAfterMs > 0 ? { retryAfterMs: meta.retryAfterMs } : {})
    };
}

function createFailureResult(result) {
    const operability = buildOperabilityMetadata(result.meta);
    return {
        isError: true,
        status: 'failed',
        error: {
            code: mapGatewayFailureToMcpErrorCode(result.code),
            message: result.error || 'MCP tool call failed',
            details: {
                canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
                gatewayCode: result.code || '',
                requestId: result.requestId || '',
                gatewayStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
                ...operability,
                ...(result.details && typeof result.details === 'object' ? result.details : {})
            }
        },
        content: createMcpTextContent({
            error: result.error || 'MCP tool call failed',
            code: mapGatewayFailureToMcpErrorCode(result.code),
            requestId: result.requestId || '',
            details: {
                gatewayStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
                ...operability,
                ...(result.details && typeof result.details === 'object' ? result.details : {})
            }
        })
    };
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
            operability: operability || {}
        },
        content: createMcpTextContent({
            status,
            requestId,
            job: job || null,
            runtime: shapedRuntime,
            message: status === 'waiting_approval'
                ? 'Tool approval is required before execution can continue.'
                : 'Tool execution was accepted for deferred processing.',
            ...(operability?.traceId ? { traceId: operability.traceId } : {})
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

function createGatewayManagedSuccessResult(name, result) {
    const operability = buildOperabilityMetadata(result.meta);
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

function createGatewayManagedDeferredResult(name, result) {
    return createDeferredResultEnvelope({
        requestId: result.requestId,
        status: result.status,
        toolName: name,
        runtime: result.data?.runtime || {},
        job: result.data?.job || null,
        audit: result.audit || {},
        operability: buildOperabilityMetadata(result.meta)
    });
}

function normalizeNativeResult(response, { fallbackStatus = 'completed' } = {}) {
    const payload = response?.payload && typeof response.payload === 'object' ? response.payload : {};
    const meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : {};

    if (!payload.success) {
        return {
            success: false,
            httpStatus: response?.httpStatus || 500,
            requestId: meta.requestId || '',
            code: payload.code || AGW_ERROR_CODES.INTERNAL_ERROR,
            error: payload.error || 'Gateway backend request failed',
            details: payload.details || {},
            meta
        };
    }

    const runtimeStatus = normalizeMcpString(
        payload.data?.runtime?.status ||
        payload.data?.job?.status ||
        meta.toolStatus ||
        meta.operationStatus,
        64
    );
    const status = runtimeStatus || (response?.httpStatus === 202 ? 'accepted' : fallbackStatus);

    return {
        success: true,
        status,
        httpStatus: response?.httpStatus || 200,
        requestId: meta.requestId || '',
        data: payload.data,
        audit: {
            runtime: 'native',
            source: 'mcp-backend-proxy'
        },
        meta
    };
}

function ensureAgentId(input, operation, fallback = '') {
    const agentId = normalizeMcpString(input?.agentId || input?.requestContext?.agentId || fallback);
    if (!agentId) {
        throw createMcpError(
            MCP_ERROR_CODES.INVALID_REQUEST,
            `${operation} requires agentId`,
            { field: 'agentId' }
        );
    }
    return agentId;
}

function ensureSessionId(input, operation, fallback = 'mcp-session') {
    const sessionId = normalizeMcpString(input?.sessionId || input?.requestContext?.sessionId || fallback);
    if (!sessionId) {
        throw createMcpError(
            MCP_ERROR_CODES.INVALID_REQUEST,
            `${operation} requires sessionId`,
            { field: 'sessionId' }
        );
    }
    return sessionId;
}

function ensureJobIdentity(input, operation, fallbackAgentId = '', fallbackSessionId = 'mcp-session') {
    const requestContext = input?.requestContext && typeof input.requestContext === 'object'
        ? input.requestContext
        : {};
    const authContext = input?.authContext && typeof input.authContext === 'object'
        ? input.authContext
        : {};
    const values = [
        input?.agentId,
        input?.sessionId,
        requestContext.agentId,
        requestContext.sessionId,
        requestContext.gatewayId,
        authContext.agentId,
        authContext.sessionId,
        authContext.gatewayId,
        fallbackAgentId,
        fallbackSessionId
    ].map((value) => normalizeMcpString(value, 256)).filter(Boolean);

    if (values.length > 0) {
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

function buildBody(input, args, { requireSession = true, defaultAgentId = '', defaultSessionId = 'mcp-session' } = {}) {
    const inputWithArgs = {
        ...input,
        agentId: input?.agentId || args?.agentId,
        sessionId: input?.sessionId || args?.sessionId
    };
    const agentId = ensureAgentId(inputWithArgs, 'tools/call', defaultAgentId);
    const sessionId = requireSession ? ensureSessionId(inputWithArgs, 'tools/call', defaultSessionId) : normalizeMcpString(inputWithArgs?.sessionId || inputWithArgs?.requestContext?.sessionId || defaultSessionId);
    const requestContext = {
        ...((input?.requestContext && typeof input.requestContext === 'object') ? input.requestContext : {}),
        agentId,
        ...(sessionId ? { sessionId } : {})
    };

    return {
        ...(args && typeof args === 'object' ? args : {}),
        ...(input?.authContext ? { authContext: input.authContext } : {}),
        ...(input?.maid ? { maid: input.maid } : {}),
        requestContext
    };
}

function buildJobQuery(input, args, defaultAgentId = '', defaultSessionId = 'mcp-session') {
    const requestContext = input?.requestContext && typeof input.requestContext === 'object'
        ? input.requestContext
        : {};
    const authContext = input?.authContext && typeof input.authContext === 'object'
        ? input.authContext
        : {};

    return {
        requestId: normalizeMcpString(requestContext.requestId, 128),
        agentId: normalizeMcpString(input?.agentId || args?.agentId || requestContext.agentId || authContext.agentId || defaultAgentId, 256),
        sessionId: normalizeMcpString(input?.sessionId || args?.sessionId || requestContext.sessionId || authContext.sessionId || defaultSessionId, 256),
        gatewayId: normalizeMcpString(requestContext.gatewayId || authContext.gatewayId, 256),
        maid: normalizeMcpString(input?.maid || requestContext.maid || authContext.maid, 256),
        jobId: normalizeMcpString(args?.jobId, 256)
    };
}

function buildPromptMeta(result, agentId) {
    return {
        requestId: result.requestId,
        agentId,
        renderMeta: result.data?.renderMeta,
        warnings: result.data?.warnings,
        unresolved: result.data?.unresolved,
        truncated: result.data?.truncated,
        hostHints: {
            injectionMode: 'prompt_message_content',
            primarySurface: 'prompts/get',
            fallbackToolSurfaceAvailable: false,
            resolvedAgentId: agentId,
            promptName: MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER,
            useMessageContentAsPromptBody: true
        },
        operability: buildOperabilityMetadata(result.meta)
    };
}

function createBackendProxyMcpAdapter({
    backendClient,
    defaultAgentId = '',
    includeAgentRender = true
}) {
    if (!backendClient) {
        throw new Error('backendClient is required');
    }

    const gatewayManagedTools = createGatewayManagedToolDescriptors({
        diaryRagLoopOnly: true
    });
    const gatewayManagedPrompts = createGatewayManagedPromptDescriptors({
        includeAgentRender
    });

    return {
        supportedResourceTemplates: MCP_DIARY_LOOP_RESOURCE_TEMPLATES,
        supportedPromptNames: gatewayManagedPrompts.map((prompt) => prompt.name),
        async listTools(input = {}) {
            const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || defaultAgentId);
            return {
                tools: gatewayManagedTools.slice().sort((left, right) => left.name.localeCompare(right.name)),
                meta: {
                    requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                    ...(agentId ? { agentId } : {})
                }
            };
        },

        async listPrompts(input = {}) {
            const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || defaultAgentId);
            return {
                prompts: gatewayManagedPrompts,
                meta: {
                    requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                    ...(agentId ? { agentId } : {})
                }
            };
        },

        async getPrompt(input = {}) {
            const name = normalizeMcpString(input.name);
            const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
                ? input.arguments
                : null;

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
            if (name !== MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER) {
                throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported MCP prompt', {
                    field: 'name',
                    name
                });
            }

            const agentId = ensureAgentId({
                ...input,
                agentId: args.agentId || input.agentId
            }, `prompts/get:${name}`, defaultAgentId);
            const response = await backendClient.renderAgent(agentId, buildBody({
                ...input,
                agentId
            }, args, {
                requireSession: false,
                defaultAgentId
            }));
            const result = normalizeNativeResult(response);

            if (!result.success) {
                throw createMcpError(
                    mapGatewayFailureToMcpErrorCode(result.code),
                    result.error || 'MCP prompt request failed',
                    {
                        canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
                        gatewayCode: result.code || '',
                        requestId: result.requestId || '',
                        gatewayStatus: result.httpStatus,
                        ...buildOperabilityMetadata(result.meta),
                        ...(result.details && typeof result.details === 'object' ? result.details : {})
                    }
                );
            }

            return {
                name,
                description: 'Final rendered Agent Gateway prompt published through the MCP prompt surface.',
                messages: [
                    createMcpPromptTextMessage(result.data?.renderedPrompt || '')
                ],
                meta: buildPromptMeta(result, agentId)
            };
        },

        async callTool(input = {}) {
            const name = normalizeMcpString(input.name);
            const args = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
                ? input.arguments
                : null;

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

            let response;
            if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH) {
                response = await backendClient.searchMemory(buildBody(input, args, { defaultAgentId }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE) {
                response = await backendClient.assembleContext(buildBody(input, args, { defaultAgentId }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE) {
                response = await backendClient.writeMemory(buildBody(input, args, { defaultAgentId }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING) {
                response = await backendClient.recallForCoding(buildBody(input, args, { defaultAgentId }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING) {
                response = await backendClient.commitMemoryForCoding(buildBody(input, args, { defaultAgentId }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.JOB_GET) {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                response = await backendClient.getJob(args.jobId, buildJobQuery(input, args, defaultAgentId));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL) {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                response = await backendClient.cancelJob(args.jobId, buildBody(input, args, {
                    requireSession: false,
                    defaultAgentId
                }));
            } else if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER) {
                throw createMcpError(
                    MCP_ERROR_CODES.NOT_FOUND,
                    'gateway_agent_render is no longer published as a MCP tool; use prompts/get instead',
                    {
                        field: 'name',
                        name,
                        primarySurface: 'prompts/get'
                    }
                );
            } else {
                throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
                    field: 'name',
                    name
                });
            }

            const result = normalizeNativeResult(response);
            if (!result.success) {
                return createFailureResult(result);
            }
            if (
                DEFERRED_RESULT_TOOL_NAMES.has(name) &&
                (result.status === 'accepted' || result.status === 'waiting_approval')
            ) {
                return createGatewayManagedDeferredResult(name, result);
            }
            return createGatewayManagedSuccessResult(name, result);
        },

        async listResources(input = {}) {
            const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || defaultAgentId);

            if (!agentId) {
                return {
                    resources: [],
                    meta: {
                        requestId: normalizeMcpString(input.requestContext?.requestId, 128)
                    }
                };
            }

            return {
                resources: [
                    createMemoryTargetsResource(agentId)
                ],
                meta: {
                    requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                    agentId
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
                        supportedTemplates: MCP_DIARY_LOOP_RESOURCE_TEMPLATES
                    }
                );
            }

            if (parsed.kind === MCP_RESOURCE_KINDS.MEMORY_TARGETS) {
                const agentId = ensureAgentId({
                    ...input,
                    agentId: parsed.agentId || input.agentId
                }, 'resources/read', defaultAgentId);
                const response = await backendClient.getMemoryTargets({
                    agentId,
                    requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                    maid: normalizeMcpString(input.maid || input.requestContext?.maid, 256)
                });
                const result = normalizeNativeResult(response);
                if (!result.success) {
                    throw createMcpError(
                        mapGatewayFailureToMcpErrorCode(result.code),
                        result.error || 'Failed to read memory targets resource',
                        {
                            canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
                            gatewayCode: result.code || '',
                            requestId: result.requestId || '',
                            gatewayStatus: result.httpStatus,
                            ...buildOperabilityMetadata(result.meta),
                            ...(result.details && typeof result.details === 'object' ? result.details : {})
                        }
                    );
                }

                return {
                    contents: [{
                        uri: input.uri,
                        mimeType: 'application/json',
                        text: serializeMcpValue(result.data?.targets || [])
                    }],
                    meta: {
                        requestId: result.requestId,
                        agentId
                    }
                };
            }

            if (parsed.kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
                ensureJobIdentity(input, 'resources/read', defaultAgentId);
                const jobQuery = buildJobQuery(input, {
                    jobId: parsed.jobId
                }, defaultAgentId);
                const [jobResponse, eventsResponse] = await Promise.all([
                    backendClient.getJob(parsed.jobId, jobQuery),
                    backendClient.listJobEvents(parsed.jobId, jobQuery)
                ]);
                const jobResult = normalizeNativeResult(jobResponse);

                if (!jobResult.success) {
                    throw createMcpError(
                        mapGatewayFailureToMcpErrorCode(jobResult.code),
                        jobResult.error || 'Failed to read Gateway job runtime events',
                        {
                            canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[jobResult.code] || jobResult.code || '',
                            gatewayCode: jobResult.code || '',
                            requestId: jobResult.requestId || '',
                            gatewayStatus: jobResult.httpStatus,
                            ...buildOperabilityMetadata(jobResult.meta),
                            ...(jobResult.details && typeof jobResult.details === 'object' ? jobResult.details : {})
                        }
                    );
                }

                if (!eventsResponse.ok) {
                    throw createMcpError(
                        MCP_ERROR_CODES.RUNTIME_ERROR,
                        'Failed to list Gateway job runtime events',
                        {
                            requestId: jobResult.requestId || '',
                            gatewayStatus: eventsResponse.httpStatus
                        }
                    );
                }

                const payload = {
                    jobId: parsed.jobId,
                    job: jobResult.data?.job || null,
                    events: eventsResponse.events.filter((event) => event?.eventType !== 'gateway.meta')
                };

                return {
                    contents: [{
                        uri: buildJobEventsResourceUri(parsed.jobId),
                        mimeType: 'application/json',
                        text: serializeMcpValue(payload)
                    }],
                    meta: {
                        requestId: jobResult.requestId || normalizeMcpString(input.requestContext?.requestId, 128),
                        jobId: parsed.jobId
                    }
                };
            }

            throw createMcpError(
                MCP_ERROR_CODES.RESOURCE_UNSUPPORTED,
                'Unsupported resource URI',
                {
                    uri: input.uri || '',
                    supportedTemplates: MCP_DIARY_LOOP_RESOURCE_TEMPLATES
                }
            );
        }
    };
}

function createBackendProxyMcpServerHarness(options = {}) {
    const adapter = options.adapter || createBackendProxyMcpAdapter(options);

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
    createBackendProxyMcpAdapter,
    createBackendProxyMcpServerHarness
};
