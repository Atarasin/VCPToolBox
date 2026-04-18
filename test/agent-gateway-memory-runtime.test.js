const assert = require('node:assert/strict');
const test = require('node:test');

const { createMemoryRuntimeService } = require('../modules/agentGateway/services/memoryRuntimeService');
const {
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

function createDailyNotePlugin() {
    return {
        name: 'DailyNote',
        displayName: '日记系统',
        description: '支持创建和更新日记。',
        pluginType: 'synchronous',
        communication: {
            protocol: 'stdio',
            timeout: 30000
        },
        capabilities: {
            invocationCommands: [
                {
                    commandIdentifier: 'create',
                    description: '创建日记。'
                }
            ]
        }
    };
}

test('MemoryRuntimeService persists durable memory through DailyNote', async () => {
    const plugins = new Map(createPluginManager().plugins);
    plugins.set('DailyNote', createDailyNotePlugin());

    let capturedCall = null;
    const pluginManager = createPluginManager({
        plugins,
        async processToolCall(toolName, args) {
            capturedCall = { toolName, args };
            return {
                status: 'success',
                message: 'Diary saved to /tmp/Nova/2026-04-01-09_30_00.md'
            };
        }
    });
    const service = createMemoryRuntimeService({ pluginManager });

    const result = await service.writeMemory({
        body: {
            target: {
                diary: 'Nova'
            },
            memory: {
                text: '需要在 Phase 4 中把 durable memory 写回 VCP 日记系统。',
                tags: ['Phase4', 'memory-write'],
                timestamp: '2026-04-01T09:30:00.000Z',
                metadata: {
                    sourceEvent: 'memory.flush',
                    importance: 0.92
                }
            },
            options: {
                idempotencyKey: 'mem-write-001',
                deduplicate: true
            },
            requestContext: {
                source: 'openclaw-memory',
                agentId: 'agent.nova',
                sessionId: 'sess-memory-write-001',
                requestId: 'req-memory-write-001'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw-memory'
    });

    assert.equal(result.success, true);
    assert.equal(result.data.writeStatus, 'created');
    assert.equal(result.data.diary, 'Nova');
    assert.equal(result.data.deduplicated, false);
    assert.equal(result.data.filePath, '/tmp/Nova/2026-04-01-09_30_00.md');
    assert.equal(capturedCall.toolName, 'DailyNote');
    assert.equal(capturedCall.args.command, 'create');
    assert.equal(capturedCall.args.maid, '[Nova]agent.nova');
    assert.equal(capturedCall.args.Date, '2026-04-01');
    assert.equal(capturedCall.args.Tag, 'Tag: Phase4, memory-write');
    assert.match(
        capturedCall.args.Content,
        /^\[\d{2}:\d{2}\] 需要在 Phase 4 中把 durable memory 写回 VCP 日记系统。\nMeta-sourceEvent: memory\.flush\nMeta-importance: 0\.92$/
    );
    assert.deepEqual(capturedCall.args.__agentGatewayContext, {
        runtime: 'openclaw',
        source: 'openclaw-memory',
        agentId: 'agent.nova',
        sessionId: 'sess-memory-write-001',
        requestId: 'req-memory-write-001',
        toolName: 'DailyNote'
    });
});

test('MemoryRuntimeService skips duplicate writes by idempotency key', async () => {
    const plugins = new Map(createPluginManager().plugins);
    plugins.set('DailyNote', createDailyNotePlugin());

    let invocationCount = 0;
    const pluginManager = createPluginManager({
        plugins,
        async processToolCall() {
            invocationCount += 1;
            return {
                status: 'success',
                message: 'Diary saved to /tmp/Nova/2026-04-01-09_31_00.md'
            };
        }
    });
    const service = createMemoryRuntimeService({ pluginManager });
    const request = {
        body: {
            target: {
                diary: 'Nova'
            },
            memory: {
                text: '同一批 durable memory 只应被写入一次。',
                tags: ['去重', '幂等'],
                timestamp: '2026-04-01T09:31:00.000Z'
            },
            options: {
                idempotencyKey: 'mem-write-duplicate-001',
                deduplicate: true
            },
            requestContext: {
                source: 'openclaw-memory',
                agentId: 'agent.nova',
                sessionId: 'sess-memory-write-002',
                requestId: 'req-memory-write-002'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw-memory'
    };

    const firstResult = await service.writeMemory(request);
    const secondResult = await service.writeMemory(request);

    assert.equal(firstResult.success, true);
    assert.equal(firstResult.data.writeStatus, 'created');
    assert.equal(secondResult.success, true);
    assert.equal(secondResult.data.writeStatus, 'skipped_duplicate');
    assert.equal(secondResult.data.entryId, firstResult.data.entryId);
    assert.equal(invocationCount, 1);
});

test('MemoryRuntimeService rejects forbidden diary targets', async () => {
    const plugins = new Map(createPluginManager().plugins);
    plugins.set('DailyNote', createDailyNotePlugin());

    let invocationCount = 0;
    const pluginManager = createPluginManager({
        plugins,
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        },
        async processToolCall() {
            invocationCount += 1;
            return { status: 'success' };
        }
    });
    const service = createMemoryRuntimeService({ pluginManager });

    const result = await service.writeMemory({
        body: {
            target: {
                diary: 'ProjectAlpha'
            },
            memory: {
                text: '越权写回应被拒绝。',
                tags: ['forbidden', 'security']
            },
            requestContext: {
                source: 'openclaw-memory',
                agentId: 'agent.nova',
                sessionId: 'sess-memory-write-003',
                requestId: 'req-memory-write-003'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw-memory'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 403);
    assert.equal(result.code, 'OCW_MEMORY_TARGET_FORBIDDEN');
    assert.equal(invocationCount, 0);
});
