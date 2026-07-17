const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createBackendProxyMcpAdapter
} = require('../../../modules/agentGateway/adapters/mcpBackendProxyAdapter');

test('backend proxy adapter forwards gateway_recall_run to backendClient.runRecall', async () => {
    const calls = [];
    const adapter = createBackendProxyMcpAdapter({
        defaultAgentId: 'Ariadne',
        backendClient: {
            async runRecall(body, requestOptions) {
                calls.push({ body, requestOptions });
                return {
                    httpStatus: 200,
                    payload: {
                        success: true,
                        data: {
                            activeProjection: 'items',
                            items: [
                                {
                                    content: 'Recall result from backend proxy',
                                    score: 0.91,
                                    sourceDiary: 'Nova'
                                }
                            ],
                            diagnostics: {
                                totalDurationMs: 12,
                                rules: [],
                                pipelineStages: [],
                                profileMeta: {
                                    profileName: 'default'
                                }
                            }
                        },
                        meta: {
                            requestId: 'req-backend-recall-001'
                        }
                    }
                };
            }
        }
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'recall through backend proxy',
            profile: 'custom-profile'
        },
        requestContext: {
            requestId: 'req-mcp-backend-recall-001'
        }
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
        agentId: 'Ariadne',
        query: 'recall through backend proxy',
        profile: 'custom-profile',
        requestContext: {
            requestId: 'req-mcp-backend-recall-001',
            agentId: 'Ariadne',
            sessionId: 'mcp-session'
        }
    });
    assert.equal(result.isError, false);
    assert.equal(result.status, 'completed');
    assert.equal(result.structuredContent.toolName, 'gateway_recall_run');
    assert.equal(result.structuredContent.requestId, 'req-backend-recall-001');
    assert.equal(result.structuredContent.result.activeProjection, 'items');
    assert.equal(result.structuredContent.result.items[0].content, 'Recall result from backend proxy');
});

test('backend proxy adapter preserves canonical recall error categories', async () => {
    const expectations = [
        ['AGW_RECALL_NO_PROFILE', 'MCP_NOT_FOUND', 404],
        ['AGW_RECALL_FORBIDDEN', 'MCP_FORBIDDEN', 403],
        ['AGW_RECALL_INVALID_RULE', 'MCP_INVALID_ARGUMENTS', 400],
        ['AGW_RECALL_EXECUTION_ERROR', 'MCP_RUNTIME_ERROR', 500]
    ];

    for (const [gatewayCode, mcpCode, httpStatus] of expectations) {
        const adapter = createBackendProxyMcpAdapter({
            defaultAgentId: 'Ariadne',
            backendClient: {
                async runRecall() {
                    return {
                        httpStatus,
                        payload: {
                            success: false,
                            code: gatewayCode,
                            error: 'recall failed',
                            meta: { requestId: `req-${gatewayCode}` }
                        }
                    };
                }
            }
        });

        const result = await adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { agentId: 'Ariadne', query: 'test recall error mapping' }
        });

        assert.equal(result.isError, true);
        assert.equal(result.error.code, mcpCode);
        assert.equal(result.error.details.canonicalCode, gatewayCode);
    }
});
