const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { sanitizeRequestContextValue } = require('../../contracts/requestContext');
const { normalizeDiaryCanonicalName } = require('../../policy/mcpAgentMemoryPolicy');
const { applyDiaryPolicyGate } = require('./diaryPolicyGate');
const { createMcpError } = require('./resultShapes');
const { MCP_ERROR_CODES } = require('./constants');

function normalizeMcpString(value, maxLength = 128) {
    return sanitizeRequestContextValue(value, maxLength);
}

function attachRequestId(result, requestId) {
    if (!result || typeof result !== 'object') {
        return result;
    }
    return { ...result, requestId: result.requestId || requestId || '' };
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
        details: { message: error?.message || 'Unknown render failure' }
    };
}

function buildBootstrapResult(renderResult, agentId) {
    const resolvedAgentId = normalizeMcpString(renderResult?.agentId || agentId, 256) || agentId;
    const renderedPrompt = typeof renderResult?.renderedPrompt === 'string' ? renderResult.renderedPrompt : '';
    const warnings = Array.isArray(renderResult?.warnings) ? renderResult.warnings : [];
    const fragments = [`Bootstrap prompt ready for ${resolvedAgentId || 'unknown-agent'}`];
    if (renderedPrompt) fragments.push(`length=${renderedPrompt.length}`);
    if (renderResult?.truncated) fragments.push('truncated=true');
    if (warnings.length > 0) fragments.push(`warnings=${warnings.length}`);
    return { ...renderResult, agentId: resolvedAgentId, summary: fragments.join('; ') };
}

async function executeRender(context) {
    const { bundle, name, args, input, operation, executeManaged } = context;
    return executeManaged({
        bundle, name, args, input,
        operationName: operation.operationName,
        source: operation.source,
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
                if (renderResult?.success && ['accepted', 'waiting_approval'].includes(renderResult.status)) {
                    return attachRequestId(renderResult, requestContext.requestId);
                }
                return {
                    success: true,
                    requestId: requestContext.requestId,
                    data: operation.asBootstrap
                        ? buildBootstrapResult(renderResult, requestContext.agentId)
                        : renderResult,
                    audit: { runtime: requestContext.runtime, source: requestContext.source }
                };
            } catch (error) {
                return mapAgentRegistryError(error, requestContext);
            }
        }
    });
}

async function executeJob(context, action) {
    const { bundle, name, args, input, operation, executeManaged } = context;
    return executeManaged({
        bundle, name, args, input,
        operationName: operation.operationName,
        source: operation.source,
        requiresJobIdentity: true,
        async execute({ requestContext, authContext }) {
            return attachRequestId(
                bundle.jobRuntimeService[action](args.jobId, authContext),
                requestContext.requestId
            );
        }
    });
}

async function executeDiary(context, serviceMethod) {
    const { bundle, name, args, input, operation, executeManaged, mapManagedResult } = context;
    const scoped = applyDiaryPolicyGate({ toolName: name, payload: args, input });
    if (scoped.rejection) {
        return mapManagedResult(name, scoped.rejection);
    }
    return executeManaged({
        bundle, name,
        operationName: operation.operationName,
        args: scoped.payload,
        clientPayloadArgs: args,
        input: { ...input, diaryPolicy: scoped.diaryPolicy },
        source: operation.source,
        async execute({ body, diaryPolicy }) {
            return bundle.contextRuntimeService[serviceMethod]({
                body,
                startedAt: Date.now(),
                defaultSource: operation.source,
                diaryPolicy
            });
        }
    });
}

async function executeMemoryWrite(context) {
    const { bundle, name, args, input, operation, executeManaged } = context;
    return executeManaged({
        bundle, name, args, input,
        operationName: operation.operationName,
        source: operation.source,
        async execute({ body }) {
            const resolvedDiary = normalizeDiaryCanonicalName(
                normalizeMcpString(body.diary || body.target?.diary, 256)
            );
            const idempotencyKey = body.options?.idempotencyKey || args.idempotencyKey || body.idempotencyKey;
            return bundle.memoryRuntimeService.writeMemory({
                body: {
                    ...body,
                    ...(resolvedDiary ? { diary: resolvedDiary } : {}),
                    ...(body.target ? { target: { ...body.target, ...(resolvedDiary ? { diary: resolvedDiary } : {}) } } : {}),
                    idempotencyKey,
                    options: { ...body.options, idempotencyKey }
                },
                startedAt: Date.now(),
                clientIp: normalizeMcpString(input.clientIp, 64) || '127.0.0.1',
                defaultSource: operation.source
            });
        }
    });
}

async function executeRecallRun(context) {
    const { bundle, name, args, input, operation, executeManaged } = context;
    return executeManaged({
        bundle, name, args, input,
        operationName: operation.operationName,
        source: operation.source,
        async execute({ body, requestContext, authContext }) {
            const agentId = normalizeMcpString(body.agentId || body.requestContext?.agentId || args.agentId);
            const query = normalizeMcpString(body.query || args.query, 4096);
            const profile = normalizeMcpString(body.profile || args.profile);
            if (!agentId || !query) {
                return {
                    success: false,
                    requestId: requestContext.requestId,
                    status: 400,
                    code: AGW_ERROR_CODES.VALIDATION_ERROR,
                    error: `${!agentId ? 'agentId' : 'query'} is required`
                };
            }
            const result = await bundle.recallRuntimeService.executeRecall({
                agentId, query, profileName: profile, requestContext, authContext,
                agentPolicyResolver: bundle.agentPolicyResolver,
                messages: Array.isArray(body.messages) ? body.messages : undefined
            });
            const projected = bundle.recallProjectionService.projectFullResult(result, requestContext.requestId);
            const audit = { runtime: requestContext.runtime, source: requestContext.source };
            return projected.success
                ? { success: true, requestId: requestContext.requestId, data: projected, audit }
                : {
                    success: false,
                    requestId: requestContext.requestId,
                    code: projected.code,
                    error: projected.error,
                    status: projected.status,
                    audit
                };
        }
    });
}

const IN_PROCESS_OPERATION_HANDLERS = Object.freeze({
    render: executeRender,
    jobGet: (context) => executeJob(context, 'pollJob'),
    jobCancel: (context) => executeJob(context, 'cancelJob'),
    memorySearch: (context) => executeDiary(context, 'search'),
    contextAssemble: (context) => executeDiary(context, 'buildRecallContext'),
    memoryWrite: executeMemoryWrite,
    recallRun: executeRecallRun
});

async function callMcpTool({
    bundle,
    agentRegistryService,
    contextRuntimeService,
    memoryRuntimeService,
    jobRuntimeService,
    recallRuntimeService,
    recallProjectionService,
    toolRuntimeService,
    executeGatewayManagedTool,
    buildMcpContexts,
    ensureAgentAndSession,
    mapToolRuntimeResultToMcp,
    normalizeMcpArguments,
    isGatewayManagedTool
}, input = {}) {
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
}

module.exports = {
    IN_PROCESS_OPERATION_HANDLERS,
    attachRequestId,
    buildBootstrapResult,
    callMcpTool,
    mapAgentRegistryError
};
