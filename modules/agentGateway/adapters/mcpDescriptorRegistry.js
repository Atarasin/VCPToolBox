const MCP_RESOURCE_KINDS = Object.freeze({
    CAPABILITIES: 'capabilities',
    MEMORY_TARGETS: 'memory-targets',
    AGENT_PROFILE: 'agent-profile',
    AGENT_PROMPT_TEMPLATE: 'agent-prompt-template',
    JOB_EVENTS: 'job-events'
});

const MCP_GATEWAY_TOOL_NAMES = Object.freeze({
    AGENT_RENDER: 'gateway_agent_render',
    AGENT_BOOTSTRAP: 'gateway_agent_bootstrap',
    JOB_GET: 'gateway_job_get',
    JOB_CANCEL: 'gateway_job_cancel',
    MEMORY_SEARCH: 'gateway_memory_search',
    CONTEXT_ASSEMBLE: 'gateway_context_assemble',
    MEMORY_WRITE: 'gateway_memory_write',
    RECALL_RUN: 'gateway_recall_run'
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
            name: MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP,
            title: 'Gateway Agent Bootstrap',
            description: 'Fetch the canonical rendered bootstrap prompt for tool-only hosts that cannot consume MCP prompt surfaces directly.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['agentId'],
                properties: {
                    agentId: {
                        type: 'string',
                        description: 'Target agent identifier used to resolve the rendered bootstrap prompt.'
                    },
                    variables: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Optional prompt template variables applied before rendering.'
                    },
                    model: {
                        type: 'string',
                        description: 'Optional model identifier forwarded to the render behavior.'
                    },
                    maxLength: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Optional maximum length for the rendered prompt output.'
                    },
                    context: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Optional extra render context merged into the prompt rendering input.'
                    },
                    messages: {
                        type: 'array',
                        description: 'Optional recent conversation messages used as render context.',
                        items: {
                            type: 'object',
                            additionalProperties: true
                        }
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.JOB_GET,
            title: 'Gateway Job Get',
            description: 'Read canonical Agent Gateway job status through the shared job runtime service.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['jobId'],
                properties: {
                    jobId: {
                        type: 'string',
                        description: 'Canonical Agent Gateway job identifier to read.'
                    }
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
                    jobId: {
                        type: 'string',
                        description: 'Canonical Agent Gateway job identifier to cancel.'
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
                    agentId: {
                        type: 'string',
                        description: 'Agent identifier used to resolve diary access policy for this search.'
                    },
                    query: {
                        type: 'string',
                        description: 'Search query used to retrieve relevant memory entries.'
                    },
                    diary: {
                        type: 'string',
                        description: 'Optional single diary target. Automatically merged into `diaries` when provided.'
                    },
                    diaries: {
                        type: 'array',
                        description: 'Optional explicit list of diary targets to search within.',
                        items: { type: 'string' }
                    },
                    mode: {
                        type: 'string',
                        enum: ['rag', 'hybrid', 'auto'],
                        description: 'Retrieval mode: `rag` uses baseline retrieval, `hybrid` enables the richer retrieval defaults, and `auto` is currently reserved for future automatic strategy selection.'
                    },
                    k: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Maximum number of candidate memories to retrieve.'
                    },
                    timeAware: {
                        type: 'boolean',
                        description: 'Whether to apply time-aware retrieval heuristics.'
                    },
                    groupAware: {
                        type: 'boolean',
                        description: 'Whether to apply semantic group activation during retrieval.'
                    },
                    rerank: {
                        type: 'boolean',
                        description: 'Whether to rerank retrieved candidates before returning results.'
                    },
                    tagMemo: {
                        type: 'boolean',
                        description: 'Whether to boost matches using core memory tag signals.'
                    },
                    options: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Optional adapter-specific search options.'
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
                    agentId: {
                        type: 'string',
                        description: 'Agent identifier used to resolve diary access policy for context assembly.'
                    },
                    query: {
                        type: 'string',
                        description: 'Optional explicit recall query. When omitted, the service derives one from `recentMessages`.'
                    },
                    recentMessages: {
                        type: 'array',
                        description: 'Optional recent messages used to derive the recall query and context.',
                        items: {
                            type: 'object',
                            additionalProperties: true
                        }
                    },
                    diary: {
                        type: 'string',
                        description: 'Optional single diary target. Automatically merged into `diaries` when provided.'
                    },
                    diaries: {
                        type: 'array',
                        description: 'Optional explicit list of diary targets to assemble context from.',
                        items: { type: 'string' }
                    },
                    maxBlocks: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Maximum number of recall blocks to return.'
                    },
                    tokenBudget: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Approximate token budget reserved for assembled recall context.'
                    },
                    minScore: {
                        type: 'number',
                        description: 'Minimum retrieval score threshold for keeping recall blocks.'
                    },
                    mode: {
                        type: 'string',
                        enum: ['rag', 'hybrid', 'auto'],
                        description: 'Retrieval mode: `rag` uses baseline retrieval, `hybrid` enables the richer retrieval defaults, and `auto` is currently reserved for future automatic strategy selection.'
                    },
                    timeAware: {
                        type: 'boolean',
                        description: 'Whether to apply time-aware retrieval heuristics.'
                    },
                    groupAware: {
                        type: 'boolean',
                        description: 'Whether to apply semantic group activation during retrieval.'
                    },
                    rerank: {
                        type: 'boolean',
                        description: 'Whether to rerank retrieved candidates before building recall blocks.'
                    },
                    tagMemo: {
                        type: 'boolean',
                        description: 'Whether to boost matches using core memory tag signals.'
                    }
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
                    agentId: {
                        type: 'string',
                        description: 'Agent identifier used to resolve memory target policy and configured write maid.'
                    },
                    target: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Write target definition. Typically contains the destination diary.'
                    },
                    memory: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Memory payload to persist, including text, tags, and optional metadata.'
                    },
                    metadata: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Optional top-level metadata shortcut merged into the memory payload.'
                    },
                    tags: {
                        type: 'array',
                        description: 'Optional top-level tag shortcut merged into the memory payload.',
                        items: { type: 'string' }
                    },
                    diary: {
                        type: 'string',
                        description: 'Optional top-level diary shortcut merged into `target.diary`.'
                    },
                    text: {
                        type: 'string',
                        description: 'Optional top-level text shortcut merged into `memory.text`.'
                    },
                    timestamp: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'number' }
                        ],
                        description: 'Optional timestamp shortcut merged into `memory.timestamp`.'
                    },
                    idempotencyKey: {
                        type: 'string',
                        description: 'Optional idempotency key used to deduplicate repeated writes.'
                    },
                    options: {
                        type: 'object',
                        additionalProperties: true,
                        description: 'Optional write controls such as deduplication and bridge tool settings.'
                    }
                }
            }
        }),
        createGatewayToolDescriptor({
            name: MCP_GATEWAY_TOOL_NAMES.RECALL_RUN,
            title: 'Gateway Recall Run',
            description: 'Execute a preconfigured recall profile for an agent. Supports rag and gated_rag base modes with Time, Group, Rerank, TagMemo, and Truncate modifiers.',
            inputSchema: {
                type: 'object',
                additionalProperties: false,
                required: ['agentId', 'query'],
                properties: {
                    agentId: {
                        type: 'string',
                        description: 'Target agent identifier used to resolve diary access and recall profile.'
                    },
                    query: {
                        type: 'string',
                        description: 'Recall query string passed to the retrieval pipeline.'
                    },
                    profile: {
                        type: 'string',
                        description: 'Optional recall profile name. Defaults to the agent\'s configured default profile or system fallback.'
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
