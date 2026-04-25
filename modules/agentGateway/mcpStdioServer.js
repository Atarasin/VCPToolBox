const { StdioTransport } = require('./transport');

const {
    createBackendProxyMcpServerHarness
} = require('./adapters/mcpBackendProxyAdapter');
const {
    GatewayBackendClient
} = require('./GatewayBackendClient');

const runtimeState = {
    initializePromise: null,
    context: null
};

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function writeStderr(stderr, message) {
    if (!stderr || typeof stderr.write !== 'function') {
        return;
    }
    stderr.write(`${message}\n`);
}

function createJsonRpcErrorResponse(id, code, message, data) {
    return {
        jsonrpc: '2.0',
        id: typeof id === 'undefined' ? null : id,
        error: {
            code,
            message,
            ...(data && typeof data === 'object' ? { data } : {})
        }
    };
}

function resolveRequiredEnv(name, fallbackValue = '') {
    const normalizedValue = typeof fallbackValue === 'string' ? fallbackValue.trim() : '';
    const envValue = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
    const value = envValue || normalizedValue;

    if (!value) {
        throw new Error(`${name} is required for backend-only MCP transport.`);
    }

    return value;
}

async function initializeBackendProxyMcpRuntime(options = {}) {
    if (runtimeState.context) {
        return runtimeState.context;
    }
    if (runtimeState.initializePromise) {
        return runtimeState.initializePromise;
    }

    runtimeState.initializePromise = (async () => {
        const backendClient = options.backendClient || new GatewayBackendClient({
            baseUrl: options.backendUrl || resolveRequiredEnv('VCP_MCP_BACKEND_URL'),
            gatewayKey: options.gatewayKey || process.env.VCP_MCP_BACKEND_KEY,
            gatewayId: options.gatewayId || process.env.VCP_MCP_BACKEND_GATEWAY_ID,
            bearerToken: options.bearerToken || process.env.VCP_MCP_BACKEND_BEARER_TOKEN
        });
        const defaultAgentId = typeof options.defaultAgentId === 'string'
            ? options.defaultAgentId.trim()
            : (typeof process.env.VCP_MCP_DEFAULT_AGENT_ID === 'string'
                ? process.env.VCP_MCP_DEFAULT_AGENT_ID.trim()
                : '');

        runtimeState.context = {
            backendClient,
            harness: createBackendProxyMcpServerHarness({
                backendClient,
                defaultAgentId,
                includeAgentRender: options.includeAgentRender !== false
            })
        };
        return runtimeState.context;
    })().catch((error) => {
        runtimeState.initializePromise = null;
        throw error;
    });

    return runtimeState.initializePromise;
}

async function shutdownBackendProxyMcpRuntime() {
    runtimeState.context = null;
    runtimeState.initializePromise = null;
}

async function createStdioMcpServer(options = {}) {
    const transport = options.transport || new StdioTransport(options);
    const stderr = options.stderr || process.stderr;
    const initializeRuntime = options.initializeRuntime || initializeBackendProxyMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownBackendProxyMcpRuntime;
    const runtimeContext = await initializeRuntime(options);
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
                try {
                    await shutdownRuntime();
                } catch (error) {
                    writeStderr(stderr, `[MCPTransport] Shutdown failed: ${error.message}`);
                }
            }
            resolve();
        });
    });

    async function handleLine(line) {
        const normalizedLine = typeof line === 'string' ? line.trim() : '';
        if (!normalizedLine) {
            return;
        }

        let request;
        try {
            request = JSON.parse(normalizedLine);
        } catch (error) {
            transport.send(JSON.stringify(createJsonRpcErrorResponse(null, -32700, 'Parse error', {
                details: error.message
            })));
            return;
        }

        if (Array.isArray(request)) {
            transport.send(JSON.stringify(createJsonRpcErrorResponse(null, -32600, 'Batch requests are not supported', {
                field: 'request'
            })));
            return;
        }

        const expectsResponse = request && hasOwn(request, 'id');

        try {
            const response = await harness.handleRequest(request);
            if (expectsResponse && response) {
                transport.send(JSON.stringify(response));
            }
        } catch (error) {
            if (!expectsResponse) {
                writeStderr(stderr, `[MCPTransport] Notification handling failed: ${error.message}`);
                return;
            }
            transport.send(JSON.stringify(createJsonRpcErrorResponse(request.id, -32603, 'Internal error', {
                details: error.message
            })));
        }
    }

    transport.setMessageHandler((line) => {
        queue = queue
            .then(() => handleLine(line))
            .catch((error) => {
                writeStderr(stderr, `[MCPTransport] Request handling failed: ${error.message}`);
            });
    });

    return {
        async close() {
            if (closed) {
                return;
            }
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
    createJsonRpcErrorResponse,
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime,
    startStdioMcpServer,
    createStdioMcpServer
};
