const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const axios = require('axios');

const originalAxiosPost = axios.post;

// Mock collectRagItems before requiring the service under test
const mockCollectRagItemsCalls = [];
let mockCollectRagItemsResult = { success: true, items: [] };
let mockCollectRagItemsImpl = async (args) => {
    mockCollectRagItemsCalls.push(args);
    return { ...mockCollectRagItemsResult };
};
const mockFullTextCalls = [];
let mockFullTextResult = { success: true, items: [], targetDiaries: [] };
let mockFullTextImpl = async (args) => {
    mockFullTextCalls.push(args);
    return { ...mockFullTextResult };
};

require.cache[require.resolve('../../modules/agentGateway/core/recall/ragRetriever')] = {
    id: require.resolve('../../modules/agentGateway/core/recall/ragRetriever'),
    filename: require.resolve('../../modules/agentGateway/core/recall/ragRetriever'),
    loaded: true,
    exports: {
        collectRagItems: async (args) => mockCollectRagItemsImpl(args),
        createContextRuntimeService: () => ({})
    }
};

const {
    createRecallRuntimeService,
    applyS02Modifiers,
    applyTruncate,
    createRecallBlock
} = require('../../modules/agentGateway/services/recallRuntimeService');

function makeItems(count, baseScore = 1.0) {
    return Array.from({ length: count }, (_, i) => ({
        text: `item-${i}`,
        score: baseScore - i * 0.01,
        sourceDiary: 'TestDiary',
        sourceFile: `f${i}.md`
    }));
}

function createMockResolver(rules, profileName = 'default') {
    return {
        resolveForAgent: (agentId, requestedProfile) => ({
            resolved: true,
            agentId,
            profileName: requestedProfile || profileName,
            rules: rules.map((rule, index) => ({
                type: rule.type || 'rag',
                diaries: rule.diaries || ['TestDiary'],
                modifiers: rule.modifiers || {},
                gateThreshold: rule.gateThreshold ?? null,
                ...rule
            }))
        })
    };
}

function createMockPluginManager() {
    return {
        messagePreprocessors: new Map()
    };
}

function createMockContextRuntimeService() {
    return {
        getKnowledgeBaseManager: () => ({
            config: { apiKey: 'test', apiUrl: 'http://test', model: 'test-model' }
        }),
        getRagPlugin: () => ({
            enhancedVectorCache: {
                TestDiary: [1, 0, 0, 0],
                AnotherDiary: [0, 1, 0, 0]
            },
            getSingleEmbeddingCached: async (text) => {
                if (text.includes('query')) return [0.95, 0.05, 0, 0];
                if (text.includes('unrelated')) return [0.1, 0.9, 0, 0];
                return [0.5, 0.5, 0, 0];
            }
        })
    };
}

function resetMocks(mockItems, enrichedFields = {}) {
    mockCollectRagItemsCalls.length = 0;
    mockFullTextCalls.length = 0;
    mockCollectRagItemsImpl = async (args) => {
        mockCollectRagItemsCalls.push(args);
        return { ...mockCollectRagItemsResult };
    };
    mockCollectRagItemsResult = {
        success: true,
        items: mockItems || [],
        timeRanges: enrichedFields.timeRanges || [],
        activatedGroups: enrichedFields.activatedGroups || new Map(),
        rerankApplied: enrichedFields.rerankApplied || false,
        coreTags: enrichedFields.coreTags || []
    };
    mockFullTextResult = {
        success: true,
        items: mockItems || [],
        targetDiaries: enrichedFields.targetDiaries || ['TestDiary']
    };
}

function createTestService(overrides = {}) {
    return createRecallRuntimeService({
        pluginManager: createMockPluginManager(),
        contextRuntimeService: createMockContextRuntimeService(),
        embeddingUtilsLoader: () => ({}),
        fullTextRetriever: async (args) => mockFullTextImpl(args),
        llmCompletionPort: {
            available: true,
            complete: (_config, payload) => axios.post('http://test/v1/chat/completions', payload)
        },
        ...overrides
    });
}

describe('S03 — Per-rule truncate semantic governance', () => {
    describe('applyTruncate', () => {
        it('returns items unchanged when limit is not a positive number', () => {
            const items = makeItems(3);
            assert.deepStrictEqual(applyTruncate(items, null), items);
            assert.deepStrictEqual(applyTruncate(items, true), items);
            assert.deepStrictEqual(applyTruncate(items, 0), items);
            assert.deepStrictEqual(applyTruncate(items, -1), items);
            assert.deepStrictEqual(applyTruncate(items, 'bad'), items);
        });

        it('truncates items to the specified limit', () => {
            const items = makeItems(5);
            const result = applyTruncate(items, 3);
            assert.strictEqual(result.length, 3);
            assert.strictEqual(result[0].text, 'item-0');
            assert.strictEqual(result[2].text, 'item-2');
        });
    });

    describe('applyS02Modifiers — truncate in pipeline', () => {
        it('applies truncate as a pipeline modifier', () => {
            const items = makeItems(5);
            const result = applyS02Modifiers(items, { truncate: 3 });
            assert.strictEqual(result.items.length, 3);
            assert.strictEqual(result.modifierDetails.length, 1);
            assert.strictEqual(result.modifierDetails[0].modifier, 'truncate');
            assert.strictEqual(result.modifierDetails[0].inputCount, 5);
            assert.strictEqual(result.modifierDetails[0].outputCount, 3);
        });

        it('truncate:true boolean is a no-op', () => {
            const items = makeItems(5);
            const result = applyS02Modifiers(items, { truncate: true });
            assert.strictEqual(result.items.length, 5);
            const truncateDetail = result.modifierDetails.find((m) => m.modifier === 'truncate');
            assert.ok(truncateDetail);
            assert.strictEqual(truncateDetail.outputCount, 5);
        });

        it('truncate with explicit 0 is a no-op', () => {
            const items = makeItems(5);
            const result = applyS02Modifiers(items, { truncate: 0 });
            assert.strictEqual(result.items.length, 5);
            const truncateDetail = result.modifierDetails.find((m) => m.modifier === 'truncate');
            assert.ok(truncateDetail);
            assert.strictEqual(truncateDetail.outputCount, 5);
        });

        it('applies truncate after other S02 modifiers in pipeline order', () => {
            const items = [
                { text: 'a', score: 1.0, role: 'user', timestamp: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() },
                { text: 'b', score: 1.0, role: 'system' },
                { text: 'c', score: 1.0, role: 'user' },
                { text: 'd', score: 1.0, role: 'user' }
            ];
            const result = applyS02Modifiers(items, {
                roleValve: ['user'],
                truncate: 2
            });
            // roleValve first → 3 user items, then truncate → 2
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.items[0].text, 'a');
            assert.strictEqual(result.items[1].text, 'c');
        });
    });

    describe('executeRecall — multi-rule truncate independence', () => {
        it('each rule truncate applies independently before merge', async () => {
            resetMocks();

            // Use distinct diaries so each rule gets non-overlapping items
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                const diary = args.requestedDiaries?.[0];
                if (diary === 'Diary1') {
                    return {
                        success: true,
                        items: [
                            { text: 'r1-a', score: 0.95, sourceDiary: 'Diary1', sourceFile: 'a.md' },
                            { text: 'r1-b', score: 0.94, sourceDiary: 'Diary1', sourceFile: 'b.md' },
                            { text: 'r1-c', score: 0.93, sourceDiary: 'Diary1', sourceFile: 'c.md' },
                            { text: 'r1-d', score: 0.92, sourceDiary: 'Diary1', sourceFile: 'd.md' },
                            { text: 'r1-e', score: 0.91, sourceDiary: 'Diary1', sourceFile: 'e.md' }
                        ]
                    };
                }
                if (diary === 'Diary2') {
                    return {
                        success: true,
                        items: [
                            { text: 'r2-a', score: 0.95, sourceDiary: 'Diary2', sourceFile: 'x.md' },
                            { text: 'r2-b', score: 0.94, sourceDiary: 'Diary2', sourceFile: 'y.md' },
                            { text: 'r2-c', score: 0.93, sourceDiary: 'Diary2', sourceFile: 'z.md' },
                            { text: 'r2-d', score: 0.92, sourceDiary: 'Diary2', sourceFile: 'w.md' },
                            { text: 'r2-e', score: 0.91, sourceDiary: 'Diary2', sourceFile: 'v.md' }
                        ]
                    };
                }
                return { success: true, items: [] };
            };

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        type: 'rag',
                        diaries: ['Diary1'],
                        modifiers: { truncate: 3 }
                    },
                    {
                        type: 'rag',
                        diaries: ['Diary2'],
                        modifiers: { truncate: 1 }
                    }
                ])
            });

            const result = await service.executeRecall({ agentId: 'AgentMR', query: 'query' });
            assert.strictEqual(result.success, true);
            // R1 truncate=3 → 3 items, R2 truncate=1 → 1 item, merge = 4 total (no overlap)
            assert.strictEqual(result.items.length, 4, `expected 4 items, got ${result.items.length}`);

            // Verify per-rule diagnostics
            const r1Diag = result.diagnostics.rules[0];
            const r2Diag = result.diagnostics.rules[1];
            assert.strictEqual(r1Diag.truncateInputCount, 5);
            assert.strictEqual(r1Diag.truncateOutputCount, 3);
            assert.strictEqual(r2Diag.truncateInputCount, 5);
            assert.strictEqual(r2Diag.truncateOutputCount, 1);
        });

        it('profile-level truncateTo caps merged output', async () => {
            resetMocks([
                { text: 'r1-a', score: 0.95, sourceDiary: 'Diary1', sourceFile: 'a.md' },
                { text: 'r1-b', score: 0.94, sourceDiary: 'Diary1', sourceFile: 'b.md' },
                { text: 'r1-c', score: 0.93, sourceDiary: 'Diary1', sourceFile: 'c.md' },
                { text: 'r1-d', score: 0.92, sourceDiary: 'Diary1', sourceFile: 'd.md' },
                { text: 'r1-e', score: 0.91, sourceDiary: 'Diary1', sourceFile: 'e.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: {
                    resolveForAgent: () => ({
                        resolved: true,
                        agentId: 'AgentPT',
                        profileName: 'pt-profile',
                        rules: [
                            { type: 'rag', diaries: ['Diary1'], modifiers: { truncate: 3 } },
                            { type: 'rag', diaries: ['Diary1'], modifiers: { truncate: 3 } }
                        ],
                        truncateTo: 2
                    })
                },
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentPT', query: 'query' });
            assert.strictEqual(result.success, true);
            // Each rule truncate=3 → 3+3 = 6 pre-merge, profile truncateTo=2 → capped to 2
            assert.strictEqual(result.items.length, 2);
        });

        it('single-rule backward compat: truncate applies pre-merge', async () => {
            resetMocks([
                { text: 'a', score: 0.95, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'b', score: 0.94, sourceDiary: 'TestDiary', sourceFile: 'b.md' },
                { text: 'c', score: 0.93, sourceDiary: 'TestDiary', sourceFile: 'c.md' },
                { text: 'd', score: 0.92, sourceDiary: 'TestDiary', sourceFile: 'd.md' },
                { text: 'e', score: 0.91, sourceDiary: 'TestDiary', sourceFile: 'e.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        type: 'rag',
                        diaries: ['TestDiary'],
                        modifiers: { truncate: 3 }
                    }
                ])
            });

            const result = await service.executeRecall({ agentId: 'AgentBC', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 3);
            assert.strictEqual(result.diagnostics.rules[0].truncateInputCount, 5);
            assert.strictEqual(result.diagnostics.rules[0].truncateOutputCount, 3);
        });

        it('multi-rule with no truncate modifier leaves all items', async () => {
            resetMocks([
                { text: 'r1-a', score: 0.95, sourceDiary: 'Diary1', sourceFile: 'a.md' },
                { text: 'r1-b', score: 0.94, sourceDiary: 'Diary1', sourceFile: 'b.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['Diary1'], modifiers: {} },
                    { type: 'rag', diaries: ['Diary1'], modifiers: {} }
                ])
            });

            const result = await service.executeRecall({ agentId: 'AgentNoTr', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.diagnostics.rules[0].truncateInputCount, undefined);
            assert.strictEqual(result.diagnostics.rules[0].truncateOutputCount, undefined);
        });
    });
});

describe('S03 — Per-rule aiMemo semantic governance', () => {
    after(() => {
        axios.post = originalAxiosPost;
    });

    describe('executeRecall — per-rule aiMemo', () => {
        it('multi-rule per-rule aiMemo: each rule gets its own summary', async () => {
            resetMocks();
            let axiosCallCount = 0;
            axios.post = async () => {
                axiosCallCount += 1;
                return {
                    data: {
                        choices: [{
                            message: { content: `summary-${axiosCallCount}` }
                        }]
                    }
                };
            };

            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                const diary = args.requestedDiaries?.[0];
                if (diary === 'Diary1') {
                    return {
                        success: true,
                        items: [
                            { text: 'r1-a', score: 0.95, sourceDiary: 'Diary1', sourceFile: 'a.md' }
                        ]
                    };
                }
                if (diary === 'Diary2') {
                    return {
                        success: true,
                        items: [
                            { text: 'r2-a', score: 0.95, sourceDiary: 'Diary2', sourceFile: 'x.md' }
                        ]
                    };
                }
                return { success: true, items: [] };
            };

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['Diary1'], modifiers: { aiMemo: true } },
                    { type: 'rag', diaries: ['Diary2'], modifiers: { aiMemo: true } }
                ]),
                aiMemoConfigLoader: () => ({ url: 'http://test/', apiKey: 'k', model: 'm' })
            });

            const result = await service.executeRecall({ agentId: 'AgentAM', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(axiosCallCount, 2, `expected 2 axios calls, got ${axiosCallCount}`);
            assert.strictEqual(result.diagnostics.rules[0].aiMemoSummary, 'summary-1');
            assert.strictEqual(result.diagnostics.rules[1].aiMemoSummary, 'summary-2');
            assert.ok(result.diagnostics.rules[0].modifierDetails.some((m) => m.modifier === 'aiMemo'));
            assert.ok(result.diagnostics.rules[1].modifierDetails.some((m) => m.modifier === 'aiMemo'));
        });

        it('profile-level aiMemo generates summary from merged items', async () => {
            resetMocks([
                { text: 'r1-a', score: 0.95, sourceDiary: 'Diary1', sourceFile: 'a.md' },
                { text: 'r2-a', score: 0.94, sourceDiary: 'Diary2', sourceFile: 'x.md' }
            ]);
            let axiosCallCount = 0;
            axios.post = async () => {
                axiosCallCount += 1;
                return {
                    data: {
                        choices: [{
                            message: { content: 'merged-summary' }
                        }]
                    }
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({}),
                fullTextRetriever: async (args) => mockFullTextImpl(args),
                llmCompletionPort: {
                    available: true,
                    complete: (_config, payload) => axios.post('http://test/v1/chat/completions', payload)
                },
                recallProfileResolver: {
                    resolveForAgent: () => ({
                        resolved: true,
                        agentId: 'AgentPAM',
                        profileName: 'pam-profile',
                        rules: [
                            { type: 'rag', diaries: ['Diary1'], modifiers: {} },
                            { type: 'rag', diaries: ['Diary2'], modifiers: {} }
                        ],
                        aiMemo: true
                    })
                },
                aiMemoConfigLoader: () => ({ url: 'http://test/', apiKey: 'k', model: 'm' })
            });

            const result = await service.executeRecall({ agentId: 'AgentPAM', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(axiosCallCount, 1, `expected 1 axios call, got ${axiosCallCount}`);
            assert.strictEqual(result.diagnostics.summary, 'merged-summary');
            assert.ok(result.diagnostics.pipelineStages.some((s) => s.name === 'aiMemo'));
        });

        it('inlineRule path skips aiMemo', async () => {
            resetMocks([
                { text: 'inline-a', score: 0.95, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);
            let axiosCallCount = 0;
            axios.post = async () => {
                axiosCallCount += 1;
                return { data: { choices: [{ message: { content: 'should-not-run' } }] } };
            };

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
                ]),
                aiMemoConfigLoader: () => ({ url: 'http://test/', apiKey: 'k', model: 'm' })
            });

            const result = await service.executeRecall({
                agentId: 'AgentIR',
                query: 'query',
                inlineRule: {
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: { aiMemo: true }
                }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(axiosCallCount, 0, `expected 0 axios calls for inlineRule, got ${axiosCallCount}`);
        });

        it('aiMemoConfigLoader returns null skips without error', async () => {
            resetMocks([
                { text: 'a', score: 0.95, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);
            let axiosCallCount = 0;
            axios.post = async () => {
                axiosCallCount += 1;
                return { data: { choices: [{ message: { content: 'should-not-run' } }] } };
            };

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['TestDiary'], modifiers: { aiMemo: true } }
                ]),
                aiMemoConfigLoader: () => null
            });

            const result = await service.executeRecall({ agentId: 'AgentNull', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(axiosCallCount, 0);
            assert.strictEqual(result.diagnostics.rules[0].aiMemoSummary, null);
            const aiMemoDetail = result.diagnostics.rules[0].modifierDetails.find((m) => m.modifier === 'aiMemo');
            assert.ok(aiMemoDetail);
            assert.strictEqual(aiMemoDetail.skipped, true);
        });
    });
});
