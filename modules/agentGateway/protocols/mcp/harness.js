const {
    JSON_RPC_ERROR_CODES,
    MCP_PROTOCOL_VERSION,
    MCP_SERVER_INFO
} = require('./constants');
const {
    buildJsonRpcError,
    shapeHarnessFailure
} = require('./resultShapes');

function buildMcpInitializeResult(params = {}, options = {}) {
    const requestedProtocolVersion = typeof params.protocolVersion === 'string'
        ? params.protocolVersion.trim()
        : '';
    return {
        protocolVersion: requestedProtocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: {
            prompts: { listChanged: false },
            resources: { listChanged: false },
            tools: { listChanged: false }
        },
        serverInfo: options.serverInfo || MCP_SERVER_INFO,
        instructions: options.instructions || 'Use the published Agent Gateway prompts, tools, and resources through this MCP server.'
    };
}

function createMcpHarness({ adapter, instructions, resolveInstructions, serverInfo } = {}) {
    if (!adapter) {
        throw new Error('MCP harness requires an adapter');
    }

    // §5.2：initialize.instructions 升级为 per-request 解析。harness factory、
    // 两个 executor 与三种 transport 都必须透传 resolveInstructions（function，
    // 不能被当作 JSON 属性序列化掉）。解析使用 transport 注入的受信任 context；
    // 失败时回退默认文案——instructions 是增强，不作为唯一正确性机制。
    async function renderInstructions(params) {
        if (typeof resolveInstructions !== 'function') {
            return instructions;
        }
        try {
            const resolved = await resolveInstructions({
                params,
                requestContext: params.requestContext && typeof params.requestContext === 'object'
                    ? params.requestContext
                    : {},
                authContext: params.authContext && typeof params.authContext === 'object'
                    ? params.authContext
                    : {}
            });
            return typeof resolved === 'string' && resolved ? resolved : instructions;
        } catch (_error) {
            return instructions;
        }
    }

    return {
        adapter,
        async handleRequest(message = {}) {
            const request = message && typeof message === 'object' ? message : {};
            const params = request.params && typeof request.params === 'object' ? request.params : {};
            try {
                let result;
                switch (request.method) {
                case 'initialize':
                    result = buildMcpInitializeResult(params, {
                        instructions: await renderInstructions(params),
                        serverInfo
                    });
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
                    return buildJsonRpcError(request.id, JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND, 'Method not found', {
                        method: request.method || ''
                    });
                }
                return { jsonrpc: '2.0', id: request.id ?? null, result };
            } catch (error) {
                const shapedError = shapeHarnessFailure(error);
                return buildJsonRpcError(
                    request.id,
                    JSON_RPC_ERROR_CODES.SERVER_ERROR,
                    shapedError.message,
                    shapedError.data
                );
            }
        }
    };
}

module.exports = {
    buildMcpInitializeResult,
    createMcpHarness
};
