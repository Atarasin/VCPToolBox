const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createMcpAdapter
} = require('../../../modules/agentGateway/adapters/mcpAdapter');
const {
    getGatewayServiceBundle
} = require('../../../modules/agentGateway/createGatewayServiceBundle');
const {
    AGW_ERROR_CODES
} = require('../../../modules/agentGateway/contracts/errorCodes');
const {
    createRecallProjectionService
} = require('../../../modules/agentGateway/services/recallProjectionService');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

function createMockRecallRuntimeService(overrides = {}) {
    return {
        async executeRecall(args) {
            const { agentId, profileName } = args;
            if (overrides.executeRecall) {
                return overrides.executeRecall(args);
            }

            return {
                success: true,
                agentId: agentId || null,
                profileName: profileName || 'default',
                items: [
                    {
                        text: 'Recall result for test query',
                        score: 0.95,
                        sourceDiary: 'Nova',
                        sourceFile: '2026-03-20.md',
                        timestamp: '2026-03-20T10:20:00.000Z',
                        tags: ['test', 'recall']
                    }
                ],
                diagnostics: {
                    totalDurationMs: 42,
                    rules: [
                        {
                            ruleIndex: 0,
                            type: 'rag',
                            status: 'ok',
                            durationMs: 30,
                            itemCount: 1
                        }
                    ],
                    pipelineStages: [
                        { name: 'resolveProfile', durationMs: 5, status: 'ok' },
                        { name: 'precomputeVector', durationMs: 7, status: 'ok' }
                    ],
                    profileMeta: {
                        profileName: profileName || 'default',
                        ruleCount: 1,
                        modifierKeys: []
                    }
                },
                error: null,
                code: null,
                status: 200
            };
        }
    };
}

function createMockRecallProjectionService(overrides = {}) {
    const projectionService = createRecallProjectionService();
    return {
        projectFullResult(result, requestId) {
            if (overrides.projectFullResult) {
                return overrides.projectFullResult(result, requestId);
            }
            return projectionService.projectFullResult(result, requestId);
        }
    };
}

function createRecallPluginManager(overrides = {}) {
    const pluginManager = createPluginManager(overrides);
    const bundle = getGatewayServiceBundle(pluginManager);

    bundle.recallRuntimeService = createMockRecallRuntimeService(overrides.recallRuntime);
    bundle.recallProjectionService = createMockRecallProjectionService(overrides.recallProjection);

    return pluginManager;
}

test('gateway_recall_run tools/call returns success with items[], recallBlocks[], diagnostics shape', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-001',
        requestContext: {
            requestId: 'req-mcp-recall-run-001'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.status, 'completed');
    assert.equal(result.structuredContent.toolName, 'gateway_recall_run');
    assert.equal(result.structuredContent.requestId, 'req-mcp-recall-run-001');
    assert.equal(Array.isArray(result.structuredContent.result.items), true);
    assert.equal(result.structuredContent.result.items.length > 0, true);
    assert.equal(result.structuredContent.result.activeProjection, 'items');
    assert.equal(typeof result.structuredContent.result.items[0].content, 'string');
    assert.equal(typeof result.structuredContent.result.items[0].score, 'number');
    assert.equal(typeof result.structuredContent.result.items[0].sourceDiary, 'string');
    assert.equal(Array.isArray(result.structuredContent.result.recallBlocks), true);
    assert.equal(result.structuredContent.result.recallBlocks.length > 0, true);
    assert.equal(Array.isArray(result.structuredContent.result.fullTextSections), true);
    assert.equal(typeof result.structuredContent.result.recallBlocks[0].blockId, 'string');
    assert.equal(typeof result.structuredContent.result.recallBlocks[0].content, 'string');
    assert.equal(typeof result.structuredContent.result.recallBlocks[0].score, 'number');
    assert.equal(typeof result.structuredContent.result.diagnostics, 'object');
    assert.equal(typeof result.structuredContent.result.diagnostics.totalDurationMs, 'number');
    assert.equal(Array.isArray(result.structuredContent.result.diagnostics.rules), true);
    assert.match(result.structuredContent.operability.traceId, /^agwop_/);
    assert.equal(result.structuredContent.operability.operationName, 'recall.run');
});

test('gateway_recall_run surfaces fullTextSections for full_text projection', async () => {
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async ({ agentId, query, profileName }) => ({
                success: true,
                agentId: agentId || null,
                profileName: profileName || 'fulltext-profile',
                items: [
                    {
                        text: 'Full text result for test query',
                        score: 0.95,
                        sourceDiary: 'Nova',
                        sourceFile: '2026-03-20.md',
                        timestamp: '2026-03-20T10:20:00.000Z',
                        tags: ['test', 'fulltext']
                    }
                ],
                diagnostics: {
                    totalDurationMs: 42,
                    rules: [
                        {
                            ruleIndex: 0,
                            type: 'full_text',
                            status: 'ok',
                            durationMs: 30,
                            itemCount: 1
                        }
                    ],
                    profileMeta: {
                        profileName: profileName || 'fulltext-profile',
                        ruleCount: 1,
                        modifierKeys: [],
                        projection: 'full'
                    }
                },
                error: null,
                code: null,
                status: 200
            })
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query',
            profile: 'fulltext-profile'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-fulltext',
        requestContext: {
            requestId: 'req-mcp-recall-run-fulltext'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.result.activeProjection, 'fullTextSections');
    assert.equal(result.structuredContent.result.fullTextSections.length, 1);
    assert.equal(result.structuredContent.result.fullTextSections[0].diaryName, 'Nova');
});

test('gateway_recall_run forwards authContext and messages to executeRecall', async () => {
    let receivedArgs = null;
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async (args) => {
                receivedArgs = args;
                return {
                    success: true,
                    agentId: args.agentId || null,
                    profileName: 'default',
                    items: [],
                    diagnostics: {
                        totalDurationMs: 1,
                        rules: [],
                        pipelineStages: [],
                        profileMeta: {
                            profileName: 'default',
                            ruleCount: 0,
                            modifierKeys: []
                        }
                    },
                    status: 200
                };
            }
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query',
            messages: [
                { role: 'user', content: 'U1' },
                { role: 'assistant', content: 'A1' }
            ],
            authContext: {
                agentId: 'Ariadne',
                sessionId: 'sess-mcp-recall-run-forwarded-auth'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-forwarded',
        requestContext: {
            requestId: 'req-mcp-recall-run-forwarded'
        }
    });

    assert.equal(result.isError, false);
    assert.ok(receivedArgs);
    assert.deepStrictEqual(receivedArgs.messages, [
        { role: 'user', content: 'U1' },
        { role: 'assistant', content: 'A1' }
    ]);
    assert.equal(receivedArgs.authContext.agentId, 'Ariadne');
    assert.equal(receivedArgs.requestContext.requestId, 'req-mcp-recall-run-forwarded');
    assert.strictEqual(receivedArgs.agentPolicyResolver, bundle.agentPolicyResolver);
});

test('gateway_recall_run missing agentId returns MCP error', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    await assert.rejects(
        () => adapter.callTool({
            name: 'gateway_recall_run',
            arguments: {
                query: 'test recall query'
            },
            sessionId: 'sess-mcp-recall-run-no-agent',
            requestContext: {
                requestId: 'req-mcp-recall-run-no-agent'
            }
        }),
        (error) => error && error.code === 'MCP_INVALID_REQUEST'
    );
});

test('gateway_recall_run missing query returns MCP error', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-no-query',
        requestContext: {
            requestId: 'req-mcp-recall-run-no-query'
        }
    });

    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(result.error.details.canonicalCode, 'AGW_VALIDATION_ERROR');
});

test('gateway_recall_run non-existent profile returns MCP error with RECALL_NO_PROFILE code', async () => {
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async ({ agentId, query, profileName }) => ({
                success: false,
                agentId: agentId || null,
                profileName: profileName || null,
                items: [],
                diagnostics: {
                    totalDurationMs: 5,
                    rules: []
                },
                error: `No recall profile resolved for agent "${agentId}"`,
                code: AGW_ERROR_CODES.RECALL_NO_PROFILE,
                status: 404
            })
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query',
            profile: 'nonexistent-profile'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-bad-profile',
        requestContext: {
            requestId: 'req-mcp-recall-run-bad-profile'
        }
    });

    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'MCP_NOT_FOUND');
    assert.equal(result.error.details.canonicalCode, 'AGW_RECALL_NO_PROFILE');
    assert.equal(result.error.details.gatewayCode, 'AGW_RECALL_NO_PROFILE');
});

test('gateway_recall_run empty query (whitespace-only) returns MCP_INVALID_ARGUMENTS', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: '   '
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-empty-query',
        requestContext: {
            requestId: 'req-mcp-recall-run-empty-query'
        }
    });

    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(result.error.details.canonicalCode, 'AGW_VALIDATION_ERROR');
    assert.equal(result.error.details.gatewayCode, 'AGW_VALIDATION_ERROR');
    assert.match(result.error.message, /query is required/);
});

test('gateway_recall_run execution error returns MCP_RUNTIME_ERROR with AGW_RECALL_EXECUTION_ERROR', async () => {
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async ({ agentId, query, profileName }) => ({
                success: false,
                agentId: agentId || null,
                profileName: profileName || null,
                items: [],
                diagnostics: { totalDurationMs: 10, rules: [] },
                error: 'Vector search failed: index unreachable',
                code: AGW_ERROR_CODES.RECALL_EXECUTION_ERROR,
                status: 500
            })
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-exec-err',
        requestContext: {
            requestId: 'req-mcp-recall-run-exec-err'
        }
    });

    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'MCP_RUNTIME_ERROR');
    assert.equal(result.error.details.canonicalCode, 'AGW_RECALL_EXECUTION_ERROR');
    assert.equal(result.error.details.gatewayCode, 'AGW_RECALL_EXECUTION_ERROR');
    assert.match(result.error.message, /Vector search failed/);
});

test('gateway_recall_run forbidden access returns MCP_FORBIDDEN with AGW_RECALL_FORBIDDEN', async () => {
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async ({ agentId, query, profileName }) => ({
                success: false,
                agentId: agentId || null,
                profileName: profileName || null,
                items: [],
                diagnostics: { totalDurationMs: 3, rules: [] },
                error: 'Recall access denied for this agent',
                code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
                status: 403
            })
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-forbidden',
        requestContext: {
            requestId: 'req-mcp-recall-run-forbidden'
        }
    });

    assert.equal(result.isError, true);
    assert.equal(result.error.code, 'MCP_FORBIDDEN');
    assert.equal(result.error.details.canonicalCode, 'AGW_RECALL_FORBIDDEN');
    assert.equal(result.error.details.gatewayCode, 'AGW_RECALL_FORBIDDEN');
});

test('gateway_recall_run with explicit profile parameter forwards profile to executeRecall and returns success', async () => {
    let capturedProfileName = null;
    const pluginManager = createRecallPluginManager({
        recallRuntime: {
            executeRecall: async ({ agentId, query, profileName }) => {
                capturedProfileName = profileName;
                return {
                    success: true,
                    agentId: agentId || null,
                    profileName: profileName || 'default',
                    items: [
                        {
                            text: `Recall result for profile ${profileName}`,
                            score: 0.88,
                            sourceDiary: 'Nova',
                            sourceFile: '2026-03-20.md',
                            timestamp: '2026-03-20T10:20:00.000Z',
                            tags: ['test', 'recall']
                        }
                    ],
                    diagnostics: {
                        totalDurationMs: 42,
                        rules: [{ ruleIndex: 0, type: 'rag', status: 'ok', durationMs: 30, itemCount: 1 }],
                        pipelineStages: [{ name: 'resolveProfile', durationMs: 5, status: 'ok' }],
                        profileMeta: { profileName: profileName || 'default', ruleCount: 1, modifierKeys: [] }
                    },
                    error: null,
                    code: null,
                    status: 200
                };
            }
        }
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query',
            profile: 'custom-profile'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-profile',
        requestContext: {
            requestId: 'req-mcp-recall-run-profile'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.status, 'completed');
    assert.equal(capturedProfileName, 'custom-profile');
    assert.equal(result.structuredContent.result.profileName, 'custom-profile');
    assert.equal(result.structuredContent.result.items[0].content, 'Recall result for profile custom-profile');
});

test('gateway_recall_run tools/list includes RECALL_RUN descriptor with correct schema', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.listTools({ agentId: 'Ariadne' });
    const recallTool = result.tools.find((tool) => tool.name === 'gateway_recall_run');

    assert.ok(recallTool, 'Expected gateway_recall_run to be present in tools list');
    assert.equal(recallTool.name, 'gateway_recall_run');
    assert.equal(typeof recallTool.description, 'string');
    assert.ok(recallTool.description.includes('recall'), 'Description should mention recall');
    // agentId 必填：4a65ab35「强制显式传入 agentId，移除自动兜底逻辑」推翻了
    // M3.S1 的 optional 化，绑定 credential 只做一致性校验、不再补全缺失的
    // agentId（见 backendProxyExecutor.resolveDirectAgentTarget 注释）。
    assert.deepStrictEqual(recallTool.inputSchema.required, ['agentId', 'query']);
    assert.equal(recallTool.inputSchema.properties.agentId.type, 'string');
    assert.equal(recallTool.inputSchema.properties.query.type, 'string');
    assert.equal(recallTool.inputSchema.properties.profile.type, 'string');
});

test('gateway_recall_run full diagnostics shape includes pipelineStages and profileMeta', async () => {
    const pluginManager = createRecallPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });

    const result = await adapter.callTool({
        name: 'gateway_recall_run',
        arguments: {
            agentId: 'Ariadne',
            query: 'test recall query'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-recall-run-diagnostics',
        requestContext: {
            requestId: 'req-mcp-recall-run-diagnostics'
        }
    });

    assert.equal(result.isError, false);
    const diagnostics = result.structuredContent.result.diagnostics;
    assert.equal(typeof diagnostics.totalDurationMs, 'number');
    assert.equal(Array.isArray(diagnostics.rules), true);
    assert.equal(Array.isArray(diagnostics.pipelineStages), true);
    assert.equal(diagnostics.pipelineStages.length > 0, true);
    assert.equal(typeof diagnostics.pipelineStages[0].name, 'string');
    assert.equal(typeof diagnostics.pipelineStages[0].durationMs, 'number');
    assert.equal(typeof diagnostics.pipelineStages[0].status, 'string');
    assert.equal(typeof diagnostics.profileMeta, 'object');
    assert.equal(typeof diagnostics.profileMeta.profileName, 'string');
    assert.equal(typeof diagnostics.profileMeta.ruleCount, 'number');
    assert.equal(Array.isArray(diagnostics.profileMeta.modifierKeys), true);
});
