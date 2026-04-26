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

const { createMcpHttpServer } = require('../../../modules/agentGateway/mcpHttpServer');
const { createMcpWebSocketServer } = require('../../../modules/agentGateway/mcpWebSocketServer');
const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const {
    AGENT_GATEWAY_HEADERS
} = require('../../../modules/agentGateway/contracts/protocolGovernance');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

const INTEGRATION_TEST_TIMEOUT_MS = 10000;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-http-'));
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
        agentGatewayProtocolConfig: overrides.agentGatewayProtocolConfig || {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-http-test'
        },
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || ''),
        ...overrides
    });
}

function createHarness(overrides = {}) {
    const requests = [];

    return {
        requests,
        harness: {
            async handleRequest(request) {
                requests.push(request);

                if (typeof overrides.handleRequest === 'function') {
                    return overrides.handleRequest(request, requests);
                }

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
                        params: cloneJson(request.params || null)
                    }
                };
            }
        }
    };
}

function createGatewayAuthHeaders(overrides = {}) {
    return {
        [AGENT_GATEWAY_HEADERS.GATEWAY_KEY]: 'gw-secret',
        [AGENT_GATEWAY_HEADERS.GATEWAY_ID]: 'gw-http-test',
        ...overrides
    };
}

async function createNativeServer(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));

    const server = http.createServer(app);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
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

async function createFixture(options = {}) {
    const pluginManager = options.pluginManager || createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret',
            gatewayId: 'gw-http-test'
        }
    });
    const harnessState = options.useStubHarness === false
        ? null
        : createHarness(options.harnessOverrides || {});
    const app = express();
    const server = http.createServer(app);
    const sockets = new Set();
    let wsManager = null;

    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => {
            sockets.delete(socket);
        });
    });

    const httpManager = createMcpHttpServer({
        pluginManager,
        ...(options.harness ? { harness: options.harness } : {}),
        ...(harnessState ? { harness: harnessState.harness } : {}),
        ...(options.initializeRuntime ? { initializeRuntime: options.initializeRuntime } : {}),
        ...(options.shutdownRuntime ? { shutdownRuntime: options.shutdownRuntime } : {}),
        ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
        ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
        ...(options.maxSessions ? { maxSessions: options.maxSessions } : {}),
        ...(options.maxPayloadBytes ? { maxPayloadBytes: options.maxPayloadBytes } : {}),
        ...(options.authTimeoutMs ? { authTimeoutMs: options.authTimeoutMs } : {}),
        ...(options.rateLimitMessages ? { rateLimitMessages: options.rateLimitMessages } : {}),
        ...(options.rateLimitWindowMs ? { rateLimitWindowMs: options.rateLimitWindowMs } : {}),
        ...(options.sessionIdleMs ? { sessionIdleMs: options.sessionIdleMs } : {}),
        ...(options.heartbeatIntervalMs ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
        ...(options.resolveAuth ? { resolveAuth: options.resolveAuth } : {}),
        stderr: options.stderr || null
    });
    httpManager.attach(app);

    if (options.enableWebSocket !== false) {
        wsManager = createMcpWebSocketServer({
            pluginManager,
            ...(harnessState ? { harness: harnessState.harness } : {}),
            ...(options.backendUrl ? { backendUrl: options.backendUrl } : {}),
            ...(options.defaultAgentId ? { defaultAgentId: options.defaultAgentId } : {}),
            stderr: options.stderr || null,
            pingIntervalMs: 40
        });
        wsManager.attach(server);
    }

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    return {
        app,
        httpManager,
        wsManager,
        pluginManager,
        requests: harnessState ? harnessState.requests : [],
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        wsUrl: `ws://127.0.0.1:${server.address().port}/mcp`,
        async close() {
            await httpManager.close();
            if (wsManager) {
                await wsManager.close();
            }
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out closing HTTP MCP test fixture server'));
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

async function readJsonResponse(response) {
    const text = await response.text();
    return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: text ? JSON.parse(text) : null
    };
}

async function postJson(url, body, options = {}) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(options.headers || {})
        },
        body: JSON.stringify(body),
        signal: options.signal
    });
    return readJsonResponse(response);
}

async function deleteRequest(url, options = {}) {
    const response = await fetch(url, {
        method: 'DELETE',
        headers: options.headers || {}
    });
    return readJsonResponse(response);
}

function parseSseBlock(block) {
    const normalized = String(block || '').trim();
    if (!normalized) {
        return null;
    }

    if (normalized.startsWith(':')) {
        return {
            kind: 'comment',
            comment: normalized.slice(1).trim()
        };
    }

    let event = 'message';
    const dataLines = [];
    normalized.split('\n').forEach((line) => {
        if (line.startsWith('event:')) {
            event = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trim());
        }
    });

    if (dataLines.length === 0) {
        return null;
    }

    const rawData = dataLines.join('\n');
    try {
        return {
            kind: 'event',
            event,
            data: JSON.parse(rawData)
        };
    } catch (_error) {
        return {
            kind: 'event',
            event,
            data: rawData
        };
    }
}

async function openSseStream(url, options = {}) {
    const target = new URL(url);
    const request = http.request({
        method: 'GET',
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers || {}
    });

    const response = await new Promise((resolve, reject) => {
        request.once('response', resolve);
        request.once('error', reject);
        request.end();
    });

    response.setEncoding('utf8');
    let buffer = '';
    const frames = [];
    const waiters = [];

    function flushWaiters() {
        while (waiters.length > 0) {
            const waiter = waiters[0];
            const match = frames.find(waiter.predicate);
            if (!match) {
                break;
            }
            waiters.shift();
            waiter.resolve(match);
        }
    }

    response.on('data', (chunk) => {
        buffer += chunk;
        let delimiterIndex = buffer.indexOf('\n\n');
        while (delimiterIndex >= 0) {
            const block = buffer.slice(0, delimiterIndex);
            buffer = buffer.slice(delimiterIndex + 2);
            const frame = parseSseBlock(block);
            if (frame) {
                frames.push(frame);
                flushWaiters();
            }
            delimiterIndex = buffer.indexOf('\n\n');
        }
    });

    return {
        statusCode: response.statusCode,
        headers: response.headers,
        frames,
        waitFor(predicate, timeoutMs = 1000) {
            const existing = frames.find(predicate);
            if (existing) {
                return Promise.resolve(existing);
            }
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out waiting for SSE frame'));
                }, timeoutMs);
                waiters.push({
                    predicate,
                    resolve(value) {
                        clearTimeout(timeout);
                        resolve(value);
                    }
                });
            });
        },
        async close() {
            response.destroy();
            request.destroy();
            await once(response, 'close').catch(() => {});
        }
    };
}

async function connectWebSocket(wsUrl, headers) {
    const client = new WebSocket(wsUrl, {
        headers
    });

    await new Promise((resolve, reject) => {
        const cleanup = () => {
            client.off('open', handleOpen);
            client.off('error', handleError);
            client.off('unexpected-response', handleUnexpectedResponse);
        };
        const handleOpen = () => {
            cleanup();
            resolve();
        };
        const handleError = (error) => {
            cleanup();
            reject(error);
        };
        const handleUnexpectedResponse = (_request, response) => {
            cleanup();
            reject(new Error(`Unexpected websocket response: ${response.statusCode}`));
        };

        client.on('open', handleOpen);
        client.on('error', handleError);
        client.on('unexpected-response', handleUnexpectedResponse);
    });

    return client;
}

async function waitForWebSocketMessage(client, timeoutMs = 1000) {
    return Promise.race([
        once(client, 'message').then(([message]) => JSON.parse(message.toString())),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Timed out waiting for websocket message')), timeoutMs))
    ]);
}

function createInitializePayload(id = 1, overrides = {}) {
    return {
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'trae',
                version: '1.0.0'
            },
            ...overrides
        }
    };
}

test('streamable HTTP initialize returns session header and injected request context', async () => {
    const fixture = await createFixture();

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(initialize.status, 200);
        assert.equal(typeof initialize.headers['mcp-session-id'], 'string');
        assert.equal(initialize.body.result.method, 'initialize');
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.requests[0].params.sessionId, initialize.headers['mcp-session-id']);
        assert.equal(fixture.requests[0].params.requestContext.source, 'agent-gateway-mcp-http');
        assert.equal(fixture.requests[0].params.requestContext.runtime, 'mcp-http');
        assert.equal(fixture.requests[0].params.authContext.gatewayId, 'gw-http-test');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP GET /mcp requires a valid session header', async () => {
    const fixture = await createFixture();

    try {
        const response = await fetch(`${fixture.baseUrl}/mcp`, {
            headers: createGatewayAuthHeaders()
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.error.data.reason, 'missing_session_header');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP GET /mcp emits heartbeat comments for live sessions', async () => {
    const fixture = await createFixture({
        heartbeatIntervalMs: 25
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const stream = await openSseStream(`${fixture.baseUrl}/mcp`, {
            headers: {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': initialize.headers['mcp-session-id']
            }
        });

        try {
            assert.equal(stream.statusCode, 200);
            const heartbeat = await stream.waitFor((frame) => frame.kind === 'comment' && frame.comment.startsWith('heartbeat'));
            assert.equal(heartbeat.kind, 'comment');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP follow-up POST mirrors JSON-RPC responses onto the active SSE stream', async () => {
    const fixture = await createFixture({
        heartbeatIntervalMs: 25
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const sessionId = initialize.headers['mcp-session-id'];
        const stream = await openSseStream(`${fixture.baseUrl}/mcp`, {
            headers: {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': sessionId
            }
        });

        try {
            await stream.waitFor((frame) => frame.kind === 'comment');
            const response = await postJson(`${fixture.baseUrl}/mcp`, {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list'
            }, {
                headers: {
                    ...createGatewayAuthHeaders(),
                    'MCP-Session-Id': sessionId
                }
            });

            assert.equal(response.status, 200);
            assert.equal(response.body.result.method, 'tools/list');
            const message = await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'message' && frame.data.id === 2);
            assert.equal(message.data.result.method, 'tools/list');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP DELETE /mcp terminates the session and invalidates follow-up requests', async () => {
    const fixture = await createFixture();

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const sessionId = initialize.headers['mcp-session-id'];

        const deleted = await deleteRequest(`${fixture.baseUrl}/mcp`, {
            headers: {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': sessionId
            }
        });
        assert.equal(deleted.status, 204);

        const followUp = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 2,
            method: 'ping'
        }, {
            headers: {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': sessionId
            }
        });

        assert.equal(followUp.status, 404);
        assert.equal(followUp.body.error.data.reason, 'unknown_session');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP enforces per-session rate limits', async () => {
    const fixture = await createFixture({
        rateLimitMessages: 1,
        rateLimitWindowMs: 1000
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const sessionId = initialize.headers['mcp-session-id'];
        const headers = {
            ...createGatewayAuthHeaders(),
            'MCP-Session-Id': sessionId
        };

        const first = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 2,
            method: 'ping'
        }, { headers });
        const second = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 3,
            method: 'prompts/list'
        }, { headers });

        assert.equal(first.status, 200);
        assert.equal(second.status, 429);
        assert.equal(second.body.error.data.canonicalCode, 'AGW_RATE_LIMITED');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP refuses new sessions when the max session limit is reached', async () => {
    const fixture = await createFixture({
        maxSessions: 1
    });

    try {
        const first = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const second = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(2), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(first.status, 200);
        assert.equal(second.status, 503);
        assert.equal(second.body.error.data.reason, 'session_limit_reached');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP applies route-local payload limits', async () => {
    const fixture = await createFixture({
        maxPayloadBytes: 128
    });

    try {
        const response = await fetch(`${fixture.baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                ...createGatewayAuthHeaders(),
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    payload: 'x'.repeat(4096)
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 413);
        assert.equal(payload.error.data.canonicalCode, 'AGW_PAYLOAD_TOO_LARGE');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP fails cleanly when auth resolution times out', async () => {
    const fixture = await createFixture({
        authTimeoutMs: 20,
        resolveAuth: () => new Promise((resolve) => {
            setTimeout(() => {
                resolve({
                    provided: true,
                    authenticated: true,
                    gatewayId: 'slow-auth'
                });
            }, 100);
        })
    });

    try {
        const response = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(response.status, 504);
        assert.equal(response.body.error.data.canonicalCode, 'AGW_TIMEOUT');
        assert.equal(response.body.error.data.reason, 'auth_timeout');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP destroys a newly created session when initialize fails', async () => {
    let shouldFailInitialize = true;
    const fixture = await createFixture({
        harnessOverrides: {
            async handleRequest(request) {
                if (request.method === 'initialize' && shouldFailInitialize) {
                    shouldFailInitialize = false;
                    throw new Error('initialize failed');
                }
                return {
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {
                        method: request.method
                    }
                };
            }
        },
        maxSessions: 1
    });

    try {
        const firstAttempt = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(firstAttempt.status, 500);
        assert.equal(firstAttempt.headers['mcp-session-id'], undefined);
        assert.equal(fixture.httpManager.getSessionCount(), 0);

        const secondAttempt = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(2), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(secondAttempt.status, 200);
        assert.equal(typeof secondAttempt.headers['mcp-session-id'], 'string');
        assert.equal(fixture.httpManager.getSessionCount(), 1);
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP aborts in-flight harness work when the session is deleted', async () => {
    let aborted = false;
    const fixture = await createFixture({
        harnessOverrides: {
            async handleRequest(request) {
                if (request.method === 'slow') {
                    return new Promise((_resolve, reject) => {
                        request.params.signal.addEventListener('abort', () => {
                            aborted = true;
                            reject(new Error('aborted'));
                        }, { once: true });
                    });
                }
                return {
                    jsonrpc: '2.0',
                    id: request.id ?? null,
                    result: {
                        method: request.method
                    }
                };
            }
        }
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const sessionId = initialize.headers['mcp-session-id'];
        const headers = {
            ...createGatewayAuthHeaders(),
            'MCP-Session-Id': sessionId
        };

        const slowRequestPromise = postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 2,
            method: 'slow'
        }, { headers });

        await new Promise((resolve) => setTimeout(resolve, 25));
        const deleted = await deleteRequest(`${fixture.baseUrl}/mcp`, { headers });
        const slowResponse = await slowRequestPromise;

        assert.equal(deleted.status, 204);
        assert.equal(slowResponse.status, 500);
        assert.equal(aborted, true);
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE companion requests inject distinct abort signals under concurrency', async () => {
    let resolveRuntime = null;
    const signalStates = [];
    const pendingRequests = new Map();
    const runtimePromise = new Promise((resolve) => {
        resolveRuntime = resolve;
    });
    const harness = {
        async handleRequest(request) {
            return new Promise((resolve, reject) => {
                const entry = {
                    id: request.id,
                    signal: request.params.signal
                };
                signalStates.push(entry);
                pendingRequests.set(request.id, { resolve, reject });
                request.params.signal.addEventListener('abort', () => {
                    reject(new Error('aborted'));
                }, { once: true });
            });
        }
    };
    const fixture = await createFixture({
        useStubHarness: false,
        harness,
        initializeRuntime: async () => runtimePromise,
        shutdownRuntime: async () => {},
        enableWebSocket: false
    });

    try {
        const stream = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            const sessionId = stream.headers['mcp-session-id'];
            await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'endpoint');
            const headers = {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': sessionId
            };
            const target = new URL(`${fixture.baseUrl}/mcp/sse/messages`);
            const firstRequest = http.request({
                method: 'POST',
                hostname: target.hostname,
                port: target.port,
                path: target.pathname,
                headers: {
                    'content-type': 'application/json',
                    ...headers
                }
            });
            const firstRequestClosed = once(firstRequest, 'close').catch(() => {});
            firstRequest.on('error', () => {});
            firstRequest.end(JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'observe-signal'
            }));
            const secondRequest = fetch(`${fixture.baseUrl}/mcp/sse/messages`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...headers
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'observe-signal'
                })
            }).then(readJsonResponse);

            await new Promise((resolve) => setTimeout(resolve, 25));
            resolveRuntime({ harness });
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out waiting for concurrent signal capture'));
                }, 250);
                const poll = () => {
                    if (signalStates.length >= 2) {
                        clearTimeout(timeout);
                        resolve();
                        return;
                    }
                    setTimeout(poll, 5);
                };
                poll();
            });

            assert.equal(signalStates.length, 2);
            const firstSignal = signalStates.find((entry) => entry.id === 2)?.signal;
            const secondSignal = signalStates.find((entry) => entry.id === 3)?.signal;

            assert.ok(firstSignal);
            assert.ok(secondSignal);
            assert.notEqual(firstSignal, secondSignal);

            pendingRequests.get(2)?.resolve({
                jsonrpc: '2.0',
                id: 2,
                result: {
                    method: 'observe-signal'
                }
            });
            pendingRequests.get(3)?.resolve({
                jsonrpc: '2.0',
                id: 3,
                result: {
                    method: 'observe-signal'
                }
            });
            await firstRequestClosed;
            const secondResponse = await secondRequest;
            assert.equal(secondResponse.status, 202);
            const secondMessage = await stream.waitFor(
                (frame) => frame.kind === 'event' && frame.event === 'message' && frame.data.id === 3
            );
            assert.equal(secondMessage.data.result.method, 'observe-signal');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP rejects session ownership mismatches', async () => {
    const fixture = await createFixture({
        resolveAuth({ headers }) {
            return {
                provided: true,
                authenticated: headers.authorization === 'Bearer test-token',
                gatewayId: String(headers['x-test-gateway-id'] || ''),
                authSource: 'bearer-token',
                authMode: 'bearer'
            };
        }
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: {
                authorization: 'Bearer test-token',
                'x-test-gateway-id': 'gateway-A'
            }
        });
        const sessionId = initialize.headers['mcp-session-id'];

        const response = await fetch(`${fixture.baseUrl}/mcp`, {
            headers: {
                authorization: 'Bearer test-token',
                'x-test-gateway-id': 'gateway-B',
                'MCP-Session-Id': sessionId
            }
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(payload.error.data.reason, 'session_owner_mismatch');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP coexists with websocket /mcp upgrades on the same HTTP server', async () => {
    const fixture = await createFixture();

    try {
        const httpInitialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        assert.equal(httpInitialize.status, 200);

        const client = await connectWebSocket(fixture.wsUrl, createGatewayAuthHeaders());
        try {
            client.send(JSON.stringify(createInitializePayload(2)));
            const wsResponse = await waitForWebSocketMessage(client);
            assert.equal(wsResponse.id, 2);
            assert.equal(wsResponse.result.method, 'initialize');
        } finally {
            client.terminate();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('streamable HTTP proxies real backend prompt and tool surfaces', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createRenderPluginManager(agentDir);
    const nativeServer = await createNativeServer(pluginManager);
    const fixture = await createFixture({
        useStubHarness: false,
        enableWebSocket: false,
        pluginManager,
        backendUrl: nativeServer.baseUrl,
        defaultAgentId: 'Ariadne'
    });

    try {
        const initialize = await postJson(`${fixture.baseUrl}/mcp`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });
        const sessionId = initialize.headers['mcp-session-id'];
        const headers = {
            ...createGatewayAuthHeaders(),
            'MCP-Session-Id': sessionId
        };

        const prompts = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 2,
            method: 'prompts/list'
        }, { headers });
        const tools = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/list'
        }, { headers });
        const promptGet = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 4,
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Nova'
                    }
                }
            }
        }, { headers });
        const toolCall = await postJson(`${fixture.baseUrl}/mcp`, {
            jsonrpc: '2.0',
            id: 5,
            method: 'tools/call',
            params: {
                name: 'gateway_agent_bootstrap',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Nova'
                    }
                }
            }
        }, { headers });

        assert.deepEqual(prompts.body.result.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
        assert.equal(tools.body.result.tools.some((tool) => tool.name === 'gateway_agent_bootstrap'), true);
        assert.equal(promptGet.body.result.messages[0].content[0].text.includes('Hello Nova'), true);
        assert.equal(toolCall.body.result.structuredContent.result.renderedPrompt.includes('Hello Nova'), true);
    } finally {
        await fixture.close();
        await nativeServer.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility GET /mcp/sse creates a session and publishes the deprecated endpoint event', async () => {
    const fixture = await createFixture({
        heartbeatIntervalMs: 25
    });

    try {
        const stream = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            assert.equal(stream.statusCode, 200);
            assert.equal(typeof stream.headers['mcp-session-id'], 'string');
            const endpoint = await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'endpoint');
            assert.equal(endpoint.data.endpoint, '/mcp/sse/messages');
            assert.equal(endpoint.data.deprecated, true);
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility stream emits heartbeats while the session is live', async () => {
    const fixture = await createFixture({
        heartbeatIntervalMs: 25
    });

    try {
        const stream = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'endpoint');
            const heartbeat = await stream.waitFor((frame) => frame.kind === 'comment' && frame.comment.startsWith('heartbeat'));
            assert.equal(heartbeat.kind, 'comment');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility companion POST streams initialize responses back to the stream', async () => {
    const fixture = await createFixture();

    try {
        const stream = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            const endpoint = await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'endpoint');
            const sessionId = stream.headers['mcp-session-id'];

            const response = await postJson(`${fixture.baseUrl}${endpoint.data.endpoint}`, createInitializePayload(1), {
                headers: {
                    ...createGatewayAuthHeaders(),
                    'MCP-Session-Id': sessionId
                }
            });
            const message = await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'message' && frame.data.id === 1);

            assert.equal(response.status, 202);
            assert.equal(message.data.result.method, 'initialize');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility companion POST rejects missing session headers', async () => {
    const fixture = await createFixture();

    try {
        const response = await postJson(`${fixture.baseUrl}/mcp/sse/messages`, createInitializePayload(1), {
            headers: createGatewayAuthHeaders()
        });

        assert.equal(response.status, 400);
        assert.equal(response.body.error.data.reason, 'missing_session_header');
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility companion POST enforces per-session rate limits', async () => {
    const fixture = await createFixture({
        rateLimitMessages: 1,
        rateLimitWindowMs: 1000
    });

    try {
        const stream = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            const sessionId = stream.headers['mcp-session-id'];
            await stream.waitFor((frame) => frame.kind === 'event' && frame.event === 'endpoint');
            const headers = {
                ...createGatewayAuthHeaders(),
                'MCP-Session-Id': sessionId
            };

            const first = await postJson(`${fixture.baseUrl}/mcp/sse/messages`, createInitializePayload(1), { headers });
            const second = await postJson(`${fixture.baseUrl}/mcp/sse/messages`, {
                jsonrpc: '2.0',
                id: 2,
                method: 'prompts/list'
            }, { headers });

            assert.equal(first.status, 202);
            assert.equal(second.status, 429);
            assert.equal(second.body.error.data.canonicalCode, 'AGW_RATE_LIMITED');
        } finally {
            await stream.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);

test('SSE compatibility GET /mcp/sse honors the max session limit', async () => {
    const fixture = await createFixture({
        maxSessions: 1
    });

    try {
        const first = await openSseStream(`${fixture.baseUrl}/mcp/sse`, {
            headers: createGatewayAuthHeaders()
        });

        try {
            const second = await fetch(`${fixture.baseUrl}/mcp/sse`, {
                headers: createGatewayAuthHeaders()
            });
            const payload = await second.json();

            assert.equal(first.statusCode, 200);
            assert.equal(second.status, 503);
            assert.equal(payload.error.data.reason, 'session_limit_reached');
        } finally {
            await first.close();
        }
    } finally {
        await fixture.close();
    }
}, INTEGRATION_TEST_TIMEOUT_MS);
