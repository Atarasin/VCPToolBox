const {
    getGatewayServiceBundle
} = require('../../createGatewayServiceBundle');
const {
    GENERIC_INSTRUCTIONS,
    buildGuidanceInstructions
} = require('../../services/agentGuidanceService');
const { buildDeferredBootstrapSummary } = require('../../services/bootstrapResultService');
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
    createAgentGuidanceResource,
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
const { IN_PROCESS_OPERATION_HANDLERS, attachRequestId, mapAgentRegistryError, callMcpTool } = require('./inProcessOperations');
const {
    isTrustedCredentialContext,
    sanitizeUntrustedAuthContext
} = require('../../policy/trustedCredentialContext');
const { ACTION_SCOPES } = require('../../contracts/authPolicyCatalog');
const { defaultAgentTargetTelemetry } = require('../../policy/agentTargetTelemetry');
const { createReadResourceHandler } = require('./resourceHandlers');
const { resolveTraceId } = require('../../infra/trace');
const { validateGatewayToolArguments } = require('../../contracts/schemas/validator');

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
    operability,
    summary
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
            ...(summary ? { summary } : {}),
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
        operability,
        // §5.3 / M2.S3.T1：bootstrap 的 deferred 分支同样返回 summary，
        // 与 backend-proxy 复用同一 canonical 实现。
        ...(name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP
            ? {
                summary: buildDeferredBootstrapSummary({
                    status: result.status,
                    agentId: result.data?.agentId,
                    jobId: result.data?.job?.jobId || result.data?.job?.id
                })
            }
            : {})
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

function buildManagedToolContextInput(input, args, { surface = 'in-process:tools/call', directAgentScoped = true } = {}) {
    const trusted = isTrustedCredentialContext(input.authContext);
    const explicitAgentId = normalizeMcpString(
        input.agentId || args.agentId || args.target?.agentId || input.requestContext?.agentId
    );
    let agentId = explicitAgentId;
    if (trusted) {
        // §3.2/§5.4 决议树（2026-08 恢复）：绑定 credential 省略 agentId →
        // 以绑定身份为 effective target；显式不一致 → 403（in-process 即
        // canonical backend，绑定一致性在此强制）。未绑定省略保持既有必填
        // 语义，由下游 ensureAgentId 受控报错；不做任何 default/env 兜底。
        const boundAgentId = normalizeMcpString(input.authContext.boundAgentId, 256);
        if (boundAgentId) {
            if (!explicitAgentId) {
                agentId = boundAgentId;
                // 比例 telemetry 只统计直接 agent-scoped 操作（job 等间接
                // 对象按 owner 决议，不计入显式 agentId 迁移比例）。
                if (directAgentScoped) {
                    defaultAgentTargetTelemetry.record({ surface, outcome: 'boundOmitted' });
                }
            } else if (explicitAgentId !== boundAgentId) {
                throw createMcpError(MCP_ERROR_CODES.FORBIDDEN, 'target agent differs from bound agent', {
                    field: 'agentId'
                });
            } else if (directAgentScoped) {
                defaultAgentTargetTelemetry.record({ surface, outcome: 'explicit' });
            }
        }
    }
    return {
        ...input,
        agentId,
        sessionId: input.sessionId || args.sessionId || input.requestContext?.sessionId,
        requestContext: (args.requestContext && typeof args.requestContext === 'object')
            ? {
                ...args.requestContext,
                ...((input.requestContext && typeof input.requestContext === 'object') ? input.requestContext : {})
            }
            : input.requestContext,
        // in-process adapter 只信任组装根注入的 trustedCredentialContext；
        // MCP params（args）传入的 authContext 一律剥离身份与 trusted 标记（§5.1）。
        authContext: trusted
            ? input.authContext
            : sanitizeUntrustedAuthContext(input.authContext || args.authContext)
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
            'agentId is required: provide an explicit agentId, or use an agent-bound credential',
            { field: 'agentId', operation }
        );
    }
}

function getSinglePublishedAgentId(agentDirectoryPort) {
    if (!agentDirectoryPort?.available) return '';
    const aliases = agentDirectoryPort.listAgents()
        .map((entry) => normalizeMcpString(entry?.alias))
        .filter(Boolean);

    return aliases.length === 1 ? aliases[0] : '';
}

function resolveDiscoveryAgentId(input, agentDirectoryPort) {
    const explicitAgentId = normalizeMcpString(input?.agentId || input?.requestContext?.agentId);
    if (explicitAgentId) {
        return explicitAgentId;
    }

    const configuredAgentId = normalizeMcpString(process.env.VCP_MCP_DEFAULT_AGENT_ID);
    if (configuredAgentId) {
        return configuredAgentId;
    }

    return getSinglePublishedAgentId(agentDirectoryPort);
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
    const contextInput = buildManagedToolContextInput(input, args, {
        surface: `in-process:tools/call:${name}`,
        directAgentScoped: !requiresJobIdentity
    });
    const { requestContext, authContext } = buildMcpContexts(bundle, contextInput, source);
    if (requiresJobIdentity) {
        ensureAgentId(requestContext, `tools/call:${name}`);
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

    const contextInput = buildManagedToolContextInput(input, args, {
        surface: `in-process:prompts/get:${name}`
    });
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
    // §5.1 / M2.S3.T2：catalog 标记 publishedAsTool: false 的 operation
    // （gateway_agent_render）两个 adapter 都不得经 tools/call 暴露；
    // in-process 与 proxy 的 removedRender 行为对齐。
    if (operation && operation.publishedAsTool === false) {
        throw createMcpError(
            MCP_ERROR_CODES.NOT_FOUND,
            `${name} is no longer published as a MCP tool; use prompts/get instead`,
            { field: 'name', name, primarySurface: 'prompts/get' }
        );
    }
    const handler = operation && IN_PROCESS_OPERATION_HANDLERS[operation.executor];
    if (!handler) {
        throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
            field: 'name',
            name
        });
    }
    // §3.5 两层授权（M1.S2.T3）：trusted context 携带 resolver 产出的
    // scopes 时按 catalog credentialAction 检查；scope 不足统一 FORBIDDEN。
    // 未携带（阶段 A admin_transition）与 authenticated 动作跳过凭据层。
    const credentialAction = operation.credentialAction;
    if (credentialAction && credentialAction !== 'authenticated'
        && isTrustedCredentialContext(input.authContext)
        && Array.isArray(input.authContext.scopes)) {
        const requiredScopes = ACTION_SCOPES[credentialAction] || [];
        const granted = input.authContext.scopes.some((scope) => requiredScopes.includes(scope));
        if (!granted) {
            throw createMcpError(MCP_ERROR_CODES.FORBIDDEN, `Credential lacks scope for "${credentialAction}"`, {
                field: 'credentialAction',
                name,
                credentialAction
            });
        }
    }
    const validationErrors = validateGatewayToolArguments(name, {
        ...args,
        agentId: args.agentId || input.agentId || input.requestContext?.agentId
    });
    if (validationErrors.length && name === MCP_GATEWAY_TOOL_NAMES.RECALL_RUN) {
        const field = validationErrors[0].params?.missingProperty || validationErrors[0].path.slice(1) || 'arguments';
        if (field === 'agentId') {
            throw createMcpError(MCP_ERROR_CODES.INVALID_REQUEST, 'agentId is required: provide an explicit agentId, or use an agent-bound credential', {
                field, validationErrors
            });
        }
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
    const agentDirectoryPort = bundle.ports?.agentDirectory;
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
            const scopedInput = applyDiscoveryAgentId(input, resolveDiscoveryAgentId(input, agentDirectoryPort));
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

        callTool: (input) => callMcpTool({
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
        }, input),

        async listResources(input = {}) {
            const scopedInput = applyDiscoveryAgentId(input, resolveDiscoveryAgentId(input, agentDirectoryPort));
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
                    createAgentPromptTemplateResource(requestContext.agentId),
                    createAgentGuidanceResource(requestContext.agentId)
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

/**
 * in-process 的 initialize.instructions per-request 渲染（§5.2）。
 *
 * 只信任组装根注入的 trustedCredentialContext（params.authContext 上的
 * Symbol 标记）；MCP params 传入的普通 authContext 不参与判定。绑定 +
 * read scope → canonical guidance service 的 ≤800 token 摘要；其余情形
 * 返回通用文案，不泄露任何 agent 内容。
 */
function createInProcessInstructionsResolver(bundle) {
    return async function resolveInstructions({ params } = {}) {
        const candidate = params?.authContext;
        if (!isTrustedCredentialContext(candidate)) {
            return GENERIC_INSTRUCTIONS;
        }
        const boundAgentId = normalizeMcpString(candidate.boundAgentId, 256);
        const scopes = Array.isArray(candidate.scopes)
            ? candidate.scopes
            : (Array.isArray(candidate.credentialScopes) ? candidate.credentialScopes : []);
        if (!boundAgentId || !scopes.includes('gateway:read')) {
            return GENERIC_INSTRUCTIONS;
        }
        if (!bundle.agentGuidanceService) {
            return GENERIC_INSTRUCTIONS;
        }
        const result = await bundle.agentGuidanceService.getAgentGuidance(boundAgentId);
        if (!result.ok) {
            return GENERIC_INSTRUCTIONS;
        }
        return buildGuidanceInstructions(result.guidance).text;
    };
}

function createMcpServerHarness(pluginManager, options = {}) {
    const adapter = options.adapter || createMcpAdapter(pluginManager, options);
    const bundle = options.gatewayServiceBundle
        || (pluginManager ? getGatewayServiceBundle(pluginManager) : null);
    return createMcpHarness({
        adapter,
        resolveInstructions: options.resolveInstructions
            || (bundle ? createInProcessInstructionsResolver(bundle) : undefined)
    });
}
module.exports = {
    MCP_ERROR_CODES,
    MCP_RESOURCE_KINDS,
    MCP_SUPPORTED_RESOURCE_TEMPLATES,
    createInProcessInstructionsResolver,
    createMcpAdapter,
    createMcpServerHarness,
    createInProcessExecutor: createMcpAdapter
};
