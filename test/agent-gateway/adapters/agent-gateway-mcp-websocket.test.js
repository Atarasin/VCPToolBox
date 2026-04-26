'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
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

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
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
    const manager = createMcpWebSocketServer({
        pluginManager,
        ...(harnessState ? { harness: harnessState.harness } : {}),
        ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.maxBatchSize ? { maxBatchSize: options.maxBatchSize } : {}),
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
        requests: harnessState ? harnessState.requests : [],
        wsUrl: `ws://127.0.0.1:${port}/mcp`,
        async close() {
            await manager.close();
            if (options.enableLegacyWebSocketServer) {
                legacyWebSocketServer.shutdown();
            }
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

test('serves /mcp independently without requiring the legacy websocket mesh', async (t) => {
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

test('completes the real MCP initialize handshake over websocket with transport-correct metadata', async (t) => {
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

test('keeps repeated initialized notifications silent and still answers ping on the real harness', async (t) => {
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

test('preserves canonical request metadata on a follow-up real-harness websocket call', async (t) => {
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

test('serves /mcp even when the legacy websocket server is attached to the same HTTP server', async (t) => {
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
