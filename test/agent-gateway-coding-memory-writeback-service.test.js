const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createMemoryRuntimeService
} = require('../modules/agentGateway/services/memoryRuntimeService');
const {
    createCodingMemoryWritebackService
} = require('../modules/agentGateway/services/codingMemoryWritebackService');
const {
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

function createCodingMemoryWritebackPluginManager() {
    const capturedDailyNoteCalls = [];
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        diaryScopes: ['Nova']
                    }
                }
            }
        }
    });
    const baseGetPlugin = pluginManager.getPlugin.bind(pluginManager);
    const baseProcessToolCall = pluginManager.processToolCall.bind(pluginManager);

    return {
        pluginManager: {
            ...pluginManager,
            getPlugin(toolName) {
                if (toolName === 'DailyNote') {
                    return {
                        name: 'DailyNote',
                        displayName: '日记写入器',
                        description: '写入 durable memory 到日记本。',
                        pluginType: 'synchronous',
                        communication: {
                            protocol: 'stdio',
                            timeout: 1000
                        }
                    };
                }
                return baseGetPlugin(toolName);
            },
            async processToolCall(toolName, args) {
                if (toolName === 'DailyNote') {
                    capturedDailyNoteCalls.push({
                        toolName,
                        args
                    });
                    const diaryName = args.maid.slice(1).split(']')[0];
                    return {
                        ok: true,
                        filePath: `${diaryName}/${args.Date}.md`
                    };
                }
                return baseProcessToolCall(toolName, args);
            }
        },
        capturedDailyNoteCalls
    };
}

test('CodingMemoryWritebackService derives deterministic memory text, tags, and repository metadata', async () => {
    const { pluginManager, capturedDailyNoteCalls } = createCodingMemoryWritebackPluginManager();
    const service = createCodingMemoryWritebackService({
        memoryRuntimeService: createMemoryRuntimeService({ pluginManager })
    });

    const result = await service.commitForCoding({
        body: {
            task: {
                description: '实现 coding memory writeback'
            },
            summary: '新增 shared service，并把 MCP 保持为 thin adapter。',
            constraints: ['不能复制第二套 memory runtime'],
            repository: {
                repositoryId: 'vcp-toolbox',
                workspaceRoot: '/home/zh/projects/VCP/VCPToolBox',
                tags: ['repo:vcp-toolbox']
            },
            target: {
                diary: 'Nova'
            },
            files: ['modules/agentGateway/adapters/mcpAdapter.js'],
            symbols: ['createMcpAdapter'],
            recommendedTags: ['gateway', 'mcp'],
            requestContext: {
                requestId: 'req-coding-writeback-service-success',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-writeback-service-success'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });

    assert.equal(result.success, true);
    assert.equal(result.requestId, 'req-coding-writeback-service-success');
    assert.equal(result.data.writeStatus, 'created');
    assert.equal(result.data.target.diary, 'Nova');
    assert.equal(result.data.target.scopeMode, 'repository_targeted');
    assert.deepEqual(
        result.data.derivedTags,
        ['coding', 'implementation', 'repo:vcp-toolbox', 'gateway', 'mcp']
    );
    assert.equal(result.data.metadata.repositoryId, 'vcp-toolbox');
    assert.equal(result.data.metadata.workspaceRoot, '/home/zh/projects/VCP/VCPToolBox');
    assert.equal(result.data.memoryText.includes('Coding task: 实现 coding memory writeback'), true);
    assert.equal(result.data.memoryText.includes('Implementation summary: 新增 shared service'), true);
    assert.equal(result.data.memoryText.includes('Related files: modules/agentGateway/adapters/mcpAdapter.js'), true);
    assert.equal(result.data.committedMemory.includes('Committed coding memory'), true);
    assert.equal(capturedDailyNoteCalls.length, 1);
    assert.equal(capturedDailyNoteCalls[0].args.Content.includes('Repository: vcp-toolbox'), true);
    assert.equal(capturedDailyNoteCalls[0].args.Content.includes('Related symbols: createMcpAdapter'), true);
    assert.equal(capturedDailyNoteCalls[0].args.Tag, 'Tag: coding, implementation, repo:vcp-toolbox, gateway, mcp');
});

test('CodingMemoryWritebackService preserves duplicate and idempotent write outcomes as machine-readable data', async () => {
    const { pluginManager } = createCodingMemoryWritebackPluginManager();
    const service = createCodingMemoryWritebackService({
        memoryRuntimeService: createMemoryRuntimeService({ pluginManager })
    });

    const baseBody = {
        task: {
            description: '提交 writeback 结论'
        },
        summary: '记录 duplicate handling contract。',
        diary: 'Nova',
        requestContext: {
            agentId: 'Ariadne',
            sessionId: 'sess-coding-writeback-service-duplicate'
        },
        options: {
            idempotencyKey: 'idem-coding-writeback-service-001'
        }
    };

    const created = await service.commitForCoding({
        body: {
            ...baseBody,
            requestContext: {
                ...baseBody.requestContext,
                requestId: 'req-coding-writeback-service-created'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });
    const duplicated = await service.commitForCoding({
        body: {
            ...baseBody,
            requestContext: {
                ...baseBody.requestContext,
                requestId: 'req-coding-writeback-service-duplicate'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });

    assert.equal(created.success, true);
    assert.equal(created.data.writeStatus, 'created');
    assert.equal(duplicated.success, true);
    assert.equal(duplicated.data.writeStatus, 'skipped_duplicate');
    assert.equal(duplicated.data.deduplicated, true);
    assert.equal(duplicated.data.committedMemory.includes('Skipped duplicate coding memory'), true);
});

test('CodingMemoryWritebackService accepts implementation-only summary aliases as valid writeback content', async () => {
    const { pluginManager } = createCodingMemoryWritebackPluginManager();
    const service = createCodingMemoryWritebackService({
        memoryRuntimeService: createMemoryRuntimeService({ pluginManager })
    });

    const result = await service.commitForCoding({
        body: {
            task: {
                description: '记录 implementation alias'
            },
            implementation: '通过 implementation 字段提供总结内容。',
            diary: 'Nova',
            requestContext: {
                requestId: 'req-coding-writeback-service-implementation-alias',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-writeback-service-implementation-alias'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });

    assert.equal(result.success, true);
    assert.equal(result.data.writeStatus, 'created');
    assert.equal(result.data.memoryText.includes('Implementation summary: 通过 implementation 字段提供总结内容。'), true);
});

test('CodingMemoryWritebackService keeps validation and canonical target failures machine-readable', async () => {
    const { pluginManager } = createCodingMemoryWritebackPluginManager();
    const service = createCodingMemoryWritebackService({
        memoryRuntimeService: createMemoryRuntimeService({ pluginManager })
    });

    const invalidSignals = await service.commitForCoding({
        body: {
            task: {
                description: '只有任务，没有其他 writeback signal'
            },
            diary: 'Nova',
            requestContext: {
                requestId: 'req-coding-writeback-service-invalid-signals',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-writeback-service-invalid-signals'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });
    const missingDiary = await service.commitForCoding({
        body: {
            task: {
                description: '缺少 diary'
            },
            summary: '有总结，但是没有明确目标日记。',
            requestContext: {
                requestId: 'req-coding-writeback-service-missing-diary',
                agentId: 'Ariadne',
                sessionId: 'sess-coding-writeback-service-missing-diary'
            }
        },
        startedAt: Date.now(),
        defaultSource: 'coding-writeback-service-test'
    });

    assert.equal(invalidSignals.success, false);
    assert.equal(invalidSignals.status, 400);
    assert.equal(invalidSignals.code, 'AGW_VALIDATION_ERROR');
    assert.equal(invalidSignals.details.field, 'task+(summary|implementation|outcome|result|notes|constraints|pitfalls|files|symbols)');
    assert.equal(missingDiary.success, false);
    assert.equal(missingDiary.status, 400);
    assert.equal(missingDiary.code, 'OCW_MEMORY_INVALID_PAYLOAD');
    assert.equal(missingDiary.details.field, 'target.diary');
});
