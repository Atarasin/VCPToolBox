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

const MCP_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'MCP_INVALID_REQUEST',
    INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
    FORBIDDEN: 'MCP_FORBIDDEN',
    NOT_FOUND: 'MCP_NOT_FOUND',
    TIMEOUT: 'MCP_TIMEOUT',
    RUNTIME_ERROR: 'MCP_RUNTIME_ERROR',
    RESOURCE_UNSUPPORTED: 'MCP_RESOURCE_UNSUPPORTED'
});

const MCP_RESOURCE_KINDS = Object.freeze({
    CAPABILITIES: 'capabilities',
    MEMORY_TARGETS: 'memory-targets'
});

const MCP_GATEWAY_TOOL_NAMES = Object.freeze({
    AGENT_RENDER: 'gateway_agent_render',
    MEMORY_SEARCH: 'gateway_memory_search',
    CONTEXT_ASSEMBLE: 'gateway_context_assemble',
    MEMORY_WRITE: 'gateway_memory_write',
    MEMORY_COMMIT_FOR_CODING: 'gateway_memory_commit_for_coding',
    RECALL_FOR_CODING: 'gateway_recall_for_coding'
});

/**
 * MCP v1 当前开放的最小能力面：
 * - tools/list
 * - tools/call
 * - resources/list
 * - resources/read
 *
 * 支持的只读资源仅包括：
 * - `vcp://agent-gateway/capabilities/<agentId>`
 * - `vcp://agent-gateway/memory-targets/<agentId>`
 *
 * prompts / jobs / events / write resources 明确不在当前里程碑范围内。
 */
const MCP_SUPPORTED_RESOURCE_TEMPLATES = Object.freeze([
    'vcp://agent-gateway/capabilities/{agentId}',
    'vcp://agent-gateway/memory-targets/{agentId}'
]);

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

function createGatewayToolDescriptor({
    name,
    title,
    description,
    inputSchema
}) {
    return {
        name,
        title,
        description,
        inputSchema,
        annotations: {
            gatewayManaged: true
        }
    };
}

function buildMcpToolDescriptor(tool) {
    return {
        name: tool.name,
        title: tool.displayName || tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
            distributed: Boolean(tool.distributed),
            approvalRequired: Boolean(tool.approvalRequired),
            timeoutMs: tool.timeoutMs,
            pluginType: tool.pluginType
        }
    };
}

// Gateway-managed MCP tools map directly onto canonical Gateway Core capabilities.
function createGatewayManagedToolDescriptors() {
    return [
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER,
            title: 'Gateway Agent Render',
            description: 'Render a canonical Agent Gateway prompt through the shared agent registry service.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['agentId'],
                properties: {
                    agentId: { type: 'string' },
                    variables: {
                        type: 'object',
                        additionalProperties: true
                    },
                    model: { type: 'string' },
                    maxLength: {
                        type: 'integer',
                        minimum: 1
                    },
                    context: {
                        type: 'object',
                        additionalProperties: true
                    },
                    messages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
            title: 'Gateway Memory Search',
            description: 'Execute canonical Agent Gateway memory search through Gateway Core.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['query'],
                properties: {
                    query: { type: 'string' },
                    diary: { type: 'string' },
                    diaries: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    maid: { type: 'string' },
                    mode: {
                        type: 'string',
                        enum: ['rag', 'hybrid', 'auto']
                    },
                    k: { type: 'integer', minimum: 1 },
                    timeAware: { type: 'boolean' },
                    groupAware: { type: 'boolean' },
                    rerank: { type: 'boolean' },
                    tagMemo: { type: 'boolean' },
                    options: {
                        type: 'object',
                        additionalProperties: true
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE,
            title: 'Gateway Context Assemble',
            description: 'Assemble canonical Agent Gateway recall context through Gateway Core.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    query: { type: 'string' },
                    recentMessages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true
                        }
                    },
                    diary: { type: 'string' },
                    diaries: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    maid: { type: 'string' },
                    maxBlocks: { type: 'integer', minimum: 1 },
                    tokenBudget: { type: 'integer', minimum: 1 },
                    minScore: { type: 'number' },
                    mode: {
                        type: 'string',
                        enum: ['rag', 'hybrid', 'auto']
                    },
                    timeAware: { type: 'boolean' },
                    groupAware: { type: 'boolean' },
                    rerank: { type: 'boolean' },
                    tagMemo: { type: 'boolean' }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE,
            title: 'Gateway Memory Write',
            description: 'Persist durable memory through the canonical Agent Gateway write path.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['target', 'memory'],
                properties: {
                    target: {
                        type: 'object',
                        additionalProperties: true
                    },
                    memory: {
                        type: 'object',
                        additionalProperties: true
                    },
                    metadata: {
                        type: 'object',
                        additionalProperties: true
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    diary: { type: 'string' },
                    text: { type: 'string' },
                    timestamp: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'number' }
                        ]
                    },
                    maid: { type: 'string' },
                    idempotencyKey: { type: 'string' },
                    options: {
                        type: 'object',
                        additionalProperties: true
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING,
            title: 'Gateway Memory Commit For Coding',
            description: 'Commit coding-oriented durable memory through shared Gateway Core write behavior.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['task'],
                allOf: [
                    {
                        anyOf: [
                            {
                                required: ['summary']
                            },
                            {
                                required: ['constraints']
                            },
                            {
                                required: ['outcome']
                            },
                            {
                                required: ['result']
                            },
                            {
                                required: ['notes']
                            },
                            {
                                required: ['pitfalls']
                            },
                            {
                                required: ['files']
                            },
                            {
                                required: ['symbols']
                            }
                        ]
                    },
                    {
                        anyOf: [
                            {
                                required: ['diary']
                            },
                            {
                                required: ['target']
                            }
                        ]
                    }
                ],
                properties: {
                    task: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    summary: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    implementation: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    outcome: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    result: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    notes: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    constraints: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'array',
                                items: { type: 'string' }
                            }
                        ]
                    },
                    pitfalls: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'array',
                                items: { type: 'string' }
                            }
                        ]
                    },
                    repository: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    workspaceRoot: { type: 'string' },
                    target: {
                        type: 'object',
                        additionalProperties: true,
                        required: ['diary'],
                        properties: {
                            diary: { type: 'string' },
                            maid: { type: 'string' }
                        }
                    },
                    diary: { type: 'string' },
                    maid: { type: 'string' },
                    files: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    additionalProperties: true
                                }
                            ]
                        }
                    },
                    symbols: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    additionalProperties: true
                                }
                            ]
                        }
                    },
                    recommendedTags: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    metadata: {
                        type: 'object',
                        additionalProperties: true
                    },
                    idempotencyKey: { type: 'string' },
                    timestamp: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'number' }
                        ]
                    },
                    options: {
                        type: 'object',
                        additionalProperties: true
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING,
            title: 'Gateway Recall For Coding',
            description: 'Build coding-oriented recall context through shared Gateway Core memory behavior.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['task'],
                anyOf: [
                    {
                        required: ['files']
                    },
                    {
                        required: ['symbols']
                    },
                    {
                        required: ['recentMessages']
                    }
                ],
                properties: {
                    task: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                additionalProperties: true
                            }
                        ]
                    },
                    repository: {
                        type: 'object',
                        additionalProperties: true
                    },
                    workspaceRoot: { type: 'string' },
                    files: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    additionalProperties: true
                                }
                            ]
                        }
                    },
                    symbols: {
                        type: 'array',
                        items: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'object',
                                    additionalProperties: true
                                }
                            ]
                        }
                    },
                    recentMessages: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: true
                        }
                    },
                    diary: { type: 'string' },
                    diaries: {
                        type: 'array',
                        items: { type: 'string' }
                    },
                    maxBlocks: { type: 'integer', minimum: 1 },
                    tokenBudget: { type: 'integer', minimum: 1 },
                    minScore: { type: 'number' },
                    mode: {
                        type: 'string',
                        enum: ['rag', 'hybrid', 'auto']
                    },
                    timeAware: { type: 'boolean' },
                    groupAware: { type: 'boolean' },
                    rerank: { type: 'boolean' },
                    tagMemo: { type: 'boolean' },
                    options: {
                        type: 'object',
                        additionalProperties: true
                    }
                }
            }
        })
    ];
}

function encodeResourceAgentId(agentId) {
    return encodeURIComponent(String(agentId || '').trim());
}

function buildResourceUri(kind, agentId) {
    return `vcp://agent-gateway/${kind}/${encodeResourceAgentId(agentId)}`;
}

function parseResourceUri(uri) {
    const normalizedUri = typeof uri === 'string' ? uri.trim() : '';
    const match = normalizedUri.match(/^vcp:\/\/agent-gateway\/([^/]+)\/([^/]+)$/);
    if (!match) {
        return null;
    }

    return {
        kind: match[1],
        agentId: decodeURIComponent(match[2])
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

function createFailureResult(result) {
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
                ...((result?.details && typeof result.details === 'object') ? result.details : {})
            }
        },
        content: createMcpTextContent({
            error: result?.error || 'MCP tool call failed',
            code: mapGatewayFailureToMcpErrorCode(result?.code),
            requestId: result?.requestId || '',
            details: {
                gatewayStatus: typeof result?.status === 'number' ? result.status : undefined,
                ...(result?.details || {})
            }
        })
    };
}

function createSuccessResult(result) {
    return {
        isError: false,
        status: 'completed',
        structuredContent: {
            status: 'completed',
            requestId: result.requestId,
            toolName: result.data.toolName,
            result: result.data.result,
            audit: result.data.audit
        },
        content: createMcpTextContent(result.data.result)
    };
}

function createDeferredResult(result) {
    return {
        isError: false,
        status: result.status,
        deferred: true,
        structuredContent: {
            status: result.status,
            requestId: result.requestId,
            toolName: result.data?.toolName || '',
            runtime: result.data?.runtime || {},
            job: result.data?.job || null,
            audit: result.data?.audit || {}
        },
        content: createMcpTextContent({
            status: result.status,
            requestId: result.requestId,
            job: result.data?.job || null,
            message: result.status === 'waiting_approval'
                ? 'Tool approval is required before execution can continue.'
                : 'Tool execution was accepted for deferred processing.'
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
    return {
        isError: false,
        status: 'completed',
        structuredContent: {
            status: 'completed',
            requestId: result.requestId,
            toolName: name,
            result: result.data,
            audit: result.audit || {}
        },
        content: createGatewayManagedContent(name, result.data)
    };
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

function mapGatewayManagedResultToMcp(name, result) {
    if (!result || typeof result !== 'object') {
        return createFailureResult({
            error: 'Gateway runtime returned an invalid result',
            code: OPENCLAW_ERROR_CODES.INTERNAL_ERROR
        });
    }

    if (result.success) {
        return createGatewayManagedSuccessResult(name, result);
    }

    return createFailureResult(result);
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

async function executeGatewayManagedTool(bundle, name, args, input = {}) {
    const contextInput = buildManagedToolContextInput(input, args);
    const source = {
        [MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER]: 'mcp-agent-render',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH]: 'mcp-memory-search',
        [MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE]: 'mcp-context-assemble',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE]: 'mcp-memory-write',
        [MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING]: 'mcp-coding-memory-writeback',
        [MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING]: 'mcp-coding-recall'
    }[name] || 'mcp';
    const { maid, requestContext, authContext } = buildMcpContexts(bundle, contextInput, source);
    ensureAgentAndSession(requestContext, `tools/call:${name}`);

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

    // Render remains the high-level MCP entry point and reuses the shared registry contract.
    if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER) {
        ensureAgentId(requestContext, `tools/call:${name}`);

        try {
            const renderResult = await bundle.agentRegistryService.renderAgent(requestContext.agentId, {
                variables: args.variables,
                model: args.model,
                maxLength: args.maxLength,
                context: args.context,
                messages: args.messages
            });

            return mapGatewayManagedResultToMcp(name, {
                success: true,
                requestId: requestContext.requestId,
                data: renderResult,
                audit: {
                    runtime: requestContext.runtime,
                    source: requestContext.source
                }
            });
        } catch (error) {
            return mapGatewayManagedResultToMcp(name, mapAgentRegistryError(error, requestContext));
        }
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH) {
        const result = await bundle.contextRuntimeService.search({
            body,
            startedAt: Date.now(),
            defaultSource: source
        });
        return mapGatewayManagedResultToMcp(name, result);
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE) {
        const result = await bundle.contextRuntimeService.buildRecallContext({
            body,
            startedAt: Date.now(),
            defaultSource: source
        });
        return mapGatewayManagedResultToMcp(name, result);
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE) {
        const result = await bundle.memoryRuntimeService.writeMemory({
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
        return mapGatewayManagedResultToMcp(name, result);
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_COMMIT_FOR_CODING) {
        const result = await bundle.codingMemoryWritebackService.commitForCoding({
            body,
            startedAt: Date.now(),
            clientIp: normalizeMcpString(input.clientIp, 64) || '127.0.0.1',
            defaultSource: source
        });
        return mapGatewayManagedResultToMcp(name, result);
    }

    if (name === MCP_GATEWAY_TOOL_NAMES.RECALL_FOR_CODING) {
        const result = await bundle.codingRecallService.recallForCoding({
            body,
            startedAt: Date.now(),
            defaultSource: source
        });
        return mapGatewayManagedResultToMcp(name, result);
    }

    throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
        field: 'name',
        name
    });
}

function createCapabilitiesResource(agentId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.CAPABILITIES, agentId),
        name: `Agent Gateway capabilities for ${agentId}`,
        description: 'Canonical capability discovery snapshot derived from Gateway Core.',
        mimeType: 'application/json'
    };
}

function createMemoryTargetsResource(agentId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.MEMORY_TARGETS, agentId),
        name: `Agent Gateway memory targets for ${agentId}`,
        description: 'Policy-filtered memory target metadata derived from Gateway Core.',
        mimeType: 'application/json'
    };
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
        toolRuntimeService
    } = bundle;
    const gatewayManagedTools = createGatewayManagedToolDescriptors();

    return {
        supportedResourceTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES,
        async listTools(input = {}) {
            const { maid, requestContext, authContext } = buildMcpContexts(bundle, input, 'mcp-tools-list');
            ensureAgentId(requestContext, 'tools/list');

            const capabilities = await capabilityService.getCapabilities({
                agentId: requestContext.agentId,
                maid,
                includeMemoryTargets: false,
                authContext
            });

            return {
                tools: [
                    ...(capabilities.tools || []).map(buildMcpToolDescriptor),
                    ...gatewayManagedTools
                ].sort((left, right) => left.name.localeCompare(right.name)),
                meta: {
                    requestId: requestContext.requestId,
                    agentId: requestContext.agentId
                }
            };
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
                    codingRecallService
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
            const { requestContext } = buildMcpContexts(bundle, input, 'mcp-resources-list');
            ensureAgentId(requestContext, 'resources/list');

            return {
                resources: [
                    createCapabilitiesResource(requestContext.agentId),
                    createMemoryTargetsResource(requestContext.agentId)
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

            const { kind, agentId } = parsed;
            const { maid, requestContext, authContext } = buildMcpContexts(bundle, {
                ...input,
                agentId
            }, 'mcp-resources-read');

            let payload;
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

            return {
                contents: [{
                    uri: buildResourceUri(kind, agentId),
                    mimeType: 'application/json',
                    text: serializeMcpValue(payload)
                }],
                meta: {
                    requestId: requestContext.requestId,
                    agentId
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
