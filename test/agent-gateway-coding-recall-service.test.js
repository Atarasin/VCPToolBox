const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createContextRuntimeService
} = require('../modules/agentGateway/services/contextRuntimeService');
const {
    createCodingRecallService
} = require('../modules/agentGateway/services/codingRecallService');
const {
    createKnowledgeBaseManager,
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

function createCodingRecallPluginManager() {
    return createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    Ariadne: ['Nova']
                },
                allowCrossRoleAccess: false
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            metadataByPath: {
                'Nova/2026-03-20.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-20.md',
                    updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
                    tags: ['repo:vcp-toolbox', 'gateway', 'coding']
                },
                'Nova/2026-03-21.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-21.md',
                    updatedAt: Date.parse('2026-03-21T10:20:00.000Z'),
                    tags: ['repo:other-project', 'deploy']
                }
            },
            searchResults: {
                Nova: [
                    {
                        text: 'VCPToolBox 最近完成了 gateway coding recall contract 收口。',
                        score: 0.951,
                        fullPath: 'Nova/2026-03-20.md'
                    },
                    {
                        text: 'OtherProject 发布回滚记录，需要补环境变量。',
                        score: 0.882,
                        fullPath: 'Nova/2026-03-21.md'
                    }
                ]
            }
        })
    });
}

test('CodingRecallService derives deterministic coding query and applies repository-aware scope', async () => {
    const pluginManager = createCodingRecallPluginManager();
    const service = createCodingRecallService({
        contextRuntimeService: createContextRuntimeService({ pluginManager })
    });

    const result = await service.recallForCoding({
        body: {
            task: {
                description: '继续实现 gateway coding recall'
            },
            repository: {
                repositoryId: 'vcp-toolbox',
                tags: ['repo:vcp-toolbox']
            },
            files: ['modules/agentGateway/adapters/mcpAdapter.js'],
            symbols: ['createMcpAdapter'],
            requestContext: {
                requestId: 'req-coding-recall-service-success',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-recall-service-success'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-recall-service-test'
    });

    assert.equal(result.success, true);
    assert.equal(result.requestId, 'req-coding-recall-service-success');
    assert.equal(result.data.query.includes('Task: 继续实现 gateway coding recall'), true);
    assert.equal(result.data.query.includes('Files: modules/agentGateway/adapters/mcpAdapter.js'), true);
    assert.equal(result.data.query.includes('Symbols: createMcpAdapter'), true);
    assert.equal(result.data.scope.mode, 'repository_terms');
    assert.equal(result.data.scope.matchCount, 1);
    assert.equal(result.data.scope.widened, false);
    assert.equal(result.data.recallBlocks.length, 1);
    assert.equal(result.data.recallBlocks[0].metadata.tags.includes('repo:vcp-toolbox'), true);
    assert.equal(result.data.codingContext.includes('VCPToolBox 最近完成了 gateway coding recall contract 收口'), true);
});

test('CodingRecallService does not silently widen repository-scoped requests when no repository memory matches', async () => {
    const pluginManager = createCodingRecallPluginManager();
    const service = createCodingRecallService({
        contextRuntimeService: createContextRuntimeService({ pluginManager })
    });

    const result = await service.recallForCoding({
        body: {
            task: '排查另一个仓库的问题',
            repository: {
                repositoryId: 'missing-repo',
                tags: ['repo:missing-repo']
            },
            recentMessages: [
                {
                    role: 'user',
                    content: '帮我回忆这个仓库之前踩过的坑'
                }
            ],
            requestContext: {
                requestId: 'req-coding-recall-service-no-match',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-recall-service-no-match'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-recall-service-test'
    });

    assert.equal(result.success, true);
    assert.equal(result.data.scope.mode, 'repository_terms_no_match');
    assert.equal(result.data.scope.matchCount, 0);
    assert.equal(result.data.recallBlocks.length, 0);
    assert.equal(result.data.codingContext.includes('No repository-scoped memory matched'), true);
});

test('CodingRecallService returns machine-readable validation failures when coding signals are missing', async () => {
    const pluginManager = createCodingRecallPluginManager();
    const service = createCodingRecallService({
        contextRuntimeService: createContextRuntimeService({ pluginManager })
    });

    const result = await service.recallForCoding({
        body: {
            requestContext: {
                requestId: 'req-coding-recall-service-invalid',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-recall-service-invalid'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-recall-service-test'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'AGW_VALIDATION_ERROR');
    assert.equal(result.details.field, 'task+(files|symbols|recentMessages)');
});

test('CodingRecallService rejects task-only requests without an additional coding signal', async () => {
    const pluginManager = createCodingRecallPluginManager();
    const service = createCodingRecallService({
        contextRuntimeService: createContextRuntimeService({ pluginManager })
    });

    const result = await service.recallForCoding({
        body: {
            task: {
                description: '只给任务描述，不给额外 coding signal'
            },
            requestContext: {
                requestId: 'req-coding-recall-service-task-only',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-recall-service-task-only'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-recall-service-test'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.equal(result.code, 'AGW_VALIDATION_ERROR');
    assert.equal(result.details.field, 'task+(files|symbols|recentMessages)');
});
