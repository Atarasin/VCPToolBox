const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { getGatewayServiceBundle } = require('../../../modules/agentGateway/createGatewayServiceBundle');
const { createRecallProjectionService } = require('../../../modules/agentGateway/services/recallProjectionService');

function cosineSimilarity(vectorA, vectorB) {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || vectorA.length !== vectorB.length) {
        return 0;
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < vectorA.length; index += 1) {
        dot += vectorA[index] * vectorB[index];
        normA += vectorA[index] * vectorA[index];
        normB += vectorB[index] * vectorB[index];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-native-routes-'));
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

function createKnowledgeBaseManager(overrides = {}) {
    const diaries = overrides.diaries || ['Nova', 'ProjectAlpha', 'SharedMemory'];
    const metadataByPath = overrides.metadataByPath || {
        'Nova/2026-03-20.md': {
            sourceDiary: 'Nova',
            sourcePath: 'Nova/2026-03-20.md',
            updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
            tags: ['项目', '会议', '桥接']
        }
    };
    const searchResults = overrides.searchResults || {
        Nova: [
            {
                text: '上次A项目会议讨论了接口桥接方案与权限策略。',
                score: 0.921,
                sourceFile: '2026-03-20.md',
                fullPath: 'Nova/2026-03-20.md'
            }
        ]
    };
    const timeChunksByPath = overrides.timeChunksByPath || {
        'Nova/2026-03-20.md': {
            text: '上次A项目会议讨论了接口桥接方案与权限策略。',
            sourceFile: 'Nova/2026-03-20.md',
            sourceDiary: 'Nova',
            vector: [0.9, 0.1, 0.4]
        }
    };

    return {
        config: {
            apiKey: 'test-key',
            apiUrl: 'https://example.com/embeddings',
            model: 'test-embedding-model'
        },
        listDiaryNames() {
            return diaries;
        },
        async search(diaryName, queryVector, k) {
            if (overrides.search) {
                return overrides.search(diaryName, queryVector, k);
            }
            return (searchResults[diaryName] || []).slice(0, k).map((item) => ({ ...item }));
        },
        applyTagBoost(vector, tagBoost) {
            if (overrides.applyTagBoost) {
                return overrides.applyTagBoost(vector, tagBoost);
            }
            return {
                vector: new Float32Array(vector),
                info: {
                    matchedTags: ['项目', '会议'],
                    boostFactor: tagBoost
                }
            };
        },
        async deduplicateResults(candidates) {
            return overrides.deduplicateResults ? overrides.deduplicateResults(candidates) : candidates;
        },
        async getChunksByFilePaths(filePaths) {
            if (overrides.getChunksByFilePaths) {
                return overrides.getChunksByFilePaths(filePaths);
            }
            return filePaths
                .filter((filePath) => timeChunksByPath[filePath])
                .map((filePath) => ({ ...timeChunksByPath[filePath] }));
        },
        async getOpenClawFileMetadata(sourcePath) {
            return overrides.getOpenClawFileMetadata
                ? overrides.getOpenClawFileMetadata(sourcePath)
                : (metadataByPath[sourcePath] || null);
        }
    };
}

function createRagPlugin(overrides = {}) {
    return {
        async getSingleEmbeddingCached(text) {
            return overrides.getSingleEmbeddingCached ? overrides.getSingleEmbeddingCached(text) : [0.9, 0.1, 0.4];
        },
        timeParser: {
            parse(text) {
                return overrides.parseTime
                    ? overrides.parseTime(text)
                    : (text.includes('上周')
                        ? [{ start: new Date('2026-03-16T00:00:00.000Z'), end: new Date('2026-03-22T23:59:59.999Z') }]
                        : []);
            }
        },
        semanticGroups: {
            detectAndActivateGroups(text) {
                return overrides.detectAndActivateGroups
                    ? overrides.detectAndActivateGroups(text)
                    : (text.includes('项目') ? new Map([['项目', { strength: 1 }]]) : new Map());
            },
            async getEnhancedVector(query, activatedGroups, queryVector) {
                return overrides.getEnhancedVector
                    ? overrides.getEnhancedVector(query, activatedGroups, queryVector)
                    : (Array.isArray(queryVector)
                        ? queryVector.map((value, index) => value + (index === 0 ? 0.01 : 0))
                        : queryVector);
            }
        },
        async _rerankDocuments(query, documents, originalK) {
            return overrides.rerankDocuments
                ? overrides.rerankDocuments(query, documents, originalK)
                : documents.slice().sort((left, right) => (right.score || 0) - (left.score || 0)).slice(0, originalK);
        },
        async _getTimeRangeFilePaths(diaryName) {
            return overrides.getTimeRangeFilePaths
                ? overrides.getTimeRangeFilePaths(diaryName)
                : (diaryName === 'Nova' ? ['Nova/2026-03-20.md'] : []);
        },
        cosineSimilarity
    };
}

function createPluginManager(overrides = {}) {
    const plugins = overrides.plugins || new Map([
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
        ['DailyNote', {
            name: 'DailyNote',
            displayName: '日记写入器',
            description: '写入 durable memory。',
            pluginType: 'synchronous',
            communication: {
                protocol: 'stdio',
                timeout: 15000
            },
            capabilities: {
                invocationCommands: [
                    {
                        description: '写入日记条目。'
                    }
                ]
            }
        }]
    ]);

    return {
        plugins,
        vectorDBManager: overrides.vectorDBManager || createKnowledgeBaseManager(),
        messagePreprocessors: new Map([['RAGDiaryPlugin', overrides.ragPlugin || createRagPlugin()]]),
        openClawBridgeConfig: overrides.openClawBridgeConfig || {
            rag: {
                agentDiaryMap: {
                    Ariadne: ['Nova', 'SharedMemory']
                }
            }
        },
        agentManager: overrides.agentManager,
        agentRegistryRenderPrompt: overrides.agentRegistryRenderPrompt,
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
            if (toolName === 'DailyNote') {
                return {
                    status: 'success',
                    message: 'Diary saved to /tmp/native-memory.txt'
                };
            }
            return {
                toolName,
                receivedArgs: args
            };
        },
        ...overrides
    };
}

function createProtectedToolPluginManager(overrides = {}) {
    const basePluginManager = createPluginManager(overrides);
    return {
        ...basePluginManager,
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
                                description: '执行受保护操作。'
                            }
                        ]
                    }
                };
            }
            return basePluginManager.getPlugin(toolName);
        }
    };
}

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

async function createServerWithRecallMocks(pluginManager, recallOverrides = {}) {
    // Pre-build the service bundle so mock recall services are injected
    // before createAgentGatewayRoutes destructures them at router creation.
    const bundle = getGatewayServiceBundle(pluginManager, { gatewayVersion: 'v1' });
    bundle.recallRuntimeService = createMockRecallRuntimeService(recallOverrides.recallRuntime);
    bundle.recallProjectionService = createMockRecallProjectionService(recallOverrides.recallProjection);

    return createServer(pluginManager);
}

async function createServer(pluginManager) {
    const app = express();
    app.use(express.json());

    const nativeRoutes = createAgentGatewayRoutes(pluginManager);

    assert.ok(pluginManager.__agentGatewayServiceBundle, 'native adapter should create the shared bundle');

    app.use('/agent_gateway', nativeRoutes);

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

test('GET /agent_gateway/capabilities returns native envelope and shared capability payload', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/capabilities?agentId=Ariadne&requestId=req-native-cap-001`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('x-agent-gateway-version'), 'v1');
        assert.equal(payload.success, true);
        assert.equal(payload.meta.requestId, 'req-native-cap-001');
        assert.equal(payload.meta.gatewayVersion, 'v1');
        assert.equal(payload.meta.authMode, 'admin_transition');
        assert.equal(payload.data.server.bridgeVersion, 'v1');
        assert.deepEqual(payload.data.sections, ['tools', 'memory', 'context', 'jobs', 'events']);
        assert.equal(payload.data.memory.targets.length, 2);
        assert.equal(payload.data.memory.targets.every((target) => typeof target.id === 'string' && target.id), true);
        assert.deepEqual(payload.data.tools.map((tool) => tool.name), ['DailyNote', 'RemoteSearch', 'SciCalculator']);
        assert.equal(payload.data.jobs.supported, true);
        assert.deepEqual(payload.data.jobs.actions, ['poll', 'cancel']);
        assert.equal(payload.data.events.supported, true);
        assert.deepEqual(payload.data.events.transports, ['sse']);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('GET /agent_gateway/health returns native readiness snapshot', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/health?requestId=req-native-health-001`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.status, 'ok');
        assert.equal(payload.data.pluginManagerReady, true);
        assert.equal(payload.data.knowledgeBaseReady, true);
        assert.equal(payload.data.gatewayVersion, 'v1');
        assert.equal(payload.meta.requestId, 'req-native-health-001');
        assert.equal(payload.meta.operationName, 'health.read');
        assert.match(payload.meta.traceId, /^agwop_/);
        assert.ok(Date.parse(payload.data.serverTime));
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('GET /agent_gateway/agents and related detail/render routes expose registry output', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello {{VarUserName}} from Ariadne\n[[阿里阿德涅日记本::Time::TagMemo]]');
    await writeAgentFile(agentDir, 'roles/Bard.md', 'Bard prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md',
            Bard: 'roles/Bard.md'
        }),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || '')
    });
    const server = await createServer(pluginManager);

    try {
        const listResponse = await fetch(`${server.baseUrl}/agent_gateway/agents?requestId=req-native-agent-list`);
        const listPayload = await listResponse.json();
        assert.equal(listResponse.status, 200);
        assert.equal(listPayload.success, true);
        assert.deepEqual(listPayload.data.agents.map((agent) => agent.agentId), ['Ariadne', 'Bard']);

        const detailResponse = await fetch(`${server.baseUrl}/agent_gateway/agents/Ariadne?requestId=req-native-agent-detail`);
        const detailPayload = await detailResponse.json();
        assert.equal(detailResponse.status, 200);
        assert.equal(detailPayload.data.agentId, 'Ariadne');
        assert.equal(detailPayload.data.prompt.raw.includes('{{VarUserName}}'), true);

        const renderResponse = await fetch(`${server.baseUrl}/agent_gateway/agents/Ariadne/render`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                requestContext: {
                    requestId: 'req-native-agent-render',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-agent-render'
                },
                variables: {
                    VarUserName: 'Nova'
                }
            })
        });
        const renderPayload = await renderResponse.json();
        assert.equal(renderResponse.status, 200);
        assert.equal(renderPayload.success, true);
        assert.equal(renderPayload.data.renderedPrompt.includes('Nova'), true);
        assert.equal(renderPayload.data.renderMeta.memoryRecallApplied, false);
        assert.deepEqual(renderPayload.data.renderMeta.recallSources, []);
        assert.equal(renderPayload.data.renderMeta.filteredByPolicy, false);
        assert.deepEqual(renderPayload.data.meta.variableKeys, ['VarUserName']);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native memory and context routes reuse shared runtime services', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const targetsResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/targets?agentId=Ariadne&requestId=req-native-targets`);
        const targetsPayload = await targetsResponse.json();
        assert.equal(targetsResponse.status, 200);
        assert.equal(targetsPayload.data.targets.length, 2);
        assert.equal(targetsPayload.data.targets.every((target) => typeof target.id === 'string' && target.id), true);

        const searchResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '上周项目会议讨论了什么',
                requestContext: {
                    requestId: 'req-native-memory-search',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-memory-search'
                }
            })
        });
        const searchPayload = await searchResponse.json();
        assert.equal(searchResponse.status, 200);
        assert.equal(searchPayload.success, true);
        assert.equal(Array.isArray(searchPayload.data.items), true);

        const contextResponse = await fetch(`${server.baseUrl}/agent_gateway/context/assemble`, {
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
                requestContext: {
                    requestId: 'req-native-context',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-context'
                }
            })
        });
        const contextPayload = await contextResponse.json();
        assert.equal(contextResponse.status, 200);
        assert.equal(contextPayload.success, true);
        assert.equal(Array.isArray(contextPayload.data.recallBlocks), true);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Removed native coding routes return 404 after MCP coding capability retirement', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const recallResponse = await fetch(`${server.baseUrl}/agent_gateway/coding/recall`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                task: {
                    description: '继续实现 gateway coding recall'
                },
                files: ['modules/agentGateway/adapters/mcpAdapter.js'],
                diary: 'Nova',
                requestContext: {
                    requestId: 'req-native-coding-recall',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-coding-recall'
                }
            })
        });
        const writebackResponse = await fetch(`${server.baseUrl}/agent_gateway/coding/memory-writeback`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                task: {
                    description: '提交 coding writeback'
                },
                summary: '把 MCP 收口为 backend-only proxy。',
                repository: {
                    repositoryId: 'vcp-toolbox',
                    workspaceRoot: '/home/zh/projects/VCP/VCPToolBox',
                    tags: ['repo:vcp-toolbox']
                },
                files: ['modules/agentGateway/mcpStdioServer.js'],
                symbols: ['initializeBackendProxyMcpRuntime'],
                diary: 'Nova',
                requestContext: {
                    requestId: 'req-native-coding-writeback',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-coding-writeback'
                }
            })
        });

        assert.equal(recallResponse.status, 404);
        assert.equal(writebackResponse.status, 404);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/tools/:toolName/invoke returns native success payload and request meta', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/tools/SciCalculator/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    expression: '1+1'
                },
                requestContext: {
                    requestId: 'req-native-tool',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-tool'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.meta.requestId, 'req-native-tool');
        assert.equal(payload.meta.toolStatus, 'completed');
        assert.equal(payload.meta.authMode, 'admin_transition');
        assert.equal(payload.data.toolName, 'SciCalculator');
        assert.equal(payload.data.result.toolName, 'SciCalculator');
        assert.equal(payload.data.result.receivedArgs.__agentGatewayContext.runtime, 'native');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native gateway surfaces operational trace metadata, payload protection and metrics snapshot', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        agentGatewayOperationalConfig: {
            operations: {
                'tool.invoke': {
                    payloadBytes: 200
                },
                'metrics.read': {
                    rateLimit: {
                        limit: 5,
                        windowMs: 60000
                    }
                }
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const oversizedBody = {
            args: {
                expression: '1+1',
                notes: 'x'.repeat(512)
            },
            requestContext: {
                requestId: 'req-native-tool-oversized',
                agentId: 'Ariadne',
                sessionId: 'sess-native-tool-oversized'
            }
        };
        const toolResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/SciCalculator/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(oversizedBody)
        });
        const toolPayload = await toolResponse.json();

        assert.equal(toolResponse.status, 413);
        assert.equal(toolPayload.success, false);
        assert.equal(toolPayload.code, 'AGW_PAYLOAD_TOO_LARGE');
        assert.equal(toolPayload.meta.operationName, 'tool.invoke');
        assert.match(toolPayload.meta.traceId, /^agwop_/);
        assert.equal(toolResponse.headers.get('x-agent-gateway-trace-id'), toolPayload.meta.traceId);

        const metricsResponse = await fetch(`${server.baseUrl}/agent_gateway/metrics?requestId=req-native-metrics-001`);
        const metricsPayload = await metricsResponse.json();

        assert.equal(metricsResponse.status, 200);
        assert.equal(metricsPayload.success, true);
        assert.equal(metricsPayload.meta.operationName, 'metrics.read');
        assert.match(metricsPayload.meta.traceId, /^agwop_/);
        assert.equal(metricsPayload.data.totals.rejected >= 1, true);
        assert.equal(
            metricsPayload.data.recentRejections.some((entry) =>
                entry.operationName === 'tool.invoke' && entry.code === 'AGW_PAYLOAD_TOO_LARGE'),
            true
        );
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native gateway releases operability state when shared runtime throws unexpectedly', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        ragPlugin: createRagPlugin({
            getSingleEmbeddingCached: async () => []
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/memory/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '上周项目讨论了什么',
                requestContext: {
                    requestId: 'req-native-search-throw-001',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-search-throw-001'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 500);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'AGW_INTERNAL_ERROR');
        assert.equal(payload.meta.operationName, 'memory.search');

        const metricsResponse = await fetch(`${server.baseUrl}/agent_gateway/metrics?requestId=req-native-metrics-throw-001`);
        const metricsPayload = await metricsResponse.json();
        const metric = metricsPayload.data.operations.find((entry) => entry.operationName === 'memory.search');

        assert.equal(metricsResponse.status, 200);
        assert.equal(metric.active, 0);
        assert.equal(metric.totals.failed, 1);
        assert.equal(metric.lastOutcome, 'failure');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native gateway accepts dedicated gateway auth and rejects invalid credentials', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentGatewayProtocolConfig: {
            gatewayKey: 'gw-secret'
        },
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const unauthorizedHealthResponse = await fetch(`${server.baseUrl}/agent_gateway/health`, {
            headers: {
                'x-agent-gateway-key': 'wrong-secret'
            }
        });
        const unauthorizedHealthPayload = await unauthorizedHealthResponse.json();
        assert.equal(unauthorizedHealthResponse.status, 401);
        assert.equal(unauthorizedHealthPayload.code, 'AGW_UNAUTHORIZED');

        const unauthorizedResponse = await fetch(`${server.baseUrl}/agent_gateway/capabilities?agentId=Ariadne`, {
            headers: {
                'x-agent-gateway-key': 'wrong-secret'
            }
        });
        const unauthorizedPayload = await unauthorizedResponse.json();
        assert.equal(unauthorizedResponse.status, 401);
        assert.equal(unauthorizedPayload.code, 'AGW_UNAUTHORIZED');

        const authorizedResponse = await fetch(`${server.baseUrl}/agent_gateway/capabilities?agentId=Ariadne`, {
            headers: {
                'x-agent-gateway-key': 'gw-secret',
                'x-agent-gateway-id': 'gw-ariadne'
            }
        });
        const authorizedPayload = await authorizedResponse.json();
        assert.equal(authorizedResponse.status, 200);
        assert.equal(authorizedPayload.success, true);
        assert.equal(authorizedPayload.meta.authMode, 'gateway_key');
        assert.equal(authorizedPayload.meta.gatewayId, 'gw-ariadne');
        assert.equal(authorizedPayload.data.auth.authMode, 'gateway_key');

        const authorizedHealthResponse = await fetch(`${server.baseUrl}/agent_gateway/health`, {
            headers: {
                'x-agent-gateway-key': 'gw-secret',
                'x-agent-gateway-id': 'gw-ariadne'
            }
        });
        const authorizedHealthPayload = await authorizedHealthResponse.json();
        assert.equal(authorizedHealthResponse.status, 200);
        assert.equal(authorizedHealthPayload.success, true);
        assert.equal(authorizedHealthPayload.meta.authMode, 'gateway_key');
        assert.equal(authorizedHealthPayload.meta.gatewayId, 'gw-ariadne');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native tool invoke replays governed idempotent requests', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    let invocationCount = 0;
    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
        async processToolCall(toolName, args) {
            invocationCount += 1;
            if (toolName === 'DailyNote') {
                return {
                    status: 'success',
                    message: 'Diary saved to /tmp/native-memory.txt'
                };
            }
            return {
                toolName,
                invocationCount,
                receivedArgs: args
            };
        }
    });
    const server = await createServer(pluginManager);

    try {
        const requestBody = {
            args: {
                expression: '1+1'
            },
            requestContext: {
                requestId: 'req-native-tool-idem-001',
                agentId: 'Ariadne',
                sessionId: 'sess-native-tool-idem-001'
            }
        };

        const firstResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/SciCalculator/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': 'idem-native-tool-001'
            },
            body: JSON.stringify(requestBody)
        });
        const firstPayload = await firstResponse.json();

        const secondResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/SciCalculator/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'idempotency-key': 'idem-native-tool-001'
            },
            body: JSON.stringify({
                ...requestBody,
                requestContext: {
                    ...requestBody.requestContext,
                    requestId: 'req-native-tool-idem-002',
                    sessionId: 'sess-native-tool-idem-002'
                }
            })
        });
        const secondPayload = await secondResponse.json();

        assert.equal(firstResponse.status, 200);
        assert.equal(secondResponse.status, 200);
        assert.equal(firstPayload.data.result.invocationCount, 1);
        assert.equal(secondPayload.data.result.invocationCount, 1);
        assert.equal(secondPayload.data.idempotentReplay, true);
        assert.equal(secondPayload.meta.requestId, 'req-native-tool-idem-002');
        assert.equal(invocationCount, 1);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native deferred tool flow exposes job poll, cancel and SSE event stream', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createProtectedToolPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const invokeResponse = await fetch(`${server.baseUrl}/agent_gateway/tools/ProtectedTool/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    task: 'dangerous'
                },
                requestContext: {
                    requestId: 'req-native-protected-tool',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-protected-tool'
                }
            })
        });
        const invokePayload = await invokeResponse.json();
        const jobId = invokePayload.data.job.jobId;

        assert.equal(invokeResponse.status, 202);
        assert.equal(invokePayload.success, true);
        assert.equal(invokePayload.meta.toolStatus, 'waiting_approval');
        assert.equal(invokePayload.data.job.status, 'waiting_approval');

        const pollResponse = await fetch(
            `${server.baseUrl}/agent_gateway/jobs/${jobId}?requestId=req-native-job-poll&agentId=Ariadne&sessionId=sess-native-protected-tool`
        );
        const pollPayload = await pollResponse.json();

        assert.equal(pollResponse.status, 200);
        assert.equal(pollPayload.success, true);
        assert.equal(pollPayload.data.job.jobId, jobId);
        assert.equal(pollPayload.data.job.status, 'waiting_approval');

        const cancelResponse = await fetch(`${server.baseUrl}/agent_gateway/jobs/${jobId}/cancel`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                requestContext: {
                    requestId: 'req-native-job-cancel',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-protected-tool'
                }
            })
        });
        const cancelPayload = await cancelResponse.json();

        assert.equal(cancelResponse.status, 200);
        assert.equal(cancelPayload.success, true);
        assert.equal(cancelPayload.data.job.status, 'cancelled');

        const eventResponse = await fetch(
            `${server.baseUrl}/agent_gateway/events/stream?requestId=req-native-events&agentId=Ariadne&sessionId=sess-native-protected-tool&jobId=${jobId}`
        );
        const eventText = await eventResponse.text();

        assert.equal(eventResponse.status, 200);
        assert.equal(eventResponse.headers.get('content-type').includes('text/event-stream'), true);
        assert.equal(eventText.includes('event: gateway.meta'), true);
        assert.equal(eventText.includes('event: job.waiting_approval'), true);
        assert.equal(eventText.includes('event: job.cancelled'), true);
        assert.equal(eventText.includes(`"jobId":"${jobId}"`), true);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Legacy OpenClaw bridge routes are no longer mounted', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServer(pluginManager);

    try {
        const openClawResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/capabilities?agentId=Ariadne`);
        const nativeResponse = await fetch(`${server.baseUrl}/agent_gateway/capabilities?agentId=Ariadne`);
        const nativePayload = await nativeResponse.json();

        assert.equal(openClawResponse.status, 404);
        assert.equal(nativeResponse.status, 200);
        assert.ok(pluginManager.__agentGatewayServiceBundle);
        assert.ok(Array.isArray(nativePayload.data.tools));
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native tool route maps shared policy denial to AGW_FORBIDDEN', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        }),
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
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/tools/RemoteSearch/invoke`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                args: {
                    query: 'hello'
                },
                requestContext: {
                    requestId: 'req-native-tool-forbidden',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-tool-forbidden'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'AGW_FORBIDDEN');
        assert.equal(payload.details.toolName, 'RemoteSearch');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run returns success with items[], recallBlocks[] and diagnostics', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                query: 'test recall query',
                requestContext: {
                    requestId: 'req-native-recall-run-001',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-run-001'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(Array.isArray(payload.data.items), true);
        assert.equal(payload.data.items.length > 0, true);
        assert.equal(typeof payload.data.items[0].content, 'string');
        assert.equal(typeof payload.data.items[0].score, 'number');
        assert.equal(Array.isArray(payload.data.recallBlocks), true);
        assert.equal(payload.data.recallBlocks.length > 0, true);
        assert.equal(payload.data.activeProjection, 'items');
        assert.equal(Array.isArray(payload.data.fullTextSections), true);
        assert.equal(typeof payload.data.recallBlocks[0].blockId, 'string');
        assert.equal(typeof payload.data.diagnostics, 'object');
        assert.equal(typeof payload.data.diagnostics.totalDurationMs, 'number');
        assert.equal(Array.isArray(payload.data.diagnostics.rules), true);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run projects full_text profiles to fullTextSections', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager, {
        recallRuntime: {
            executeRecall: async ({ agentId, profileName }) => ({
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

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                query: 'test recall query',
                profile: 'fulltext-profile',
                requestContext: {
                    requestId: 'req-native-recall-run-fulltext',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-run-fulltext'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.activeProjection, 'fullTextSections');
        assert.equal(payload.data.fullTextSections.length, 1);
        assert.equal(payload.data.fullTextSections[0].diaryName, 'Nova');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run forwards authContext and messages to executeRecall', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    let receivedArgs = null;
    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const bundle = getGatewayServiceBundle(pluginManager, { gatewayVersion: 'v1' });
    const server = await createServerWithRecallMocks(pluginManager, {
        recallRuntime: {
            executeRecall: async (args) => {
                receivedArgs = args;
                return {
                    success: true,
                    agentId: args.agentId,
                    profileName: 'default',
                    items: [],
                    diagnostics: { totalDurationMs: 1, rules: [], pipelineStages: [], profileMeta: { profileName: 'default', ruleCount: 0, modifierKeys: [] } },
                    status: 200
                };
            }
        }
    });

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                query: 'test recall query',
                messages: [
                    { role: 'user', content: 'U1' },
                    { role: 'assistant', content: 'A1' }
                ],
                authContext: {
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-run-forwarded',
                    requestId: 'req-native-recall-run-forwarded-auth'
                },
                requestContext: {
                    requestId: 'req-native-recall-run-forwarded',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-run-forwarded'
                }
            })
        });

        assert.equal(response.status, 200);
        assert.ok(receivedArgs);
        assert.deepStrictEqual(receivedArgs.messages, [
            { role: 'user', content: 'U1' },
            { role: 'assistant', content: 'A1' }
        ]);
        assert.equal(receivedArgs.authContext.agentId, 'Ariadne');
        assert.equal(receivedArgs.requestContext.requestId, 'req-native-recall-run-forwarded');
    assert.strictEqual(receivedArgs.agentPolicyResolver, bundle.agentPolicyResolver);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run missing agentId returns 400 AGW_INVALID_REQUEST', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: 'test recall query',
                requestContext: {
                    requestId: 'req-native-recall-no-agent',
                    sessionId: 'sess-native-recall-no-agent'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'AGW_INVALID_REQUEST');
        assert.equal(payload.details.field, 'agentId');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run missing query returns 400 AGW_INVALID_REQUEST', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                requestContext: {
                    requestId: 'req-native-recall-no-query',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-no-query'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'AGW_INVALID_REQUEST');
        assert.equal(payload.details.field, 'query');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run non-existent profile returns 404 AGW_RECALL_NO_PROFILE', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager, {
        recallRuntime: {
            executeRecall: async ({ agentId, profileName }) => ({
                success: false,
                agentId: agentId || null,
                profileName: profileName || null,
                items: [],
                diagnostics: { totalDurationMs: 5, rules: [] },
                error: `No recall profile resolved for agent "${agentId}"`,
                code: 'AGW_RECALL_NO_PROFILE',
                status: 404
            })
        }
    });

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                query: 'test recall query',
                profile: 'nonexistent-profile',
                requestContext: {
                    requestId: 'req-native-recall-bad-profile',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-bad-profile'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 404);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'AGW_RECALL_NO_PROFILE');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('POST /agent_gateway/recall/run native envelope shape verification', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const server = await createServerWithRecallMocks(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/recall/run`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                agentId: 'Ariadne',
                query: 'test recall query',
                requestContext: {
                    requestId: 'req-native-recall-envelope',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-recall-envelope'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.meta.requestId, 'req-native-recall-envelope');
        assert.equal(payload.meta.operationName, 'recall.run');
        assert.match(payload.meta.traceId, /^agwop_/);
        assert.equal(response.headers.get('x-agent-gateway-trace-id'), payload.meta.traceId);
        assert.equal(typeof payload.data, 'object');
        assert.equal(payload.data.success, true);
        assert.equal(payload.data.code, null);
        assert.equal(payload.data.error, null);
        assert.equal(typeof payload.data.projectedAt, 'number');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('GET /agent_gateway/agents/:agentId/guidance returns the canonical guidance bundle (M2.S1)', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');
    const guidanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-native-guidance-'));
    const guidancePath = path.join(guidanceDir, 'agent_guidance.json');
    await fs.writeFile(guidancePath, JSON.stringify({
        version: 1,
        shared: {
            workflow: ['先调用 gateway_recall_run。'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥和敏感数据'] }
        },
        agents: {
            Ariadne: {
                displayName: '阿里阿德涅',
                memoryDefaults: { tags: ['vcp'], metadata: { project: 'vcp-toolbox' } }
            }
        }
    }, null, 2), 'utf8');
    const previousGuidancePath = process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH;
    process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH = guidancePath;

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, { Ariadne: 'Ariadne.md' })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/agents/Ariadne/guidance?requestId=req-native-guidance-001`);
        const payload = await response.json();
        assert.equal(response.status, 200);
        // §6 / M2.S2.T4：guidance 响应 no-store 且 Vary 覆盖身份呈现通道
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        const varyHeader = String(response.headers.get('vary') || '').toLowerCase();
        for (const channel of ['authorization', 'x-agent-gateway-key', 'cookie']) {
            assert.ok(varyHeader.includes(channel), `Vary must include ${channel}`);
        }
        assert.equal(payload.success, true);
        assert.equal(payload.meta.operationName, 'agents.guidance');
        assert.equal(payload.data.agentId, 'Ariadne');
        assert.equal(payload.data.displayName, '阿里阿德涅');
        assert.deepEqual(payload.data.workflow, ['先调用 gateway_recall_run。']);
        assert.deepEqual(payload.data.memoryWritePolicy, {
            write: ['已验证结论'],
            skip: ['密钥和敏感数据']
        });
        // 日记本集合由 memory policy / rag 配置注入（Ariadne → Nova, SharedMemory）
        assert.deepEqual(payload.data.allowedDiaries, ['Nova', 'SharedMemory']);
        assert.deepEqual(payload.data.memoryDefaults, { tags: ['vcp'], metadata: { project: 'vcp-toolbox' } });
        assert.match(payload.data.revision, /^sha256:[0-9a-f]{64}$/);

        // revision 与冻结 integration snapshot 一致（M2.S1.T3）
        const bundle = pluginManager.__agentGatewayServiceBundle;
        assert.equal(payload.data.revision, bundle.agentGuidanceService.getIntegrationRevision());

        const notFoundResponse = await fetch(`${server.baseUrl}/agent_gateway/agents/Unknown/guidance`);
        const notFoundPayload = await notFoundResponse.json();
        assert.equal(notFoundResponse.status, 404);
        assert.equal(notFoundPayload.code, 'AGW_NOT_FOUND');
    } finally {
        if (previousGuidancePath === undefined) {
            delete process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH;
        } else {
            process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH = previousGuidancePath;
        }
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
        await fs.rm(guidanceDir, { recursive: true, force: true });
    }
});
