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

/**
 * MCP v1 只开放最小能力面：
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
                ...((result?.details && typeof result.details === 'object') ? result.details : {})
            }
        },
        content: createMcpTextContent({
            error: result?.error || 'MCP tool call failed',
            code: mapGatewayFailureToMcpErrorCode(result?.code),
            requestId: result?.requestId || '',
            details: result?.details || {}
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

function normalizeMcpArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return null;
    }
    return args;
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
        toolRuntimeService
    } = bundle;

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
                tools: (capabilities.tools || []).map(buildMcpToolDescriptor),
                meta: {
                    requestId: requestContext.requestId,
                    agentId: requestContext.agentId
                }
            };
        },

        async callTool(input = {}) {
            const name = normalizeMcpString(input.name);
            const args = normalizeMcpArguments(input.arguments);
            const { requestContext, authContext } = buildMcpContexts(bundle, input, 'mcp-tools-call');
            ensureAgentAndSession(requestContext, 'tools/call');

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
