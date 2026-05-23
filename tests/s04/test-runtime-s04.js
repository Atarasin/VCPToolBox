const { describe, it, before } = require('node:test');
const assert = require('node:assert');

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

require.cache[require.resolve('../../modules/agentGateway/services/contextRuntimeService')] = {
    id: require.resolve('../../modules/agentGateway/services/contextRuntimeService'),
    filename: require.resolve('../../modules/agentGateway/services/contextRuntimeService'),
    loaded: true,
    exports: {
        collectRagItems: async (args) => mockCollectRagItemsImpl(args),
        createContextRuntimeService: () => ({})
    }
};

const {
    createRecallRuntimeService,
    aggregateDeduplicateItems,
    interleaveItems,
    deduplicateItems,
    sortItemsByScore,
    applyRoleValve,
    parseRoleValveConfig,
    evaluateRoleValveExpression,
    applyAIMemo,
    AIMEMO_PRESETS,
    mapResolvedRecallFailure
} = require('../../modules/agentGateway/services/recallRuntimeService');

function createMockResolver(rules, extraProfileFields = {}, profileName = 'default') {
    return {
        resolveForAgent: (agentId, requestedProfile) => ({
            resolved: true,
            agentId,
            profileName: requestedProfile || profileName,
            rules: rules.map((rule) => {
                const baseMode = rule.baseMode || rule.type || 'rag';
                const hasStructuredTargets = Boolean(rule.targets && typeof rule.targets === 'object' && !Array.isArray(rule.targets));
                const shouldNormalizeStructured = hasStructuredTargets || Boolean(rule.baseMode);
                const diaries = Array.isArray(rule.targets?.diaries)
                    ? rule.targets.diaries
                    : (rule.diaries || ['TestDiary']);
                const normalizedTargets = shouldNormalizeStructured
                    ? {
                        ...(hasStructuredTargets ? rule.targets : {}),
                        diaries,
                        ...((hasStructuredTargets && rule.targets.kMultiplier !== undefined)
                            ? {}
                            : { kMultiplier: rule.kMultiplier ?? 1.0 })
                    }
                    : null;

                return {
                    baseMode,
                    modifiers: rule.modifiers || {},
                    gateThreshold: rule.gateThreshold ?? null,
                    ...(normalizedTargets ? { targets: normalizedTargets } : {}),
                    ...rule
                };
            }),
            ...extraProfileFields
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
    mockCollectRagItemsResult = {
        success: true,
        items: mockItems || [],
        timeRanges: enrichedFields.timeRanges || [],
        activatedGroups: enrichedFields.activatedGroups || new Map(),
        rerankApplied: enrichedFields.rerankApplied || false,
        coreTags: enrichedFields.coreTags || []
    };
    mockCollectRagItemsImpl = async (args) => {
        mockCollectRagItemsCalls.push(args);
        return { ...mockCollectRagItemsResult };
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
        fullTextRetriever: async (args) => mockFullTextImpl(args),
        ...overrides
    });
}

describe('RecallRuntimeService S04 — merge policy', () => {
    describe('aggregateDeduplicateItems', () => {
        it('uses max by default', () => {
            const items = [
                { text: 'dup', score: 0.7, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'dup', score: 0.9, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'unique', score: 0.8, sourceDiary: 'B', sourceFile: 'b.md' }
            ];
            const result = aggregateDeduplicateItems(items);
            assert.strictEqual(result.length, 2);
            const dup = result.find((i) => i.text === 'dup');
            assert.strictEqual(dup.score, 0.9);
        });

        it('uses sum strategy', () => {
            const items = [
                { text: 'dup', score: 0.7, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'dup', score: 0.9, sourceDiary: 'A', sourceFile: 'a.md' }
            ];
            const result = aggregateDeduplicateItems(items, 'sum');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].score, 1.6);
        });

        it('uses mean strategy', () => {
            const items = [
                { text: 'dup', score: 0.6, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'dup', score: 0.8, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'dup', score: 1.0, sourceDiary: 'A', sourceFile: 'a.md' }
            ];
            const result = aggregateDeduplicateItems(items, 'mean');
            assert.strictEqual(result.length, 1);
            assert.ok(Math.abs(result[0].score - 0.8) < 1e-9, `expected 0.8, got ${result[0].score}`);
        });

        it('ignores invalid scores', () => {
            const items = [
                { text: 'a', score: NaN, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'a', score: 0.5, sourceDiary: 'A', sourceFile: 'a.md' }
            ];
            const result = aggregateDeduplicateItems(items, 'sum');
            assert.strictEqual(result.length, 1);
            assert.strictEqual(result[0].score, 0.5);
        });
    });

    describe('interleaveItems', () => {
        it('round-robins items from each rule array', () => {
            const ruleItems = [
                [{ text: 'a1', score: 0.9 }, { text: 'a2', score: 0.8 }],
                [{ text: 'b1', score: 0.85 }, { text: 'b2', score: 0.75 }]
            ];
            const result = interleaveItems(ruleItems);
            assert.deepStrictEqual(result.map((i) => i.text), ['a1', 'b1', 'a2', 'b2']);
        });

        it('continues until every rule is exhausted', () => {
            const ruleItems = [
                [{ text: 'a1' }, { text: 'a2' }, { text: 'a3' }],
                [{ text: 'b1' }]
            ];
            const result = interleaveItems(ruleItems);
            assert.deepStrictEqual(result.map((i) => i.text), ['a1', 'b1', 'a2', 'a3']);
        });

        it('handles empty rule arrays', () => {
            const ruleItems = [
                [{ text: 'a1' }],
                []
            ];
            const result = interleaveItems(ruleItems);
            assert.deepStrictEqual(result.map((i) => i.text), ['a1']);
        });

        it('handles single rule', () => {
            const ruleItems = [
                [{ text: 'a1' }, { text: 'a2' }]
            ];
            const result = interleaveItems(ruleItems);
            assert.deepStrictEqual(result.map((i) => i.text), ['a1', 'a2']);
        });
    });

    describe('executeRecall — default merge (backward compat)', () => {
        it('uses deduplicate + sort + truncate when merge is unset', async () => {
            resetMocks([
                { text: 'dup', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'dup', score: 0.7, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'unique', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['TestDiary'], modifiers: { truncate: 2 } }
                ]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentDef', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            // dup should keep higher score (0.9), sorted first
            assert.strictEqual(result.items[0].text, 'dup');
            assert.strictEqual(result.items[0].score, 0.9);
            assert.strictEqual(result.items[1].text, 'unique');

            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.ok(mergeStage);
            assert.strictEqual(mergeStage.detail.strategy, 'default');
            assert.strictEqual(mergeStage.detail.aggregate, 'max');
        });
    });

    describe('executeRecall — interleave merge', () => {
        it('interleaves items from two rules', async () => {
            resetMocks();
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return {
                    success: true,
                    items: [
                        { text: 'rule1-a', score: 0.9, sourceDiary: args.requestedDiaries[0], sourceFile: 'a.md' },
                        { text: 'rule1-b', score: 0.8, sourceDiary: args.requestedDiaries[0], sourceFile: 'b.md' }
                    ]
                };
            };
            mockFullTextImpl = async (args) => {
                mockFullTextCalls.push(args);
                return {
                    success: true,
                    targetDiaries: args.requestedDiaries,
                    items: [
                        { text: 'rule2-a', score: 0.45, sourceDiary: args.requestedDiaries[0], sourceFile: 'a.md' },
                        { text: 'rule2-b', score: 0.4, sourceDiary: args.requestedDiaries[0], sourceFile: 'b.md' }
                    ]
                };
            };

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'] },
                    { type: 'full_text', diaries: ['DiaryB'] }
                ], { merge: 'interleave' }),
                pluginManager: createMockPluginManager(),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentInt', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 4);
            // Interleaved: rule1-a, rule2-a, rule1-b, rule2-b
            assert.strictEqual(result.items[0].text, 'rule1-a');
            assert.strictEqual(result.items[1].text, 'rule2-a');
            assert.strictEqual(result.items[2].text, 'rule1-b');
            assert.strictEqual(result.items[3].text, 'rule2-b');

            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.ok(mergeStage);
            assert.strictEqual(mergeStage.detail.strategy, 'interleave');
            assert.strictEqual(mergeStage.detail.interleavedRuleCount, 2);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            assert.strictEqual(mockFullTextCalls.length, 1);

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
            mockFullTextImpl = async (args) => {
                mockFullTextCalls.push(args);
                return { ...mockFullTextResult };
            };
        });

        it('interleave deduplicates cross-rule duplicates with aggregate=max', async () => {
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return {
                    success: true,
                    items: [
                        { text: 'shared', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'x.md' },
                        { text: 'only-a', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
                    ]
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'] },
                    { type: 'rag', diaries: ['DiaryB'] }
                ], { merge: 'interleave' }),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentIntDedup', query: 'query' });
            assert.strictEqual(result.success, true);
            // shared 与 only-a 去重后都应保留，且不能因为第二条 rule 为空而丢失全部结果。
            assert.deepStrictEqual(result.items.map((item) => item.text), ['shared', 'only-a']);

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });

        it('interleave with partial overlap preserves diverse items', async () => {
            let callIndex = 0;
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                callIndex += 1;
                if (callIndex === 1) {
                    return {
                        success: true,
                        items: [
                            { text: 'shared', score: 0.9, sourceDiary: 'D', sourceFile: 'x.md' },
                            { text: 'only-a', score: 0.8, sourceDiary: 'D', sourceFile: 'a.md' }
                        ]
                    };
                }
                return {
                    success: true,
                    items: [
                        { text: 'shared', score: 0.85, sourceDiary: 'D', sourceFile: 'x.md' },
                        { text: 'only-b', score: 0.75, sourceDiary: 'D', sourceFile: 'b.md' }
                    ]
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'] },
                    { type: 'rag', diaries: ['DiaryB'] }
                ], { merge: 'interleave', aggregate: 'max' }),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentIntPart', query: 'query' });
            assert.strictEqual(result.success, true);
            // Deduped: shared (score 0.9 from rule1), only-a (0.8), only-b (0.75)
            // itemsByRule[0] = [shared(0.9), only-a(0.8)]
            // itemsByRule[1] = [only-b(0.75)] (shared already seen)
            // 新 interleave 语义会继续输出剩余多样结果：[shared, only-b, only-a]
            assert.strictEqual(result.items.length, 3);
            assert.strictEqual(result.items[0].text, 'shared');
            assert.strictEqual(result.items[1].text, 'only-b');
            assert.strictEqual(result.items[2].text, 'only-a');
            assert.strictEqual(result.items[0].score, 0.9);

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });
    });

    describe('executeRecall — structured rule compatibility', () => {
        it('uses baseMode and targets.diaries for retrieval and exposes rule projection', async () => {
            resetMocks([
                { text: 'structured', score: 0.9, sourceDiary: 'DiaryA', sourceFile: 'a.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        id: 'structured-rule',
                        baseMode: 'rag',
                        targets: {
                            diaries: ['DiaryA', 'DiaryB'],
                            aggregate: true,
                            kMultiplier: 1.5
                        },
                        projection: 'recall_blocks',
                        modifiers: { time: true }
                    }
                ]),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentStructured', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            assert.deepStrictEqual(mockCollectRagItemsCalls[0].requestedDiaries, ['DiaryA', 'DiaryB']);
            assert.strictEqual(result.diagnostics.rules[0].type, 'rag');
            assert.strictEqual(result.diagnostics.rules[0].baseMode, 'rag');
            assert.strictEqual(result.diagnostics.rules[0].projection, 'recall_blocks');
            assert.strictEqual(result.diagnostics.rules[0].targetAggregate, true);
        });

        it('uses targets.kMultiplier for structured rag rules', async () => {
            resetMocks([
                { text: 'structured-k', score: 0.9, sourceDiary: 'DiaryA', sourceFile: 'a.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        baseMode: 'rag',
                        targets: {
                            diaries: ['DiaryA'],
                            kMultiplier: 2.0
                        },
                        modifiers: {}
                    }
                ]),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentStructuredK', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.k, 10);
            assert.strictEqual(result.diagnostics.rules[0].targetMode, 'single');
        });

        it('rejects explicit multi-diary structured rules when targets.aggregate=false', async () => {
            resetMocks([
                { text: 'should-not-run', score: 0.9, sourceDiary: 'DiaryA', sourceFile: 'a.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        baseMode: 'rag',
                        targets: {
                            diaries: ['DiaryA', 'DiaryB'],
                            aggregate: false,
                            kMultiplier: 1.0
                        },
                        modifiers: {}
                    }
                ]),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentStructuredInvalid', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(result.diagnostics.rules[0].status, 'error');
            assert.strictEqual(result.diagnostics.rules[0].targetMode, 'parallel');
            assert.strictEqual(result.diagnostics.rules[0].errorMessage, 'Structured multi-diary rules must set targets.aggregate=true');
        });

        it('infers aggregate mode for legacy multi-diary rules', async () => {
            resetMocks([
                { text: 'legacy-aggregate', score: 0.9, sourceDiary: 'DiaryA', sourceFile: 'a.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([
                    {
                        type: 'rag',
                        diaries: ['DiaryA', 'DiaryB'],
                        modifiers: {}
                    }
                ]),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentLegacyAggregate', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            assert.deepStrictEqual(mockCollectRagItemsCalls[0].requestedDiaries, ['DiaryA', 'DiaryB']);
            assert.strictEqual(result.diagnostics.rules[0].targetMode, 'aggregate');
            assert.strictEqual(result.diagnostics.rules[0].targetAggregate, true);
            assert.strictEqual(result.diagnostics.rules[0].targetAggregateInferred, true);
        });
    });

    describe('executeRecall — aggregate strategies', () => {
        it('aggregate=sum combines duplicate scores', async () => {
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return {
                    success: true,
                    items: [
                        { text: 'dup', score: 0.6, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                        { text: 'unique', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' }
                    ]
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'] },
                    { type: 'rag', diaries: ['DiaryB'] }
                ], { aggregate: 'sum' }),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentSum', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            const dup = result.items.find((i) => i.text === 'dup');
            assert.strictEqual(dup.score, 1.2); // 0.6 + 0.6

            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.strictEqual(mergeStage.detail.aggregate, 'sum');

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });

        it('aggregate=mean combines duplicate scores', async () => {
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return {
                    success: true,
                    items: [
                        { text: 'dup', score: 0.6, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                        { text: 'unique', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' }
                    ]
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'] },
                    { type: 'rag', diaries: ['DiaryB'] }
                ], { aggregate: 'mean' }),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentMean', query: 'query' });
            assert.strictEqual(result.success, true);
            const dup = result.items.find((i) => i.text === 'dup');
            assert.strictEqual(dup.score, 0.6); // (0.6 + 0.6) / 2

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });
    });

    describe('executeRecall — profile-level truncateTo', () => {
        it('truncateTo limits output count', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'b', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' },
                { text: 'c', score: 0.7, sourceDiary: 'TestDiary', sourceFile: 'c.md' },
                { text: 'd', score: 0.6, sourceDiary: 'TestDiary', sourceFile: 'd.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver(
                    [{ type: 'rag', diaries: ['TestDiary'] }],
                    { truncateTo: 2 }
                ),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentTT', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.items[0].text, 'a');
            assert.strictEqual(result.items[1].text, 'b');

            assert.strictEqual(result.diagnostics.profileMeta.truncateTo, 2);
        });

        it('truncateTo overrides rule-level truncate', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'b', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' },
                { text: 'c', score: 0.7, sourceDiary: 'TestDiary', sourceFile: 'c.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver(
                    [{ type: 'rag', diaries: ['TestDiary'], modifiers: { truncate: 1 } }],
                    { truncateTo: 2 }
                ),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentTTOvr', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
        });

        it('profileMeta includes merge, aggregate, projection when set', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver(
                    [{ type: 'rag', diaries: ['TestDiary'] }],
                    { merge: 'interleave', aggregate: 'sum', projection: 'recallBlock' }
                ),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentMeta', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.diagnostics.profileMeta.merge, 'interleave');
            assert.strictEqual(result.diagnostics.profileMeta.aggregate, 'sum');
            assert.strictEqual(result.diagnostics.profileMeta.projection, 'recallBlock');
        });
    });

    describe('executeRecall — merge diagnostics enrichment', () => {
        it('mergeResults stage includes strategy and aggregate', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver(
                    [{ type: 'rag', diaries: ['TestDiary'] }],
                    { merge: 'interleave', aggregate: 'mean' }
                ),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentDiag', query: 'query' });
            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.ok(mergeStage);
            assert.strictEqual(mergeStage.status, 'ok');
            assert.strictEqual(mergeStage.detail.strategy, 'interleave');
            assert.strictEqual(mergeStage.detail.aggregate, 'mean');
            assert.strictEqual(mergeStage.detail.inputRuleCount, 1);
            assert.strictEqual(mergeStage.detail.inputItemCount, 1);
            assert.strictEqual(mergeStage.detail.outputItemCount, 1);
        });
    });

    describe('executeRecall — inlineRule backward compat', () => {
        it('inlineRule ignores profile merge settings (no merge field)', async () => {
            resetMocks([
                { text: 'inline item', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.strictEqual(mergeStage.detail.strategy, 'default');
        });
    });
});

// ---------------------------------------------------------------------------
// S04 Runtime Semantics Tests
// ---------------------------------------------------------------------------

describe('RecallRuntimeService S04 — runtime semantics', () => {
    const mockPluginManager = createMockPluginManager();
    const mockContextService = createMockContextRuntimeService();

    describe('full_text independent retrieval', () => {
        it('full_text rule uses fullTextRetriever instead of collectRagItems', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'full_text', diaries: ['TestDiary'] }]);
            const service = createTestService({
                recallProfileResolver: resolver,
                pluginManager: mockPluginManager,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentFT', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
            assert.deepStrictEqual(result.diagnostics.rules[0].targetDiaries, ['TestDiary']);
        });

        it('full_text with kMultiplier still stays on fullTextRetriever path', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'full_text', diaries: ['TestDiary'], kMultiplier: 1.5 }]);
            const service = createTestService({
                recallProfileResolver: resolver,
                pluginManager: mockPluginManager,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentFT', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
            assert.strictEqual(mockFullTextCalls[0].rule.kMultiplier, 1.5);
        });
    });

    describe('gated_full_text gate evaluation', () => {
        it('gated_full_text passes gate and uses fullTextRetriever', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'gated_full_text', diaries: ['TestDiary'], gateThreshold: 0.5 }
            ]);
            const service = createTestService({
                recallProfileResolver: resolver,
                pluginManager: mockPluginManager,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentGFT', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
            const ruleStage = result.diagnostics.pipelineStages.find((s) => s.name === 'ruleExecution');
            assert.strictEqual(ruleStage.status, 'ok');
        });

        it('gated_full_text blocks when gate fails', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'gated_full_text', diaries: ['AnotherDiary'], gateThreshold: 0.99 }
            ]);
            const service = createTestService({
                recallProfileResolver: resolver,
                pluginManager: mockPluginManager,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentGFT', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 0);
            const ruleStage = result.diagnostics.pipelineStages.find((s) => s.name === 'ruleExecution');
            assert.strictEqual(ruleStage.status, 'gated');
        });
    });

    describe('tagMemo.weight dynamic control', () => {
        it('forwards tagMemo.weight to ragOptions', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: { weight: 0.42 } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentTMW', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemoWeight, 0.42);
        });

        it('includes tagMemo weight in rule modifierDetails', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: { weight: 0.42 } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentTMW', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const tagMemoDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'tagMemo');
            assert.ok(tagMemoDetail);
            assert.strictEqual(tagMemoDetail.weight, 0.42);
            assert.strictEqual(tagMemoDetail.applied, true);
        });
    });

    describe('tagMemo.geodesic options passthrough', () => {
        it('forwards tagMemo.geodesic to ragOptions', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: { geodesic: true } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentTMG', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemoGeodesic, true);
        });

        it('includes tagMemo geodesic in rule modifierDetails', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: { geodesic: true } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentTMG', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const tagMemoDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'tagMemo');
            assert.ok(tagMemoDetail);
            assert.strictEqual(tagMemoDetail.geodesic, true);
        });
    });

    describe('rerank.weight forwarding', () => {
        it('forwards rerank.weight to ragOptions', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { rerank: { weight: 0.7 } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentRW', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.rerankWeight, 0.7);
        });

        it('includes rerank weight in rule modifierDetails', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { rerank: { weight: 0.7 } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentRW', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const rerankDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'rerank');
            assert.ok(rerankDetail);
            assert.strictEqual(rerankDetail.weight, 0.7);
            assert.strictEqual(rerankDetail.applied, true);
        });
    });

    describe('roleValve expression AND/OR/object', () => {
        it('parses expression syntax as pre-gate mode', () => {
            const config = parseRoleValveConfig({ enabled: true, expression: '@User>=2&@Assistant<5' });
            assert.strictEqual(config.mode, 'expression');
            assert.strictEqual(config.enabled, true);
            assert.strictEqual(config.expression, '@User>=2&@Assistant<5');
        });

        it('parses legacy role filter syntax defaulting to OR', () => {
            const config = parseRoleValveConfig({ roles: ['user'] });
            assert.strictEqual(config.mode, 'roles');
            assert.deepStrictEqual(config.roles, ['user']);
            assert.strictEqual(config.expression, 'OR');
        });

        it('evaluates expression against conversation role counts', () => {
            const result = evaluateRoleValveExpression('@User>=2&@Assistant<2|@System>=1', [
                { role: 'user', content: 'U1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'U2' }
            ]);
            assert.strictEqual(result.passed, true);
            assert.deepStrictEqual(result.roleCounts, { User: 2, Assistant: 1, System: 0 });
        });

        it('applyRoleValve gates result set when expression is not satisfied', () => {
            const items = [
                { text: 'A', role: 'user' },
                { text: 'B', role: 'assistant' }
            ];
            const result = applyRoleValve(items, { enabled: true, expression: '@User>=2&@Assistant<1' }, {
                messages: [
                    { role: 'user', content: 'U1' },
                    { role: 'assistant', content: 'A1' }
                ]
            });
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.expression, '@User>=2&@Assistant<1');
            assert.strictEqual(result.passed, false);
            assert.strictEqual(result.matchedCount, 0);
        });

        it('roleValve expression blocks retrieval before base mode when condition fails', async () => {
            resetMocks([
                { text: 'A', score: 0.9, sourceDiary: 'TestDiary', role: 'user' }
            ]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { roleValve: { enabled: true, expression: '@User>=2' } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'AgentRVExprBlock',
                query: 'test query',
                messages: [{ role: 'user', content: 'only one user message' }]
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            const ruleDiag = result.diagnostics.rules[0];
            const rvDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.ok(rvDetail);
            assert.strictEqual(ruleDiag.status, 'gated');
            assert.strictEqual(ruleDiag.roleValvePassed, false);
            assert.strictEqual(rvDetail.expression, '@User>=2');
            assert.strictEqual(rvDetail.passed, false);
            assert.deepStrictEqual(rvDetail.roleCounts, { User: 1, Assistant: 0, System: 0 });
        });

        it('roleValve expression allows retrieval when request messages satisfy condition', async () => {
            resetMocks([
                { text: 'A', score: 0.9, sourceDiary: 'TestDiary', role: 'user' }
            ]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { roleValve: { enabled: true, expression: '@User>=2&@Assistant<2' } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'AgentRVExprPass',
                query: 'test query',
                messages: [
                    { role: 'user', content: 'U1' },
                    { role: 'assistant', content: 'A1' },
                    { role: 'user', content: 'U2' }
                ]
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            const rvDetail = result.diagnostics.rules[0].modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.strictEqual(rvDetail.passed, true);
            assert.strictEqual(rvDetail.stage, 'pre');
        });

        it('roleValve legacy filter detail still includes expression and matchedCount', async () => {
            resetMocks([
                { text: 'A', score: 0.9, sourceDiary: 'TestDiary', role: 'user' },
                { text: 'B', score: 0.8, sourceDiary: 'TestDiary', role: 'assistant' },
                { text: 'C', score: 0.7, sourceDiary: 'TestDiary', role: 'system' }
            ]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { roleValve: { roles: ['user'], expression: 'OR' } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentRV', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const rvDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.ok(rvDetail);
            assert.strictEqual(rvDetail.expression, 'OR');
            assert.strictEqual(rvDetail.matchedCount, 1);
            assert.strictEqual(rvDetail.inputCount, 3);
            assert.strictEqual(rvDetail.outputCount, 1);
        });

        it('legacy array syntax still works and defaults to OR', async () => {
            resetMocks([
                { text: 'A', score: 0.9, sourceDiary: 'TestDiary', role: 'user' },
                { text: 'B', score: 0.8, sourceDiary: 'TestDiary', role: 'assistant' }
            ]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { roleValve: ['user'] } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentRVLegacy', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const rvDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.ok(rvDetail);
            assert.strictEqual(rvDetail.expression, 'OR');
            assert.strictEqual(rvDetail.outputCount, 1);
        });
    });

    describe('aiMemo.preset lookup', () => {
        it('AIMEMO_PRESETS has default, concise, detailed, timeline', () => {
            assert.ok(AIMEMO_PRESETS.default);
            assert.ok(AIMEMO_PRESETS.concise);
            assert.ok(AIMEMO_PRESETS.detailed);
            assert.ok(AIMEMO_PRESETS.timeline);
        });

        it('applyAIMemo modifierDetail records preset name', async () => {
            const items = [{ text: 'Test', sourceDiary: 'TestDiary', score: 0.9 }];
            const result = await applyAIMemo(items, { url: 'http://127.0.0.1:1/', apiKey: 'k', model: 'm', preset: 'concise' });
            assert.strictEqual(result.modifierDetail.preset, 'concise');
        });

        it('applyAIMeo falls back to default preset when unknown', async () => {
            const items = [{ text: 'Test', sourceDiary: 'TestDiary', score: 0.9 }];
            const result = await applyAIMemo(items, { url: 'http://127.0.0.1:1/', apiKey: 'k', model: 'm', preset: 'nonexistent' });
            assert.strictEqual(result.modifierDetail.preset, 'default');
        });
    });

    describe('backward compatibility — boolean modifiers', () => {
        it('boolean tagMemo still works and sets tagMemo=true', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: true } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentBoolTM', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemo, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemoWeight, undefined);
        });

        it('boolean rerank still works and sets rerank=true', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { rerank: true } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentBoolRR', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.rerank, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.rerankWeight, undefined);
        });

        it('string "true" for tagMemo is parsed as boolean', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: 'true' } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentStrTM', query: 'test query' });
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemo, true);
        });
    });

    describe('edge cases', () => {
        it('empty rules array returns no profile', async () => {
            const resolver = {
                resolveForAgent: () => ({
                    resolved: true,
                    profileName: 'empty',
                    rules: []
                })
            };
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentEmpty', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.diagnostics.rules.length, 0);
        });

        it('null modifiers does not throw', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: null }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentNull', query: 'test query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
        });

        it('inlineRule path unaffected by profile merge and truncateTo', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'b', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md' },
                { text: 'c', score: 0.7, sourceDiary: 'TestDiary', sourceFile: 'c.md' }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'test query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 3);
            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.strictEqual(mergeStage.detail.strategy, 'default');
        });
    });

    describe('modifierDetail enrichment — tagMemo + rerank + roleValve', () => {
        it('rule diagnostic contains both RAG-phase and S02 modifierDetails', async () => {
            resetMocks([
                { text: 'A', score: 0.9, sourceDiary: 'TestDiary', role: 'user' }
            ]);
            const resolver = createMockResolver([
                {
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: {
                        tagMemo: { weight: 0.25, geodesic: true },
                        rerank: { weight: 0.8 },
                        roleValve: { roles: ['user'], expression: 'AND' }
                    }
                }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentCombo', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            assert.ok(Array.isArray(ruleDiag.modifierDetails));
            assert.strictEqual(ruleDiag.modifierDetails.length, 3);

            const tagMemoDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'tagMemo');
            assert.ok(tagMemoDetail);
            assert.strictEqual(tagMemoDetail.weight, 0.25);
            assert.strictEqual(tagMemoDetail.geodesic, true);

            const rerankDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'rerank');
            assert.ok(rerankDetail);
            assert.strictEqual(rerankDetail.weight, 0.8);

            const rvDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.ok(rvDetail);
            assert.strictEqual(rvDetail.expression, 'AND');
        });

        it('tagMemo modifierDetail without weight omits weight field', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { tagMemo: true } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentTMBool', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const tagMemoDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'tagMemo');
            assert.ok(tagMemoDetail);
            assert.strictEqual(tagMemoDetail.weight, undefined);
            assert.strictEqual(tagMemoDetail.geodesic, undefined);
            assert.strictEqual(tagMemoDetail.applied, true);
        });

        it('rerank modifierDetail without weight omits weight field', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['TestDiary'], modifiers: { rerank: true } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentRRBool', query: 'test query' });
            const ruleDiag = result.diagnostics.rules[0];
            const rerankDetail = ruleDiag.modifierDetails.find((d) => d.modifier === 'rerank');
            assert.ok(rerankDetail);
            assert.strictEqual(rerankDetail.weight, undefined);
            assert.strictEqual(rerankDetail.applied, true);
        });
    });

    describe('profileMeta enrichment', () => {
        it('profileMeta includes truncateTo when set', async () => {
            resetMocks([{ text: 'a', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver(
                [{ type: 'rag', diaries: ['TestDiary'] }],
                { truncateTo: 5 }
            );
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentPM', query: 'query' });
            assert.strictEqual(result.diagnostics.profileMeta.truncateTo, 5);
        });

        it('profileMeta does not include truncateTo when unset', async () => {
            resetMocks([{ text: 'a', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver(
                [{ type: 'rag', diaries: ['TestDiary'] }]
            );
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({ agentId: 'AgentPM', query: 'query' });
            assert.strictEqual(result.diagnostics.profileMeta.truncateTo, undefined);
        });
    });

    describe('mapResolvedRecallFailure — S04 error codes', () => {
        it('maps RECALL_INVALID_PROFILE to 400 with details', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_INVALID_PROFILE',
                profileName: 'badProfile',
                details: { message: 'All rules in profile are invalid' }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'badProfile');
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_PROFILE');
            assert.strictEqual(result.status, 400);
            assert.strictEqual(result.error, 'All rules in profile are invalid');
            assert.deepStrictEqual(result.details, { message: 'All rules in profile are invalid' });
        });

        it('maps RECALL_INVALID_RULE to 400 with details', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_INVALID_RULE',
                profileName: 'p1',
                details: { ruleIndex: 0, ruleType: 'unknown', message: 'Rule type "unknown" is not allowed' }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_RULE');
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('unknown'));
            assert.strictEqual(result.details.ruleIndex, 0);
        });

        it('maps RECALL_INVALID_MODIFIER to 400 with details', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_INVALID_MODIFIER',
                profileName: 'p1',
                details: { ruleIndex: 0, invalidModifiers: ['badMod'], message: 'Invalid modifiers: badMod' }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_MODIFIER');
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('badMod'));
        });

        it('maps RECALL_INVALID_DIARY to 400 with details', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_INVALID_DIARY',
                profileName: 'p1',
                details: { ruleIndex: 0, forbidden: ['D3'], message: 'Forbidden diaries: D3' }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_DIARY');
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('D3'));
        });

        it('maps AGW-prefixed RECALL_INVALID_PROFILE code', () => {
            const resolved = {
                resolved: false,
                code: 'AGW_RECALL_INVALID_PROFILE',
                details: { message: 'Bad profile' }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_PROFILE');
            assert.strictEqual(result.status, 400);
        });

        it('falls back to default message when details.message is missing', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_INVALID_MODIFIER',
                details: { ruleIndex: 0 }
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.status, 400);
            assert.ok(result.error.includes('Invalid modifier'));
        });

        it('still maps RECALL_FORBIDDEN to 403', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_FORBIDDEN',
                profileName: 'p1'
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_FORBIDDEN');
            assert.strictEqual(result.status, 403);
        });

        it('still falls back to RECALL_NO_PROFILE for unknown codes', () => {
            const resolved = {
                resolved: false,
                code: 'RECALL_UNKNOWN_CODE'
            };
            const result = mapResolvedRecallFailure(resolved, 'AgentA', 'p1');
            assert.strictEqual(result.code, 'AGW_RECALL_NO_PROFILE');
            assert.strictEqual(result.status, 404);
        });
    });
});
