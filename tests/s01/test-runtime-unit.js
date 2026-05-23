const { describe, it, before } = require('node:test');
const assert = require('node:assert');

// Mock collectRagItems before requiring the service under test
const mockCollectRagItemsCalls = [];
let mockCollectRagItemsResult = { success: true, items: [] };
let mockCollectRagItemsImpl = async (args) => {
    mockCollectRagItemsCalls.push(args);
    return { ...mockCollectRagItemsResult };
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
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    evaluateGate,
    deduplicateItems,
    sortItemsByScore,
    applyTruncate,
    createRecallBlock,
    buildRecallResult,
    MODIFIER_PIPELINE_ORDER
} = require('../../modules/agentGateway/services/recallRuntimeService');

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

function createMockResolverNoProfile() {
    return {
        resolveForAgent: () => ({
            resolved: false,
            code: 'RECALL_NO_PROFILE',
            agentId: 'Unknown',
            profileName: null,
            rules: []
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
                // Deterministic fake embedding based on text content
                if (text.includes('query')) return [0.95, 0.05, 0, 0];
                if (text.includes('unrelated')) return [0.1, 0.9, 0, 0];
                return [0.5, 0.5, 0, 0];
            }
        })
    };
}

function resetMocks() {
    mockCollectRagItemsCalls.length = 0;
    mockCollectRagItemsResult = { success: true, items: [] };
}

describe('RecallRuntimeService', () => {
    before(() => {
        resetMocks();
    });

    describe('factory validation', () => {
        it('throws when recallProfileResolver is missing', () => {
            assert.throws(() => {
                createRecallRuntimeService({ pluginManager: {} });
            }, /recallProfileResolver is required/);
        });

        it('creates service with valid dependencies', () => {
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{ type: 'rag' }])
            });
            assert.strictEqual(typeof service.executeRecall, 'function');
        });
    });

    describe('executeRecall input validation', () => {
        it('returns 400 when agentId is missing', async () => {
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{ type: 'rag' }])
            });
            const result = await service.executeRecall({ query: 'hello' });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 400);
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_QUERY');
        });

        it('returns 400 when query is missing', async () => {
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{ type: 'rag' }])
            });
            const result = await service.executeRecall({ agentId: 'TestAgent' });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 400);
            assert.strictEqual(result.code, 'AGW_RECALL_INVALID_QUERY');
        });

        it('returns 404 when no profile resolved', async () => {
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolverNoProfile()
            });
            const result = await service.executeRecall({ agentId: 'Ghost', query: 'hello' });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 404);
            assert.strictEqual(result.code, 'RECALL_NO_PROFILE');
            assert.strictEqual(result.diagnostics.rules.length, 0);
            assert.ok(result.diagnostics.totalDurationMs >= 0);
        });
    });

    describe('rag mode execution plan', () => {
        it('compiles single rag rule and calls collectRagItems with correct options', async () => {
            resetMocks();
            mockCollectRagItemsResult = {
                success: true,
                items: [
                    { text: 'result 1', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
                ]
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: { time: true, group: false, rerank: true, tagMemo: true, truncate: 3 }
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentA', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'result 1');
            assert.strictEqual(result.diagnostics.rules.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].itemCount, 1);
            assert.ok(result.diagnostics.rules[0].durationMs >= 0);

            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            const call = mockCollectRagItemsCalls[0];
            assert.deepStrictEqual(call.requestedDiaries, ['TestDiary']);
            assert.strictEqual(call.ragOptions.timeAware, true);
            assert.strictEqual(call.ragOptions.groupAware, false);
            assert.strictEqual(call.ragOptions.rerank, true);
            assert.strictEqual(call.ragOptions.tagMemo, true);
            assert.strictEqual(call.ragOptions.mode, 'rag');
        });

        it('executes multiple rules sequentially', async () => {
            resetMocks();
            let callIndex = 0;
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                callIndex += 1;
                return {
                    success: true,
                    items: [
                        { text: `result ${callIndex}`, score: 0.8 / callIndex, sourceDiary: args.requestedDiaries[0], sourceFile: `${callIndex}.md` }
                    ]
                };
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['DiaryA'], modifiers: {} },
                    { type: 'rag', diaries: ['DiaryB'], modifiers: {} }
                ]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentB', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.diagnostics.rules.length, 2);
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[1].status, 'ok');
            assert.strictEqual(mockCollectRagItemsCalls.length, 2);

            // Restore default mock
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });
    });

    describe('gated_rag gate behavior', () => {
        it('passes gate when similarity exceeds threshold', async () => {
            resetMocks();
            mockCollectRagItemsResult = {
                success: true,
                items: [
                    { text: 'gated result', score: 0.85, sourceDiary: 'TestDiary', sourceFile: 'x.md' }
                ]
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'gated_rag',
                    diaries: ['TestDiary'],
                    gateThreshold: 0.3,
                    modifiers: {}
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentG', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, true);
            assert.ok(typeof result.diagnostics.rules[0].gateSimilarity === 'number');
            assert.ok(result.diagnostics.rules[0].gateSimilarity >= 0.3);
        });

        it('blocks gate when similarity is below threshold', async () => {
            resetMocks();

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'gated_rag',
                    diaries: ['AnotherDiary'],
                    gateThreshold: 0.99, // Impossibly high
                    modifiers: {}
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentG2', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.diagnostics.rules[0].status, 'gated');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, false);
            assert.ok(typeof result.diagnostics.rules[0].gateSimilarity === 'number');
            assert.ok(result.diagnostics.rules[0].gateSimilarity < 0.99);
            // collectRagItems should NOT have been called for gated rule
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
        });

        it('passes gate when no concept vectors are available', async () => {
            resetMocks();
            mockCollectRagItemsResult = {
                success: true,
                items: [
                    { text: 'fallback result', score: 0.7, sourceDiary: 'UnknownDiary', sourceFile: 'z.md' }
                ]
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'gated_rag',
                    diaries: ['UnknownDiary'], // No vector in cache
                    gateThreshold: 0.5,
                    modifiers: {}
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentG3', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, true);
            assert.strictEqual(result.diagnostics.rules[0].gateSimilarity, null);
        });

        it('blocks gate when query vector cannot be computed', async () => {
            resetMocks();

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'gated_rag',
                    diaries: ['TestDiary'],
                    gateThreshold: 0.5,
                    modifiers: {}
                }]),
                contextRuntimeService: {
                    getKnowledgeBaseManager: () => ({}),
                    getRagPlugin: () => ({
                        enhancedVectorCache: { TestDiary: [1, 0, 0, 0] },
                        getSingleEmbeddingCached: async () => null // fails
                    })
                },
                embeddingUtilsLoader: () => ({
                    getEmbeddingsBatch: async () => [null]
                })
            });

            const result = await service.executeRecall({ agentId: 'AgentG4', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.diagnostics.rules[0].status, 'gated');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, false);
        });
    });

    describe('modifiers pipeline mapping', () => {
        it('maps all S01 modifiers to ragOptions correctly', () => {
            const { options, truncate } = buildRagOptionsFromModifiers({
                time: true,
                group: true,
                rerank: false,
                tagMemo: true,
                truncate: 7
            }, 5);

            assert.strictEqual(options.timeAware, true);
            assert.strictEqual(options.groupAware, true);
            assert.strictEqual(options.rerank, false);
            assert.strictEqual(options.tagMemo, true);
            assert.strictEqual(truncate, 7);
            assert.strictEqual(options.mode, 'rag');
        });

        it('defaults modifiers to false when omitted', () => {
            const { options, truncate } = buildRagOptionsFromModifiers({}, 5);
            assert.strictEqual(options.timeAware, false);
            assert.strictEqual(options.groupAware, false);
            assert.strictEqual(options.rerank, false);
            assert.strictEqual(options.tagMemo, false);
            assert.strictEqual(truncate, null);
        });

        it('accepts string "true" / "false" for modifiers', () => {
            const { options } = buildRagOptionsFromModifiers({
                time: 'true',
                group: 'false',
                rerank: '1',
                tagMemo: '0'
            });
            assert.strictEqual(options.timeAware, true);
            assert.strictEqual(options.groupAware, false);
            assert.strictEqual(options.rerank, true);
            assert.strictEqual(options.tagMemo, false);
        });

        it('ignores unknown modifiers', () => {
            const { options } = buildRagOptionsFromModifiers({
                time: true,
                unknownModifier: true
            });
            assert.strictEqual(options.timeAware, true);
            assert.strictEqual(options.unknownModifier, undefined);
        });

        it('parses structured tagMemo with weight and geodesic', () => {
            const { options } = buildRagOptionsFromModifiers({
                tagMemo: { weight: 0.25, geodesic: true }
            });
            assert.strictEqual(options.tagMemo, true);
            assert.strictEqual(options.tagMemoWeight, 0.25);
            assert.strictEqual(options.tagMemoGeodesic, true);
        });

        it('parses structured rerank with weight', () => {
            const { options } = buildRagOptionsFromModifiers({
                rerank: { weight: 0.7 }
            });
            assert.strictEqual(options.rerank, true);
            assert.strictEqual(options.rerankWeight, 0.7);
        });

        it('falls back to boolean parsing for non-object tagMemo/rerank', () => {
            const { options } = buildRagOptionsFromModifiers({
                tagMemo: 'true',
                rerank: false
            });
            assert.strictEqual(options.tagMemo, true);
            assert.strictEqual(options.tagMemoWeight, undefined);
            assert.strictEqual(options.tagMemoGeodesic, undefined);
            assert.strictEqual(options.rerank, false);
            assert.strictEqual(options.rerankWeight, undefined);
        });
    });

    describe('result merging', () => {
        it('deduplicates items by sourceDiary + sourceFile + text', () => {
            const items = [
                { text: 'dup', score: 0.9, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'dup', score: 0.7, sourceDiary: 'A', sourceFile: 'a.md' },
                { text: 'unique', score: 0.8, sourceDiary: 'B', sourceFile: 'b.md' }
            ];
            const deduped = deduplicateItems(items);
            assert.strictEqual(deduped.length, 2);
            assert.strictEqual(deduped[0].score, 0.9); // higher score wins
        });

        it('sorts items by score descending', () => {
            const items = [
                { text: 'c', score: 0.5 },
                { text: 'a', score: 0.9 },
                { text: 'b', score: 0.7 }
            ];
            const sorted = sortItemsByScore(items);
            assert.deepStrictEqual(sorted.map((i) => i.text), ['a', 'b', 'c']);
        });

        it('applies truncate limit', () => {
            const items = [
                { text: 'a', score: 0.9 },
                { text: 'b', score: 0.8 },
                { text: 'c', score: 0.7 }
            ];
            const truncated = applyTruncate(items, 2);
            assert.strictEqual(truncated.length, 2);
            assert.deepStrictEqual(truncated.map((i) => i.text), ['a', 'b']);
        });

        it('ignores invalid truncate values', () => {
            const items = [{ text: 'a' }, { text: 'b' }];
            assert.strictEqual(applyTruncate(items, 0).length, 2);
            assert.strictEqual(applyTruncate(items, -1).length, 2);
            assert.strictEqual(applyTruncate(items, null).length, 2);
            assert.strictEqual(applyTruncate(items, 'bad').length, 2);
        });
    });

    describe('RecallResult structure', () => {
        it('buildRecallResult produces correct shape for success', () => {
            const result = buildRecallResult({
                success: true,
                agentId: 'AgentX',
                profileName: 'prof',
                items: [{ text: 'item' }],
                diagnostics: { totalDurationMs: 42, rules: [] }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.agentId, 'AgentX');
            assert.strictEqual(result.profileName, 'prof');
            assert.deepStrictEqual(result.items, [{ text: 'item' }]);
            assert.strictEqual(result.diagnostics.totalDurationMs, 42);
            assert.strictEqual(result.status, 200);
            assert.strictEqual(result.error, null);
            assert.strictEqual(result.code, null);
        });

        it('buildRecallResult produces correct shape for failure', () => {
            const result = buildRecallResult({
                success: false,
                code: 'ERR',
                error: 'boom',
                status: 500
            });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.code, 'ERR');
            assert.strictEqual(result.error, 'boom');
            assert.strictEqual(result.status, 500);
            assert.deepStrictEqual(result.items, []);
        });

        it('createRecallBlock normalizes item fields', () => {
            const block = createRecallBlock({
                text: '  hello  ',
                score: 0.85,
                sourceDiary: 'DiaryA',
                source_file: 'file.md',
                timestamp: '2024-01-01T00:00:00Z',
                matchedTags: ['tag1', 'tag2']
            });
            assert.strictEqual(block.text, 'hello');
            assert.strictEqual(block.score, 0.85);
            assert.strictEqual(block.sourceDiary, 'DiaryA');
            assert.strictEqual(block.sourceFile, 'file.md');
            assert.strictEqual(block.timestamp, '2024-01-01T00:00:00Z');
            assert.deepStrictEqual(block.tags, ['tag1', 'tag2']);
        });
    });

    describe('error handling in rule execution', () => {
        it('marks rule as error when collectRagItems returns failure', async () => {
            resetMocks();
            mockCollectRagItemsResult = {
                success: false,
                code: 'OCW_RAG_TARGET_FORBIDDEN',
                error: 'Forbidden diary'
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['ForbiddenDiary'],
                    modifiers: {}
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentE', query: 'query' });
            assert.strictEqual(result.success, true); // Overall success; individual rule errored
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.diagnostics.rules[0].status, 'error');
            assert.strictEqual(result.diagnostics.rules[0].errorCode, 'OCW_RAG_TARGET_FORBIDDEN');
            assert.strictEqual(result.diagnostics.rules[0].errorMessage, 'Forbidden diary');
        });

        it('marks rule as error on exception and continues to next rule', async () => {
            resetMocks();
            mockCollectRagItemsImpl = async () => {
                throw new Error('Simulated RAG crash');
            };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([
                    { type: 'rag', diaries: ['A'], modifiers: {} },
                    { type: 'rag', diaries: ['B'], modifiers: {} }
                ]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentE2', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.diagnostics.rules[0].status, 'error');
            assert.strictEqual(result.diagnostics.rules[0].errorMessage, 'Simulated RAG crash');
            assert.strictEqual(result.diagnostics.rules[1].status, 'error');

            // Restore
            mockCollectRagItemsImpl = async (args) => {
                mockCollectRagItemsCalls.push(args);
                return { ...mockCollectRagItemsResult };
            };
        });
    });

    describe('cosine similarity utility', () => {
        it('computes perfect similarity for identical vectors', () => {
            const sim = computeCosineSimilarity([1, 0, 0], [1, 0, 0]);
            assert.strictEqual(sim, 1);
        });

        it('computes zero for orthogonal vectors', () => {
            const sim = computeCosineSimilarity([1, 0, 0], [0, 1, 0]);
            assert.strictEqual(sim, 0);
        });

        it('returns 0 for mismatched dimensions', () => {
            const sim = computeCosineSimilarity([1, 0], [1, 0, 0]);
            assert.strictEqual(sim, 0);
        });

        it('returns 0 for empty vectors', () => {
            assert.strictEqual(computeCosineSimilarity([], []), 0);
            assert.strictEqual(computeCosineSimilarity(null, [1]), 0);
        });
    });

    describe('modifier pipeline order constant', () => {
        it('exports expected order including S02 modifiers', () => {
            assert.deepStrictEqual(MODIFIER_PIPELINE_ORDER, [
                'time',
                'group',
                'tagMemo',
                'rerank',
                'timeDecay',
                'roleValve',
                'base64Memo',
                'truncate',
                'aiMemo'
            ]);
        });
    });
});
