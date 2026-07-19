const { StdioTransport, validateMcpTransport } = require('./transport');
const { createBackendProxyMcpServerHarness } = require('./protocols/mcp/backendProxyExecutor');
const { GatewayBackendClient } = require('./clients/GatewayBackendClient');
const {
    createJsonRpcErrorResponse,
    createRuntimeProvider,
    dispatchJsonRpc,
    parseJsonRpcPayload,
    createTransportLogger
} = require('./transport/shared');

function resolveRequiredEnv(name, fallbackValue = '') {
    const fallback = typeof fallbackValue === 'string' ? fallbackValue.trim() : '';
    const configured = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
    const value = configured || fallback;
    if (!value) throw new Error(`${name} is required for backend-only MCP transport.`);
    return value;
}

async function createBackendRuntime(options = {}) {
    // HTTP/WS 生产 proxy 逐请求透传 credential，禁止静态 backend key 兜底
    //（§3.3 M1.S4.T3）；静态凭据仅供 stdio 单身份进程。
    const requireRequestAuthOverride = options.requireRequestAuthOverride === true;
    const backendClient = options.backendClient || new GatewayBackendClient({
        baseUrl: options.backendUrl || resolveRequiredEnv('VCP_MCP_BACKEND_URL'),
        gatewayKey: requireRequestAuthOverride ? undefined : (options.gatewayKey || process.env.VCP_MCP_BACKEND_KEY),
        gatewayId: options.gatewayId || process.env.VCP_MCP_BACKEND_GATEWAY_ID,
        bearerToken: requireRequestAuthOverride ? undefined : (options.bearerToken || process.env.VCP_MCP_BACKEND_BEARER_TOKEN),
        requireRequestAuthOverride
    });
    const defaultAgentId = typeof options.defaultAgentId === 'string'
        ? options.defaultAgentId.trim()
        : String(process.env.VCP_MCP_DEFAULT_AGENT_ID || '').trim();
    return {
        backendClient,
        harness: createBackendProxyMcpServerHarness({
            backendClient,
            defaultAgentId,
            // §3.4 T4：VCP_MCP_DEFAULT_AGENT_ID 只保留给 stdio 开发兼容；
            // 外部 HTTP/WS transport 显式传 false 关闭 discovery 参与。
            discoveryDefaultAgentEnabled: options.discoveryDefaultAgentEnabled !== false,
            includeAgentRender: options.includeAgentRender !== false
        })
    };
}

const backendProxyRuntimeProvider = createRuntimeProvider(createBackendRuntime);

function initializeBackendProxyMcpRuntime(options = {}) {
    return backendProxyRuntimeProvider.get(options);
}

function shutdownBackendProxyMcpRuntime() {
    return backendProxyRuntimeProvider.reset();
}

async function createStdioMcpServer(options = {}) {
    const transport = validateMcpTransport(options.transport || new StdioTransport(options));
    const logger = createTransportLogger({ stderr: options.stderr || process.stderr, transport: 'mcp-stdio' });
    const provider = options.runtimeProvider || backendProxyRuntimeProvider;
    const runtimeContext = options.harness ? null : await provider.get(options);
    const harness = options.harness || runtimeContext?.harness;
    if (!harness || typeof harness.handleRequest !== 'function') {
        throw new Error('MCP stdio transport requires a harness with handleRequest(request).');
    }

    let queue = Promise.resolve();
    let closed = false;
    const finished = new Promise((resolve) => {
        transport.finished.then(async () => {
            closed = true;
            await queue;
            if (options.shutdownOnClose !== false) {
                try { await provider.reset(); } catch (error) { logger.error('runtime.reset.failed', error); }
            }
            resolve();
        });
    });

    async function handleLine(line) {
        const parsed = parseJsonRpcPayload(line, { batchPolicy: 'reject' });
        if (parsed.error) {
            transport.send(JSON.stringify(parsed.error));
            return;
        }
        const response = await dispatchJsonRpc({
            ...parsed,
            harness,
            onNotificationError: (error) => logger.error('notification.failed', error)
        });
        if (response) transport.send(JSON.stringify(response));
    }

    transport.setMessageHandler((line) => {
        queue = queue.then(() => handleLine(line)).catch((error) => logger.error('request.failed', error));
    });

    return {
        async close() {
            if (closed) return;
            await transport.close();
            await finished;
        },
        finished
    };
}

async function startStdioMcpServer(options = {}) {
    return createStdioMcpServer(options);
}

module.exports = {
    backendProxyRuntimeProvider,
    createJsonRpcErrorResponse,
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime,
    startStdioMcpServer,
    createStdioMcpServer
};
