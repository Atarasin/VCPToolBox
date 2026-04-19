const assert = require('node:assert/strict');
const test = require('node:test');

const { createSchemaRegistry } = require('../modules/agentGateway/infra/schemaRegistry');
const { createToolRuntimeService } = require('../modules/agentGateway/services/toolRuntimeService');
const { createJobRuntimeService } = require('../modules/agentGateway/services/jobRuntimeService');
const { createAgentPolicyResolver } = require('../modules/agentGateway/policy/agentPolicyResolver');
const { resolveAuthContext } = require('../modules/agentGateway/policy/authContextResolver');
const { ensureToolAllowed } = require('../modules/agentGateway/policy/toolScopeGuard');
const {
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

function createAuditLoggerRecorder() {
    const entries = [];
    return {
        entries,
        logToolInvoke(event, payload) {
            entries.push({ event, payload });
        }
    };
}

test('ToolRuntimeService completes tool invocation with unified and legacy context', async () => {
    let capturedCall = null;
    const pluginManager = createPluginManager({
        async processToolCall(toolName, args) {
            capturedCall = { toolName, args };
            return { ok: true };
        }
    });
    const auditLogger = createAuditLoggerRecorder();
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        jobRuntimeService: createJobRuntimeService(),
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        },
        auditLogger
    });

    const result = await service.invokeTool({
        toolName: 'SciCalculator',
        body: {
            args: {
                expression: '1+1'
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.math',
                sessionId: 'sess-tool-001',
                requestId: 'req-tool-001'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.data.toolName, 'SciCalculator');
    assert.deepEqual(result.data.audit, {
        approvalUsed: false,
        distributed: false
    });
    assert.deepEqual(capturedCall, {
        toolName: 'SciCalculator',
        args: {
            expression: '1+1',
            __agentGatewayContext: {
                runtime: 'openclaw',
                source: 'openclaw',
                agentId: 'agent.math',
                sessionId: 'sess-tool-001',
                requestId: 'req-tool-001',
                toolName: 'SciCalculator'
            },
            __openclawContext: {
                source: 'openclaw',
                agentId: 'agent.math',
                sessionId: 'sess-tool-001',
                requestId: 'req-tool-001'
            }
        }
    });
    assert.deepEqual(
        auditLogger.entries.map((entry) => entry.event),
        ['invoke.started', 'invoke.completed']
    );
});

test('ToolRuntimeService returns waiting_approval without invoking protected tools', async () => {
    let invocationCount = 0;
    const pluginManager = createPluginManager({
        getPlugin(toolName) {
            if (toolName === 'ProtectedTool') {
                return {
                    name: 'ProtectedTool',
                    displayName: '受保护工具',
                    description: '需要审批。',
                    pluginType: 'synchronous',
                    communication: {
                        protocol: 'stdio',
                        timeout: 1000
                    },
                    capabilities: {
                        invocationCommands: [
                            {
                                description: '执行受保护操作。\n- `task`: 必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」ProtectedTool「末」,\ntask:「始」dangerous「末」\n<<<[END_TOOL_REQUEST]>>>'
                            }
                        ]
                    }
                };
            }
            return this.plugins.get(toolName);
        },
        async processToolCall() {
            invocationCount += 1;
            return { ok: true };
        }
    });
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        jobRuntimeService: createJobRuntimeService(),
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        }
    });

    const result = await service.invokeTool({
        toolName: 'ProtectedTool',
        body: {
            args: {
                task: 'dangerous'
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.secure',
                sessionId: 'sess-tool-002',
                requestId: 'req-tool-002'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'waiting_approval');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.code, 'OCW_TOOL_APPROVAL_REQUIRED');
    assert.equal(typeof result.details.job.jobId, 'string');
    assert.equal(result.details.job.status, 'waiting_approval');
    assert.equal(invocationCount, 0);
});

test('ToolRuntimeService rejects tools outside shared agent policy scope', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    'agent.math': {
                        toolScopes: ['SciCalculator']
                    }
                }
            }
        }
    });
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        authContextResolver: resolveAuthContext,
        agentPolicyResolver: createAgentPolicyResolver({ pluginManager }),
        toolScopeGuard: ensureToolAllowed,
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        }
    });

    const result = await service.invokeTool({
        toolName: 'RemoteSearch',
        body: {
            args: {
                query: 'hello'
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.math',
                sessionId: 'sess-tool-002b',
                requestId: 'req-tool-002b'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 403);
    assert.equal(result.code, 'OCW_TOOL_FORBIDDEN');
    assert.equal(result.details.canonicalCode, 'AGW_FORBIDDEN');
});

test('ToolRuntimeService rejects invalid args with shared schema validation', async () => {
    const pluginManager = createPluginManager();
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        }
    });

    const result = await service.invokeTool({
        toolName: 'ChromeBridge',
        body: {
            args: {
                command: 'click'
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.browser',
                sessionId: 'sess-tool-003',
                requestId: 'req-tool-003'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'OCW_TOOL_INVALID_ARGS');
    assert.deepEqual(result.details.issues, ['args.target is required']);
});

test('ToolRuntimeService maps timeout failures through failed status', async () => {
    const pluginManager = createPluginManager({
        async processToolCall() {
            throw new Error(JSON.stringify({
                plugin_error: 'Tool execution timed out after 30 seconds.'
            }));
        }
    });
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        }
    });

    const result = await service.invokeTool({
        toolName: 'SciCalculator',
        body: {
            args: {
                expression: '1+1'
            },
            requestContext: {
                source: 'openclaw',
                agentId: 'agent.math',
                sessionId: 'sess-tool-004',
                requestId: 'req-tool-004'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.httpStatus, 504);
    assert.equal(result.code, 'OCW_TOOL_TIMEOUT');
    assert.equal(result.error, 'Tool execution timed out');
});

test('ToolRuntimeService replays supported idempotent invoke results by tool and key', async () => {
    let invocationCount = 0;
    const pluginManager = createPluginManager({
        async processToolCall(toolName, args) {
            invocationCount += 1;
            return {
                toolName,
                invocationCount,
                receivedArgs: args
            };
        }
    });
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        memoryRuntimeService: {
            async writeMemory() {
                throw new Error('memory bridge should not be used');
            }
        }
    });

    const firstResult = await service.invokeTool({
        toolName: 'SciCalculator',
        body: {
            args: {
                expression: '1+1'
            },
            options: {
                idempotencyKey: 'tool-idem-001'
            },
            requestContext: {
                source: 'native',
                agentId: 'agent.math',
                sessionId: 'sess-tool-idem-001',
                requestId: 'req-tool-idem-001'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'native'
    });

    const secondResult = await service.invokeTool({
        toolName: 'SciCalculator',
        body: {
            args: {
                expression: '1+1'
            },
            options: {
                idempotencyKey: 'tool-idem-001'
            },
            requestContext: {
                source: 'native',
                agentId: 'agent.math',
                sessionId: 'sess-tool-idem-002',
                requestId: 'req-tool-idem-002'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'native'
    });

    assert.equal(firstResult.success, true);
    assert.equal(secondResult.success, true);
    assert.equal(firstResult.data.result.invocationCount, 1);
    assert.equal(secondResult.data.result.invocationCount, 1);
    assert.equal(secondResult.data.idempotentReplay, true);
    assert.equal(secondResult.requestId, 'req-tool-idem-002');
    assert.equal(invocationCount, 1);
});

test('ToolRuntimeService routes vcp_memory_write through MemoryRuntimeService bridge', async () => {
    let capturedBridgeRequest = null;
    const pluginManager = createPluginManager();
    const service = createToolRuntimeService({
        pluginManager,
        schemaRegistry: createSchemaRegistry(),
        memoryRuntimeService: {
            async writeMemory(request) {
                capturedBridgeRequest = request;
                return {
                    success: true,
                    requestId: request.body.requestContext.requestId,
                    data: {
                        writeStatus: 'created',
                        diary: 'Nova',
                        entryId: 'bridge-entry-001'
                    }
                };
            }
        }
    });

    const result = await service.invokeTool({
        toolName: 'vcp_memory_write',
        body: {
            args: {
                diary: 'Nova',
                text: '通过内部桥接工具写回 durable memory。',
                tags: ['durable-memory', 'bridge-tool'],
                timestamp: '2026-04-03T08:30:00.000Z',
                idempotencyKey: 'tool-memory-bridge-001'
            },
            requestContext: {
                source: 'openclaw-memory-write',
                agentId: 'agent.nova',
                sessionId: 'sess-tool-memory-001',
                requestId: 'req-tool-memory-001'
            }
        },
        startedAt: Date.now(),
        clientIp: '127.0.0.1',
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.data.toolName, 'vcp_memory_write');
    assert.deepEqual(capturedBridgeRequest.body.options, {
        idempotencyKey: 'tool-memory-bridge-001',
        deduplicate: undefined,
        bridgeToolName: 'vcp_memory_write'
    });
    assert.equal(capturedBridgeRequest.defaultSource, 'openclaw-memory-write');
});
