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

function createMemoryPluginManager(overrides = {}) {
    const pluginManager = createPluginManager(overrides);
    const dailyNotePlugin = {
        name: 'DailyNote',
        displayName: '日记写入器',
        description: '写入 durable memory 到日记本。',
        pluginType: 'synchronous',
        communication: {
            protocol: 'stdio',
            timeout: 1000
        },
        capabilities: {
            invocationCommands: [
                {
                    description: '创建日记条目。'
                }
            ]
        }
    };
    const baseGetPlugin = pluginManager.getPlugin.bind(pluginManager);
    const baseProcessToolCall = pluginManager.processToolCall.bind(pluginManager);

    return {
        ...pluginManager,
        getPlugin(toolName) {
            if (toolName === 'DailyNote') {
                return dailyNotePlugin;
            }
            return baseGetPlugin(toolName);
        },
        async processToolCall(toolName, args) {
            if (toolName === 'DailyNote') {
                const diaryName = typeof args?.maid === 'string' && args.maid.startsWith('[')
                    ? args.maid.slice(1).split(']')[0]
                    : 'UnknownDiary';
                return {
                    ok: true,
                    filePath: `${diaryName}/${args.Date}.md`
                };
            }
            return baseProcessToolCall(toolName, args);
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
        [
            'ChromeBridge',
            'gateway_context_assemble',
            'gateway_memory_search',
            'gateway_memory_write',
            'SciCalculator'
        ]
    );
    const chromeBridgeTool = result.tools.find((tool) => tool.name === 'ChromeBridge');
    const memorySearchTool = result.tools.find((tool) => tool.name === 'gateway_memory_search');
    assert.ok(chromeBridgeTool && chromeBridgeTool.inputSchema);
    assert.equal(chromeBridgeTool.annotations.pluginType, 'hybridservice');
    assert.ok(memorySearchTool && memorySearchTool.inputSchema);
    assert.equal(memorySearchTool.annotations.gatewayManaged, true);
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

test('MCP adapter executes canonical memory and context tools with MCP request context', async () => {
    const pluginManager = createMemoryPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        diaryScopes: ['Nova', 'SharedMemory']
                    }
                }
            }
        }
    });
    const adapter = createMcpAdapter(pluginManager);

    const searchResult = await adapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: '上周项目会议讨论了什么',
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-memory-search',
        requestContext: {
            requestId: 'req-mcp-memory-search'
        }
    });
    const contextResult = await adapter.callTool({
        name: 'gateway_context_assemble',
        arguments: {
            recentMessages: [
                {
                    role: 'user',
                    content: '上周项目会议讨论了什么'
                }
            ],
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-context',
        requestContext: {
            requestId: 'req-mcp-context'
        }
    });
    const writeResult = await adapter.callTool({
        name: 'gateway_memory_write',
        arguments: {
            target: {
                diary: 'Nova'
            },
            memory: {
                text: '记录本次 MCP memory core 的实现结论。',
                tags: ['实现', 'MCP']
            },
            options: {
                idempotencyKey: 'idem-mcp-memory-write-001'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-memory-write',
        requestContext: {
            requestId: 'req-mcp-memory-write'
        }
    });
    const duplicateWriteResult = await adapter.callTool({
        name: 'gateway_memory_write',
        arguments: {
            target: {
                diary: 'Nova'
            },
            memory: {
                text: '记录本次 MCP memory core 的实现结论。',
                tags: ['实现', 'MCP']
            },
            options: {
                idempotencyKey: 'idem-mcp-memory-write-001'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-memory-write',
        requestContext: {
            requestId: 'req-mcp-memory-write-dup'
        }
    });

    assert.equal(searchResult.isError, false);
    assert.equal(searchResult.structuredContent.requestId, 'req-mcp-memory-search');
    assert.equal(searchResult.structuredContent.result.items[0].sourceDiary, 'Nova');
    assert.equal(contextResult.isError, false);
    assert.equal(Array.isArray(contextResult.structuredContent.result.recallBlocks), true);
    assert.equal(contextResult.structuredContent.result.recallBlocks.length > 0, true);
    assert.equal(writeResult.isError, false);
    assert.equal(writeResult.structuredContent.result.writeStatus, 'created');
    assert.equal(duplicateWriteResult.isError, false);
    assert.equal(duplicateWriteResult.structuredContent.result.writeStatus, 'skipped_duplicate');
});

test('MCP memory adapter keeps canonical failure identity for validation and policy errors', async () => {
    const pluginManager = createMemoryPluginManager({
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
    const adapter = createMcpAdapter(pluginManager);

    const invalidSearch = await adapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-invalid-search',
        requestContext: {
            requestId: 'req-mcp-invalid-search'
        }
    });
    const forbiddenWrite = await adapter.callTool({
        name: 'gateway_memory_write',
        arguments: {
            target: {
                diary: 'ProjectAlpha'
            },
            memory: {
                text: '不应被允许的写入。',
                tags: ['拒绝']
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-forbidden-write',
        requestContext: {
            requestId: 'req-mcp-forbidden-write'
        }
    });

    assert.equal(invalidSearch.isError, true);
    assert.equal(invalidSearch.error.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(invalidSearch.error.details.canonicalCode, 'AGW_VALIDATION_ERROR');
    assert.equal(forbiddenWrite.isError, true);
    assert.equal(forbiddenWrite.error.code, 'MCP_FORBIDDEN');
    assert.equal(forbiddenWrite.error.details.canonicalCode, 'AGW_FORBIDDEN');
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

test('MCP memory adapter remains semantically aligned with representative native memory flows', async () => {
    const pluginManager = createMemoryPluginManager({
        openClawBridgeConfig: {
            policy: {
                agentPolicyMap: {
                    Ariadne: {
                        diaryScopes: ['Nova', 'SharedMemory']
                    }
                }
            }
        }
    });
    const adapter = createMcpAdapter(pluginManager);
    const server = await createNativeServer(pluginManager);

    try {
        const nativeTargetsResponse = await fetch(
            `${server.baseUrl}/agent_gateway/memory/targets?agentId=Ariadne&requestId=req-native-mcp-targets`
        );
        const nativeTargetsPayload = await nativeTargetsResponse.json();
        const listed = await adapter.listResources({
            agentId: 'Ariadne',
            requestContext: {
                requestId: 'req-mcp-targets-list'
            }
        });
        const mcpTargets = await adapter.readResource({
            uri: listed.resources.find((resource) => resource.uri.includes('/memory-targets/')).uri,
            requestContext: {
                requestId: 'req-mcp-targets-read'
            }
        });

        const nativeSearchResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '上周项目会议讨论了什么',
                diary: 'Nova',
                requestContext: {
                    requestId: 'req-native-mcp-memory-search',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-memory-search'
                }
            })
        });
        const nativeSearchPayload = await nativeSearchResponse.json();
        const mcpSearch = await adapter.callTool({
            name: 'gateway_memory_search',
            arguments: {
                query: '上周项目会议讨论了什么',
                diary: 'Nova'
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-memory-search',
            requestContext: {
                requestId: 'req-mcp-memory-search-parity'
            }
        });

        const nativeContextResponse = await fetch(`${server.baseUrl}/agent_gateway/context/assemble`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                recentMessages: [
                    {
                        role: 'user',
                        content: '上周项目会议讨论了什么'
                    }
                ],
                diary: 'Nova',
                requestContext: {
                    requestId: 'req-native-mcp-context',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-context'
                }
            })
        });
        const nativeContextPayload = await nativeContextResponse.json();
        const mcpContext = await adapter.callTool({
            name: 'gateway_context_assemble',
            arguments: {
                recentMessages: [
                    {
                        role: 'user',
                        content: '上周项目会议讨论了什么'
                    }
                ],
                diary: 'Nova'
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-context',
            requestContext: {
                requestId: 'req-mcp-context-parity'
            }
        });

        const nativeWriteResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': 'idem-native-mcp-write-001'
            },
            body: JSON.stringify({
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '记录 parity test 的写入结果。',
                    tags: ['parity', 'mcp']
                },
                requestContext: {
                    requestId: 'req-native-mcp-write',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-write'
                }
            })
        });
        const nativeWritePayload = await nativeWriteResponse.json();
        const nativeDuplicateWriteResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': 'idem-native-mcp-write-001'
            },
            body: JSON.stringify({
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '记录 parity test 的写入结果。',
                    tags: ['parity', 'mcp']
                },
                requestContext: {
                    requestId: 'req-native-mcp-write-dup',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-write'
                }
            })
        });
        const nativeDuplicateWritePayload = await nativeDuplicateWriteResponse.json();
        const mcpWrite = await adapter.callTool({
            name: 'gateway_memory_write',
            arguments: {
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '记录 parity test 的写入结果。',
                    tags: ['parity', 'mcp']
                },
                options: {
                    idempotencyKey: 'idem-mcp-write-001'
                }
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-write',
            requestContext: {
                requestId: 'req-mcp-write-parity'
            }
        });
        const mcpDuplicateWrite = await adapter.callTool({
            name: 'gateway_memory_write',
            arguments: {
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '记录 parity test 的写入结果。',
                    tags: ['parity', 'mcp']
                },
                options: {
                    idempotencyKey: 'idem-mcp-write-001'
                }
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-write',
            requestContext: {
                requestId: 'req-mcp-write-parity-dup'
            }
        });

        const nativeForbiddenWriteResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                target: {
                    diary: 'ProjectAlpha'
                },
                memory: {
                    text: '不应被允许的写入。',
                    tags: ['forbidden']
                },
                requestContext: {
                    requestId: 'req-native-mcp-write-forbidden',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-write-forbidden'
                }
            })
        });
        const nativeForbiddenWritePayload = await nativeForbiddenWriteResponse.json();
        const mcpForbiddenWrite = await adapter.callTool({
            name: 'gateway_memory_write',
            arguments: {
                target: {
                    diary: 'ProjectAlpha'
                },
                memory: {
                    text: '不应被允许的写入。',
                    tags: ['forbidden']
                }
            },
            agentId: 'Ariadne',
            sessionId: 'sess-native-mcp-write-forbidden',
            requestContext: {
                requestId: 'req-mcp-write-forbidden'
            }
        });

        assert.equal(nativeTargetsResponse.status, 200);
        assert.deepEqual(
            nativeTargetsPayload.data.targets.map((target) => target.id),
            JSON.parse(mcpTargets.contents[0].text).map((target) => target.id)
        );

        assert.equal(nativeSearchResponse.status, 200);
        assert.equal(mcpSearch.isError, false);
        assert.equal(nativeSearchPayload.data.items[0].sourceDiary, mcpSearch.structuredContent.result.items[0].sourceDiary);

        assert.equal(nativeContextResponse.status, 200);
        assert.equal(mcpContext.isError, false);
        assert.equal(nativeContextPayload.data.recallBlocks.length > 0, true);
        assert.equal(mcpContext.structuredContent.result.recallBlocks.length > 0, true);

        assert.equal(nativeWriteResponse.status, 200);
        assert.equal(nativeWritePayload.data.writeStatus, 'created');
        assert.equal(nativeDuplicateWriteResponse.status, 200);
        assert.equal(nativeDuplicateWritePayload.data.writeStatus, 'skipped_duplicate');
        assert.equal(mcpWrite.isError, false);
        assert.equal(mcpWrite.structuredContent.result.writeStatus, 'created');
        assert.equal(mcpDuplicateWrite.isError, false);
        assert.equal(mcpDuplicateWrite.structuredContent.result.writeStatus, 'skipped_duplicate');

        assert.equal(nativeForbiddenWriteResponse.status, 403);
        assert.equal(nativeForbiddenWritePayload.code, 'AGW_FORBIDDEN');
        assert.equal(mcpForbiddenWrite.isError, true);
        assert.equal(mcpForbiddenWrite.error.details.canonicalCode, 'AGW_FORBIDDEN');
    } finally {
        await server.close();
    }
});
