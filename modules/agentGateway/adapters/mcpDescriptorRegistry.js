const MCP_RESOURCE_KINDS = Object.freeze({
    CAPABILITIES: 'capabilities',
    MEMORY_TARGETS: 'memory-targets',
    AGENT_PROFILE: 'agent-profile',
    AGENT_PROMPT_TEMPLATE: 'agent-prompt-template',
    JOB_EVENTS: 'job-events'
});

const MCP_GATEWAY_TOOL_NAMES = Object.freeze({
    AGENT_RENDER: 'gateway_agent_render',
    JOB_GET: 'gateway_job_get',
    JOB_CANCEL: 'gateway_job_cancel',
    MEMORY_SEARCH: 'gateway_memory_search',
    CONTEXT_ASSEMBLE: 'gateway_context_assemble',
    MEMORY_WRITE: 'gateway_memory_write',
    MEMORY_COMMIT_FOR_CODING: 'gateway_memory_commit_for_coding',
    RECALL_FOR_CODING: 'gateway_recall_for_coding'
});

const MCP_GATEWAY_PROMPT_NAMES = Object.freeze({
    AGENT_RENDER: MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER
});

const MCP_SUPPORTED_RESOURCE_TEMPLATES = Object.freeze([
    'vcp://agent-gateway/capabilities/{agentId}',
    'vcp://agent-gateway/memory-targets/{agentId}',
    'vcp://agent-gateway/agents/{agentId}/profile',
    'vcp://agent-gateway/agents/{agentId}/prompt-template',
    'vcp://agent-gateway/jobs/{jobId}/events'
]);

const MCP_DIARY_LOOP_RESOURCE_TEMPLATES = Object.freeze([
    'vcp://agent-gateway/memory-targets/{agentId}',
    'vcp://agent-gateway/jobs/{jobId}/events'
]);

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

function createGatewayPromptDescriptor({
    name,
    title,
    description,
    arguments: promptArguments
}) {
    return {
        name,
        title,
        description,
        arguments: Array.isArray(promptArguments) ? promptArguments : []
    };
}

function createPromptArgumentDescriptor({
    name,
    description,
    required = false
}) {
    return {
        name,
        description,
        required: Boolean(required)
    };
}

function normalizeMcpInputSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return {
            type: 'object',
            additionalProperties: true
        };
    }

    if (schema.type === 'object') {
        return schema;
    }

    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
        return {
            type: 'object',
            additionalProperties: schema.additionalProperties !== undefined
                ? schema.additionalProperties
                : true,
            ...schema
        };
    }

    return {
        type: 'object',
        additionalProperties: schema.additionalProperties !== undefined
            ? schema.additionalProperties
            : true,
        properties: schema.properties && typeof schema.properties === 'object'
            ? schema.properties
            : {},
        ...(Array.isArray(schema.required) ? { required: schema.required } : {})
    };
}

function buildMcpToolDescriptor(tool) {
    return {
        name: tool.name,
        title: tool.displayName || tool.name,
        description: tool.description,
        inputSchema: normalizeMcpInputSchema(tool.inputSchema),
        annotations: {
            distributed: Boolean(tool.distributed),
            approvalRequired: Boolean(tool.approvalRequired),
            timeoutMs: tool.timeoutMs,
            pluginType: tool.pluginType
        }
    };
}

function createGatewayManagedPromptDescriptors({ includeAgentRender = true } = {}) {
    if (!includeAgentRender) {
        return [];
    }

    return [
        createGatewayPromptDescriptor({
            name: MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER,
            title: 'Gateway Agent Render Prompt',
            description: 'Fetch the final canonical Agent Gateway rendered prompt as the primary MCP prompt surface for host-side agent injection.',
            arguments: [
                createPromptArgumentDescriptor({
                    name: 'agentId',
                    description: 'Stable agent identifier for the render target.',
                    required: true
                }),
                createPromptArgumentDescriptor({
                    name: 'variables',
                    description: 'Optional render variables applied before final prompt compilation.'
                }),
                createPromptArgumentDescriptor({
                    name: 'model',
                    description: 'Optional model identifier forwarded to the shared render behavior.'
                }),
                createPromptArgumentDescriptor({
                    name: 'maxLength',
                    description: 'Optional rendered prompt truncation limit.'
                }),
                createPromptArgumentDescriptor({
                    name: 'context',
                    description: 'Optional additional render context forwarded to the shared render behavior.'
                }),
                createPromptArgumentDescriptor({
                    name: 'messages',
                    description: 'Optional recent message context used by the shared render behavior.'
                })
            ]
        })
    ];
}

function createGatewayManagedToolDescriptors({
    diaryRagLoopOnly = false
} = {}) {
    const tools = [];

    tools.push(
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.JOB_GET,
            title: 'Gateway Job Get',
            description: 'Read canonical Agent Gateway job status through the shared job runtime service.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['jobId'],
                properties: {
                    jobId: { type: 'string' }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL,
            title: 'Gateway Job Cancel',
            description: 'Cancel a cancellable Agent Gateway job through the shared job runtime service.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['jobId'],
                properties: {
                    jobId: { type: 'string' }
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
    );

    if (diaryRagLoopOnly) {
        return tools;
    }

    return tools;
}

function encodeResourceAgentId(agentId) {
    return encodeURIComponent(String(agentId || '').trim());
}

function buildJobEventsResourceUri(jobId) {
    return `vcp://agent-gateway/jobs/${encodeResourceAgentId(jobId)}/events`;
}

function buildResourceUri(kind, agentId) {
    if (kind === MCP_RESOURCE_KINDS.AGENT_PROFILE) {
        return `vcp://agent-gateway/agents/${encodeResourceAgentId(agentId)}/profile`;
    }
    if (kind === MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE) {
        return `vcp://agent-gateway/agents/${encodeResourceAgentId(agentId)}/prompt-template`;
    }
    if (kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
        return buildJobEventsResourceUri(agentId);
    }
    return `vcp://agent-gateway/${kind}/${encodeResourceAgentId(agentId)}`;
}

function parseResourceUri(uri) {
    const normalizedUri = typeof uri === 'string' ? uri.trim() : '';
    const agentResourceMatch = normalizedUri.match(/^vcp:\/\/agent-gateway\/agents\/([^/]+)\/(profile|prompt-template)$/);
    if (agentResourceMatch) {
        return {
            kind: agentResourceMatch[2] === 'profile'
                ? MCP_RESOURCE_KINDS.AGENT_PROFILE
                : MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE,
            agentId: decodeURIComponent(agentResourceMatch[1])
        };
    }
    const jobEventMatch = normalizedUri.match(/^vcp:\/\/agent-gateway\/jobs\/([^/]+)\/events$/);
    if (jobEventMatch) {
        return {
            kind: MCP_RESOURCE_KINDS.JOB_EVENTS,
            jobId: decodeURIComponent(jobEventMatch[1])
        };
    }
    const match = normalizedUri.match(/^vcp:\/\/agent-gateway\/([^/]+)\/([^/]+)$/);
    if (!match) {
        return null;
    }

    return {
        kind: match[1],
        agentId: decodeURIComponent(match[2])
    };
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

function createAgentProfileResource(agentId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.AGENT_PROFILE, agentId),
        name: `Agent Gateway profile for ${agentId}`,
        description: 'Governed agent profile metadata derived from the shared agent registry contract.',
        mimeType: 'application/json'
    };
}

function createAgentPromptTemplateResource(agentId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE, agentId),
        name: `Agent Gateway prompt template preview for ${agentId}`,
        description: 'Preview-oriented prompt template metadata derived from the shared agent registry contract.',
        mimeType: 'application/json'
    };
}

function createJobEventsResource(jobId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.JOB_EVENTS, jobId),
        name: `Agent Gateway job runtime events for ${jobId}`,
        description: 'Read-only runtime event snapshots for a canonical Gateway Core job.',
        mimeType: 'application/json'
    };
}

module.exports = {
    MCP_RESOURCE_KINDS,
    MCP_GATEWAY_TOOL_NAMES,
    MCP_GATEWAY_PROMPT_NAMES,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    MCP_DIARY_LOOP_RESOURCE_TEMPLATES,
    normalizeMcpInputSchema,
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
};
