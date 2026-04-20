const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const createOpenClawBridgeRoutes = require('../routes/openclawBridgeRoutes');
const createAgentGatewayRoutes = require('../routes/agentGatewayRoutes');
const {
    getGatewayServiceBundle
} = require('../modules/agentGateway/createGatewayServiceBundle');

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

async function createServer(pluginManager) {
    const app = express();
    app.use(express.json());

    const openClawRoutes = createOpenClawBridgeRoutes(pluginManager);
    const sharedBundle = pluginManager.__agentGatewayServiceBundle;
    const nativeRoutes = createAgentGatewayRoutes(pluginManager);

    assert.ok(sharedBundle, 'shared bundle should be created by the first adapter');
    assert.equal(pluginManager.__agentGatewayServiceBundle, sharedBundle, 'native adapter should reuse the same shared bundle');

    app.use('/admin_api', openClawRoutes);
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
        assert.deepEqual(payload.data.memory.targets.map((target) => target.id), ['Nova', 'SharedMemory']);
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
        assert.deepEqual(targetsPayload.data.targets.map((target) => target.id), ['Nova', 'SharedMemory']);

        const searchResponse = await fetch(`${server.baseUrl}/agent_gateway/memory/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '上周项目会议讨论了什么',
                diary: 'Nova',
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
        assert.equal(searchPayload.data.items.length, 1);
        assert.equal(searchPayload.data.items[0].sourceDiary, 'Nova');

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
                diary: 'Nova',
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
        assert.equal(contextPayload.data.recallBlocks.length > 0, true);
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native coding routes publish canonical recall and coding memory writeback behavior', async () => {
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
        const recallPayload = await recallResponse.json();

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
        const writebackPayload = await writebackResponse.json();

        assert.equal(recallResponse.status, 200);
        assert.equal(recallPayload.success, true);
        assert.equal(recallPayload.meta.operationName, 'coding.recall');
        assert.match(recallPayload.meta.traceId, /^agwop_/);
        assert.equal(recallPayload.data.scope.applied, true);
        assert.equal(recallPayload.data.recallBlocks.length > 0, true);

        assert.equal(writebackResponse.status, 200);
        assert.equal(writebackPayload.success, true);
        assert.equal(writebackPayload.meta.operationName, 'coding.memory_writeback');
        assert.match(writebackPayload.meta.traceId, /^agwop_/);
        assert.equal(writebackPayload.data.writeStatus, 'created');
        assert.equal(writebackPayload.data.target.diary, 'Nova');
    } finally {
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('Native coding routes preserve deferred and validation machine-readable metadata', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Ariadne system prompt');

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, {
            Ariadne: 'Ariadne.md'
        })
    });
    const bundle = getGatewayServiceBundle(pluginManager);
    bundle.codingRecallService.recallForCoding = async ({ body }) => ({
        success: true,
        requestId: body.requestContext.requestId,
        status: 'waiting_approval',
        data: {
            runtime: {
                deferred: true,
                status: 'waiting_approval'
            },
            job: {
                jobId: 'job-native-coding-recall-deferred',
                status: 'waiting_approval'
            }
        }
    });
    bundle.codingMemoryWritebackService.commitForCoding = async ({ body }) => ({
        success: false,
        requestId: body.requestContext.requestId,
        status: 400,
        code: 'AGW_VALIDATION_ERROR',
        error: 'coding memory writeback requires task plus additional signals',
        details: {
            field: 'task+(summary|implementation|outcome|result|notes|constraints|pitfalls|files|symbols)'
        }
    });

    const server = await createServer(pluginManager);

    try {
        const deferredResponse = await fetch(`${server.baseUrl}/agent_gateway/coding/recall`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                task: {
                    description: '等待审批后继续 recall'
                },
                files: ['modules/agentGateway/adapters/mcpBackendProxyAdapter.js'],
                requestContext: {
                    requestId: 'req-native-coding-recall-deferred',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-coding-recall-deferred'
                }
            })
        });
        const deferredPayload = await deferredResponse.json();

        const invalidWritebackResponse = await fetch(`${server.baseUrl}/agent_gateway/coding/memory-writeback`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                task: {
                    description: '只有 task，没有其它信号'
                },
                diary: 'Nova',
                requestContext: {
                    requestId: 'req-native-coding-writeback-invalid',
                    agentId: 'Ariadne',
                    sessionId: 'sess-native-coding-writeback-invalid'
                }
            })
        });
        const invalidWritebackPayload = await invalidWritebackResponse.json();

        assert.equal(deferredResponse.status, 202);
        assert.equal(deferredPayload.success, true);
        assert.equal(deferredPayload.meta.operationName, 'coding.recall');
        assert.equal(deferredPayload.meta.operationStatus, 'waiting_approval');
        assert.equal(deferredPayload.data.job.jobId, 'job-native-coding-recall-deferred');

        assert.equal(invalidWritebackResponse.status, 400);
        assert.equal(invalidWritebackPayload.success, false);
        assert.equal(invalidWritebackPayload.code, 'AGW_VALIDATION_ERROR');
        assert.equal(
            invalidWritebackPayload.details.field,
            'task+(summary|implementation|outcome|result|notes|constraints|pitfalls|files|symbols)'
        );
        assert.equal(invalidWritebackPayload.meta.operationName, 'coding.memory_writeback');
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

test('OpenClaw and Native adapters coexist without replacing the shared bundle', async () => {
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
        const openClawPayload = await openClawResponse.json();
        const nativeResponse = await fetch(`${server.baseUrl}/agent_gateway/capabilities?agentId=Ariadne`);
        const nativePayload = await nativeResponse.json();

        assert.equal(openClawResponse.status, 200);
        assert.equal(nativeResponse.status, 200);
        assert.deepEqual(
            openClawPayload.data.tools.map((tool) => tool.name),
            nativePayload.data.tools.map((tool) => tool.name)
        );
        assert.ok(pluginManager.__agentGatewayServiceBundle);
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
