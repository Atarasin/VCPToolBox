const {
    OPENCLAW_TO_AGENT_GATEWAY_CODE,
    AGW_ERROR_CODES
} = require('../../contracts/errorCodes');
const {
    MCP_RESOURCE_KINDS,
    MCP_GATEWAY_TOOL_NAMES,
    MCP_GATEWAY_PROMPT_NAMES,
    MCP_DIARY_LOOP_RESOURCE_TEMPLATES,
    createGatewayManagedPromptDescriptors,
    createGatewayManagedToolDescriptors,
    buildJobEventsResourceUri,
    buildResourceUri,
    parseResourceUri,
    createAgentGuidanceResource,
    createMemoryTargetsResource
} = require('./descriptors');
const {
    normalizeDiaryCanonicalName
} = require('../../policy/mcpAgentMemoryPolicy');
const { createMcpHarness } = require('./harness');
const {
    createMcpError,
    createMcpPromptTextMessage,
    createMcpTextContent,
    sanitizeMcpErrorDetails,
    serializeMcpValue
} = require('./resultShapes');
const { mapGatewayFailureToMcpErrorCode } = require('./errorMapping');
const { MCP_ERROR_CODES } = require('./constants');
const { applyDiaryPolicyGate } = require('./diaryPolicyGate');
const { getGatewayOperation } = require('./operations');
const { getPresentedCredential } = require('../../policy/trustedCredentialContext');
const {
    GENERIC_INSTRUCTIONS,
    buildGuidanceInstructions
} = require('../../services/agentGuidanceService');
const {
    buildBootstrapResult,
    buildDeferredBootstrapSummary
} = require('../../services/bootstrapResultService');
const { serveFrozenList } = require('../../policy/discoverySnapshot');
const { resolveTraceId } = require('../../infra/trace');
const { validateGatewayToolArguments } = require('../../contracts/schemas/validator');

const DEFERRED_RESULT_TOOL_NAMES = new Set([
    MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER,
    MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP,
    MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH,
    MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE,
    MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE,
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

function buildGatewayFailureDetails(result) {
    return sanitizeMcpErrorDetails({
        canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
        gatewayCode: result.code || '',
        requestId: result.requestId || '',
        gatewayStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
        ...buildOperabilityMetadata(result.meta),
        ...(result.details && typeof result.details === 'object' ? result.details : {})
    }) || {};
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
    const gatewayStatus = typeof result.httpStatus === 'number'
        ? result.httpStatus
        : (typeof result.status === 'number' ? result.status : undefined);
    const errorDetails = sanitizeMcpErrorDetails({
        canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
        gatewayCode: result.code || '',
        requestId: result.requestId || '',
        gatewayStatus,
        ...operability,
        ...(result.details && typeof result.details === 'object' ? result.details : {})
    }) || {};
    const contentDetails = sanitizeMcpErrorDetails({
        gatewayStatus,
        ...operability,
        ...(result.details && typeof result.details === 'object' ? result.details : {})
    }) || {};

    return {
        isError: true,
        status: 'failed',
        error: {
            code: mapGatewayFailureToMcpErrorCode(result.code),
            message: result.error || 'MCP tool call failed',
            details: errorDetails
        },
        content: createMcpTextContent({
            error: result.error || 'MCP tool call failed',
            code: mapGatewayFailureToMcpErrorCode(result.code),
            requestId: result.requestId || '',
            details: contentDetails
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
    operability,
    summary
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
            ...(summary ? { summary } : {}),
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
    if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP && data && typeof data.renderedPrompt === 'string') {
        return createMcpTextContent(data.renderedPrompt);
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
        operability: buildOperabilityMetadata(result.meta),
        // §5.3 / M2.S3.T1：bootstrap 的 deferred 分支同样返回 summary，
        // 与 in-process 复用同一 canonical 实现。
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
    const args = input?.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
        ? input.arguments
        : {};
    const agentId = normalizeMcpString(input?.agentId || args.agentId || input?.requestContext?.agentId || fallback);
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
        requestContext
    };
}

function buildRequestOptions(input) {
    const traceId = normalizeMcpString(input?.requestContext?.traceId, 128);
    // transport 私有通道透传的 presented credential（Symbol 属性，不进 JSON/日志）
    const presentedCredential = getPresentedCredential(input);
    return {
        ...(input?.signal ? { signal: input.signal } : {}),
        ...(traceId ? { headers: { 'x-agent-gateway-trace-id': traceId } } : {}),
        ...(presentedCredential ? { authOverride: { token: presentedCredential } } : {})
    };
}

function ensureTraceContext(input) {
    const requestContext = input?.requestContext && typeof input.requestContext === 'object' ? input.requestContext : {};
    return {
        ...input,
        requestContext: { ...requestContext, traceId: resolveTraceId(requestContext.traceId, 'agwop') }
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
            fallbackToolSurfaceAvailable: true,
            resolvedAgentId: agentId,
            promptName: MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER,
            fallbackToolName: MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP,
            useMessageContentAsPromptBody: true
        },
        operability: buildOperabilityMetadata(result.meta)
    };
}

const BACKEND_PROXY_METHODS = {
    async listTools(state, input = {}) {
        return serveFrozenList(input, 'tools', () => {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
        const discoveryDefault = state.discoveryDefaultAgentEnabled === false ? '' : defaultAgentId;
        const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || discoveryDefault);
        return {
            tools: gatewayManagedTools.slice().sort((left, right) => left.name.localeCompare(right.name)),
            meta: {
                requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                ...(agentId ? { agentId } : {})
            }
        };
        });
    },

    async listPrompts(state, input = {}) {
        return serveFrozenList(input, 'prompts', () => {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
        const discoveryDefault = state.discoveryDefaultAgentEnabled === false ? '' : defaultAgentId;
        const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || discoveryDefault);
        return {
            prompts: gatewayManagedPrompts,
            meta: {
                requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                ...(agentId ? { agentId } : {})
            }
        };
        });
    },

    async getPrompt(state, input = {}) {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
        input = ensureTraceContext(input);
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
        const requestOptions = buildRequestOptions(input);
        const response = await backendClient.renderAgent(agentId, buildBody({
            ...input,
            agentId
        }, args, {
            requireSession: false,
            defaultAgentId
        }), requestOptions);
        const result = normalizeNativeResult(response);

        if (!result.success) {
            throw createMcpError(
                mapGatewayFailureToMcpErrorCode(result.code),
                result.error || 'MCP prompt request failed',
                buildGatewayFailureDetails(result)
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

    async callTool(state, input = {}) {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
        input = ensureTraceContext(input);
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

        const requestOptions = buildRequestOptions(input);
        const operation = getGatewayOperation(name);
        if (!operation) {
            throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
                field: 'name',
                name
            });
        }
        const validationErrors = validateGatewayToolArguments(name, {
            ...args,
            agentId: args.agentId || input.agentId || input.requestContext?.agentId || defaultAgentId
        });
        if (validationErrors.length && name === MCP_GATEWAY_TOOL_NAMES.RECALL_RUN) {
            const field = validationErrors[0].params?.missingProperty || validationErrors[0].path.slice(1) || 'arguments';
            throw createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENTS, `${field} is required`, {
                field, validationErrors
            });
        }

        const executeDiaryOperation = async (methodName) => {
            const scoped = applyDiaryPolicyGate({
                toolName: name,
                payload: buildBody(input, args, { defaultAgentId }),
                input,
                defaultAgentId
            });
            if (scoped.rejection) {
                return { finalResult: createFailureResult(scoped.rejection) };
            }
            return {
                response: await backendClient[methodName](scoped.payload, requestOptions)
            };
        };

        const handlers = {
            memorySearch: () => executeDiaryOperation('searchMemory'),
            contextAssemble: () => executeDiaryOperation('assembleContext'),
            memoryWrite: async () => {
                const writeBody = buildBody(input, args, { defaultAgentId });
                const idempotencyKey = normalizeMcpString(
                    writeBody.options?.idempotencyKey || writeBody.target?.idempotencyKey ||
                    args.idempotencyKey || writeBody.idempotencyKey,
                    256
                );
                const resolvedDiary = normalizeDiaryCanonicalName(
                    normalizeMcpString(writeBody.diary || writeBody.target?.diary, 256)
                );
                if (resolvedDiary) {
                    writeBody.diary = resolvedDiary;
                    if (writeBody.target && typeof writeBody.target === 'object') {
                        writeBody.target.diary = resolvedDiary;
                    }
                }
                if (idempotencyKey) {
                    writeBody.idempotencyKey = idempotencyKey;
                    writeBody.options = { ...(writeBody.options || {}), idempotencyKey };
                }
                return backendClient.writeMemory(writeBody, requestOptions);
            },
            recallRun: async () => {
                const recallBody = buildBody(input, args, { requireSession: false, defaultAgentId });
                if (!normalizeMcpString(recallBody.query, 4096)) {
                    throw createMcpError(MCP_ERROR_CODES.INVALID_ARGUMENTS, 'gateway_recall_run requires query', {
                        field: 'query'
                    });
                }
                return backendClient.runRecall(recallBody, requestOptions);
            },
            render: () => backendClient.renderAgent(
                ensureAgentId(input, `tools/call:${name}`, defaultAgentId),
                buildBody(input, args, { requireSession: false, defaultAgentId }),
                requestOptions
            ),
            jobGet: () => {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                return backendClient.getJob(args.jobId, buildJobQuery(input, args, defaultAgentId), requestOptions);
            },
            jobCancel: () => {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                return backendClient.cancelJob(
                    args.jobId,
                    buildBody(input, args, { requireSession: false, defaultAgentId }),
                    requestOptions
                );
            },
            removedRender: () => {
                throw createMcpError(
                    MCP_ERROR_CODES.NOT_FOUND,
                    'gateway_agent_render is no longer published as a MCP tool; use prompts/get instead',
                    { field: 'name', name, primarySurface: 'prompts/get' }
                );
            }
        };

        const handler = handlers[operation.backendExecutor];
        if (!handler) {
            throw createMcpError(MCP_ERROR_CODES.NOT_FOUND, 'Unsupported gateway-managed tool', {
                field: 'name',
                name
            });
        }
        const execution = await handler();
        if (execution?.finalResult) {
            return execution.finalResult;
        }
        const response = execution?.response ?? execution;

        const result = normalizeNativeResult(response);
        if (!result.success) {
            return createFailureResult(result);
        }
        const isDeferredResult = DEFERRED_RESULT_TOOL_NAMES.has(name) &&
            (result.status === 'accepted' || result.status === 'waiting_approval');
        if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP) {
            const resolvedAgentId = result.data?.agentId || input.agentId || args.agentId || defaultAgentId;
            if (isDeferredResult) {
                // deferred 分支只需 agentId 供 canonical summary；render 尚未
                // 完成，不做 prompt 整形也不取 guidance。
                result.data = { ...(result.data || {}), agentId: normalizeMcpString(resolvedAgentId, 256) };
            } else {
                result.data = buildBootstrapResult(result.data || {}, resolvedAgentId);
                // §5.3 / M2.S2.T2：bootstrap 以向后兼容的附加字段承载 guidance，
                // 内容与 guidance resource 等价并含同一 revision。canonical backend
                // 重新校验凭据与绑定；guidance 不可用时省略字段，不阻断 bootstrap。
                const guidanceAgentId = normalizeMcpString(result.data?.agentId, 256);
                if (guidanceAgentId) {
                    try {
                        const guidanceResponse = await backendClient.getAgentGuidance(guidanceAgentId, undefined, requestOptions);
                        const guidanceResult = normalizeNativeResult(guidanceResponse);
                        if (guidanceResult.success && guidanceResult.data) {
                            result.data = { ...result.data, integrationGuidance: guidanceResult.data };
                        }
                    } catch (_error) {
                        // guidance 是增强内容；获取失败保持原 bootstrap 语义。
                    }
                }
            }
        }
        if (isDeferredResult) {
            return createGatewayManagedDeferredResult(name, result);
        }
        return createGatewayManagedSuccessResult(name, result);
    },

    async listResources(state, input = {}) {
        return serveFrozenList(input, 'resources', () => {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
        const discoveryDefault = state.discoveryDefaultAgentEnabled === false ? '' : defaultAgentId;
        const agentId = normalizeMcpString(input.agentId || input.requestContext?.agentId || discoveryDefault);

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
                createMemoryTargetsResource(agentId),
                createAgentGuidanceResource(agentId)
            ],
            meta: {
                requestId: normalizeMcpString(input.requestContext?.requestId, 128),
                agentId
            }
        };
        });
    },

    async readResource(state, input = {}) {
        const { backendClient, defaultAgentId, gatewayManagedTools, gatewayManagedPrompts } = state;
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
                requestId: normalizeMcpString(input.requestContext?.requestId, 128)
            }, input.signal ? { signal: input.signal } : undefined);
            const result = normalizeNativeResult(response);
            if (!result.success) {
                throw createMcpError(
                    mapGatewayFailureToMcpErrorCode(result.code),
                    result.error || 'Failed to read memory targets resource',
                    buildGatewayFailureDetails(result)
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

        if (parsed.kind === MCP_RESOURCE_KINDS.AGENT_GUIDANCE) {
            // §5.3：URI target 决议 + 统一 context 绑定校验由 canonical backend
            // 的 guidance REST binding 执行（request-scoped credential 透传）。
            const agentId = ensureAgentId({
                ...input,
                agentId: parsed.agentId || input.agentId
            }, 'resources/read', defaultAgentId);
            const response = await backendClient.getAgentGuidance(agentId, {
                requestId: normalizeMcpString(input.requestContext?.requestId, 128)
            }, buildRequestOptions(input));
            const result = normalizeNativeResult(response);
            if (!result.success) {
                throw createMcpError(
                    mapGatewayFailureToMcpErrorCode(result.code),
                    result.error || 'Failed to read agent integration guidance',
                    buildGatewayFailureDetails(result)
                );
            }

            return {
                contents: [{
                    uri: buildResourceUri(MCP_RESOURCE_KINDS.AGENT_GUIDANCE, agentId),
                    mimeType: 'application/json',
                    text: serializeMcpValue(result.data || {})
                }],
                meta: {
                    requestId: result.requestId || normalizeMcpString(input.requestContext?.requestId, 128),
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
                backendClient.getJob(parsed.jobId, jobQuery, input.signal ? { signal: input.signal } : undefined),
                backendClient.listJobEvents(parsed.jobId, jobQuery, input.signal ? { signal: input.signal } : undefined)
            ]);
            const jobResult = normalizeNativeResult(jobResponse);

            if (!jobResult.success) {
                throw createMcpError(
                    mapGatewayFailureToMcpErrorCode(jobResult.code),
                    jobResult.error || 'Failed to read Gateway job runtime events',
                    buildGatewayFailureDetails(jobResult)
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

function createBackendProxyMcpAdapter({
    backendClient,
    defaultAgentId = process.env.VCP_MCP_DEFAULT_AGENT_ID || '',
    discoveryDefaultAgentEnabled = true,
    includeAgentRender = true
}) {
    if (!backendClient) throw new Error('backendClient is required');
    const state = {
        backendClient,
        defaultAgentId,
        discoveryDefaultAgentEnabled,
        gatewayManagedTools: createGatewayManagedToolDescriptors(),
        gatewayManagedPrompts: createGatewayManagedPromptDescriptors({ includeAgentRender })
    };
    return {
        supportedResourceTemplates: MCP_DIARY_LOOP_RESOURCE_TEMPLATES,
        supportedPromptNames: state.gatewayManagedPrompts.map((prompt) => prompt.name),
        ...Object.fromEntries(Object.entries(BACKEND_PROXY_METHODS).map(([name, method]) => [
            name, (input) => method(state, input)
        ]))
    };
}

/**
 * backend-proxy 的 initialize.instructions per-request 渲染（§5.2）。
 *
 * 绑定与 scope 来自边缘 credential 决议注入的受信任 authContext
 * （HTTP session / WS connection context；客户端 params 中的同名字段已被
 * transport 注入整体覆盖）。绑定 + read scope 时经 canonical backend 取
 * guidance bundle（request-scoped credential 透传，backend 重新校验），
 * 摘要裁剪复用 canonical 单点实现；其余情形（含 stdio 静态凭据进程，
 * 边缘无绑定信息）返回通用文案，不泄露任何 agent 内容。
 */
function createBackendProxyInstructionsResolver(backendClient) {
    return async function resolveInstructions({ params, authContext } = {}) {
        const context = authContext && typeof authContext === 'object' ? authContext : {};
        const boundAgentId = normalizeMcpString(context.boundAgentId, 256);
        const scopes = Array.isArray(context.credentialScopes) ? context.credentialScopes : [];
        if (!boundAgentId || !scopes.includes('gateway:read')) {
            return GENERIC_INSTRUCTIONS;
        }
        try {
            const response = await backendClient.getAgentGuidance(
                boundAgentId,
                undefined,
                buildRequestOptions(params || {})
            );
            const result = normalizeNativeResult(response);
            if (!result.success || !result.data) {
                return GENERIC_INSTRUCTIONS;
            }
            return buildGuidanceInstructions(result.data).text;
        } catch (_error) {
            return GENERIC_INSTRUCTIONS;
        }
    };
}

function createBackendProxyMcpServerHarness(options = {}) {
    const adapter = options.adapter || createBackendProxyMcpAdapter(options);
    const backendClient = options.backendClient || null;
    return createMcpHarness({
        adapter,
        resolveInstructions: options.resolveInstructions
            || (backendClient ? createBackendProxyInstructionsResolver(backendClient) : undefined)
    });
}

module.exports = {
    MCP_ERROR_CODES,
    createBackendProxyInstructionsResolver,
    createBackendProxyMcpAdapter,
    createBackendProxyMcpServerHarness,
    createBackendProxyExecutor: createBackendProxyMcpAdapter,
    sanitizeMcpErrorDetails
};
