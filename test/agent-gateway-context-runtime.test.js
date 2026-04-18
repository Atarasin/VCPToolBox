const assert = require('node:assert/strict');
const test = require('node:test');

const { createContextRuntimeService } = require('../modules/agentGateway/services/contextRuntimeService');
const {
    createKnowledgeBaseManager,
    createPluginManager,
    createRagPlugin
} = require('./helpers/agent-gateway-test-helpers');

test('ContextRuntimeService search returns normalized items and diagnostics', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const service = createContextRuntimeService({ pluginManager });

    const result = await service.search({
        body: {
            query: '上周项目会议讨论了什么',
            diary: 'Nova',
            k: 3,
            options: {
                timeAware: true,
                groupAware: true,
                rerank: true,
                tagMemo: true
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.nova',
                sessionId: 'sess-memory-001',
                requestId: 'req-memory-001'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, true);
    assert.equal(result.data.items.length, 1);
    assert.equal(result.data.items[0].sourceDiary, 'Nova');
    assert.equal(result.data.items[0].sourceFile, '2026-03-20.md');
    assert.deepEqual(result.data.items[0].tags, ['项目', '会议', '桥接']);
    assert.deepEqual(result.data.diagnostics.targetDiaries, ['Nova']);
    assert.equal(result.data.diagnostics.timeAwareApplied, true);
    assert.equal(result.data.diagnostics.groupAwareApplied, true);
    assert.equal(result.data.diagnostics.rerankApplied, true);
    assert.equal(result.data.diagnostics.tagMemoApplied, true);
    assert.deepEqual(result.data.diagnostics.coreTags, ['项目', '会议']);
});

test('ContextRuntimeService builds recall blocks from recent messages and token budget', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            searchResults: {
                Nova: [
                    {
                        text: '这是一个非常长的上下文片段这是一个非常长的上下文片段这是一个非常长的上下文片段',
                        score: 0.93,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    }
                ]
            }
        })
    });
    const service = createContextRuntimeService({ pluginManager });

    const result = await service.buildRecallContext({
        body: {
            recentMessages: [
                {
                    role: 'user',
                    content: '帮我回忆一下上周项目会议的关键结论'
                }
            ],
            tokenBudget: 10,
            maxTokenRatio: 0.5,
            maxBlocks: 2,
            requestContext: {
                source: 'openclaw-context',
                agentId: 'agent.nova',
                sessionId: 'sess-context-002',
                requestId: 'req-context-002'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw-context'
    });

    assert.equal(result.success, true);
    assert.equal(result.data.recallBlocks.length, 1);
    assert.equal(result.data.recallBlocks[0].metadata.sourceDiary, 'Nova');
    assert.equal(result.data.recallBlocks[0].metadata.truncated, true);
    assert.equal(result.data.estimatedTokens <= 5, true);
    assert.equal(result.data.appliedPolicy.maxInjectedTokens, 5);
});

test('ContextRuntimeService rejects forbidden diary access and invalid query', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        },
        ragPlugin: createRagPlugin()
    });
    const service = createContextRuntimeService({ pluginManager });

    const forbiddenResult = await service.search({
        body: {
            query: 'Project Alpha 的部署失败原因',
            diary: 'ProjectAlpha',
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.nova',
                sessionId: 'sess-memory-003',
                requestId: 'req-memory-003'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });
    const invalidResult = await service.buildRecallContext({
        body: {
            requestContext: {
                source: 'openclaw-context',
                agentId: 'agent.nova',
                sessionId: 'sess-context-003',
                requestId: 'req-context-003'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw-context'
    });

    assert.equal(forbiddenResult.success, false);
    assert.equal(forbiddenResult.status, 403);
    assert.equal(forbiddenResult.code, 'OCW_RAG_TARGET_FORBIDDEN');
    assert.equal(invalidResult.success, false);
    assert.equal(invalidResult.status, 400);
    assert.equal(invalidResult.code, 'OCW_RAG_INVALID_QUERY');
});
