const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const {
    getGatewayServiceBundle
} = require('../../../modules/agentGateway/createGatewayServiceBundle');
const {
    createMcpAdapter,
    createMcpServerHarness
} = require('../../../modules/agentGateway/adapters/mcpAdapter');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

let previousMemoryPolicyPath = process.env.MCP_AGENT_MEMORY_POLICY_PATH;

test.before(async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-policy-'));
    const policyPath = path.join(tempDir, 'mcp_agent_memory_policy.json');

    await fs.writeFile(policyPath, JSON.stringify({
        agents: {
            Ariadne: {
                allowedDiaries: ['Nova', 'SharedMemory'],
                defaultDiaries: ['Nova']
            }
        }
    }, null, 2), 'utf8');

    process.env.MCP_AGENT_MEMORY_POLICY_PATH = policyPath;
});

test.after(() => {
    if (previousMemoryPolicyPath === undefined) {
        delete process.env.MCP_AGENT_MEMORY_POLICY_PATH;
        return;
    }
    process.env.MCP_AGENT_MEMORY_POLICY_PATH = previousMemoryPolicyPath;
});

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

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-adapter-'));
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings) {
    const agentMap = new Map(Object.entries(mappings));
    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            const sourceFile = agentMap.get(alias);
            return fs.readFile(path.join(agentDir, sourceFile), 'utf8');
        },
        async getAllAgentFiles() {
            return {
                files: Array.from(agentMap.values()),
                folderStructure: {}
            };
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

function createRenderPluginManager(agentDir, overrides = {}) {
    return createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md',
            ...(overrides.agentMappings || {})
        }),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt
                .replaceAll('{{VarUserName}}', renderVariables.VarUserName || '')
                .replace(
                    '[[阿里阿德涅日记本::Time::TagMemo]]',
                    '记忆片段：上周完成了 gateway render contract 收口。'
                ),
        ...overrides
    });
}

function createDelayedRenderPluginManager(agentDir, delayMs = 25, overrides = {}) {
    return createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md',
            ...(overrides.agentMappings || {})
        }),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) => {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            return rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || '');
        },
        ...overrides
    });
}

function createDeferredGatewayResult(jobRuntimeService, {
    status,
    operation,
    authContext,
    target,
    metadata,
    audit
}) {
    const job = status === 'waiting_approval'
        ? jobRuntimeService.createWaitingApprovalJob({
            operation,
            authContext,
            target,
            metadata
        })
        : jobRuntimeService.createAcceptedJob({
            operation,
            authContext,
            target,
            metadata
        });

    return {
        success: true,
        status,
        data: {
            runtime: {
                deferred: true,
                status
            },
            job
        },
        audit: audit || {}
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
            'gateway_agent_bootstrap',
            'gateway_context_assemble',
            'gateway_job_cancel',
            'gateway_job_get',
            'gateway_memory_search',
            'gateway_memory_write',
            'SciCalculator'
        ]
    );
    const chromeBridgeTool = result.tools.find((tool) => tool.name === 'ChromeBridge');
    const bootstrapTool = result.tools.find((tool) => tool.name === 'gateway_agent_bootstrap');
    const memorySearchTool = result.tools.find((tool) => tool.name === 'gateway_memory_search');
    assert.equal(
        result.tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'),
        true
    );
    assert.ok(chromeBridgeTool && chromeBridgeTool.inputSchema);
    assert.equal(chromeBridgeTool.inputSchema.type, 'object');
    assert.equal(Array.isArray(chromeBridgeTool.inputSchema.oneOf), true);
    assert.equal(chromeBridgeTool.annotations.pluginType, 'hybridservice');
    assert.ok(bootstrapTool && bootstrapTool.inputSchema);
    assert.equal(bootstrapTool.annotations.gatewayManaged, true);
    assert.ok(memorySearchTool && memorySearchTool.inputSchema);
    assert.equal(memorySearchTool.annotations.gatewayManaged, true);
});

test('MCP adapter executes agent bootstrap through shared render behavior and returns a concise summary', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} from Ariadne\n[[阿里阿德涅日记本::Time::TagMemo]]'
    );
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const result = await adapter.callTool({
            name: 'gateway_agent_bootstrap',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            requestContext: {
                requestId: 'req-mcp-agent-bootstrap'
            }
        });

        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.requestId, 'req-mcp-agent-bootstrap');
        assert.equal(result.structuredContent.toolName, 'gateway_agent_bootstrap');
        assert.equal(result.structuredContent.result.renderedPrompt.includes('Hello Nova from Ariadne'), true);
        assert.equal(result.structuredContent.result.renderedPrompt.includes('记忆片段'), true);
        assert.equal(result.structuredContent.result.summary.includes('Bootstrap prompt ready for Ariadne'), true);
        assert.equal(result.content[0].text, result.structuredContent.result.renderedPrompt);
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Gateway-managed MCP tools expose additive operability trace metadata without replacing business payloads', async () => {
    const pluginManager = createMemoryPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'memory.write': {
                    concurrencyLimit: 2
                }
            }
        },
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

    const result = await adapter.callTool({
        name: 'gateway_memory_write',
        arguments: {
            target: {
                diary: 'Nova'
            },
            memory: {
                text: '记录 operability trace metadata。',
                tags: ['trace', 'mcp']
            },
            options: {
                idempotencyKey: 'idem-mcp-operability-trace-001'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-operability-trace',
        requestContext: {
            requestId: 'req-mcp-operability-trace'
        }
    });

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.result.writeStatus, 'created');
    assert.match(result.structuredContent.operability.traceId, /^agwop_/);
    assert.equal(result.structuredContent.operability.operationName, 'memory.write');
    assert.equal(result.structuredContent.result.writeStatus, 'created');
});

test('MCP adapter no longer publishes coding recall and coding memory writeback as callable tools', async () => {
    const pluginManager = createMemoryPluginManager();
    const adapter = createMcpAdapter(pluginManager);

    const recall = await adapter.callTool({
        name: 'gateway_recall_for_coding',
        arguments: {
            task: {
                description: '继续实现 gateway coding recall'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-coding-recall-removed',
        requestContext: {
            requestId: 'req-mcp-coding-recall-removed'
        }
    });
    const writeback = await adapter.callTool({
        name: 'gateway_memory_commit_for_coding',
        arguments: {
            task: {
                description: '提交 coding memory writeback'
            }
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-coding-writeback-removed',
        requestContext: {
            requestId: 'req-mcp-coding-writeback-removed'
        }
    });

    assert.equal(recall.isError, true);
    assert.equal(recall.error.code, 'MCP_NOT_FOUND');
    assert.equal(writeback.isError, true);
    assert.equal(writeback.error.code, 'MCP_NOT_FOUND');
});

test('MCP bootstrap tool exposes additive summary metadata without replacing the business payload', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello {{VarUserName}} from Ariadne');
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const result = await adapter.callTool({
            name: 'gateway_agent_bootstrap',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            requestContext: {
                requestId: 'req-mcp-bootstrap-summary'
            }
        });

        assert.equal(result.isError, false);
        assert.equal(result.structuredContent.result.summary.includes('Bootstrap prompt ready for Ariadne'), true);
        assert.equal(result.structuredContent.result.renderedPrompt.includes('Hello Nova from Ariadne'), true);
        assert.match(result.structuredContent.operability.traceId, /^agwop_/);
        assert.equal(result.structuredContent.operability.operationName, 'agents.render');
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Removed coding MCP tools return machine-readable not-found failures', async () => {
    const pluginManager = createMemoryPluginManager();
    const adapter = createMcpAdapter(pluginManager);

    const recall = await adapter.callTool({
        name: 'gateway_recall_for_coding',
        arguments: {},
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-coding-recall-invalid',
        requestContext: {
            requestId: 'req-mcp-coding-recall-invalid'
        }
    });
    const writeback = await adapter.callTool({
        name: 'gateway_memory_commit_for_coding',
        arguments: {},
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-coding-writeback-invalid',
        requestContext: {
            requestId: 'req-mcp-coding-writeback-invalid'
        }
    });

    assert.equal(recall.isError, true);
    assert.equal(recall.error.code, 'MCP_NOT_FOUND');
    assert.equal(writeback.isError, true);
    assert.equal(writeback.error.code, 'MCP_NOT_FOUND');
});

test('MCP memory search and context assembly enforce agent diary policy and use default diaries when omitted', async () => {
    const pluginManager = createMemoryPluginManager();
    const adapter = createMcpAdapter(pluginManager);

    const defaultSearch = await adapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: '查询最近讨论'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-memory-default',
        requestContext: {
            requestId: 'req-mcp-memory-default'
        }
    });
    const forbiddenSearch = await adapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: '查询不允许的 diary',
            diary: 'ProjectAlpha'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-memory-forbidden',
        requestContext: {
            requestId: 'req-mcp-memory-forbidden'
        }
    });

    assert.equal(defaultSearch.isError, false);
    assert.deepEqual(defaultSearch.structuredContent.result.diagnostics.targetDiaries.includes('Nova'), true);
    assert.equal(forbiddenSearch.isError, true);
    assert.equal(forbiddenSearch.error.code, 'MCP_FORBIDDEN');
});

test('Gateway-managed MCP tools preserve rate-limit and payload operability rejections as machine-readable metadata', async () => {
    const rateLimitedPluginManager = createMemoryPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'memory.search': {
                    rateLimit: {
                        limit: 1,
                        windowMs: 60000
                    }
                }
            }
        },
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
    const payloadLimitedPluginManager = createMemoryPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'context.assemble': {
                    payloadBytes: 128
                }
            }
        },
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
    const rateAdapter = createMcpAdapter(rateLimitedPluginManager);
    const payloadAdapter = createMcpAdapter(payloadLimitedPluginManager);

    const firstSearch = await rateAdapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: '查询最近讨论',
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-operability-rate-1',
        requestContext: {
            requestId: 'req-mcp-operability-rate-1'
        }
    });
    const secondSearch = await rateAdapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: '再次查询最近讨论',
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-operability-rate-2',
        requestContext: {
            requestId: 'req-mcp-operability-rate-2'
        }
    });
    const payloadRejected = await payloadAdapter.callTool({
        name: 'gateway_context_assemble',
        arguments: {
            diary: 'Nova',
            recentMessages: [{
                role: 'user',
                content: 'x'.repeat(400)
            }]
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-operability-payload',
        requestContext: {
            requestId: 'req-mcp-operability-payload'
        }
    });

    assert.equal(firstSearch.isError, false);
    assert.equal(secondSearch.isError, true);
    assert.equal(secondSearch.error.details.canonicalCode, 'AGW_RATE_LIMITED');
    assert.equal(secondSearch.error.details.operationName, 'memory.search');
    assert.equal(secondSearch.error.details.rejectionCategory, 'rate_limit');
    assert.equal(secondSearch.error.details.retryable, true);
    assert.equal(secondSearch.error.details.retryAfterMs > 0, true);
    assert.match(secondSearch.error.details.traceId, /^agwop_/);

    assert.equal(payloadRejected.isError, true);
    assert.equal(payloadRejected.error.details.canonicalCode, 'AGW_PAYLOAD_TOO_LARGE');
    assert.equal(payloadRejected.error.details.operationName, 'context.assemble');
    assert.equal(payloadRejected.error.details.rejectionCategory, 'payload_too_large');
    assert.equal(payloadRejected.error.details.retryable, false);
    assert.match(payloadRejected.error.details.traceId, /^agwop_/);
});

test('Gateway-managed MCP payload governance measures client-visible MCP payload rather than adapter-enriched internal body', async () => {
    const requestContext = {
        requestId: 'req-mcp-operability-payload-alignment'
    };
    const rawClientPayload = {
        query: 'hello',
        diary: 'Nova',
        requestContext
    };
    const payloadLimit = Buffer.byteLength(JSON.stringify(rawClientPayload), 'utf8') + 8;
    const pluginManager = createMemoryPluginManager({
        agentGatewayOperationalConfig: {
            operations: {
                'memory.search': {
                    payloadBytes: payloadLimit
                }
            }
        },
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

    const result = await adapter.callTool({
        name: 'gateway_memory_search',
        arguments: {
            query: 'hello',
            diary: 'Nova'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-operability-payload-alignment',
        requestContext
    });

    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.toolName, 'gateway_memory_search');
});

test('Gateway-managed MCP tools preserve concurrency operability rejection for render flows', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} from Ariadne'
    );
    const pluginManager = createDelayedRenderPluginManager(agentDir, 40, {
        agentGatewayOperationalConfig: {
            operations: {
                'agents.render': {
                    concurrencyLimit: 1
                }
            }
        }
    });
    const adapter = createMcpAdapter(pluginManager);

    try {
        const firstPromise = adapter.callTool({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            sessionId: 'sess-mcp-operability-render-1',
            requestContext: {
                requestId: 'req-mcp-operability-render-1'
            }
        });
        const secondPromise = adapter.callTool({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Echo'
                }
            },
            sessionId: 'sess-mcp-operability-render-2',
            requestContext: {
                requestId: 'req-mcp-operability-render-2'
            }
        });
        const [first, second] = await Promise.all([firstPromise, secondPromise]);

        assert.equal(first.isError, false);
        assert.equal(first.structuredContent.operability.operationName, 'agents.render');
        assert.equal(second.isError, true);
        assert.equal(second.error.details.canonicalCode, 'AGW_CONCURRENCY_LIMITED');
        assert.equal(second.error.details.operationName, 'agents.render');
        assert.equal(second.error.details.rejectionCategory, 'concurrency_limit');
        assert.equal(second.error.details.retryable, true);
        assert.match(second.error.details.traceId, /^agwop_/);
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('MCP adapter executes canonical agent render tool with shared render metadata', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} from Ariadne\n[[阿里阿德涅日记本::Time::TagMemo]]'
    );
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const result = await adapter.callTool({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            sessionId: 'sess-mcp-agent-render',
            requestContext: {
                requestId: 'req-mcp-agent-render'
            }
        });

        assert.equal(result.isError, false);
        assert.equal(result.status, 'completed');
        assert.equal(result.structuredContent.requestId, 'req-mcp-agent-render');
        assert.equal(result.structuredContent.toolName, 'gateway_agent_render');
        assert.equal(result.structuredContent.result.renderedPrompt.includes('Hello Nova from Ariadne'), true);
        assert.equal(result.structuredContent.result.renderedPrompt.includes('记忆片段'), true);
        assert.equal(result.structuredContent.result.renderMeta.memoryRecallApplied, true);
        assert.deepEqual(result.structuredContent.result.renderMeta.recallSources, ['tagmemo']);
        assert.equal(result.content[0].text, result.structuredContent.result.renderedPrompt);
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('MCP adapter lists and fetches the published agent render prompt through shared render behavior', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} from Ariadne\n[[阿里阿德涅日记本::Time::TagMemo]]'
    );
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const promptList = await adapter.listPrompts({
            requestContext: {
                requestId: 'req-mcp-prompts-list'
            }
        });
        const promptResult = await adapter.getPrompt({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            requestContext: {
                requestId: 'req-mcp-prompts-get'
            }
        });

        assert.equal(promptList.meta.requestId, 'req-mcp-prompts-list');
        assert.deepEqual(promptList.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
        assert.equal(promptList.prompts[0].arguments[0].name, 'agentId');
        assert.equal(promptResult.name, 'gateway_agent_render');
        assert.equal(promptResult.messages[0].role, 'system');
        assert.equal(promptResult.messages[0].content[0].text.includes('Hello Nova from Ariadne'), true);
        assert.equal(promptResult.messages[0].content[0].text.includes('记忆片段'), true);
        assert.equal(promptResult.meta.requestId, 'req-mcp-prompts-get');
        assert.equal(promptResult.meta.agentId, 'Ariadne');
        assert.equal(promptResult.meta.renderMeta.memoryRecallApplied, true);
        assert.equal(promptResult.meta.operability.operationName, 'agents.render');
        assert.match(promptResult.meta.operability.traceId, /^agwop_/);
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
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
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Ariadne system prompt\n{{VarUserName}}\n[[VCP元思考::Auto::Group]]'
    );
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const listed = await adapter.listResources({
            agentId: 'Ariadne',
            requestContext: {
                requestId: 'req-mcp-resources-list'
            }
        });
        const capabilitiesUri = listed.resources[0].uri;
        const memoryTargetsUri = listed.resources[1].uri;
        const profileUri = listed.resources[2].uri;
        const promptTemplateUri = listed.resources[3].uri;
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
        const profile = await adapter.readResource({
            uri: profileUri,
            requestContext: {
                requestId: 'req-mcp-resources-read-profile'
            }
        });
        const promptTemplate = await adapter.readResource({
            uri: promptTemplateUri,
            requestContext: {
                requestId: 'req-mcp-resources-read-template'
            }
        });

        assert.deepEqual(
            listed.resources.map((resource) => resource.uri),
            [
                'vcp://agent-gateway/capabilities/Ariadne',
                'vcp://agent-gateway/memory-targets/Ariadne',
                'vcp://agent-gateway/agents/Ariadne/profile',
                'vcp://agent-gateway/agents/Ariadne/prompt-template'
            ]
        );
        assert.equal(JSON.parse(capabilities.contents[0].text).server.bridgeVersion, 'v1');
        assert.ok(Array.isArray(JSON.parse(memoryTargets.contents[0].text)));
        const profilePayload = JSON.parse(profile.contents[0].text);
        const promptTemplatePayload = JSON.parse(promptTemplate.contents[0].text);
        assert.equal(profilePayload.agentId, 'Ariadne');
        assert.deepEqual(
            profilePayload.accessibleTools.map((tool) => tool.name).sort(),
            ['ChromeBridge', 'RemoteSearch', 'SciCalculator']
        );
        assert.equal(promptTemplatePayload.prompt.raw.includes('{{VarUserName}}'), true);
        assert.equal(promptTemplatePayload.prompt.placeholderSummary.metaThinkingBlocks, 1);

        await assert.rejects(
            () => adapter.readResource({
                uri: 'vcp://agent-gateway/jobs/Ariadne'
            }),
            (error) => error && error.code === 'MCP_RESOURCE_UNSUPPORTED'
        );
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('MCP adapter exposes canonical job tools and job-scoped runtime event resources', async () => {
    const pluginManager = createPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });
    const authContext = {
        requestId: 'req-job-runtime-origin',
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-runtime',
        runtime: 'mcp',
        source: 'mcp-job-runtime',
        gatewayId: 'gw-mcp-runtime'
    };
    const job = bundle.jobRuntimeService.createAcceptedJob({
        operation: 'agents.render',
        authContext,
        target: {
            type: 'tool',
            id: 'gateway_agent_bootstrap'
        },
        metadata: {
            phase: 'queued'
        }
    });
    bundle.jobRuntimeService.updateJob(job.jobId, {
        status: 'running',
        metadata: {
            worker: 'job-runtime-test'
        }
    });

    const listedTools = await adapter.listTools({
        agentId: 'Ariadne',
        requestContext: {
            requestId: 'req-mcp-job-runtime-tools-list'
        }
    });
    const jobRead = await adapter.callTool({
        name: 'gateway_job_get',
        arguments: {
            jobId: job.jobId
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-runtime',
        authContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-read'
        }
    });
    const jobCancel = await adapter.callTool({
        name: 'gateway_job_cancel',
        arguments: {
            jobId: job.jobId
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-runtime',
        authContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-cancel'
        }
    });
    const eventsResource = await adapter.readResource({
        uri: `vcp://agent-gateway/jobs/${encodeURIComponent(job.jobId)}/events`,
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-runtime',
        authContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-events'
        }
    });
    const eventPayload = JSON.parse(eventsResource.contents[0].text);

    assert.equal(listedTools.tools.some((tool) => tool.name === 'gateway_job_get'), true);
    assert.equal(listedTools.tools.some((tool) => tool.name === 'gateway_job_cancel'), true);
    assert.equal(adapter.supportedResourceTemplates.includes('vcp://agent-gateway/jobs/{jobId}/events'), true);

    assert.equal(jobRead.isError, false);
    assert.equal(jobRead.structuredContent.result.job.jobId, job.jobId);
    assert.equal(jobRead.structuredContent.result.job.status, 'running');

    assert.equal(jobCancel.isError, false);
    assert.equal(jobCancel.structuredContent.result.job.status, 'cancelled');

    assert.equal(eventsResource.contents[0].uri, `vcp://agent-gateway/jobs/${encodeURIComponent(job.jobId)}/events`);
    assert.equal(eventPayload.jobId, job.jobId);
    assert.equal(eventPayload.job.jobId, job.jobId);
    assert.deepEqual(
        eventPayload.events.map((event) => event.eventType),
        ['job.accepted', 'job.running', 'job.cancelled']
    );
});

test('MCP job runtime preserves machine-readable failure identity and visibility rules', async () => {
    const pluginManager = createPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });
    const ownerAuthContext = {
        requestId: 'req-job-runtime-owner',
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-owner',
        runtime: 'mcp',
        source: 'mcp-job-runtime',
        gatewayId: 'gw-owner'
    };
    const completedJob = bundle.jobRuntimeService.createAcceptedJob({
        operation: 'memory.write',
        authContext: ownerAuthContext,
        target: {
            type: 'tool',
            id: 'gateway_memory_write'
        }
    });
    bundle.jobRuntimeService.completeJob(completedJob.jobId, {
        completedBy: 'job-runtime-test'
    });

    const missing = await adapter.callTool({
        name: 'gateway_job_get',
        arguments: {
            jobId: 'missing-job-id'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-owner',
        authContext: ownerAuthContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-missing'
        }
    });
    const invalidCancel = await adapter.callTool({
        name: 'gateway_job_cancel',
        arguments: {
            jobId: completedJob.jobId
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-job-owner',
        authContext: ownerAuthContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-invalid-cancel'
        }
    });

    assert.equal(missing.isError, true);
    assert.equal(missing.error.code, 'MCP_NOT_FOUND');
    assert.equal(missing.error.details.canonicalCode, 'AGW_NOT_FOUND');

    assert.equal(invalidCancel.isError, true);
    assert.equal(invalidCancel.error.code, 'MCP_INVALID_ARGUMENTS');
    assert.equal(invalidCancel.error.details.canonicalCode, 'AGW_VALIDATION_ERROR');
    assert.equal(invalidCancel.error.details.status, 'completed');

    await assert.rejects(
        () => adapter.readResource({
            uri: `vcp://agent-gateway/jobs/${encodeURIComponent(completedJob.jobId)}/events`,
            agentId: 'OtherAgent',
            sessionId: 'sess-foreign',
            authContext: {
                requestId: 'req-job-runtime-foreign',
                agentId: 'OtherAgent',
                sessionId: 'sess-foreign',
                runtime: 'mcp',
                source: 'mcp-job-runtime',
                gatewayId: 'gw-owner'
            },
            requestContext: {
                requestId: 'req-mcp-job-runtime-forbidden-events'
            }
        }),
        (error) => (
            error &&
            error.code === 'MCP_FORBIDDEN' &&
            error.details.canonicalCode === 'AGW_FORBIDDEN'
        )
    );
});

test('MCP job runtime accepts canonical visibility identity from auth context without explicit agentId input', async () => {
    const pluginManager = createPluginManager();
    const bundle = getGatewayServiceBundle(pluginManager);
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: bundle
    });
    const authContext = {
        requestId: 'req-job-runtime-auth-only',
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-auth-only',
        runtime: 'mcp',
        source: 'mcp-job-runtime',
        gatewayId: 'gw-auth-only'
    };
    const job = bundle.jobRuntimeService.createAcceptedJob({
        operation: 'agents.render',
        authContext,
        target: {
            type: 'tool',
            id: 'gateway_agent_bootstrap'
        }
    });

    const jobRead = await adapter.callTool({
        name: 'gateway_job_get',
        arguments: {
            jobId: job.jobId
        },
        authContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-auth-only-read'
        }
    });
    const eventsResource = await adapter.readResource({
        uri: `vcp://agent-gateway/jobs/${encodeURIComponent(job.jobId)}/events`,
        authContext,
        requestContext: {
            requestId: 'req-mcp-job-runtime-auth-only-events'
        }
    });

    assert.equal(jobRead.isError, false);
    assert.equal(jobRead.structuredContent.result.job.jobId, job.jobId);
    assert.equal(JSON.parse(eventsResource.contents[0].text).jobId, job.jobId);
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
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello {{VarUserName}} from Ariadne');
    const pluginManager = createRenderPluginManager(agentDir);
    const harness = createMcpServerHarness(pluginManager);

    try {
        const promptListResponse = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'prompts/list',
            params: {}
        });
        const promptGetResponse = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Nova'
                    }
                }
            }
        });
        const callResponse = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 3,
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

        assert.equal(promptListResponse.jsonrpc, '2.0');
        assert.equal(Array.isArray(promptListResponse.result.prompts), true);
        assert.equal(promptGetResponse.jsonrpc, '2.0');
        assert.equal(promptGetResponse.result.messages[0].content[0].text.includes('Hello Nova from Ariadne'), true);
        assert.equal(callResponse.jsonrpc, '2.0');
        assert.equal(callResponse.result.isError, false);
        assert.equal(callResponse.result.status, 'completed');
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('MCP server harness supports the base lifecycle handshake expected by MCP clients', async () => {
    const pluginManager = createPluginManager();
    const harness = createMcpServerHarness(pluginManager);

    const initializeResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: {
                name: 'trae',
                version: '1.0.0'
            }
        }
    });
    const pingResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'ping'
    });
    const initializedNotificationResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        method: 'notifications/initialized'
    });

    assert.equal(initializeResponse.jsonrpc, '2.0');
    assert.equal(initializeResponse.result.protocolVersion, '2025-06-18');
    assert.equal(initializeResponse.result.serverInfo.name, 'vcp-agent-gateway');
    assert.equal(typeof initializeResponse.result.serverInfo.version, 'string');
    assert.deepEqual(initializeResponse.result.capabilities.prompts, { listChanged: false });
    assert.deepEqual(initializeResponse.result.capabilities.resources, { listChanged: false });
    assert.deepEqual(initializeResponse.result.capabilities.tools, { listChanged: false });
    assert.deepEqual(pingResponse.result, {});
    assert.equal(initializedNotificationResponse.jsonrpc, '2.0');
    assert.equal(initializedNotificationResponse.id, null);
    assert.equal(initializedNotificationResponse.result, null);
});

test('MCP discovery tolerates agent-less list requests from standard MCP clients', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello {{VarUserName}} from Ariadne');
    const pluginManager = createRenderPluginManager(agentDir);
    const harness = createMcpServerHarness(pluginManager);

    try {
        const toolsResponse = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list'
        });
        const resourcesResponse = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 2,
            method: 'resources/list'
        });

        assert.equal(toolsResponse.jsonrpc, '2.0');
        assert.equal(toolsResponse.result.meta.agentId, 'Ariadne');
        assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'SciCalculator'), true);
        assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'gateway_agent_render'), false);
        assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'gateway_agent_bootstrap'), true);
        assert.equal(resourcesResponse.jsonrpc, '2.0');
        assert.equal(resourcesResponse.result.meta.agentId, 'Ariadne');
        assert.equal(resourcesResponse.result.resources.some((resource) => resource.uri === 'vcp://agent-gateway/agents/Ariadne/profile'), true);
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('MCP discovery falls back to global gateway-managed tools when no default agent can be inferred', async () => {
    const pluginManager = createRenderPluginManager('/tmp/non-existent-agent-dir', {
        agentMappings: {
            Boreas: 'Boreas.md'
        }
    });
    const harness = createMcpServerHarness(pluginManager);

    const toolsResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
    });
    const resourcesResponse = await harness.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/list'
    });

    assert.equal(toolsResponse.jsonrpc, '2.0');
    assert.equal(toolsResponse.result.meta.agentId, undefined);
    assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'gateway_agent_render'), false);
    assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'gateway_agent_bootstrap'), true);
    assert.equal(toolsResponse.result.tools.some((tool) => tool.name === 'SciCalculator'), false);
    assert.deepEqual(resourcesResponse.result.resources, []);
    assert.equal(resourcesResponse.result.meta.agentId, undefined);
});

test('Gateway-managed MCP tools reuse one deferred runtime envelope for render and bootstrap', async () => {
    const pluginManager = createPluginManager();
    const baseBundle = getGatewayServiceBundle(pluginManager);
    const deferredBundle = {
        ...baseBundle,
        agentRegistryService: {
            ...baseBundle.agentRegistryService,
            async renderAgent(agentId) {
                return createDeferredGatewayResult(baseBundle.jobRuntimeService, {
                    status: 'accepted',
                    operation: 'agents.render',
                    authContext: {
                        requestId: 'req-deferred-render-origin',
                        agentId,
                        sessionId: '',
                        runtime: 'mcp',
                        source: 'mcp-agent-render',
                        gatewayId: 'gw-deferred'
                    },
                    target: {
                        type: 'agent',
                        id: agentId
                    },
                    metadata: {
                        publication: 'tool'
                    }
                });
            }
        }
    };
    const adapter = createMcpAdapter(pluginManager, {
        gatewayServiceBundle: deferredBundle
    });

    const render = await adapter.callTool({
        name: 'gateway_agent_render',
        arguments: {
            agentId: 'Ariadne'
        },
        requestContext: {
            requestId: 'req-mcp-deferred-render'
        }
    });
    const bootstrap = await adapter.callTool({
        name: 'gateway_agent_bootstrap',
        arguments: {
            agentId: 'Ariadne'
        },
        agentId: 'Ariadne',
        sessionId: 'sess-mcp-deferred-bootstrap',
        requestContext: {
            requestId: 'req-mcp-deferred-bootstrap'
        }
    });

    assert.equal(render.deferred, true);
    assert.equal(render.status, 'accepted');
    assert.equal(render.structuredContent.toolName, 'gateway_agent_render');
    assert.equal(render.structuredContent.runtime.eventResourceUri.includes('/events'), true);
    assert.equal(render.structuredContent.operability.operationName, 'agents.render');

    assert.equal(bootstrap.deferred, true);
    assert.equal(bootstrap.status, 'accepted');
    assert.equal(bootstrap.structuredContent.job.status, 'accepted');
    assert.equal(bootstrap.structuredContent.runtime.eventResourceUri.includes(encodeURIComponent(bootstrap.structuredContent.job.jobId)), true);
    assert.equal(bootstrap.structuredContent.operability.operationName, 'agents.render');
});

test('MCP prompt publication and agent preview resources preserve machine-readable missing-agent failures', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello from Ariadne');
    const pluginManager = createRenderPluginManager(agentDir);
    const harness = createMcpServerHarness(pluginManager);
    const adapter = createMcpAdapter(pluginManager);

    try {
        const promptFailure = await harness.handleRequest({
            jsonrpc: '2.0',
            id: 99,
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'MissingAgent'
                }
            }
        });

        assert.equal(promptFailure.error.data.code, 'MCP_NOT_FOUND');
        assert.equal(promptFailure.error.data.canonicalCode, 'AGW_NOT_FOUND');

        await assert.rejects(
            () => adapter.readResource({
                uri: 'vcp://agent-gateway/agents/MissingAgent/profile',
                requestContext: {
                    requestId: 'req-mcp-missing-agent-profile'
                }
            }),
            (error) => (
                error &&
                error.code === 'MCP_NOT_FOUND' &&
                error.details.canonicalCode === 'AGW_NOT_FOUND'
            )
        );
    } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
    }
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

test('MCP agent render adapter remains semantically aligned with representative native render flows', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(
        agentDir,
        'Ariadne.md',
        'Hello {{VarUserName}} from Ariadne\n[[阿里阿德涅日记本::Time::TagMemo]]'
    );
    const pluginManager = createRenderPluginManager(agentDir);
    const adapter = createMcpAdapter(pluginManager);
    const server = await createNativeServer(pluginManager);

    try {
        const nativeRenderResponse = await fetch(`${server.baseUrl}/agent_gateway/agents/Ariadne/render`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                requestContext: {
                    requestId: 'req-native-mcp-render',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-mcp-render'
                },
                variables: {
                    VarUserName: 'Nova'
                }
            })
        });
        const nativeRenderPayload = await nativeRenderResponse.json();
        const mcpRender = await adapter.callTool({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'Ariadne',
                variables: {
                    VarUserName: 'Nova'
                }
            },
            sessionId: 'sess-native-mcp-render',
            requestContext: {
                requestId: 'req-mcp-render-parity'
            }
        });

        const nativeMissingResponse = await fetch(`${server.baseUrl}/agent_gateway/agents/MissingAgent/render`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                requestContext: {
                    requestId: 'req-native-mcp-render-missing',
                    agentId: 'MissingAgent',
                    sessionId: 'sess-native-mcp-render-missing'
                }
            })
        });
        const nativeMissingPayload = await nativeMissingResponse.json();
        const mcpMissing = await adapter.callTool({
            name: 'gateway_agent_render',
            arguments: {
                agentId: 'MissingAgent'
            },
            sessionId: 'sess-native-mcp-render-missing',
            requestContext: {
                requestId: 'req-mcp-render-missing'
            }
        });

        assert.equal(nativeRenderResponse.status, 200);
        assert.equal(mcpRender.isError, false);
        assert.equal(nativeRenderPayload.data.renderedPrompt, mcpRender.structuredContent.result.renderedPrompt);
        assert.deepEqual(nativeRenderPayload.data.renderMeta, mcpRender.structuredContent.result.renderMeta);

        assert.equal(nativeMissingResponse.status, 404);
        assert.equal(nativeMissingPayload.code, 'AGW_NOT_FOUND');
        assert.equal(mcpMissing.isError, true);
        assert.equal(mcpMissing.error.code, 'MCP_NOT_FOUND');
        assert.equal(mcpMissing.error.details.canonicalCode, 'AGW_NOT_FOUND');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});
