const { StdioTransport, validateMcpTransport } = require('./transport');
const { createBackendProxyMcpServerHarness } = require('./protocols/mcp/backendProxyExecutor');
const { GatewayBackendClient } = require('./clients/GatewayBackendClient');
const { sanitizeUntrustedAuthContext } = require('./policy/trustedCredentialContext');
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

async function resolveStaticCredentialIdentity(backendClient, options = {}) {
    // HTTP/WS proxy 逐请求透传 credential 并由 transport 注入受信任身份，
    // 不需要也不应做静态自省（requireRequestAuthOverride 下无静态凭据可用）。
    if (options.requireRequestAuthOverride === true || options.resolveStaticCredentialIdentity === false) {
        return null;
    }
    try {
        const response = await backendClient.getCredentialContext();
        const data = response?.payload?.data;
        if (!response?.ok || !data) return null;
        const boundAgentId = typeof data.boundAgentId === 'string' ? data.boundAgentId.trim() : '';
        if (!boundAgentId) return null;
        return {
            boundAgentId,
            credentialScopes: Array.isArray(data.scopes) ? data.scopes : []
        };
    } catch (_error) {
        // 自省失败不阻断启动：保持「调用方需显式 agentId」的现状语义。
        return null;
    }
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
    // §5.5 / L4：stdio 静态 credential 的绑定信息原本对边缘不可见；启动时
    // 经凭据自省端点解析绑定身份，作为受信任身份注入后续每条请求。
    const staticCredentialIdentity = options.staticCredentialIdentity !== undefined
        ? options.staticCredentialIdentity
        : await resolveStaticCredentialIdentity(backendClient, options);
    return {
        backendClient,
        staticCredentialIdentity,
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
    // runtime 获取可能含网络自省（§5.5/L4），而 readline 从 transport 构造起
    // 就在发射 line 事件（stdioTransport.js:38-41）——handler 注册前到达的行
    // 会被静默丢弃。因此先注册 handler、在行处理内等待 runtime 就绪，
    // 不在 await 之后才注册。
    const runtimeReady = (async () => {
        const runtimeContext = options.harness ? null : await provider.get(options);
        const harness = options.harness || runtimeContext?.harness;
        if (!harness || typeof harness.handleRequest !== 'function') {
            throw new Error('MCP stdio transport requires a harness with handleRequest(request).');
        }
        return {
            harness,
            // 启动时自省出的静态凭据绑定身份（trusted，来自 backend 对进程静态
            // credential 的决议）；未绑定/自省失败为 null，注入保持现状。
            staticCredentialIdentity: options.staticCredentialIdentity !== undefined
                ? options.staticCredentialIdentity
                : (runtimeContext?.staticCredentialIdentity || null)
        };
    })();

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
        const { harness, staticCredentialIdentity } = await runtimeReady;
        const parsed = parseJsonRpcPayload(line, { batchPolicy: 'reject' });
        if (parsed.error) {
            transport.send(JSON.stringify(parsed.error));
            return;
        }
        const response = await dispatchJsonRpc({
            ...parsed,
            harness,
            // §3.2/§5.5：stdio 客户端 params 中的 authContext 身份字段
            //（boundAgentId/credentialScopes 等）可伪造——剥离后透传；
            // 启动时自省出的静态绑定身份为 trusted，覆盖写入。
            inject: (request) => {
                const sanitizedAuthContext = request?.params?.authContext
                    ? sanitizeUntrustedAuthContext(request.params.authContext)
                    : undefined;
                if (!staticCredentialIdentity && sanitizedAuthContext === undefined) {
                    return request;
                }
                return {
                    ...request,
                    params: {
                        ...request.params,
                        authContext: {
                            ...(sanitizedAuthContext || {}),
                            ...(staticCredentialIdentity
                                ? {
                                    boundAgentId: staticCredentialIdentity.boundAgentId,
                                    credentialScopes: staticCredentialIdentity.credentialScopes
                                }
                                : {})
                        }
                    }
                };
            },
            onNotificationError: (error) => logger.error('notification.failed', error)
        });
        if (response) transport.send(JSON.stringify(response));
    }

    transport.setMessageHandler((line) => {
        queue = queue.then(() => handleLine(line)).catch((error) => logger.error('request.failed', error));
    });

    // 保持既有启动失败语义：harness 缺失/runtime 初始化失败在此抛出；
    // 到达此点前收到的行已在队列中等待 runtimeReady。
    await runtimeReady;

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
