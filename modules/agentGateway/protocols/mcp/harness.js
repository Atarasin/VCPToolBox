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

function createMcpHarness({ adapter, instructions, serverInfo } = {}) {
    if (!adapter) {
        throw new Error('MCP harness requires an adapter');
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
                    result = buildMcpInitializeResult(params, { instructions, serverInfo });
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
