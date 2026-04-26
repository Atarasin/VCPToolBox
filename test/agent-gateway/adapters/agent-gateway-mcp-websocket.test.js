'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const express = require('express');
const WebSocket = require('ws');

const legacyWebSocketServer = require('../../../WebSocketServer.js');
const { createMcpWebSocketServer } = require('../../../modules/agentGateway/mcpWebSocketServer');
const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const {
    AGENT_GATEWAY_HEADERS
} = require('../../../modules/agentGateway/contracts/protocolGovernance');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

let previousMemoryPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
const INTEGRATION_TEST_TIMEOUT_MS = 10000;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

test.before(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-ws-policy-'));
    const policyPath = path.join(tempDir, 'mcp_agent_memory_policy.json');

    await fs.writeFile(policyPath, JSON.stringify({
        agents: {
            Ariadne: {
                allowedDiaries: ['Nova', 'SharedMemory'],
                defaultDiaries: ['Nova']
            }
        }
    }, null, 2), 'utf8');

    process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
});

test.after(() => {
    if (previousMemoryPolicyPath === undefined) {
        delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        return;
    }
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousMemoryPolicyPath;
});

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-ws-'));
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings = {
    Ariadne: 'Ariadne.md'
}) {
    const agentMap = new Map(Object.entries(mappings));

    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            const sourceFile = agentMap.get(alias);
            return fs.readFile(path.join(agentDir, sourceFile), 'utf8');
        },
        async getAllAgentFiles() {
            return {
                files: Array.from(agentMap.values()),
                folderStructure: {}
            };
        }
    };
}

function createRenderPluginManager(agentDir, overrides = {}) {
    return createPluginManager({
        agentManager: createAgentManager(agentDir, overrides.agentMappings),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || ''),
        ...overrides
    });
}

function createHarness() {
    const requests = [];

    return {
        requests,
        harness: {
            async handleRequest(request) {
                requests.push(cloneJson(request));

                if (request.method === 'explode') {
                    throw new Error('boom');
                }

                if (!Object.prototype.hasOwnProperty.call(request, 'id')) {
                    return null;
                }

                return {
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {
                        method: request.method,
                        params: request.params || null
                    }
                };
            }
        }
    };
}

async function createFixture(options = {}) {
    const pluginManager = options.pluginManager || createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-websocket-test'
        }
    });
    const useStubHarness = options.useStubHarness !== false;
    const harnessState = useStubHarness ? createHarness() : null;
    const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end('not found');
    });
    const sockets = new Set();
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
    });
    const manager = createMcpWebSocketServer({
        pluginManager,
        ...(harnessState ? { harness: harnessState.harness } : {}),
        ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.maxBatchSize ? { maxBatchSize: options.maxBatchSize } : {}),
        ...(options.initializeRuntime ? { initializeRuntime: options.initializeRuntime } : {}),
        ...(options.shutdownRuntime ? { shutdownRuntime: options.shutdownRuntime } : {}),
        pingIntervalMs: options.pingIntervalMs || 40,
        stderr: options.stderr || null
    });

    if (options.enableLegacyWebSocketServer) {
        legacyWebSocketServer.initialize(server, {
            debugMode: false,
            vcpKey: 'legacy-secret'
        });
    }

    manager.attach(server);

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;

    return {
        manager,
        server,
        port,
        requests: harnessState ? harnessState.requests : [],
        wsUrl: `ws://127.0.0.1:${port}/mcp`,
        async close() {
            await manager.close();
            if (options.enableLegacyWebSocketServer) {
                legacyWebSocketServer.shutdown();
            }
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out closing websocket test fixture server'));
                }, 1000);
                server.close((error) => {
                    clearTimeout(timeout);
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
                for (const socket of sockets) {
                    socket.destroy();
                }
            });
        }
    };
}

async function connectClient(wsUrl, options = {}) {
    const client = new WebSocket(wsUrl, options);

    await new Promise((resolve, reject) => {
        const handleOpen = () => {
            cleanup();
            resolve();
        };
        const handleUnexpectedResponse = (_request, response) => {
            cleanup();
            reject(new Error(`Unexpected response: ${response.statusCode}`));
        };
        const handleError = (error) => {
            cleanup();
            reject(error);
        };
        const cleanup = () => {
            client.off('open', handleOpen);
            client.off('unexpected-response', handleUnexpectedResponse);
            client.off('error', handleError);
        };

        client.on('open', handleOpen);
        client.on('unexpected-response', handleUnexpectedResponse);
        client.on('error', handleError);
    });

    return client;
}

async function expectConnectFailure(wsUrl, options = {}) {
    const client = new WebSocket(wsUrl, options);

    const failure = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Expected websocket connection to fail'));
        }, 1000);

        const handleOpen = () => {
            cleanup();
            reject(new Error('Unexpected websocket open event'));
        };
        const handleUnexpectedResponse = (_request, response) => {
            cleanup();
            resolve(`unexpected-response:${response.statusCode}`);
        };
        const handleError = (error) => {
            cleanup();
            resolve(`error:${error.message}`);
        };
        const cleanup = () => {
            clearTimeout(timeout);
            client.off('open', handleOpen);
            client.off('unexpected-response', handleUnexpectedResponse);
            client.off('error', handleError);
        };

        client.on('open', handleOpen);
        client.on('unexpected-response', handleUnexpectedResponse);
        client.on('error', handleError);
    });

    client.terminate();
    return failure;
}

async function waitForJsonMessage(client, timeoutMs = 1000) {
    return Promise.race([
        once(client, 'message').then(([message]) => JSON.parse(message.toString())),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timed out waiting for websocket message')), timeoutMs))
    ]);
}

async function waitForNoMessage(client, timeoutMs = 150) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);

        const handleMessage = (message) => {
            cleanup();
            reject(new Error(`Unexpected websocket message: ${message.toString()}`));
        };

        const cleanup = () => {
            clearTimeout(timeout);
            client.off('message', handleMessage);
        };

        client.on('message', handleMessage);
    });
}

async function createNativeServer(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    };
}

function createGatewayHeaders() {
    return {
        [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
    };
}

function assertNoStackLeak(response) {
    assert.equal(response.error?.data?.stack, undefined);
    assert.equal(response.error?.data?.details?.stack, undefined);
}

function assertNoTopologyLeak(response) {
    const payload = JSON.stringify(response);
    assert.doesNotMatch(payload, /127\.0\.0\.1:9|localhost:9|ECONNREFUSED|https?:\/\/127\.0\.0\.1:9/i);
}

async function createBackendProxyClient(t, options = {}) {
    let backendServer = null;
    if (!options.backendUrl) {
        backendServer = await createNativeServer(options.backendPluginManager || createPluginManager());
        t.after(async () => backendServer.close());
    }

    const fixture = await createFixture({
        useStubHarness: false,
        backendUrl: options.backendUrl || backendServer.baseUrl,
        defaultAgentId: options.defaultAgentId || 'Ariadne'
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: createGatewayHeaders()
    });
    t.after(() => client.terminate());

    return {
        client,
        fixture,
        backendServer
    };
}

async function createRealHarnessFixture(t, options = {}) {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', options.agentPrompt || 'You are Ariadne. Hello {{VarUserName}}.');
    t.after(async () => {
        await fs.rm(agentDir, { recursive: true, force: true });
    });

    const pluginManager = createRenderPluginManager(agentDir, options.pluginManagerOverrides);
    const { client } = await createBackendProxyClient(t, {
        backendPluginManager: pluginManager,
        defaultAgentId: options.defaultAgentId || 'Ariadne'
    });

    return {
        client,
        agentDir
    };
}

test('accepts a gateway key websocket upgrade and returns a JSON-RPC response', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'ping',
        params: {}
    }));

    const response = await waitForJsonMessage(client);

    assert.equal(response.id, 'req-1');
    assert.equal(response.result.method, 'ping');
    assert.equal(fixture.manager.getConnectionCount(), 1);
});

test('accepts bearer-token websocket upgrades through dedicated gateway auth', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            Authorization: 'Bearer gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-bearer',
        method: 'tools/list',
        params: {}
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.id, 'req-bearer');
    assert.equal(response.result.method, 'tools/list');
});

test('rejects unauthenticated upgrades and does not leak a live connection', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const failure = await expectConnectFailure(fixture.wsUrl);

    assert.match(failure, /unexpected-response|error:/);
    assert.equal(fixture.manager.getConnectionCount(), 0);
});

test('overwrites client-provided session context with the server-generated sessionId', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-session',
        method: 'tools/call',
        params: {
            agentId: 'Ariadne',
            sessionId: 'client-controlled-session',
            requestContext: {
                requestId: 'client-request-id',
                source: 'client-source',
                runtime: 'client-runtime',
                sessionId: 'client-request-context-session'
            },
            authContext: {
                gatewayId: 'client-gateway',
                authMode: 'admin_transition',
                authSource: 'client-spoofed',
                roles: ['admin_transition']
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    const serverParams = response.result.params;

    assert.notEqual(serverParams.sessionId, 'client-controlled-session');
    assert.match(serverParams.sessionId, /^mcpws_/);
    assert.equal(serverParams.requestContext.sessionId, serverParams.sessionId);
    assert.equal(serverParams.authContext.sessionId, serverParams.sessionId);
    assert.equal(serverParams.requestContext.requestId, 'client-request-id');
    assert.equal(serverParams.requestContext.source, 'client-source');
    assert.equal(serverParams.requestContext.runtime, 'client-runtime');
    assert.equal(serverParams.requestContext.gatewayId, 'gw-websocket-test');
    assert.equal(serverParams.authContext.gatewayId, 'gw-websocket-test');
    assert.equal(serverParams.authContext.authMode, 'gateway_key');
    assert.equal(serverParams.authContext.authSource, AGENT_GATEWAY_HEADERS.GATEWAY_KEY);
    assert.deepEqual(serverParams.authContext.roles, ['gateway_client']);
});

test('ignores forged websocket authContext metadata and keeps the canonical gateway auth identity', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            Authorization: 'Bearer gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-auth-integrity',
        method: 'tools/call',
        params: {
            authContext: {
                gatewayId: 'forged-gateway',
                authMode: 'admin_transition',
                authSource: 'forged-source',
                roles: ['admin_transition', 'superuser']
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    const serverParams = response.result.params;

    assert.equal(serverParams.authContext.gatewayId, 'gw-websocket-test');
    assert.equal(serverParams.authContext.authMode, 'gateway_key');
    assert.equal(serverParams.authContext.authSource, 'authorization-bearer');
    assert.deepEqual(serverParams.authContext.roles, ['gateway_client']);
});

test('returns a JSON-RPC parse error for malformed frames and keeps the connection usable', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send('{');
    const parseError = await waitForJsonMessage(client);
    assert.equal(parseError.error.code, -32700);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-after-parse-error',
        method: 'ping',
        params: {}
    }));

    const recovery = await waitForJsonMessage(client);
    assert.equal(recovery.id, 'req-after-parse-error');
    assert.equal(recovery.result.method, 'ping');
});

test('returns ordered responses for a valid JSON-RPC batch request', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([
        { jsonrpc: '2.0', id: 'batch-1', method: 'ping', params: { order: 1 } },
        { jsonrpc: '2.0', id: 'batch-2', method: 'tools/list', params: { order: 2 } }
    ]));

    const response = await waitForJsonMessage(client);

    assert.equal(Array.isArray(response), true);
    assert.deepEqual(response.map((item) => item.id), ['batch-1', 'batch-2']);
    assert.deepEqual(response.map((item) => item.result.method), ['ping', 'tools/list']);
    assert.equal(fixture.requests.length, 2);
});

test('omits notification entries from mixed batch responses', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([
        { jsonrpc: '2.0', id: 'batch-mixed-1', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { source: 'batch' } },
        { jsonrpc: '2.0', id: 'batch-mixed-2', method: 'tools/list' }
    ]));

    const response = await waitForJsonMessage(client);

    assert.equal(Array.isArray(response), true);
    assert.deepEqual(response.map((item) => item.id), ['batch-mixed-1', 'batch-mixed-2']);
    assert.equal(fixture.requests.length, 3);
});

test('sends no frame for an all-notification batch and keeps the connection usable', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: { repeated: true } }
    ]));

    await waitForNoMessage(client);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-after-notification-batch',
        method: 'ping'
    }));

    const recovery = await waitForJsonMessage(client);
    assert.equal(recovery.id, 'req-after-notification-batch');
    assert.equal(recovery.result.method, 'ping');
});

test('rejects an empty JSON-RPC batch with invalid-request shaping', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([]));

    const response = await waitForJsonMessage(client);

    assert.equal(response.error.code, -32600);
    assert.equal(response.error.data.reason, 'empty_batch');
});

test('rejects oversized JSON-RPC batches with the configured limit in the error details', async (t) => {
    const fixture = await createFixture({ maxBatchSize: 1 });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([
        { jsonrpc: '2.0', id: 'limit-1', method: 'ping' },
        { jsonrpc: '2.0', id: 'limit-2', method: 'tools/list' }
    ]));

    const response = await waitForJsonMessage(client);

    assert.equal(response.error.code, -32600);
    assert.equal(response.error.data.reason, 'batch_limit_exceeded');
    assert.equal(response.error.data.limit, 1);
    assert.equal(response.error.data.actual, 2);
});

test('returns per-entry invalid-request errors for malformed batch members', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify([
        { jsonrpc: '2.0', id: 'valid-before', method: 'ping' },
        42,
        { jsonrpc: '2.0', id: 'valid-after', method: 'tools/list' }
    ]));

    const response = await waitForJsonMessage(client);

    assert.equal(Array.isArray(response), true);
    assert.deepEqual(response.map((item) => item.id), ['valid-before', null, 'valid-after']);
    assert.equal(response[1].error.code, -32600);
    assert.equal(response[1].error.data.reason, 'invalid_batch_member');
    assert.equal(response[1].error.data.batchIndex, 1);
});

test('surfaces harness failures as JSON-RPC internal errors', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-explode',
        method: 'explode',
        params: {}
    }));

    const response = await waitForJsonMessage(client);

    assert.equal(response.error.code, -32603);
    assert.match(response.error.data.details, /boom/);
});

test('websocket backend proxy maps prompt misuse to stable MCP JSON-RPC errors', async (t) => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    t.after(async () => fs.rm(agentDir, { recursive: true, force: true }));

    const { client } = await createBackendProxyClient(t, {
        backendPluginManager: createRenderPluginManager(agentDir)
    });

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'prompt-unsupported',
        method: 'prompts/get',
        params: {
            name: 'missing_prompt',
            arguments: {
                agentId: 'Ariadne'
            }
        }
    }));

    const unsupported = await waitForJsonMessage(client);
    assert.equal(unsupported.error.code, -32000);
    assert.equal(unsupported.error.data.code, 'MCP_NOT_FOUND');
    assert.equal(unsupported.error.data.name, 'missing_prompt');
    assertNoStackLeak(unsupported);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'prompt-invalid-args',
        method: 'prompts/get',
        params: {
            name: 'gateway_agent_render'
        }
    }));

    const invalidArguments = await waitForJsonMessage(client);
    assert.equal(invalidArguments.error.code, -32000);
    assert.equal(invalidArguments.error.data.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(invalidArguments.error.data.field, 'arguments');
    assertNoStackLeak(invalidArguments);
});

test('websocket backend proxy points gateway_agent_render tool misuse to prompts/get', async (t) => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne.');
    t.after(async () => fs.rm(agentDir, { recursive: true, force: true }));

    const { client } = await createBackendProxyClient(t, {
        backendPluginManager: createRenderPluginManager(agentDir)
    });

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'tool-render-misuse',
        method: 'tools/call',
        params: {
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne'
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.data.code, 'MCP_NOT_FOUND');
    assert.equal(response.error.data.primarySurface, 'prompts/get');
    assertNoStackLeak(response);
});

test('websocket backend proxy preserves result-level MCP tool failures for diary policy rejections', async (t) => {
    const { client } = await createBackendProxyClient(t);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'tool-policy-rejection',
        method: 'tools/call',
        params: {
            name: 'gateway_memory_search',
            arguments: {
                query: '查询不允许的 diary',
                diary: 'ProjectAlpha'
            },
            agentId: 'Ariadne'
        }
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.error.code, 'MCP_FORBIDDEN');
    assert.equal(response.result.error.details.diary, 'ProjectAlpha');
});

test('websocket backend proxy maps unsupported tool and resource requests to MCP-standard JSON-RPC errors', async (t) => {
    const { client } = await createBackendProxyClient(t);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'tool-unsupported',
        method: 'tools/call',
        params: {
            name: 'gateway_unknown_tool',
            arguments: {}
        }
    }));

    const toolFailure = await waitForJsonMessage(client);
    assert.equal(toolFailure.error.code, -32000);
    assert.equal(toolFailure.error.data.code, 'MCP_NOT_FOUND');
    assert.equal(toolFailure.error.data.name, 'gateway_unknown_tool');
    assertNoStackLeak(toolFailure);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'resource-unsupported',
        method: 'resources/read',
        params: {
            uri: 'vcp://agent-gateway/agents/Ariadne/profile'
        }
    }));

    const resourceFailure = await waitForJsonMessage(client);
    assert.equal(resourceFailure.error.code, -32000);
    assert.equal(resourceFailure.error.data.code, 'MCP_RESOURCE_UNSUPPORTED');
    assert.equal(resourceFailure.error.data.uri, 'vcp://agent-gateway/agents/Ariadne/profile');
    assertNoStackLeak(resourceFailure);
});

test('websocket backend proxy sanitizes representative backend runtime failures', async (t) => {
    const { client } = await createBackendProxyClient(t, {
        backendUrl: 'http://127.0.0.1:9',
        defaultAgentId: 'Ariadne'
    });

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'prompt-backend-runtime',
        method: 'prompts/get',
        params: {
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne'
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.message, 'Gateway backend request failed');
    assert.equal(response.error.data.code, 'MCP_RUNTIME_ERROR');
    assertNoStackLeak(response);
    assertNoTopologyLeak(response);
});

test('websocket backend proxy preserves per-entry semantics for mixed success and failure batches', async (t) => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne.');
    t.after(async () => fs.rm(agentDir, { recursive: true, force: true }));

    const { client } = await createBackendProxyClient(t, {
        backendPluginManager: createRenderPluginManager(agentDir)
    });

    client.send(JSON.stringify([
        {
            jsonrpc: '2.0',
            id: 'batch-tools-list',
            method: 'tools/list',
            params: {
                agentId: 'Ariadne'
            }
        },
        {
            jsonrpc: '2.0',
            id: 'batch-invalid-prompt',
            method: 'prompts/get',
            params: {
                name: 'missing_prompt',
                arguments: {
                    agentId: 'Ariadne'
                }
            }
        }
    ]));

    const response = await waitForJsonMessage(client);
    assert.equal(Array.isArray(response), true);
    assert.deepEqual(response.map((entry) => entry.id), ['batch-tools-list', 'batch-invalid-prompt']);
    assert.equal(Array.isArray(response[0].result.tools), true);
    assert.equal(response[1].error.data.code, 'MCP_NOT_FOUND');
});

test('keeps healthy websocket clients connected across native ping/pong heartbeats', async (t) => {
    const fixture = await createFixture({ pingIntervalMs: 25 });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(client.readyState, WebSocket.OPEN);
    assert.equal(fixture.manager.getConnectionCount(), 1);
});

test('terminates stale websocket clients that stop answering native pings', async (t) => {
    const fixture = await createFixture({ pingIntervalMs: 25 });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        autoPong: false,
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    await Promise.race([
        once(client, 'close'),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timed out waiting for stale websocket termination')), 1500))
    ]);

    assert.equal(fixture.manager.getConnectionCount(), 0);
});

test('cleans up connection state after the client closes the websocket', async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });

    client.close();
    await once(client, 'close');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fixture.manager.getConnectionCount(), 0);
});

test('serves /mcp independently without requiring the legacy websocket mesh', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const fixture = await createFixture();
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-isolated',
        method: 'initialize',
        params: {}
    }));

    const response = await waitForJsonMessage(client);

    assert.equal(response.id, 'req-isolated');
    assert.equal(response.result.method, 'initialize');
    assert.equal(fixture.requests.length, 1);
});

test('completes the real MCP initialize handshake over websocket with transport-correct metadata', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const pluginManager = createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-websocket-test'
        }
    });
    const backend = await createNativeServer(pluginManager);
    t.after(async () => backend.close());

    const fixture = await createFixture({
        pluginManager,
        useStubHarness: false,
        backendUrl: backend.baseUrl,
        defaultAgentId: 'Ariadne'
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'real-init',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'trae',
                version: '1.0.0'
            }
        }
    }));

    const response = await waitForJsonMessage(client);

    assert.equal(response.id, 'real-init');
    assert.equal(response.result.protocolVersion, '2025-06-18');
    assert.equal(response.result.serverInfo.name, 'vcp-agent-gateway');
    assert.deepEqual(response.result.capabilities.tools, { listChanged: false });
    assert.doesNotMatch(response.result.instructions, /stdio/i);
});

test('keeps repeated initialized notifications silent and still answers ping on the real harness', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const pluginManager = createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-websocket-test'
        }
    });
    const backend = await createNativeServer(pluginManager);
    t.after(async () => backend.close());

    const fixture = await createFixture({
        pluginManager,
        useStubHarness: false,
        backendUrl: backend.baseUrl,
        defaultAgentId: 'Ariadne'
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'real-init-for-ping',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'trae',
                version: '1.0.0'
            }
        }
    }));
    await waitForJsonMessage(client);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }));
    await waitForNoMessage(client);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    }));
    await waitForNoMessage(client);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'real-ping',
        method: 'ping'
    }));

    const ping = await waitForJsonMessage(client);
    assert.equal(ping.id, 'real-ping');
    assert.deepEqual(ping.result, {});
});

test('preserves canonical request metadata on a follow-up real-harness websocket call', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const pluginManager = createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-websocket-test'
        }
    });
    const backend = await createNativeServer(pluginManager);
    t.after(async () => backend.close());

    const fixture = await createFixture({
        pluginManager,
        useStubHarness: false,
        backendUrl: backend.baseUrl,
        defaultAgentId: 'Ariadne'
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'real-init-for-context',
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'trae',
                version: '1.0.0'
            }
        }
    }));
    await waitForJsonMessage(client);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'real-tools-list',
        method: 'tools/list',
        params: {
            requestContext: {
                requestId: 'req-real-tools-list'
            }
        }
    }));

    const tools = await waitForJsonMessage(client);
    assert.equal(tools.id, 'real-tools-list');
    assert.equal(tools.result.meta.requestId, 'req-real-tools-list');
    assert.equal(tools.result.meta.agentId, 'Ariadne');
});

test('real harness: websocket capability discovery exposes prompt-only and tool-only gateway surfaces', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const { client } = await createRealHarnessFixture(t);

    client.send(JSON.stringify([
        {
            jsonrpc: '2.0',
            id: 'cap-tools-list',
            method: 'tools/list',
            params: {
                requestContext: {
                    requestId: 'req-cap-tools-list'
                }
            }
        },
        {
            jsonrpc: '2.0',
            id: 'cap-prompts-list',
            method: 'prompts/list',
            params: {
                requestContext: {
                    requestId: 'req-cap-prompts-list'
                }
            }
        }
    ]));

    const response = await waitForJsonMessage(client);
    assert.equal(Array.isArray(response), true);

    const tools = response.find((entry) => entry.id === 'cap-tools-list');
    const prompts = response.find((entry) => entry.id === 'cap-prompts-list');

    assert.equal(Array.isArray(tools.result.tools), true);
    assert.equal(tools.result.meta.requestId, 'req-cap-tools-list');
    assert.equal(tools.result.meta.agentId, 'Ariadne');
    assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_memory_search'), true);
    assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_context_assemble'), true);
    assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_memory_write'), true);
    assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_agent_render'), false);

    assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
    assert.equal(prompts.result.meta.requestId, 'req-cap-prompts-list');
    assert.equal(prompts.result.meta.agentId, 'Ariadne');
});

test('real harness: websocket prompts/get returns rendered prompt content with host hints', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const { client } = await createRealHarnessFixture(t);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'cap-prompt-get',
        method: 'prompts/get',
        params: {
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            requestContext: {
                requestId: 'req-cap-prompt-get'
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.id, 'cap-prompt-get');
    assert.equal(response.result.name, 'gateway_agent_render');
    assert.equal(response.result.messages[0].role, 'system');
    assert.equal(response.result.messages[0].content[0].text.includes('Hello Nova'), true);
    assert.equal(response.result.meta.requestId, 'req-cap-prompt-get');
    assert.equal(response.result.meta.agentId, 'Ariadne');
    assert.equal(response.result.meta.hostHints.primarySurface, 'prompts/get');
    assert.equal(response.result.meta.hostHints.resolvedAgentId, 'Ariadne');
});

test('real harness: websocket representative gateway-managed search and context calls keep MCP result shaping', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const { client } = await createRealHarnessFixture(t);

    client.send(JSON.stringify([
        {
            jsonrpc: '2.0',
            id: 'cap-memory-search',
            method: 'tools/call',
            params: {
                name: 'gateway_memory_search',
                arguments: {
                    query: 'Nova',
                    diary: 'Nova'
                },
                agentId: 'Ariadne',
                sessionId: 'sess-cap-memory-search',
                requestContext: {
                    requestId: 'req-cap-memory-search'
                }
            }
        },
        {
            jsonrpc: '2.0',
            id: 'cap-context-assemble',
            method: 'tools/call',
            params: {
                name: 'gateway_context_assemble',
                arguments: {
                    query: 'Ariadne gateway'
                },
                agentId: 'Ariadne',
                sessionId: 'sess-cap-context-assemble',
                requestContext: {
                    requestId: 'req-cap-context-assemble'
                }
            }
        }
    ]));

    const response = await waitForJsonMessage(client, 2000);
    assert.equal(Array.isArray(response), true);

    const memorySearch = response.find((entry) => entry.id === 'cap-memory-search');
    const contextAssemble = response.find((entry) => entry.id === 'cap-context-assemble');

    assert.equal(memorySearch.result.isError, false);
    assert.equal(Array.isArray(memorySearch.result.content), true);
    assert.equal(typeof memorySearch.result.structuredContent, 'object');

    assert.equal(contextAssemble.result.isError, false);
    assert.equal(Array.isArray(contextAssemble.result.content), true);
    assert.equal(typeof contextAssemble.result.structuredContent, 'object');
});

test('mock harness: websocket memory write preserves MCP tool-result success shaping', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const fixture = await createFixture({
        useStubHarness: false,
        initializeRuntime: async () => ({
            harness: {
                async handleRequest(request) {
                    if (request.method !== 'tools/call') {
                        return {
                            jsonrpc: '2.0',
                            id: request.id ?? null,
                            error: {
                                code: -32601,
                                message: 'Method not found'
                            }
                        };
                    }

                    return {
                        jsonrpc: '2.0',
                        id: request.id ?? null,
                        result: {
                            content: [{
                                type: 'text',
                                text: 'Memory write created'
                            }],
                            isError: false,
                            structuredContent: {
                                result: {
                                    writeStatus: 'created',
                                    diary: 'Nova'
                                },
                                operability: {
                                    operationName: 'memory.write'
                                }
                            }
                        }
                    };
                }
            }
        }),
        shutdownRuntime: async () => {}
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: createGatewayHeaders()
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'cap-memory-write',
        method: 'tools/call',
        params: {
            name: 'gateway_memory_write',
            arguments: {
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: 'Phase 4 websocket capability exposure verification note',
                    tags: ['phase4', 'websocket']
                }
            },
            agentId: 'Ariadne',
            sessionId: 'sess-cap-memory-write',
            requestContext: {
                requestId: 'req-cap-memory-write'
            }
        }
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.id, 'cap-memory-write');
    assert.equal(response.result.isError, false);
    assert.equal(Array.isArray(response.result.content), true);
    assert.equal(response.result.structuredContent.result.writeStatus, 'created');
    assert.equal(response.result.structuredContent.operability.operationName, 'memory.write');
});

test('real harness: websocket batch capability discovery preserves per-entry prompt and tool semantics', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const { client } = await createRealHarnessFixture(t);

    client.send(JSON.stringify([
        {
            jsonrpc: '2.0',
            id: 'cap-batch-tools-list',
            method: 'tools/list',
            params: {
                requestContext: {
                    requestId: 'req-cap-batch-tools-list'
                }
            }
        },
        {
            jsonrpc: '2.0',
            id: 'cap-batch-prompts-list',
            method: 'prompts/list',
            params: {
                requestContext: {
                    requestId: 'req-cap-batch-prompts-list'
                }
            }
        },
        {
            jsonrpc: '2.0',
            id: 'cap-batch-prompt-get',
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Trae'
                    }
                },
                requestContext: {
                    requestId: 'req-cap-batch-prompt-get'
                }
            }
        }
    ]));

    const response = await waitForJsonMessage(client);
    assert.equal(Array.isArray(response), true);

    const tools = response.find((entry) => entry.id === 'cap-batch-tools-list');
    const prompts = response.find((entry) => entry.id === 'cap-batch-prompts-list');
    const promptGet = response.find((entry) => entry.id === 'cap-batch-prompt-get');

    assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_memory_search'), true);
    assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
    assert.equal(promptGet.result.name, 'gateway_agent_render');
    assert.equal(promptGet.result.messages[0].content[0].text.includes('Hello Trae'), true);
    assert.equal(promptGet.result.meta.hostHints.primarySurface, 'prompts/get');
});

test('serves /mcp even when the legacy websocket server is attached to the same HTTP server', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const fixture = await createFixture({
        enableLegacyWebSocketServer: true
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-coexist',
        method: 'ping',
        params: {}
    }));

    const response = await waitForJsonMessage(client);

    assert.equal(response.id, 'req-coexist');
    assert.equal(response.result.method, 'ping');
});

test('legacy websocket server leaves unknown upgrade paths available for sibling websocket stacks', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    const fixture = await createFixture({
        enableLegacyWebSocketServer: true
    });
    t.after(async () => fixture.close());

    const customWss = new WebSocket.Server({
        noServer: true,
        clientTracking: false
    });
    const handleUpgrade = (request, socket, head) => {
        if (new URL(request.url, 'http://127.0.0.1').pathname !== '/custom') {
            return;
        }

        customWss.handleUpgrade(request, socket, head, (ws) => {
            // Defer the first frame so the client-side message waiter is attached.
            setTimeout(() => {
                if (ws.readyState !== WebSocket.OPEN) {
                    return;
                }
                ws.send(JSON.stringify({
                    ok: true,
                    path: 'custom'
                }));
            }, 10);
        });
    };

    fixture.server.on('upgrade', handleUpgrade);
    t.after(async () => {
        fixture.server.off('upgrade', handleUpgrade);
        await new Promise((resolve) => customWss.close(() => resolve()));
    });

    const client = await connectClient(`ws://127.0.0.1:${fixture.port}/custom`);

    const payload = await waitForJsonMessage(client);
    assert.deepEqual(payload, {
        ok: true,
        path: 'custom'
    });

    const closePromise = once(client, 'close');
    client.close();
    await closePromise;
});

test('retries harness initialization on the same websocket after a transient bootstrap failure', { timeout: INTEGRATION_TEST_TIMEOUT_MS }, async (t) => {
    let initializeAttempts = 0;
    const fixture = await createFixture({
        useStubHarness: false,
        initializeRuntime: async () => {
            initializeAttempts += 1;
            if (initializeAttempts === 1) {
                throw new Error('transient bootstrap failure');
            }

            return {
                harness: {
                    async handleRequest(request) {
                        return {
                            jsonrpc: '2.0',
                            id: request.id ?? null,
                            result: {
                                method: request.method
                            }
                        };
                    }
                }
            };
        },
        shutdownRuntime: async () => {}
    });
    t.after(async () => fixture.close());

    const client = await connectClient(fixture.wsUrl, {
        headers: {
            [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret'
        }
    });
    t.after(() => client.terminate());

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'first-bootstrap-attempt',
        method: 'ping',
        params: {}
    }));

    await waitForNoMessage(client, 120);

    client.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 'second-bootstrap-attempt',
        method: 'ping',
        params: {}
    }));

    const response = await waitForJsonMessage(client);
    assert.equal(response.id, 'second-bootstrap-attempt');
    assert.equal(response.result.method, 'ping');
    assert.equal(initializeAttempts, 2);
});
