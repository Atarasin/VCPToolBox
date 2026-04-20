const path = require('node:path');
const readline = require('node:readline');

const {
    createMcpServerHarness
} = require('./adapters/mcpAdapter');

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

function writeJsonMessage(stdout, payload) {
    stdout.write(`${JSON.stringify(payload)}\n`);
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

async function initializeDefaultAgentGatewayMcpRuntime(options = {}) {
    if (runtimeState.context) {
        return runtimeState.context;
    }
    if (runtimeState.initializePromise) {
        return runtimeState.initializePromise;
    }

    const projectBasePath = options.projectBasePath || path.resolve(__dirname, '../..');
    const pluginManager = options.pluginManager || require('../../Plugin');
    const knowledgeBaseManager = options.knowledgeBaseManager || require('../../KnowledgeBaseManager.js');

    runtimeState.initializePromise = (async () => {
        if (!knowledgeBaseManager.initialized) {
            await knowledgeBaseManager.initialize();
        }

        if (typeof pluginManager.setProjectBasePath === 'function') {
            pluginManager.setProjectBasePath(projectBasePath);
        }
        if (typeof pluginManager.setVectorDBManager === 'function') {
            pluginManager.setVectorDBManager(knowledgeBaseManager);
        }

        if (!pluginManager.__agentGatewayMcpTransportPluginsLoaded) {
            await pluginManager.loadPlugins();
            pluginManager.__agentGatewayMcpTransportPluginsLoaded = true;
        }

        runtimeState.context = {
            pluginManager,
            knowledgeBaseManager,
            harness: createMcpServerHarness(pluginManager)
        };
        return runtimeState.context;
    })().catch((error) => {
        runtimeState.initializePromise = null;
        throw error;
    });

    return runtimeState.initializePromise;
}

async function shutdownDefaultAgentGatewayMcpRuntime() {
    const context = runtimeState.context;
    runtimeState.context = null;
    runtimeState.initializePromise = null;

    if (!context) {
        return;
    }

    const { pluginManager, knowledgeBaseManager } = context;
    if (pluginManager && typeof pluginManager.shutdownAllPlugins === 'function') {
        await pluginManager.shutdownAllPlugins();
    }
    if (knowledgeBaseManager && knowledgeBaseManager.initialized && typeof knowledgeBaseManager.shutdown === 'function') {
        await knowledgeBaseManager.shutdown();
    }
    if (pluginManager) {
        delete pluginManager.__agentGatewayMcpTransportPluginsLoaded;
    }
}

async function startStdioMcpServer(options = {}) {
    const stdin = options.stdin || process.stdin;
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    const initializeRuntime = options.initializeRuntime || initializeDefaultAgentGatewayMcpRuntime;
    const shutdownRuntime = options.shutdownRuntime || shutdownDefaultAgentGatewayMcpRuntime;
    const runtimeContext = await initializeRuntime(options);
    const harness = options.harness || runtimeContext?.harness;

    if (!harness || typeof harness.handleRequest !== 'function') {
        throw new Error('MCP stdio transport requires a harness with handleRequest(request).');
    }

    if (typeof stdin.setEncoding === 'function') {
        stdin.setEncoding('utf8');
    }

    const input = readline.createInterface({
        input: stdin,
        crlfDelay: Infinity,
        terminal: false
    });

    let queue = Promise.resolve();
    let closed = false;

    const finished = new Promise((resolve) => {
        input.once('close', async () => {
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
            writeJsonMessage(stdout, createJsonRpcErrorResponse(null, -32700, 'Parse error', {
                details: error.message
            }));
            return;
        }

        if (Array.isArray(request)) {
            writeJsonMessage(stdout, createJsonRpcErrorResponse(null, -32600, 'Batch requests are not supported', {
                field: 'request'
            }));
            return;
        }

        const expectsResponse = request && hasOwn(request, 'id');

        try {
            const response = await harness.handleRequest(request);
            if (expectsResponse && response) {
                writeJsonMessage(stdout, response);
            }
        } catch (error) {
            if (!expectsResponse) {
                writeStderr(stderr, `[MCPTransport] Notification handling failed: ${error.message}`);
                return;
            }
            writeJsonMessage(stdout, createJsonRpcErrorResponse(request.id, -32603, 'Internal error', {
                details: error.message
            }));
        }
    }

    input.on('line', (line) => {
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
            input.close();
            await finished;
        },
        finished
    };
}

module.exports = {
    createJsonRpcErrorResponse,
    initializeDefaultAgentGatewayMcpRuntime,
    shutdownDefaultAgentGatewayMcpRuntime,
    startStdioMcpServer
};
