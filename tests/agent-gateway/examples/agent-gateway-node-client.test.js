const assert = require('node:assert/strict');
const test = require('node:test');

const {
    AgentGatewayClient,
    AgentGatewayClientError
} = require('../../../examples/agent-gateway-node-client');

test('AgentGatewayClient sends governed auth headers and parses success envelopes', async () => {
    const requests = [];
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        gatewayKey: 'gw-secret',
        gatewayId: 'gw-prod',
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify({
                success: true,
                data: {
                    sections: ['tools', 'memory', 'context', 'jobs', 'events']
                },
                meta: {
                    requestId: 'req-cap-001',
                    durationMs: 2,
                    gatewayVersion: 'v1'
                }
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            });
        }
    });

    const payload = await client.getCapabilities({
        agentId: 'Ariadne',
        requestId: 'req-cap-001'
    });

    assert.equal(payload.success, true);
    assert.equal(payload.meta.gatewayVersion, 'v1');
    assert.equal(requests[0].url, 'http://localhost:3000/agent_gateway/capabilities?agentId=Ariadne&requestId=req-cap-001');
    assert.equal(requests[0].options.headers['x-agent-gateway-key'], 'gw-secret');
    assert.equal(requests[0].options.headers['x-agent-gateway-id'], 'gw-prod');
});

test('AgentGatewayClient converts canonical error envelopes into client errors', async () => {
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        gatewayKey: 'gw-secret',
        fetchImpl: async () => new Response(JSON.stringify({
            success: false,
            code: 'AGW_FORBIDDEN',
            error: 'Tool access denied by policy',
            details: {
                toolName: 'ProtectedTool'
            },
            meta: {
                requestId: 'req-tool-err-001',
                durationMs: 1,
                gatewayVersion: 'v1'
            }
        }), {
            status: 403,
            headers: {
                'content-type': 'application/json'
            }
        })
    });

    await assert.rejects(
        client.invokeTool('ProtectedTool', {
            args: { task: 'dangerous' },
            requestContext: {
                requestId: 'req-tool-err-001',
                agentId: 'Ariadne',
                runtime: 'native'
            }
        }),
        (error) => {
            assert.equal(error instanceof AgentGatewayClientError, true);
            assert.equal(error.status, 403);
            assert.equal(error.code, 'AGW_FORBIDDEN');
            assert.equal(error.details.toolName, 'ProtectedTool');
            return true;
        }
    );
});

test('AgentGatewayClient can prepare an SSE request for the published event stream', () => {
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        bearerToken: 'gw-secret',
        gatewayId: 'gw-prod',
        fetchImpl: async () => {
            throw new Error('fetch is not used in this test');
        }
    });

    const eventStreamRequest = client.createEventStreamRequest({
        agentId: 'Ariadne',
        sessionId: 'sess-001'
    });

    assert.equal(
        eventStreamRequest.url,
        'http://localhost:3000/agent_gateway/events/stream?agentId=Ariadne&sessionId=sess-001'
    );
    assert.equal(eventStreamRequest.headers.accept, 'text/event-stream');
    assert.equal(eventStreamRequest.headers.authorization, 'Bearer gw-secret');
    assert.equal(eventStreamRequest.headers['x-agent-gateway-id'], 'gw-prod');
});

test('AgentGatewayClient exposes canonical render and memory routes', async () => {
    const requests = [];
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify({
                success: true,
                data: {
                    ok: true
                },
                meta: {
                    requestId: 'req-coding-route-001',
                    durationMs: 1,
                    gatewayVersion: 'v1'
                }
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            });
        }
    });

    await client.renderAgent('Ariadne', {
        requestContext: {
            requestId: 'req-render-001'
        }
    });
    await client.writeMemory({
        diary: 'Nova',
        text: 'backend canonical memory write'
    });

    assert.equal(requests[0].url, 'http://localhost:3000/agent_gateway/agents/Ariadne/render');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[1].url, 'http://localhost:3000/agent_gateway/memory/write');
    assert.equal(requests[1].options.method, 'POST');
});

test('AgentGatewayClient runRecall sends POST to /agent_gateway/recall/run with auth headers', async () => {
    const requests = [];
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        gatewayKey: 'gw-secret',
        gatewayId: 'gw-prod',
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify({
                success: true,
                data: {
                    agentId: 'Ariadne',
                    profileName: 'default',
                    items: [
                        { content: 'recall item 1', score: 0.95, sourceDiary: 'Nova', sourceFile: '2026-03-20.md' }
                    ],
                    recallBlocks: [
                        { blockId: 'rb-0', content: 'recall item 1', score: 0.95, sourceDiary: 'Nova' }
                    ],
                    diagnostics: { totalDurationMs: 42, rules: [] }
                },
                meta: { requestId: 'req-recall-001', durationMs: 5 }
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });

    const payload = await client.runRecall({
        agentId: 'Ariadne',
        query: 'test recall query',
        profile: 'default'
    });

    assert.equal(payload.success, true);
    assert.equal(requests[0].url, 'http://localhost:3000/agent_gateway/recall/run');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.headers['x-agent-gateway-key'], 'gw-secret');
    assert.equal(requests[0].options.headers['x-agent-gateway-id'], 'gw-prod');
    assert.equal(requests[0].options.headers['content-type'], 'application/json');
    const requestBody = JSON.parse(requests[0].options.body);
    assert.equal(requestBody.agentId, 'Ariadne');
    assert.equal(requestBody.query, 'test recall query');
    assert.equal(requestBody.profile, 'default');
});

test('AgentGatewayClient runRecall maps AGW_RECALL_NO_PROFILE to AgentGatewayClientError', async () => {
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        fetchImpl: async () => new Response(JSON.stringify({
            success: false,
            code: 'AGW_RECALL_NO_PROFILE',
            error: 'No recall profile resolved for agent "Ariadne"',
            details: { agentId: 'Ariadne' },
            meta: { requestId: 'req-recall-err-001' }
        }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
        })
    });

    await assert.rejects(
        client.runRecall({ agentId: 'Ariadne', query: 'test' }),
        (error) => {
            assert.equal(error instanceof AgentGatewayClientError, true);
            assert.equal(error.status, 404);
            assert.equal(error.code, 'AGW_RECALL_NO_PROFILE');
            assert.equal(error.details.agentId, 'Ariadne');
            return true;
        }
    );
});

test('AgentGatewayClient runRecall payload round-trips items[] through the response envelope', async () => {
    const requests = [];
    const client = new AgentGatewayClient({
        baseUrl: 'http://localhost:3000',
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            return new Response(JSON.stringify({
                success: true,
                data: {
                    agentId: 'Ariadne',
                    profileName: 'custom-profile',
                    items: [
                        { content: 'item alpha', score: 0.91, sourceDiary: 'Nova', sourceFile: '2026-03-20.md', tags: ['test'] },
                        { content: 'item beta', score: 0.82, sourceDiary: 'ProjectAlpha', sourceFile: '2026-03-18.md', tags: ['release'] }
                    ],
                    recallBlocks: [
                        { blockId: 'rb-0', content: 'item alpha', score: 0.91, sourceDiary: 'Nova' },
                        { blockId: 'rb-1', content: 'item beta', score: 0.82, sourceDiary: 'ProjectAlpha' }
                    ],
                    diagnostics: {
                        totalDurationMs: 55,
                        rules: [{ ruleIndex: 0, type: 'rag', status: 'ok', durationMs: 30, itemCount: 2 }],
                        pipelineStages: [{ name: 'resolveProfile', durationMs: 5, status: 'ok' }],
                        profileMeta: { profileName: 'custom-profile', ruleCount: 1, modifierKeys: [] }
                    }
                },
                meta: { requestId: 'req-recall-002' }
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            });
        }
    });

    const payload = await client.runRecall({ agentId: 'Ariadne', query: 'round-trip test', profile: 'custom-profile' });

    assert.equal(payload.success, true);
    assert.equal(Array.isArray(payload.data.items), true);
    assert.equal(payload.data.items.length, 2);
    assert.equal(payload.data.items[0].content, 'item alpha');
    assert.equal(payload.data.items[1].content, 'item beta');
    assert.equal(payload.data.profileName, 'custom-profile');
    assert.equal(payload.data.diagnostics.totalDurationMs, 55);
    assert.equal(Array.isArray(payload.data.diagnostics.pipelineStages), true);
    assert.equal(payload.data.diagnostics.profileMeta.profileName, 'custom-profile');
});
