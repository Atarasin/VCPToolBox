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

module.exports = {
    createKnowledgeBaseManager,
    createPluginManager,
    createRagPlugin,
    cosineSimilarity
};
