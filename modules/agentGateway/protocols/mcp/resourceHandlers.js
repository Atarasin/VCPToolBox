const { OPENCLAW_TO_AGENT_GATEWAY_CODE, AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const {
    MCP_RESOURCE_KINDS,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    buildResourceUri,
    createJobEventsResource,
    parseResourceUri
} = require('./descriptors');
const { mapGatewayFailureToMcpErrorCode } = require('./errorMapping');
const { MCP_ERROR_CODES } = require('./constants');
const { createMcpError, serializeMcpValue } = require('./resultShapes');

function throwResourceFailure(result, requestId, fallbackMessage) {
    throw createMcpError(
        mapGatewayFailureToMcpErrorCode(result.code),
        result.error || fallbackMessage,
        {
            canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
            gatewayCode: result.code || '',
            requestId: result.requestId || requestId,
            ...(result.details && typeof result.details === 'object' ? result.details : {})
        }
    );
}

async function readJobEvents({ jobRuntimeService, jobId, authContext, requestContext, attachRequestId }) {
    const jobResult = attachRequestId(
        jobRuntimeService.pollJob(jobId, authContext),
        requestContext.requestId
    );
    if (!jobResult.success) {
        throwResourceFailure(jobResult, requestContext.requestId, 'Failed to read Gateway job runtime events');
    }
    const eventResult = attachRequestId(
        jobRuntimeService.listEvents({ authContext, filters: { jobId } }),
        requestContext.requestId
    );
    if (!eventResult.success) {
        throwResourceFailure(eventResult, requestContext.requestId, 'Failed to list Gateway job runtime events');
    }
    return {
        jobId,
        job: jobResult.data?.job || null,
        events: eventResult.data?.events || []
    };
}

function createResourcePayloadHandlers(bundle, context) {
    return {
        [MCP_RESOURCE_KINDS.CAPABILITIES]: ({ agentId, authContext }) =>
            bundle.capabilityService.getCapabilities({ agentId, includeMemoryTargets: true, authContext }),
        [MCP_RESOURCE_KINDS.MEMORY_TARGETS]: ({ agentId, authContext }) =>
            bundle.capabilityService.getMemoryTargets({ agentId, authContext }),
        [MCP_RESOURCE_KINDS.AGENT_PROFILE]: ({ agentId, authContext }) =>
            bundle.agentRegistryService.getAgentProfile(agentId, { authContext }),
        [MCP_RESOURCE_KINDS.AGENT_PROMPT_TEMPLATE]: ({ agentId, authContext }) =>
            bundle.agentRegistryService.getPromptTemplatePreview(agentId, { authContext }),
        [MCP_RESOURCE_KINDS.JOB_EVENTS]: (input) => readJobEvents({
            jobRuntimeService: bundle.jobRuntimeService,
            attachRequestId: context.attachRequestId,
            ...input
        })
    };
}

function createReadResourceHandler(bundle, context) {
    const payloadHandlers = createResourcePayloadHandlers(bundle, context);
    return async function readResource(input = {}) {
        const parsed = parseResourceUri(input.uri);
        if (!parsed) {
            throw createMcpError(MCP_ERROR_CODES.RESOURCE_UNSUPPORTED, 'Unsupported resource URI', {
                uri: input.uri || '',
                supportedTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES
            });
        }

        const { kind, agentId, jobId } = parsed;
        const resourceAgentId = agentId || input.agentId || input.requestContext?.agentId;
        const { requestContext, authContext } = context.buildMcpContexts(bundle, {
            ...input,
            ...(resourceAgentId ? { agentId: resourceAgentId } : {})
        }, 'mcp-resources-read');
        if (kind === MCP_RESOURCE_KINDS.JOB_EVENTS) {
            context.ensureJobIdentity(requestContext, authContext, 'resources/read');
        } else {
            context.ensureAgentId(requestContext, 'resources/read');
        }

        const handler = payloadHandlers[kind];
        if (!handler) {
            throw createMcpError(MCP_ERROR_CODES.RESOURCE_UNSUPPORTED, 'Unsupported resource URI', {
                uri: input.uri,
                supportedTemplates: MCP_SUPPORTED_RESOURCE_TEMPLATES
            });
        }

        let payload;
        try {
            payload = await handler({ agentId, jobId, authContext, requestContext });
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
    };
}

module.exports = { createReadResourceHandler };
