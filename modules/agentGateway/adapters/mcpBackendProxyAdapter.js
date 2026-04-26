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
const {
    areDiaryNamesEquivalent,
    resolveConfiguredAgentMemoryPolicy
} = require('../policy/mcpAgentMemoryPolicy');

const MCP_ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'MCP_INVALID_REQUEST',
    INVALID_ARGUMENTS: 'MCP_INVALID_ARGUMENTS',
    FORBIDDEN: 'MCP_FORBIDDEN',
    NOT_FOUND: 'MCP_NOT_FOUND',
    TIMEOUT: 'MCP_TIMEOUT',
    RUNTIME_ERROR: 'MCP_RUNTIME_ERROR',
    RESOURCE_UNSUPPORTED: 'MCP_RESOURCE_UNSUPPORTED'
});

const MCP_ERROR_CODE_SET = new Set(Object.values(MCP_ERROR_CODES));

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

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createMcpError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}

const MAX_SANITIZATION_DEPTH = 8;

function sanitizeMcpErrorDetails(value, depth = 0, seen = new WeakSet()) {
    if (depth > MAX_SANITIZATION_DEPTH) {
        return undefined;
    }

    if (Array.isArray(value)) {
        return value
            .map((entry) => sanitizeMcpErrorDetails(entry, depth + 1, seen))
            .filter((entry) => typeof entry !== 'undefined');
    }

    if (!isPlainObject(value)) {
        return value;
    }

    if (seen.has(value)) {
        return undefined;
    }
    seen.add(value);

    const sanitized = {};
    Object.entries(value).forEach(([key, entry]) => {
        if (key.toLowerCase() === 'stack') {
            return;
        }

        const sanitizedEntry = sanitizeMcpErrorDetails(entry, depth + 1, seen);
        if (typeof sanitizedEntry !== 'undefined') {
            sanitized[key] = sanitizedEntry;
        }
    });

    return sanitized;
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

function shapeHarnessFailure(error) {
    const rawCode = normalizeMcpString(error?.code, 64);

    if (!MCP_ERROR_CODE_SET.has(rawCode)) {
        return {
            message: 'Gateway backend request failed',
            data: {
                code: MCP_ERROR_CODES.RUNTIME_ERROR,
                ...(rawCode ? { sourceErrorCode: rawCode } : {})
            }
        };
    }

    const details = sanitizeMcpErrorDetails(error?.details);
    return {
        message: normalizeMcpString(error?.message || 'MCP adapter request failed', 256) || 'MCP adapter request failed',
        data: {
            code: rawCode,
            ...(isPlainObject(details) ? details : {})
        }
    };
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
        instructions: 'Use the published Agent Gateway diary RAG prompts, tools, and resources through this MCP server.'
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
    const errorDetails = sanitizeMcpErrorDetails({
        canonicalCode: OPENCLAW_TO_AGENT_GATEWAY_CODE[result.code] || result.code || '',
        gatewayCode: result.code || '',
        requestId: result.requestId || '',
        gatewayStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
        ...operability,
        ...(result.details && typeof result.details === 'object' ? result.details : {})
    }) || {};
    const contentDetails = sanitizeMcpErrorDetails({
        gatewayStatus: typeof result.httpStatus === 'number' ? result.httpStatus : undefined,
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

function normalizeDiarySelectionArgs(args) {
    const diary = normalizeMcpString(args?.diary, 256);
    const diaries = Array.isArray(args?.diaries)
        ? args.diaries.map((value) => normalizeMcpString(value, 256)).filter(Boolean)
        : [];
    return {
        diary,
        diaries: diary && !diaries.includes(diary) ? [diary, ...diaries] : diaries
    };
}

function buildBootstrapSummary(renderResult, agentId) {
    const resolvedAgentId = normalizeMcpString(renderResult?.agentId || agentId, 256) || 'unknown-agent';
    const renderedPrompt = typeof renderResult?.renderedPrompt === 'string' ? renderResult.renderedPrompt : '';
    const warnings = Array.isArray(renderResult?.warnings) ? renderResult.warnings : [];
    const fragments = [`Bootstrap prompt ready for ${resolvedAgentId}`];

    if (renderedPrompt) {
        fragments.push(`length=${renderedPrompt.length}`);
    }
    if (renderResult?.truncated) {
        fragments.push('truncated=true');
    }
    if (warnings.length > 0) {
        fragments.push(`warnings=${warnings.length}`);
    }

    return fragments.join('; ');
}

function buildBootstrapResult(renderResult, agentId) {
    return {
        ...renderResult,
        agentId: normalizeMcpString(renderResult?.agentId || agentId, 256) || agentId,
        summary: buildBootstrapSummary(renderResult, agentId)
    };
}

function applyAgentDiaryPolicyToBody(name, body = {}) {
    if (name !== MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH && name !== MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE) {
        return {
            body,
            rejection: null
        };
    }

    const agentId = normalizeMcpString(body?.requestContext?.agentId || body?.agentId, 256);
    const maid = normalizeMcpString(body?.maid || body?.requestContext?.maid || agentId, 256);
    const policy = resolveConfiguredAgentMemoryPolicy({ agentId, maid });

    if (policy.allowedDiaryNames.length === 0 && policy.defaultDiaryNames.length === 0) {
        return {
            body,
            rejection: null
        };
    }

    const { diary, diaries } = normalizeDiarySelectionArgs(body);
    const requestedDiaries = diaries;
    const allowedDiaries = policy.allowedDiaryNames;
    const defaultDiaries = policy.defaultDiaryNames.length > 0
        ? policy.defaultDiaryNames
        : policy.allowedDiaryNames;

    if (requestedDiaries.length > 0) {
        const forbiddenDiaries = requestedDiaries.filter(
            (requestedDiary) => !allowedDiaries.some((allowedDiary) => areDiaryNamesEquivalent(requestedDiary, allowedDiary))
        );
        if (forbiddenDiaries.length > 0) {
            return {
                body,
                rejection: {
                    success: false,
                    requestId: normalizeMcpString(body?.requestContext?.requestId, 128),
                    code: AGW_ERROR_CODES.FORBIDDEN,
                    error: 'Requested diary target is not allowed for this agent',
                    details: {
                        diary: forbiddenDiaries[0],
                        diaries: forbiddenDiaries,
                        agentId,
                        allowedDiaries
                    }
                }
            };
        }

        return {
            body: {
                ...body,
                diary: diary || requestedDiaries[0] || '',
                diaries: requestedDiaries
            },
            rejection: null
        };
    }

    if (defaultDiaries.length === 0) {
        return {
            body,
            rejection: {
                success: false,
                requestId: normalizeMcpString(body?.requestContext?.requestId, 128),
                code: AGW_ERROR_CODES.FORBIDDEN,
                error: 'No default diary targets are configured for this agent',
                details: {
                    agentId,
                    allowedDiaries,
                    defaultDiaries
                }
            }
        };
    }

    return {
        body: {
            ...body,
            diary: defaultDiaries[0],
            diaries: defaultDiaries
        },
        rejection: null
    };
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
            fallbackToolSurfaceAvailable: true,
            resolvedAgentId: agentId,
            promptName: MCP_GATEWAY_PROMPT_NAMES.AGENT_RENDER,
            fallbackToolName: MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP,
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
            const requestOptions = input.signal ? { signal: input.signal } : undefined;
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
            const requestOptions = input.signal ? { signal: input.signal } : undefined;
            if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH) {
                const scopedBody = applyAgentDiaryPolicyToBody(name, buildBody(input, args, { defaultAgentId }));
                if (scopedBody.rejection) {
                    return createFailureResult(scopedBody.rejection);
                }
                response = await backendClient.searchMemory(scopedBody.body, requestOptions);
            } else if (name === MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE) {
                const scopedBody = applyAgentDiaryPolicyToBody(name, buildBody(input, args, { defaultAgentId }));
                if (scopedBody.rejection) {
                    return createFailureResult(scopedBody.rejection);
                }
                response = await backendClient.assembleContext(scopedBody.body, requestOptions);
            } else if (name === MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE) {
                response = await backendClient.writeMemory(buildBody(input, args, { defaultAgentId }), requestOptions);
            } else if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP) {
                response = await backendClient.renderAgent(
                    ensureAgentId(input, `tools/call:${name}`, defaultAgentId),
                    buildBody(input, args, {
                        requireSession: false,
                        defaultAgentId
                    }),
                    requestOptions
                );
            } else if (name === MCP_GATEWAY_TOOL_NAMES.JOB_GET) {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                response = await backendClient.getJob(args.jobId, buildJobQuery(input, args, defaultAgentId), requestOptions);
            } else if (name === MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL) {
                ensureJobIdentity(input, `tools/call:${name}`, defaultAgentId);
                response = await backendClient.cancelJob(args.jobId, buildBody(input, args, {
                    requireSession: false,
                    defaultAgentId
                }), requestOptions);
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
            if (name === MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP) {
                result.data = buildBootstrapResult(result.data || {}, result.data?.agentId || input.agentId || args.agentId || defaultAgentId);
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
}

function createBackendProxyMcpServerHarness(options = {}) {
    const adapter = options.adapter || createBackendProxyMcpAdapter(options);

    return {
        adapter,
        // This harness is cached as a singleton across stdio and websocket transports.
        // Keep per-connection mutable state in transport-injected requestContext/sessionId, not on the harness object.
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
                const shapedError = shapeHarnessFailure(error);
                return buildJsonRpcError(
                    request.id,
                    -32000,
                    shapedError.message,
                    shapedError.data
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
