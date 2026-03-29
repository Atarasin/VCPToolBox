const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const createOpenClawBridgeRoutes = require('../routes/openclawBridgeRoutes');

function createPluginManager(overrides = {}) {
    const plugins = new Map([
        ['SciCalculator', {
            name: 'SciCalculator',
            displayName: '科学计算器',
            description: '执行数学表达式计算。',
            pluginType: 'synchronous',
            communication: {
                protocol: 'stdio',
                timeout: 15000
            },
            capabilities: {
                invocationCommands: [
                    {
                        description: '执行数学表达式计算。\n- `expression`: 表达式文本，必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」SciCalculator「末」,\nexpression:「始」1+1「末」\n<<<[END_TOOL_REQUEST]>>>'
                    }
                ]
            }
        }],
        ['ChromeBridge', {
            name: 'ChromeBridge',
            displayName: 'Chrome 浏览器桥接器',
            description: '执行浏览器控制命令。',
            pluginType: 'hybridservice',
            communication: {
                protocol: 'direct',
                timeout: 30000
            },
            capabilities: {
                invocationCommands: [
                    {
                        command: 'click',
                        description: '点击元素。\n- `command`: 固定为 `click`。\n- `target`: 目标元素，必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」ChromeBridge「末」,\ncommand:「始」click「末」,\ntarget:「始」登录「末」\n<<<[END_TOOL_REQUEST]>>>'
                    },
                    {
                        command: 'open_url',
                        description: '打开网页。\n- `command`: 固定为 `open_url`。\n- `url`: 目标地址，必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」ChromeBridge「末」,\ncommand:「始」open_url「末」,\nurl:「始」https://example.com「末」\n<<<[END_TOOL_REQUEST]>>>'
                    }
                ]
            }
        }],
        ['RemoteSearch', {
            name: 'RemoteSearch',
            displayName: '远程搜索',
            description: '分布式搜索工具。',
            pluginType: 'synchronous',
            isDistributed: true,
            communication: {
                protocol: 'stdio',
                timeout: 20000
            },
            capabilities: {
                invocationCommands: [
                    {
                        description: '执行远程搜索。\n- `query`: 查询词，必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」RemoteSearch「末」,\nquery:「始」hello「末」\n<<<[END_TOOL_REQUEST]>>>'
                    }
                ]
            }
        }],
        ['BackgroundService', {
            name: 'BackgroundService',
            displayName: '后台服务',
            description: '不应暴露为工具。',
            pluginType: 'service',
            communication: {
                protocol: 'direct',
                timeout: 1000
            }
        }]
    ]);

    return {
        plugins,
        getPlugin(toolName) {
            return plugins.get(toolName);
        },
        toolApprovalManager: {
            shouldApprove(toolName) {
                return toolName === 'ProtectedTool';
            }
        },
        async processToolCall(toolName, args) {
            if (overrides.processToolCall) {
                return overrides.processToolCall(toolName, args);
            }
            return {
                toolName,
                receivedArgs: args
            };
        },
        ...overrides
    };
}

async function createServer(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/admin_api', createOpenClawBridgeRoutes(pluginManager));

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    };
}

test('GET /admin_api/openclaw/capabilities returns bridgeable tools and schema metadata', async () => {
    const pluginManager = createPluginManager();
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/capabilities?agentId=agent.default`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-openclaw-bridge-version'), 'v1');
        assert.equal(payload.success, true);
        assert.equal(payload.data.server.version, '7.1.2');

        const toolNames = payload.data.tools.map((tool) => tool.name);
        assert.deepEqual(toolNames, ['ChromeBridge', 'RemoteSearch', 'SciCalculator']);

        const chromeBridge = payload.data.tools.find((tool) => tool.name === 'ChromeBridge');
        assert.equal(chromeBridge.pluginType, 'hybridservice');
        assert.equal(chromeBridge.distributed, false);
        assert.equal(Array.isArray(chromeBridge.inputSchema.oneOf), true);
        assert.equal(chromeBridge.inputSchema.oneOf.length, 2);
        assert.deepEqual(payload.data.memory.targets, []);
        assert.deepEqual(payload.data.memory.features, {
            timeAware: false,
            groupAware: false,
            rerank: false,
            tagMemo: false,
            writeBack: false
        });
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/tools/:toolName forwards args with OpenClaw requestContext', async () => {
    let capturedCall = null;
    const pluginManager = createPluginManager({
        async processToolCall(toolName, args) {
            capturedCall = { toolName, args };
            return { status: 'success' };
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/tools/SciCalculator`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    expression: '1+1'
                },
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.math',
                    sessionId: 'sess-001',
                    requestId: 'req-001'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.audit, {
            approvalUsed: false,
            distributed: false
        });
        assert.deepEqual(capturedCall, {
            toolName: 'SciCalculator',
            args: {
                expression: '1+1',
                __openclawContext: {
                    source: 'openclaw',
                    agentId: 'agent.math',
                    sessionId: 'sess-001',
                    requestId: 'req-001'
                }
            }
        });
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/tools/:toolName rejects invalid args using derived schema', async () => {
    const pluginManager = createPluginManager();
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/tools/ChromeBridge`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    command: 'click'
                },
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.browser',
                    sessionId: 'sess-002',
                    requestId: 'req-002'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_TOOL_INVALID_ARGS');
        assert.deepEqual(payload.details.issues, ['args.target is required']);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/tools/:toolName returns approval required without invoking the plugin', async () => {
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
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/tools/ProtectedTool`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    task: 'dangerous'
                },
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.secure',
                    sessionId: 'sess-003',
                    requestId: 'req-003'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(payload.code, 'OCW_TOOL_APPROVAL_REQUIRED');
        assert.equal(invocationCount, 0);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/tools/:toolName maps timeout failures to OCW_TOOL_TIMEOUT', async () => {
    const pluginManager = createPluginManager({
        async processToolCall() {
            throw new Error(JSON.stringify({
                plugin_error: 'Tool execution timed out after 30 seconds.'
            }));
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/tools/SciCalculator`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    expression: '1+1'
                },
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.math',
                    sessionId: 'sess-004',
                    requestId: 'req-004'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 504);
        assert.equal(payload.code, 'OCW_TOOL_TIMEOUT');
        assert.equal(payload.error, 'Tool execution timed out');
    } finally {
        await server.close();
    }
});
