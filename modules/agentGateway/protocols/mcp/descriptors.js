const MCP_RESOURCE_KINDS = Object.freeze({
    CAPABILITIES: 'capabilities',
    MEMORY_TARGETS: 'memory-targets',
    AGENT_PROFILE: 'agent-profile',
    AGENT_PROMPT_TEMPLATE: 'agent-prompt-template',
    AGENT_GUIDANCE: 'agent-guidance',
    JOB_EVENTS: 'job-events'
});

const { MCP_GATEWAY_TOOL_NAMES } = require('../../contracts/operations');
const generatedDescriptors = require('../../contracts/generated/mcpDescriptors.json');

const MCP_GATEWAY_PROMPT_NAMES = Object.freeze({
    AGENT_RENDER: MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER
});

const MCP_SUPPORTED_RESOURCE_TEMPLATES = Object.freeze([
    'vcp://agent-gateway/capabilities/{agentId}',
    'vcp://agent-gateway/memory-targets/{agentId}',
    'vcp://agent-gateway/agents/{agentId}/profile',
    'vcp://agent-gateway/agents/{agentId}/prompt-template',
    'vcp://agent-gateway/agents/{agentId}/guidance',
    'vcp://agent-gateway/jobs/{jobId}/events'
]);

const MCP_DIARY_LOOP_RESOURCE_TEMPLATES = Object.freeze([
    'vcp://agent-gateway/memory-targets/{agentId}',
    'vcp://agent-gateway/agents/{agentId}/guidance',
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
    return includeAgentRender ? structuredClone(generatedDescriptors.prompts) : [];
}

function createGatewayManagedToolDescriptors() {
    return structuredClone(generatedDescriptors.tools);
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
    if (kind === MCP_RESOURCE_KINDS.AGENT_GUIDANCE) {
        return `vcp://agent-gateway/agents/${encodeResourceAgentId(agentId)}/guidance`;
    }
    if (kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
        return buildJobEventsResourceUri(agentId);
    }
    return `vcp://agent-gateway/${kind}/${encodeResourceAgentId(agentId)}`;
}

function parseResourceUri(uri) {
    const normalizedUri = typeof uri === 'string' ? uri.trim() : '';
    const agentResourceMatch = normalizedUri.match(/^vcp:\/\/agent-gateway\/agents\/([^/]+)\/(profile|prompt-template|guidance)$/);
    if (agentResourceMatch) {
        const agentResourceKinds = {
            profile: MCP_RESOURCE_KINDS.AGENT_PROFILE,
            'prompt-template': MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE,
            guidance: MCP_RESOURCE_KINDS.AGENT_GUIDANCE
        };
        return {
            kind: agentResourceKinds[agentResourceMatch[2]],
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

function createAgentGuidanceResource(agentId) {
    return {
        uri: buildResourceUri(MCP_RESOURCE_KINDS.AGENT_GUIDANCE, agentId),
        name: `Agent Gateway integration guidance for ${agentId}`,
        description: 'Canonical integration guidance bundle (workflow, memory write policy, diary routing) derived from the frozen integration snapshot.',
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
    createAgentGuidanceResource,
    createJobEventsResource
};
