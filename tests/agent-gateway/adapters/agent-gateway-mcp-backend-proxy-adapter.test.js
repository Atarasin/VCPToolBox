const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('backend proxy adapter validates recall query before backend dispatch', async () => {
    let callCount = 0;
    const adapter = createBackendProxyMcpAdapter({
        defaultAgentId: 'Ariadne',
        backendClient: {
            async runRecall() {
                callCount += 1;
            }
        }
    });

    await assert.rejects(
        adapter.callTool({
            name: 'gateway_recall_run',
            arguments: { query: '   ' }
        }),
        (error) => error.code === 'MCP_INVALID_ARGUMENTS' && error.details.field === 'query'
    );
    assert.equal(callCount, 0);
});

test('backend proxy adapter merges memory write idempotency sources', async () => {
    const calls = [];
    const adapter = createBackendProxyMcpAdapter({
        defaultAgentId: 'Ariadne',
        backendClient: {
            async writeMemory(body) {
                calls.push(body);
                return {
                    httpStatus: 200,
                    payload: {
                        success: true,
                        data: { entryId: 'entry-1' },
                        meta: { requestId: 'req-write-1' }
                    }
                };
            }
        }
    });

    await adapter.callTool({
        name: 'gateway_memory_write',
        arguments: {
            diary: 'Nova日记本',
            content: 'test',
            target: { idempotencyKey: 'idem-target-1' }
        }
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].diary, 'Nova');
    assert.equal(calls[0].idempotencyKey, 'idem-target-1');
    assert.equal(calls[0].options.idempotencyKey, 'idem-target-1');
});

test('backend proxy diary policy uses the configured default agent and returns status 403', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-proxy-policy-'));
    const policyPath = path.join(tempDir, 'policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
        agents: {
            EnvAgent: {
                allowedDiaries: ['Nova'],
                defaultDiaries: ['Nova']
            }
        }
    }));
    const previousPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;
    const previousDefaultAgent = process.env.VCP_MCP_DEFAULT_AGENT_ID;

    try {
        process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
        process.env.VCP_MCP_DEFAULT_AGENT_ID = 'EnvAgent';
        const calls = [];
        const adapter = createBackendProxyMcpAdapter({
            backendClient: {
                async searchMemory(body) {
                    calls.push(body);
                    return {
                        httpStatus: 200,
                        payload: {
                            success: true,
                            data: { items: [] },
                            meta: { requestId: 'req-search-1' }
                        }
                    };
                }
            }
        });

        await adapter.callTool({
            name: 'gateway_memory_search',
            arguments: { query: 'default diary' }
        });
        const forbidden = await adapter.callTool({
            name: 'gateway_memory_search',
            arguments: { query: 'forbidden diary', diary: 'Secret' }
        });

        assert.equal(calls[0].requestContext.agentId, 'EnvAgent');
        assert.deepEqual(calls[0].diaries, ['Nova']);
        assert.equal(calls[0].__defaultDiaryPolicyApplied, undefined);
        assert.equal(forbidden.isError, true);
        assert.equal(forbidden.error.details.gatewayStatus, 403);
    } finally {
        if (typeof previousPolicyPath === 'string') process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousPolicyPath;
        else delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        if (typeof previousDefaultAgent === 'string') process.env.VCP_MCP_DEFAULT_AGENT_ID = previousDefaultAgent;
        else delete process.env.VCP_MCP_DEFAULT_AGENT_ID;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
