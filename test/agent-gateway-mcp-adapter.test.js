const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../routes/agentGatewayRoutes');
const {
    createMcpAdapter,
    createMcpServerHarness
} = require('../modules/agentGateway/adapters/mcpAdapter');
const {
    createPluginManager
} = require('./helpers/agent-gateway-test-helpers');

async function createNativeServer(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));

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

function createProtectedToolPluginManager(overrides = {}) {
    const pluginManager = createPluginManager(overrides);
    return {
        ...pluginManager,
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
                                description: '执行受保护操作。\n- `task`: 必需。'
                            }
                        ]
                    }
                };
            }
            return pluginManager.getPlugin(toolName);
        }
    };
}

test('MCP adapter lists policy-filtered tools from the shared capability service', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        toolScopes: ['SciCalculator', 'ChromeBridge']
                    }
                }
            }
        }
    });
    const adapter = createMcpAdapter(pluginManager);

    const result = await adapter.listTools({
        agentId: 'Ariadne',
        requestContext: {
            requestId: 'req-mcp-tools-list'
        }
    });

    assert.equal(result.meta.requestId, 'req-mcp-tools-list');
    assert.deepEqual(
        result.tools.map((tool) => tool.name),
        ['ChromeBridge', 'SciCalculator']
    );
    assert.ok(result.tools[0].inputSchema);
    assert.equal(result.tools[0].annotations.pluginType, 'hybridservice');
});

test('MCP adapter routes tool invocation through shared runtime with MCP request context', async () => {
    let capturedCall = null;
    const pluginManager = createPluginManager({
        async processToolCall(toolName, args) {
            capturedCall = { toolName, args };
            return {
                ok: true,
                toolName
            };
        }
    });
    const adapter = createMcpAdapter(pluginManager);

    const result = await adapter.callTool({
        name: 'SciCalculator',
        arguments: {
            expression: '1+1'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-tool-001',
        requestContext: {
            requestId: 'req-mcp-tool-001'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.status, 'completed');
    assert.equal(result.structuredContent.requestId, 'req-mcp-tool-001');
    assert.equal(capturedCall.toolName, 'SciCalculator');
    assert.equal(capturedCall.args.__agentGatewayContext.runtime, 'mcp');
    assert.equal(capturedCall.args.__agentGatewayContext.source, 'mcp-tools-call');
    assert.equal(capturedCall.args.__openclawContext.requestId, 'req-mcp-tool-001');
});

test('MCP adapter maps forbidden and validation failures into stable MCP-facing errors', async () => {
    const forbiddenPluginManager = createPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        toolScopes: ['SciCalculator']
                    }
                }
            }
        }
    });
    const forbiddenAdapter = createMcpAdapter(forbiddenPluginManager);
    const validationAdapter = createMcpAdapter(createPluginManager());

    const forbidden = await forbiddenAdapter.callTool({
        name: 'RemoteSearch',
        arguments: {
            query: 'hello'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-tool-forbidden',
        requestContext: {
            requestId: 'req-mcp-tool-forbidden'
        }
    });
    const invalid = await validationAdapter.callTool({
        name: 'ChromeBridge',
        arguments: {
            command: 'click'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-tool-invalid',
        requestContext: {
            requestId: 'req-mcp-tool-invalid'
        }
    });

    assert.equal(forbidden.isError, true);
    assert.ok(forbidden.isError && forbidden.error);
    assert.equal(forbidden.error.code, 'MCP_FORBIDDEN');
    assert.equal(forbidden.error.details.canonicalCode, 'AGW_FORBIDDEN');

    assert.equal(invalid.isError, true);
    assert.ok(invalid.isError && invalid.error);
    assert.equal(invalid.error.code, 'MCP_INVALID_ARGUMENTS');
    assert.deepEqual(invalid.error.details.issues, ['args.target is required']);
});

test('MCP adapter preserves approval-required deferred semantics for protected tools', async () => {
    const pluginManager = createProtectedToolPluginManager();
    const adapter = createMcpAdapter(pluginManager);

    const result = await adapter.callTool({
        name: 'ProtectedTool',
        arguments: {
            task: 'dangerous'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-protected-tool',
        requestContext: {
            requestId: 'req-mcp-protected-tool'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.deferred, true);
    assert.equal(result.status, 'waiting_approval');
    assert.equal(result.structuredContent.job.status, 'waiting_approval');
});

test('MCP adapter lists and reads the supported read-only resource subset', async () => {
    const pluginManager = createPluginManager();
    const adapter = createMcpAdapter(pluginManager);

    const listed = await adapter.listResources({
        agentId: 'Ariadne',
        requestContext: {
            requestId: 'req-mcp-resources-list'
        }
    });
    const capabilitiesUri = listed.resources[0].uri;
    const memoryTargetsUri = listed.resources[1].uri;
    const capabilities = await adapter.readResource({
        uri: capabilitiesUri,
        requestContext: {
            requestId: 'req-mcp-resources-read-cap'
        }
    });
    const memoryTargets = await adapter.readResource({
        uri: memoryTargetsUri,
        requestContext: {
            requestId: 'req-mcp-resources-read-targets'
        }
    });

    assert.deepEqual(
        listed.resources.map((resource) => resource.uri),
        [
            'vcp://agent-gateway/capabilities/Ariadne',
            'vcp://agent-gateway/memory-targets/Ariadne'
        ]
    );
    assert.equal(JSON.parse(capabilities.contents[0].text).server.bridgeVersion, 'v1');
    assert.ok(Array.isArray(JSON.parse(memoryTargets.contents[0].text)));

    await assert.rejects(
        () => adapter.readResource({
            uri: 'vcp://agent-gateway/jobs/Ariadne'
        }),
        (error) => error && error.code === 'MCP_RESOURCE_UNSUPPORTED'
    );
});

test('MCP server harness exposes a representative client flow', async () => {
    const pluginManager = createPluginManager();
    const harness = createMcpServerHarness(pluginManager);

    const listResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
            agentId: 'Ariadne'
        }
    });
    const callResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
            name: 'SciCalculator',
            arguments: {
                expression: '1+1'
            },
            agentId: 'Ariadne',
            sessionId: 'sess-mcp-harness'
        }
    });

    assert.equal(listResponse.jsonrpc, '2.0');
    assert.equal(Array.isArray(listResponse.result.tools), true);
    assert.equal(callResponse.jsonrpc, '2.0');
    assert.equal(callResponse.result.isError, false);
    assert.equal(callResponse.result.status, 'completed');
});

test('MCP adapter remains semantically aligned with representative native tool flows', async () => {
    let invocationCount = 0;
    const pluginManager = createPluginManager({
        async processToolCall(toolName, args) {
            invocationCount += 1;
            return {
                toolName,
                receivedArgs: args,
                invocationCount
            };
        },
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        toolScopes: ['SciCalculator']
                    }
                }
            }
        }
    });
    const adapter = createMcpAdapter(pluginManager);
    const server = await createNativeServer(pluginManager);

    try {
        const nativeSuccessResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/SciCalculator/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    expression: '1+1'
                },
                requestContext: {
                    requestId: 'req-native-mcp-parity-success',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-parity-success'
                }
            })
        });
        const nativeSuccessPayload = await nativeSuccessResponse.json();
        const mcpSuccess = await adapter.callTool({
            name: 'SciCalculator',
            arguments: {
                expression: '1+1'
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-parity-success',
            requestContext: {
                requestId: 'req-mcp-parity-success'
            }
        });

        const nativeForbiddenResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/RemoteSearch/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    query: 'hello'
                },
                requestContext: {
                    requestId: 'req-native-mcp-parity-forbidden',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-parity-forbidden'
                }
            })
        });
        const nativeForbiddenPayload = await nativeForbiddenResponse.json();
        const mcpForbidden = await adapter.callTool({
            name: 'RemoteSearch',
            arguments: {
                query: 'hello'
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-parity-forbidden',
            requestContext: {
                requestId: 'req-mcp-parity-forbidden'
            }
        });

        assert.equal(nativeSuccessResponse.status, 200);
        assert.equal(nativeSuccessPayload.meta.toolStatus, 'completed');
        assert.equal(mcpSuccess.isError, false);
        assert.equal(mcpSuccess.status, 'completed');
        assert.equal(nativeSuccessPayload.data.result.toolName, mcpSuccess.structuredContent.result.toolName);

        assert.equal(nativeForbiddenResponse.status, 403);
        assert.equal(nativeForbiddenPayload.code, 'AGW_FORBIDDEN');
        assert.equal(mcpForbidden.isError, true);
        assert.ok(mcpForbidden.isError && mcpForbidden.error);
        assert.equal(mcpForbidden.error.details.canonicalCode, 'AGW_FORBIDDEN');
    } finally {
        await server.close();
    }
});
