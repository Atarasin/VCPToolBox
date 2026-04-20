const assert = require('node:assert/strict');
const test = require('node:test');

const {
    AgentGatewayClient,
    AgentGatewayClientError
} = require('../examples/agent-gateway-node-client');

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

test('AgentGatewayClient exposes canonical coding recall and writeback routes', async () => {
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

    await client.recallForCoding({
        task: {
            description: 'continue coding recall'
        }
    });
    await client.commitMemoryForCoding({
        task: {
            description: 'commit coding writeback'
        },
        summary: 'backend-only proxy'
    });

    assert.equal(requests[0].url, 'http://localhost:3000/agent_gateway/coding/recall');
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[1].url, 'http://localhost:3000/agent_gateway/coding/memory-writeback');
    assert.equal(requests[1].options.method, 'POST');
});
