const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const createOpenClawBridgeRoutes = require('../routes/openclawBridgeRoutes');

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

function createKnowledgeBaseManager(overrides = {}) {
    const diaries = overrides.diaries || ['Nova', 'ProjectAlpha', 'SharedMemory'];
    const metadataByPath = overrides.metadataByPath || {
        'Nova/2026-03-20.md': {
            sourceDiary: 'Nova',
            sourcePath: 'Nova/2026-03-20.md',
            updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
            tags: ['项目', '会议', '桥接']
        },
        'ProjectAlpha/2026-03-18.md': {
            sourceDiary: 'ProjectAlpha',
            sourcePath: 'ProjectAlpha/2026-03-18.md',
            updatedAt: Date.parse('2026-03-18T08:00:00.000Z'),
            tags: ['发布', '复盘']
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
        ],
        ProjectAlpha: [
            {
                text: 'Project Alpha 部署失败的原因是缺失环境变量。',
                score: 0.812,
                sourceFile: '2026-03-18.md',
                fullPath: 'ProjectAlpha/2026-03-18.md'
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
        async search(diaryName, queryVector, k, tagBoost, coreTags) {
            if (overrides.search) {
                return overrides.search(diaryName, queryVector, k, tagBoost, coreTags);
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
            if (overrides.deduplicateResults) {
                return overrides.deduplicateResults(candidates);
            }
            return candidates;
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
            if (overrides.getOpenClawFileMetadata) {
                return overrides.getOpenClawFileMetadata(sourcePath);
            }
            return metadataByPath[sourcePath] || null;
        }
    };
}

function createRagPlugin(overrides = {}) {
    return {
        async getSingleEmbeddingCached(text) {
            if (overrides.getSingleEmbeddingCached) {
                return overrides.getSingleEmbeddingCached(text);
            }
            return [0.9, 0.1, 0.4];
        },
        timeParser: {
            parse(text) {
                if (overrides.parseTime) {
                    return overrides.parseTime(text);
                }
                return text.includes('上周')
                    ? [{ start: new Date('2026-03-16T00:00:00.000Z'), end: new Date('2026-03-22T23:59:59.999Z') }]
                    : [];
            }
        },
        semanticGroups: {
            detectAndActivateGroups(text) {
                if (overrides.detectAndActivateGroups) {
                    return overrides.detectAndActivateGroups(text);
                }
                return text.includes('项目') ? new Map([['项目', { strength: 1 }]]) : new Map();
            },
            async getEnhancedVector(query, activatedGroups, queryVector) {
                if (overrides.getEnhancedVector) {
                    return overrides.getEnhancedVector(query, activatedGroups, queryVector);
                }
                return Array.isArray(queryVector)
                    ? queryVector.map((value, index) => value + (index === 0 ? 0.01 : 0))
                    : queryVector;
            }
        },
        async _rerankDocuments(query, documents, originalK) {
            if (overrides.rerankDocuments) {
                return overrides.rerankDocuments(query, documents, originalK);
            }
            return documents.slice().sort((left, right) => (right.score || 0) - (left.score || 0)).slice(0, originalK);
        },
        async _getTimeRangeFilePaths(diaryName, timeRange) {
            if (overrides.getTimeRangeFilePaths) {
                return overrides.getTimeRangeFilePaths(diaryName, timeRange);
            }
            return diaryName === 'Nova' ? ['Nova/2026-03-20.md'] : [];
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
    const vectorDBManager = overrides.vectorDBManager || createKnowledgeBaseManager();
    const ragPlugin = overrides.ragPlugin || createRagPlugin();

    return {
        plugins,
        vectorDBManager,
        messagePreprocessors: new Map([['RAGDiaryPlugin', ragPlugin]]),
        openClawBridgeConfig: overrides.openClawBridgeConfig || {},
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

test('GET /admin_api/openclaw/capabilities returns bridgeable tools and memory metadata', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.default': ['Nova', 'SharedMemory']
                }
            }
        }
    });
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
        assert.equal(Array.isArray(chromeBridge.invocationCommands), true);
        assert.equal(chromeBridge.invocationCommands.length, 2);
        assert.equal(chromeBridge.invocationCommands[0].command, 'click');
        assert.equal(Array.isArray(chromeBridge.invocationCommands[0].parameters), true);
        assert.deepEqual(payload.data.memory.targets.map((target) => target.id), ['Nova', 'SharedMemory']);
        assert.deepEqual(payload.data.memory.features, {
            timeAware: true,
            groupAware: true,
            rerank: true,
            tagMemo: true,
            writeBack: false
        });
    } finally {
        await server.close();
    }
});

test('GET /admin_api/openclaw/rag/targets filters diaries by agent policy', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/targets?agentId=agent.nova`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.targets.map((target) => target.id), ['Nova']);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/search returns normalized items and diagnostics', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '上周项目会议讨论了什么',
                diary: 'Nova',
                k: 3,
                options: {
                    timeAware: true,
                    groupAware: true,
                    rerank: true,
                    tagMemo: true
                },
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-001',
                    requestId: 'req-memory-001'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.items.length, 1);
        assert.equal(payload.data.items[0].sourceDiary, 'Nova');
        assert.equal(payload.data.items[0].sourceFile, '2026-03-20.md');
        assert.deepEqual(payload.data.items[0].tags, ['项目', '会议', '桥接']);
        assert.equal(typeof payload.data.items[0].timestamp, 'string');
        assert.deepEqual(payload.data.diagnostics.targetDiaries, ['Nova']);
        assert.equal(payload.data.diagnostics.timeAwareApplied, true);
        assert.equal(payload.data.diagnostics.groupAwareApplied, true);
        assert.equal(payload.data.diagnostics.rerankApplied, true);
        assert.equal(payload.data.diagnostics.tagMemoApplied, true);
        assert.deepEqual(payload.data.diagnostics.coreTags, ['项目', '会议']);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/search returns stable empty results', async () => {
    const pluginManager = createPluginManager({
        vectorDBManager: createKnowledgeBaseManager({
            async search() {
                return [];
            },
            async getChunksByFilePaths() {
                return [];
            }
        }),
        ragPlugin: createRagPlugin({
            parseTime() {
                return [];
            },
            detectAndActivateGroups() {
                return new Map();
            }
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '不存在的历史片段',
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.default',
                    sessionId: 'sess-memory-002',
                    requestId: 'req-memory-002'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.items, []);
        assert.equal(payload.data.diagnostics.resultCount, 0);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/search rejects forbidden diaries', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: 'Project Alpha 的部署失败原因',
                diary: 'ProjectAlpha',
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-003',
                    requestId: 'req-memory-003'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_RAG_TARGET_FORBIDDEN');
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/search restricts results to requested diaries[]', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova', 'SharedMemory']
                },
                allowCrossRoleAccess: false
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            diaries: ['Nova', 'ProjectAlpha', 'SharedMemory'],
            searchResults: {
                Nova: [
                    {
                        text: 'Nova 中的项目纪要。',
                        score: 0.921,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    }
                ],
                SharedMemory: [
                    {
                        text: 'SharedMemory 中的共享结论。',
                        score: 0.812,
                        sourceFile: '2026-03-21.md',
                        fullPath: 'SharedMemory/2026-03-21.md'
                    }
                ],
                ProjectAlpha: [
                    {
                        text: 'Project Alpha 中的结果不应返回。',
                        score: 0.999,
                        sourceFile: '2026-03-18.md',
                        fullPath: 'ProjectAlpha/2026-03-18.md'
                    }
                ]
            },
            metadataByPath: {
                'Nova/2026-03-20.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-20.md',
                    updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
                    tags: ['项目']
                },
                'SharedMemory/2026-03-21.md': {
                    sourceDiary: 'SharedMemory',
                    sourcePath: 'SharedMemory/2026-03-21.md',
                    updatedAt: Date.parse('2026-03-21T10:20:00.000Z'),
                    tags: ['共享']
                }
            }
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '最近的项目纪要',
                diaries: ['Nova', 'SharedMemory'],
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-004',
                    requestId: 'req-memory-004'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.diagnostics.targetDiaries, ['Nova', 'SharedMemory']);
        assert.deepEqual(payload.data.items.map((item) => item.sourceDiary).sort(), ['Nova', 'SharedMemory']);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/search audit log includes score statistics', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                }
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            searchResults: {
                Nova: [
                    {
                        text: '高分搜索结果。',
                        score: 0.95,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    },
                    {
                        text: '次高分搜索结果。',
                        score: 0.75,
                        sourceFile: '2026-03-21.md',
                        fullPath: 'Nova/2026-03-21.md'
                    },
                    {
                        text: '较低分搜索结果。',
                        score: 0.55,
                        sourceFile: '2026-03-22.md',
                        fullPath: 'Nova/2026-03-22.md'
                    }
                ]
            },
            metadataByPath: {
                'Nova/2026-03-20.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-20.md',
                    updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
                    tags: ['高分']
                },
                'Nova/2026-03-21.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-21.md',
                    updatedAt: Date.parse('2026-03-21T10:20:00.000Z'),
                    tags: ['次高分']
                },
                'Nova/2026-03-22.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-22.md',
                    updatedAt: Date.parse('2026-03-22T10:20:00.000Z'),
                    tags: ['较低分']
                }
            }
        })
    });
    const server = await createServer(pluginManager);
    const originalConsoleLog = console.log;
    const auditEvents = [];
    console.log = (message, ...rest) => {
        void rest;
        if (typeof message !== 'string' || !message.startsWith('[OpenClawBridgeAudit] ')) return;
        auditEvents.push(JSON.parse(message.slice('[OpenClawBridgeAudit] '.length)));
    };

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '搜索高分结果',
                diary: 'Nova',
                k: 2,
                requestContext: {
                    source: 'openclaw',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-005',
                    requestId: 'req-memory-005'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        const completedEvent = auditEvents.find((event) => event.event === 'rag.search.completed');
        assert.ok(completedEvent);
        assert.equal(completedEvent.filteredByResultWindow, 1);
        assert.deepEqual(completedEvent.scoreStats.candidates, {
            count: 3,
            max: 0.95,
            min: 0.55,
            avg: 0.75
        });
        assert.deepEqual(completedEvent.scoreStats.returned, {
            count: 2,
            max: 0.95,
            min: 0.75,
            avg: 0.85
        });
    } finally {
        console.log = originalConsoleLog;
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/context builds recall blocks from recent messages', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                recentMessages: [
                    {
                        role: 'user',
                        content: '帮我回忆一下上周项目会议的关键结论'
                    },
                    {
                        role: 'assistant',
                        content: '我将检索相关日记片段'
                    }
                ],
                tokenBudget: 80,
                maxTokenRatio: 0.5,
                maxBlocks: 1,
                minScore: 0.7,
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.nova',
                    sessionId: 'sess-context-001',
                    requestId: 'req-context-001'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.recallBlocks.length, 1);
        assert.equal(payload.data.recallBlocks[0].metadata.sourceDiary, 'Nova');
        assert.equal(payload.data.recallBlocks[0].metadata.sourceFile, '2026-03-20.md');
        assert.equal(payload.data.recallBlocks[0].metadata.score >= 0.7, true);
        assert.equal(payload.data.estimatedTokens > 0, true);
        assert.deepEqual(payload.data.appliedPolicy.targetDiaries, ['Nova']);
        assert.equal(payload.data.appliedPolicy.maxBlocks, 1);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/context restricts recall to requested diaries[]', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova', 'SharedMemory']
                },
                allowCrossRoleAccess: false
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            diaries: ['Nova', 'ProjectAlpha', 'SharedMemory'],
            searchResults: {
                Nova: [
                    {
                        text: 'Nova 中的上下文块。',
                        score: 0.93,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    }
                ],
                SharedMemory: [
                    {
                        text: 'SharedMemory 中的上下文块。',
                        score: 0.9,
                        sourceFile: '2026-03-21.md',
                        fullPath: 'SharedMemory/2026-03-21.md'
                    }
                ],
                ProjectAlpha: [
                    {
                        text: 'ProjectAlpha 中的上下文块不应出现。',
                        score: 0.99,
                        sourceFile: '2026-03-18.md',
                        fullPath: 'ProjectAlpha/2026-03-18.md'
                    }
                ]
            },
            metadataByPath: {
                'Nova/2026-03-20.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-20.md',
                    updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
                    tags: ['项目']
                },
                'SharedMemory/2026-03-21.md': {
                    sourceDiary: 'SharedMemory',
                    sourcePath: 'SharedMemory/2026-03-21.md',
                    updatedAt: Date.parse('2026-03-21T10:20:00.000Z'),
                    tags: ['共享']
                }
            }
        })
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '回忆项目背景',
                diaries: ['Nova', 'SharedMemory'],
                tokenBudget: 120,
                maxTokenRatio: 0.5,
                maxBlocks: 3,
                minScore: 0.7,
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.nova',
                    sessionId: 'sess-context-004',
                    requestId: 'req-context-004'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.deepEqual(payload.data.appliedPolicy.targetDiaries, ['Nova', 'SharedMemory']);
        assert.deepEqual(
            payload.data.recallBlocks.map((block) => block.metadata.sourceDiary).sort(),
            ['Nova', 'SharedMemory']
        );
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/context audit log includes recall score statistics', async () => {
    const pluginManager = createPluginManager({
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                }
            }
        },
        vectorDBManager: createKnowledgeBaseManager({
            searchResults: {
                Nova: [
                    {
                        text: '高分召回片段。',
                        score: 0.95,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    },
                    {
                        text: '低分片段，会被 minScore 过滤。',
                        score: 0.55,
                        sourceFile: '2026-03-21.md',
                        fullPath: 'Nova/2026-03-21.md'
                    }
                ]
            },
            metadataByPath: {
                'Nova/2026-03-20.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-20.md',
                    updatedAt: Date.parse('2026-03-20T10:20:00.000Z'),
                    tags: ['高分']
                },
                'Nova/2026-03-21.md': {
                    sourceDiary: 'Nova',
                    sourcePath: 'Nova/2026-03-21.md',
                    updatedAt: Date.parse('2026-03-21T10:20:00.000Z'),
                    tags: ['低分']
                }
            }
        })
    });
    const server = await createServer(pluginManager);
    const originalConsoleLog = console.log;
    const auditEvents = [];
    console.log = (message, ...rest) => {
        void rest;
        if (typeof message !== 'string' || !message.startsWith('[OpenClawBridgeAudit] ')) return;
        auditEvents.push(JSON.parse(message.slice('[OpenClawBridgeAudit] '.length)));
    };

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '回忆高分片段',
                maxBlocks: 3,
                tokenBudget: 120,
                maxTokenRatio: 0.5,
                minScore: 0.7,
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.nova',
                    sessionId: 'sess-context-005',
                    requestId: 'req-context-005'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        const completedEvent = auditEvents.find((event) => event.event === 'rag.context.completed');
        assert.ok(completedEvent);
        assert.equal(completedEvent.filteredByMinScore, 1);
        assert.deepEqual(completedEvent.scoreStats.candidates, {
            count: 2,
            max: 0.95,
            min: 0.55,
            avg: 0.75
        });
        assert.deepEqual(completedEvent.scoreStats.eligible, {
            count: 1,
            max: 0.95,
            min: 0.95,
            avg: 0.95
        });
        assert.deepEqual(completedEvent.scoreStats.recalled, {
            count: 1,
            max: 0.95,
            min: 0.95,
            avg: 0.95
        });
    } finally {
        console.log = originalConsoleLog;
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/context truncates recall blocks to token budget', async () => {
    const pluginManager = createPluginManager({
        vectorDBManager: createKnowledgeBaseManager({
            searchResults: {
                Nova: [
                    {
                        text: '这是一个非常长的上下文片段这是一个非常长的上下文片段这是一个非常长的上下文片段',
                        score: 0.93,
                        sourceFile: '2026-03-20.md',
                        fullPath: 'Nova/2026-03-20.md'
                    }
                ]
            }
        }),
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                }
            }
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '回忆上周的长片段',
                tokenBudget: 10,
                maxTokenRatio: 0.5,
                maxBlocks: 2,
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.nova',
                    sessionId: 'sess-context-002',
                    requestId: 'req-context-002'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.recallBlocks.length, 1);
        assert.equal(payload.data.recallBlocks[0].metadata.truncated, true);
        assert.equal(payload.data.estimatedTokens <= 5, true);
        assert.equal(payload.data.appliedPolicy.maxInjectedTokens, 5);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/rag/context validates query input', async () => {
    const pluginManager = createPluginManager();
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.default',
                    sessionId: 'sess-context-003',
                    requestId: 'req-context-003'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_RAG_INVALID_QUERY');
    } finally {
        await server.close();
    }
});

test('GET /admin_api/openclaw/capabilities marks writeBack as available when DailyNote exists', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
                    description: '创建日记。\n- `command`: 固定为 `create`。\n- `maid`: 必需。\n- `Date`: 必需。\n- `Content`: 必需。\n- `Tag`: 必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」DailyNote「末」,\ncommand:「始」create「末」,\nmaid:「始」[Nova]Nova「末」,\nDate:「始」2026-04-01「末」,\nContent:「始」示例内容「末」,\nTag:「始」阶段总结, durable-memory「末」\n<<<[END_TOOL_REQUEST]>>>',
                    parameters: [
                        { name: 'command', type: 'string', required: true },
                        { name: 'maid', type: 'string', required: true },
                        { name: 'Date', type: 'string', required: true },
                        { name: 'Content', type: 'string', required: true },
                        { name: 'Tag', type: 'string', required: true }
                    ]
                }
            ]
        }
    });
    const pluginManager = createPluginManager({ plugins });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/capabilities?agentId=agent.default`);
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.memory.features.writeBack, true);
        const dailyNoteTool = payload.data.tools.find((tool) => tool.name === 'DailyNote');
        assert.ok(dailyNoteTool);
        assert.deepEqual(
            dailyNoteTool.inputSchema.required.sort(),
            ['Content', 'Date', 'Tag', 'command', 'maid'].sort()
        );
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write writes durable memory through DailyNote create flow', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
    });

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
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
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
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.writeStatus, 'created');
        assert.equal(payload.data.diary, 'Nova');
        assert.equal(payload.data.deduplicated, false);
        assert.equal(payload.data.filePath, '/tmp/Nova/2026-04-01-09_30_00.md');
        assert.equal(typeof payload.data.entryId, 'string');
        assert.equal(payload.data.entryId.length, 24);

        assert.equal(capturedCall.toolName, 'DailyNote');
        assert.equal(capturedCall.args.command, 'create');
        assert.equal(capturedCall.args.maid, '[Nova]agent.nova');
        assert.equal(capturedCall.args.Date, '2026-04-01');
        assert.equal(capturedCall.args.Tag, 'Tag: Phase4, memory-write');
        assert.match(
            capturedCall.args.Content,
            /^\[\d{2}:\d{2}\] 需要在 Phase 4 中把 durable memory 写回 VCP 日记系统。\nMeta-sourceEvent: memory\.flush\nMeta-importance: 0\.92$/
        );
        assert.deepEqual(capturedCall.args.__openclawContext, {
            source: 'openclaw-memory',
            agentId: 'agent.nova',
            sessionId: 'sess-memory-write-001',
            requestId: 'req-memory-write-001'
        });
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write skips duplicate writes by idempotency key', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
    });

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
    const server = await createServer(pluginManager);
    const requestBody = {
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
    };

    try {
        const firstResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        const firstPayload = await firstResponse.json();
        const secondResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        const secondPayload = await secondResponse.json();

        assert.equal(firstResponse.status, 200);
        assert.equal(firstPayload.data.writeStatus, 'created');
        assert.equal(secondResponse.status, 200);
        assert.equal(secondPayload.data.writeStatus, 'skipped_duplicate');
        assert.equal(secondPayload.data.deduplicated, true);
        assert.equal(secondPayload.data.entryId, firstPayload.data.entryId);
        assert.equal(invocationCount, 1);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write rejects forbidden target diaries', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
    });

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
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
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
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 403);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_MEMORY_TARGET_FORBIDDEN');
        assert.equal(invocationCount, 0);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write requires memory.tags and no longer falls back to generated tags', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
    });

    let invocationCount = 0;
    const pluginManager = createPluginManager({
        plugins,
        async processToolCall() {
            invocationCount += 1;
            return { status: 'success' };
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '缺少 tags 的 durable memory 不应被写入。'
                },
                requestContext: {
                    source: 'openclaw-memory',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-write-004',
                    requestId: 'req-memory-write-004'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 400);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_MEMORY_INVALID_PAYLOAD');
        assert.equal(payload.error, 'memory.tags is required');
        assert.equal(invocationCount, 0);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write requires DailyNote and does not fall back to DailyNoteWrite', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.delete('DailyNote');
    plugins.set('DailyNoteWrite', {
        name: 'DailyNoteWrite',
        displayName: '日记写入器',
        description: '旧写入插件。',
        pluginType: 'synchronous',
        communication: {
            protocol: 'stdio',
            timeout: 30000
        }
    });
    const pluginManager = createPluginManager({
        plugins,
        async executePlugin() {
            throw new Error('DailyNoteWrite should not be used');
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: '仅存在 DailyNoteWrite 时应直接报错。',
                    tags: ['phase4', 'daily-note-only']
                },
                requestContext: {
                    source: 'openclaw-memory',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-write-005',
                    requestId: 'req-memory-write-005'
                }
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 500);
        assert.equal(payload.success, false);
        assert.equal(payload.code, 'OCW_MEMORY_WRITE_ERROR');
        assert.equal(payload.error, 'DailyNote is required for diary memory write');
        assert.deepEqual(payload.details.supportedPlugins, ['DailyNote']);
    } finally {
        await server.close();
    }
});

test('POST /admin_api/openclaw/memory/write makes persisted memory searchable and recallable', async () => {
    const basePluginManager = createPluginManager();
    const plugins = new Map(basePluginManager.plugins);
    plugins.set('DailyNote', {
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
    });

    const persistedEntries = [];
    const vectorDBManager = createKnowledgeBaseManager({
        diaries: ['Nova'],
        async search(diaryName, queryVector, k) {
            void queryVector;
            if (diaryName !== 'Nova') {
                return [];
            }
            return persistedEntries.slice(0, k).map((entry) => ({
                text: entry.text,
                score: entry.score,
                sourceFile: entry.sourceFile,
                fullPath: entry.fullPath
            }));
        },
        async getOpenClawFileMetadata(sourcePath) {
            const matchedEntry = persistedEntries.find((entry) => entry.fullPath === sourcePath);
            return matchedEntry
                ? {
                    sourceDiary: 'Nova',
                    sourcePath: matchedEntry.fullPath,
                    updatedAt: matchedEntry.updatedAt,
                    tags: matchedEntry.tags
                }
                : null;
        },
        async getChunksByFilePaths(filePaths) {
            return filePaths
                .map((filePath) => persistedEntries.find((entry) => entry.fullPath === filePath))
                .filter(Boolean)
                .map((entry) => ({
                    text: entry.text,
                    sourceFile: entry.fullPath,
                    sourceDiary: 'Nova',
                    vector: [0.9, 0.1, 0.4]
                }));
        }
    });

    const pluginManager = createPluginManager({
        plugins,
        vectorDBManager,
        openClawBridgeConfig: {
            rag: {
                agentDiaryMap: {
                    'agent.nova': ['Nova']
                },
                allowCrossRoleAccess: false
            }
        },
        async processToolCall(toolName, args) {
            assert.equal(toolName, 'DailyNote');
            const contentLines = String(args.Content || '').split('\n');
            const firstLine = contentLines[0] || '';
            const matchedTime = firstLine.match(/^\[(\d{2}:\d{2})\]\s*(.+)$/);
            const text = matchedTime ? matchedTime[2] : firstLine;
            const sourceFile = `${args.Date}.md`;
            const fullPath = `Nova/${sourceFile}`;
            const updatedAt = Date.parse(`${args.Date}T${matchedTime ? matchedTime[1] : '00:00'}:00.000Z`);
            const tags = String(args.Tag || '')
                .replace(/^Tag:\s*/u, '')
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean);

            persistedEntries.push({
                text,
                score: 0.97,
                sourceFile,
                fullPath,
                updatedAt,
                tags
            });

            return {
                status: 'success',
                message: `Diary saved to /tmp/${fullPath.replace('/', '_')}`
            };
        }
    });
    const server = await createServer(pluginManager);

    try {
        const writeResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                target: {
                    diary: 'Nova'
                },
                memory: {
                    text: 'OpenClaw durable memory 写回完成后，下一轮需要能检索并注入召回。',
                    tags: ['phase4', 'writeback', 'recall'],
                    timestamp: '2026-04-02T10:15:00.000Z',
                    metadata: {
                        sourceEvent: 'memory.flush'
                    }
                },
                options: {
                    idempotencyKey: 'mem-write-linked-001',
                    deduplicate: true
                },
                requestContext: {
                    source: 'openclaw-memory',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-linked-001',
                    requestId: 'req-memory-linked-001'
                }
            })
        });
        const writePayload = await writeResponse.json();

        const searchResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/search`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: '回忆 durable memory 写回完成后的下一步',
                diary: 'Nova',
                k: 3,
                mode: 'hybrid',
                requestContext: {
                    source: 'openclaw-memory',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-linked-002',
                    requestId: 'req-memory-linked-002'
                }
            })
        });
        const searchPayload = await searchResponse.json();

        const contextResponse = await fetch(`${server.baseUrl}/admin_api/openclaw/rag/context`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                query: 'OpenClaw durable memory 写回后应该召回什么',
                maxBlocks: 2,
                tokenBudget: 160,
                maxTokenRatio: 0.5,
                minScore: 0.7,
                requestContext: {
                    source: 'openclaw-context',
                    agentId: 'agent.nova',
                    sessionId: 'sess-memory-linked-003',
                    requestId: 'req-memory-linked-003'
                }
            })
        });
        const contextPayload = await contextResponse.json();

        assert.equal(writeResponse.status, 200);
        assert.equal(writePayload.success, true);
        assert.equal(writePayload.data.writeStatus, 'created');
        assert.equal(persistedEntries.length, 1);

        assert.equal(searchResponse.status, 200);
        assert.equal(searchPayload.success, true);
        assert.equal(searchPayload.data.items.length, 1);
        assert.equal(searchPayload.data.items[0].sourceDiary, 'Nova');
        assert.equal(searchPayload.data.items[0].sourceFile, '2026-04-02.md');
        assert.match(searchPayload.data.items[0].text, /写回完成后，下一轮需要能检索并注入召回/u);

        assert.equal(contextResponse.status, 200);
        assert.equal(contextPayload.success, true);
        assert.equal(contextPayload.data.recallBlocks.length, 1);
        assert.equal(contextPayload.data.recallBlocks[0].metadata.sourceDiary, 'Nova');
        assert.equal(contextPayload.data.recallBlocks[0].metadata.sourceFile, '2026-04-02.md');
        assert.match(contextPayload.data.recallBlocks[0].text, /写回完成后，下一轮需要能检索并注入召回/u);
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

test('POST /admin_api/openclaw/tools/vcp_memory_write bridges durable memory writes without exposing DailyNote directly', async () => {
    let capturedCall = null;
    const plugins = new Map(createPluginManager().plugins);
    plugins.set('DailyNote', {
        name: 'DailyNote',
        displayName: '日记插件',
        description: '用于创建日记。',
        pluginType: 'hybridservice',
        communication: {
            protocol: 'direct',
            timeout: 30000
        },
        capabilities: {
            invocationCommands: [
                {
                    command: 'create',
                    description: '创建日记。\n- `command`: 固定为 `create`。\n- `maid`: 必需。\n- `Date`: 必需。\n- `Content`: 必需。\n- `Tag`: 必需。\n<<<[TOOL_REQUEST]>>>\ntool_name:「始」DailyNote「末」,\ncommand:「始」create「末」,\nmaid:「始」[Nova]Nova「末」,\nDate:「始」2026-04-03「末」,\nContent:「始」示例内容「末」,\nTag:「始」durable-memory, bridge-tool「末」\n<<<[END_TOOL_REQUEST]>>>',
                    parameters: [
                        { name: 'command', required: true, type: 'string' },
                        { name: 'maid', required: true, type: 'string' },
                        { name: 'Date', required: true, type: 'string' },
                        { name: 'Content', required: true, type: 'string' },
                        { name: 'Tag', required: true, type: 'string' }
                    ]
                }
            ]
        }
    });
    const pluginManager = createPluginManager({
        plugins,
        async processToolCall(toolName, args) {
            capturedCall = { toolName, args };
            return {
                filePath: '/tmp/Nova/2026-04-03.md'
            };
        }
    });
    const server = await createServer(pluginManager);

    try {
        const response = await fetch(`${server.baseUrl}/admin_api/openclaw/tools/vcp_memory_write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
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
            })
        });
        const payload = await response.json();

        assert.equal(response.status, 200);
        assert.equal(payload.success, true);
        assert.equal(payload.data.toolName, 'vcp_memory_write');
        assert.equal(payload.data.result.writeStatus, 'created');
        assert.deepEqual(payload.data.audit, {
            approvalUsed: false,
            distributed: false
        });
        assert.equal(capturedCall.toolName, 'DailyNote');
        assert.equal(capturedCall.args.command, 'create');
        assert.equal(capturedCall.args.Tag, 'Tag: durable-memory, bridge-tool');
        assert.deepEqual(capturedCall.args.__openclawContext, {
            source: 'openclaw-memory-write',
            agentId: 'agent.nova',
            sessionId: 'sess-tool-memory-001',
            requestId: 'req-tool-memory-001'
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
