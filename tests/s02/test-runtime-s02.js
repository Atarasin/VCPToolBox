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
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    evaluateGate,
    deduplicateItems,
    sortItemsByScore,
    applyTruncate,
    createRecallBlock,
    buildRecallResult,
    applyTimeDecay,
    applyRoleValve,
    applyBase64Memo,
    applyS02Modifiers,
    applyBudgetPostProcessing,
    MODIFIER_PIPELINE_ORDER,
    MODIFIER_TO_RAG_OPTION,
    GATED_RULE_TYPES,
    FULL_TEXT_RULE_TYPES
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
        ...overrides
    });
}

describe('S02 — RecallRuntimeService extensions', () => {
    describe('GATED_RULE_TYPES', () => {
        it('includes gated_rag and gated_full_text', () => {
            assert.ok(GATED_RULE_TYPES.has('gated_rag'));
            assert.ok(GATED_RULE_TYPES.has('gated_full_text'));
            assert.strictEqual(GATED_RULE_TYPES.size, 2);
        });

        it('does not include non-gated types', () => {
            assert.ok(!GATED_RULE_TYPES.has('rag'));
            assert.ok(!GATED_RULE_TYPES.has('full_text'));
        });
    });

    describe('FULL_TEXT_RULE_TYPES', () => {
        it('includes full_text and gated_full_text', () => {
            assert.ok(FULL_TEXT_RULE_TYPES.has('full_text'));
            assert.ok(FULL_TEXT_RULE_TYPES.has('gated_full_text'));
            assert.strictEqual(FULL_TEXT_RULE_TYPES.size, 2);
        });
    });

    describe('MODIFIER_PIPELINE_ORDER — S02 extended', () => {
        it('includes all 9 modifiers in correct order', () => {
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

    describe('applyTimeDecay', () => {
        it('returns items unchanged when no config provided', () => {
            const items = [{ text: 'a', score: 0.9 }];
            const result = applyTimeDecay(items, null);
            assert.deepStrictEqual(result, items);
        });

        it('returns items unchanged when halfLifeDays is missing', () => {
            const items = [{ text: 'a', score: 0.9 }];
            const result = applyTimeDecay(items, {});
            assert.deepStrictEqual(result, items);
        });

        it('applies exponential decay based on item age', () => {
            const now = Date.now();
            const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
            const items = [
                { text: 'old', score: 1.0, timestamp: tenDaysAgo },
                { text: 'new', score: 1.0, timestamp: new Date(now).toISOString() }
            ];

            // halfLifeDays = 7 → λ = ln(2)/7 ≈ 0.099
            // After 10 days: decayFactor = e^(-0.099*10) ≈ e^(-0.99) ≈ 0.3716
            // After 0 days: decayFactor ≈ 1.0
            const result = applyTimeDecay(items, { halfLifeDays: 7 });
            assert.strictEqual(result.length, 2);
            assert.ok(result[0].score < 0.95, `old item should decay: ${result[0].score}`);
            assert.ok(result[0].score > 0.2, `old item should not decay too much: ${result[0].score}`);
            assert.ok(result[1].score > 0.99, `new item should have near-zero decay: ${result[1].score}`);
        });

        it('passes items without timestamp through unchanged', () => {
            const items = [
                { text: 'noTs', score: 0.8 }
            ];
            const result = applyTimeDecay(items, { halfLifeDays: 7 });
            assert.strictEqual(result[0].score, 0.8);
        });

        it('rejects invalid halfLifeDays values', () => {
            const items = [{ text: 'a', score: 0.9, timestamp: new Date().toISOString() }];

            assert.deepStrictEqual(applyTimeDecay(items, { halfLifeDays: 0 }), items);
            assert.deepStrictEqual(applyTimeDecay(items, { halfLifeDays: -1 }), items);
            assert.deepStrictEqual(applyTimeDecay(items, { halfLifeDays: 'bad' }), items);
        });

        it('scales linearly with halfLifeDays — longer half-life preserves more score', () => {
            const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
            const items = [{ text: 'old', score: 1.0, timestamp: tenDaysAgo }];

            const shortHalfLife = applyTimeDecay([...items], { halfLifeDays: 1 });
            const longHalfLife = applyTimeDecay([...items], { halfLifeDays: 30 });

            // Shorter half-life should result in more decay (lower score)
            assert.ok(shortHalfLife[0].score < longHalfLife[0].score,
                `short=${shortHalfLife[0].score} should be < long=${longHalfLife[0].score}`);
        });
    });

    describe('applyRoleValve', () => {
        it('returns all items when no roles specified', () => {
            const items = [{ text: 'a', role: 'user' }, { text: 'b', role: 'assistant' }];
            const result = applyRoleValve(items, []);
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.expression, 'OR');
            assert.strictEqual(result.matchedCount, 2);
        });

        it('returns all items when allowedRoles is not an array', () => {
            const items = [{ text: 'a', role: 'user' }];
            assert.strictEqual(applyRoleValve(items, null).items.length, 1);
            assert.strictEqual(applyRoleValve(items, '').items.length, 1);
        });

        it('filters items to only allowed roles', () => {
            const items = [
                { text: 'a', role: 'user' },
                { text: 'b', role: 'assistant' },
                { text: 'c', role: 'system' }
            ];
            const result = applyRoleValve(items, ['user', 'assistant']);
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.items[0].text, 'a');
            assert.strictEqual(result.items[1].text, 'b');
            assert.strictEqual(result.matchedCount, 2);
        });

        it('passes items without a role through', () => {
            const items = [
                { text: 'noRole' },
                { text: 'hasRole', role: 'system' }
            ];
            const result = applyRoleValve(items, ['user', 'assistant']);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'noRole');
        });

        it('accepts string-serialized role list', () => {
            const items = [
                { text: 'a', role: 'user' },
                { text: 'b', role: 'tool' }
            ];
            const result = applyRoleValve(items, 'user,assistant');
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'a');
        });
    });

    describe('applyBase64Memo', () => {
        it('returns items unchanged when disabled', () => {
            const items = [{ text: 'normal text' }];
            const result = applyBase64Memo(items, false);
            assert.deepStrictEqual(result.items, items);
            assert.deepStrictEqual(result.attachments, []);
        });

        it('returns items unchanged when modifier value is falsy', () => {
            const items = [{ text: 'text' }];
            assert.deepStrictEqual(applyBase64Memo(items, null).items, items);
            assert.deepStrictEqual(applyBase64Memo(items, 0).items, items);
        });

        it('extracts base64 data URIs and strips them from text', () => {
            const items = [
                { text: 'before data:image/png;base64,iVBORw0KGgo= after', sourceDiary: 'TestDiary' }
            ];
            const result = applyBase64Memo(items, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'before [base64-attachment] after');
            assert.strictEqual(result.attachments.length, 1);
            assert.strictEqual(result.attachments[0].content, 'data:image/png;base64,iVBORw0KGgo=');
            assert.strictEqual(result.attachments[0].sourceDiary, 'TestDiary');
        });

        it('handles multiple base64 attachments in one item', () => {
            const items = [
                { text: 'img1: data:image/png;base64,abc= img2: data:image/jpeg;base64,xyz=' }
            ];
            const result = applyBase64Memo(items, true);
            assert.strictEqual(result.attachments.length, 2);
            assert.strictEqual(result.attachments[0].content, 'data:image/png;base64,abc=');
            assert.strictEqual(result.attachments[1].content, 'data:image/jpeg;base64,xyz=');
        });

        it('passes items without base64 content through unchanged', () => {
            const items = [{ text: 'plain text only' }];
            const result = applyBase64Memo(items, true);
            assert.deepStrictEqual(result.items, items);
            assert.deepStrictEqual(result.attachments, []);
        });

        it('accepts string "true" for enabled', () => {
            const items = [{ text: 'data:image/png;base64,aa=' }];
            const result = applyBase64Memo(items, 'true');
            assert.strictEqual(result.attachments.length, 1);
        });
    });

    describe('applyS02Modifiers — integrated pipeline', () => {
        it('applies timeDecay then roleValve then base64Memo in order', () => {
            const now = Date.now();
            const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
            const items = [
                { text: 'user item data:image/png;base64,abc=', score: 1.0, role: 'user', timestamp: threeDaysAgo },
                { text: 'system item', score: 1.0, role: 'system', timestamp: new Date(now).toISOString() },
                { text: 'user item 2', score: 1.0, role: 'user', timestamp: new Date(now).toISOString() }
            ];

            const result = applyS02Modifiers(items, {
                timeDecay: { halfLifeDays: 7 },
                roleValve: ['user'],
                base64Memo: true
            });

            // After timeDecay: user scores decay, system no change
            // After roleValve: system removed, only user items remain
            // After base64Memo: base64 stripped from first item
            assert.strictEqual(result.items.length, 2);
            assert.strictEqual(result.items[0].role, 'user');
            assert.strictEqual(result.items[1].role, 'user');
            assert.strictEqual(result.items[0].text, 'user item [base64-attachment]');
            // After timeDecay (halfLifeDays=7, age=3 days), score should be decayed from 1.0
            const decayedScore = result.items[0].score;
            assert.ok(decayedScore > 0.7 && decayedScore < 1.0,
                `score should be decayed, got ${decayedScore}`);
            assert.strictEqual(result.attachments.length, 1);
        });

        it('respects pipeline order defined in MODIFIER_PIPELINE_ORDER', () => {
            const timeDecayIdx = MODIFIER_PIPELINE_ORDER.indexOf('timeDecay');
            const roleValveIdx = MODIFIER_PIPELINE_ORDER.indexOf('roleValve');
            const base64MemoIdx = MODIFIER_PIPELINE_ORDER.indexOf('base64Memo');

            assert.ok(timeDecayIdx < roleValveIdx, 'timeDecay should come before roleValve');
            assert.ok(roleValveIdx < base64MemoIdx, 'roleValve should come before base64Memo');
        });

        it('returns items unchanged when modifiers are empty', () => {
            const items = [{ text: 'a', score: 0.9 }];
            const result = applyS02Modifiers(items, {});
            assert.deepStrictEqual(result.items, items);
            assert.deepStrictEqual(result.attachments, []);
        });

        it('handles null modifiers gracefully', () => {
            const items = [{ text: 'a' }];
            const result = applyS02Modifiers(items, null);
            assert.deepStrictEqual(result.items, items);
            assert.deepStrictEqual(result.attachments, []);
        });
    });

    describe('full_text rule execution via executeRecall', () => {
        it('executes full_text rule via independent fullTextRetriever', async () => {
            resetMocks([
                { text: 'full content 1', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'full_text',
                    diaries: ['TestDiary'],
                    modifiers: { timeDecay: { halfLifeDays: 7 } }
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentFT', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].type, 'full_text');
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
            assert.deepStrictEqual(mockFullTextCalls[0].requestedDiaries, ['TestDiary']);
            assert.deepStrictEqual(result.diagnostics.rules[0].targetDiaries, ['TestDiary']);
        });

        it('executes full_text rule with timeDecay modifier', async () => {
            const now = Date.now();
            const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
            resetMocks([
                { text: 'old item', score: 1.0, sourceDiary: 'TestDiary', sourceFile: 'old.md', timestamp: threeDaysAgo },
                { text: 'new item', score: 1.0, sourceDiary: 'TestDiary', sourceFile: 'new.md', timestamp: new Date(now).toISOString() }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'full_text',
                    diaries: ['TestDiary'],
                    modifiers: { timeDecay: { halfLifeDays: 7 } }
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentFT2', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            // After timeDecay + sort, higher-scored items come first (new > old)
            assert.ok(result.items[0].score > result.items[1].score,
                `new item score ${result.items[0].score} should be > old item score ${result.items[1].score}`);
        });

        it('executes full_text rule with base64Memo modifier', async () => {
            resetMocks([
                { text: 'text with data:image/png;base64,abc=', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'img.md' },
                { text: 'plain text', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'plain.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'full_text',
                    diaries: ['TestDiary'],
                    modifiers: { base64Memo: true }
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentFT3', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            // First item should have base64 stripped
            assert.strictEqual(result.items[0].text, 'text with [base64-attachment]');
            assert.ok(result.diagnostics.attachments, 'should have attachments');
            assert.strictEqual(result.diagnostics.attachments.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].attachmentCount, 1);
        });
    });

    describe('gated_full_text rule execution via executeRecall', () => {
        it('passes gate and executes full_text retrieval', async () => {
            resetMocks([
                { text: 'gated full result', score: 0.85, sourceDiary: 'TestDiary', sourceFile: 'x.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'gated_full_text',
                    diaries: ['TestDiary'],
                    gateThreshold: 0.3,
                    modifiers: {}
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentGFT', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].type, 'gated_full_text');
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, true);

            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
        });

        it('blocks gate when similarity is below threshold', async () => {
            resetMocks();

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'gated_full_text',
                    diaries: ['AnotherDiary'],
                    gateThreshold: 0.99,
                    modifiers: {}
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentGFT2', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 0);
            assert.strictEqual(result.diagnostics.rules[0].status, 'gated');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, false);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 0);
        });

        it('passes gate when no concept vectors are available', async () => {
            resetMocks([
                { text: 'fallback', score: 0.7, sourceDiary: 'UnknownDiary', sourceFile: 'z.md' }
            ]);

            const service = createTestService({
                recallProfileResolver: createMockResolver([{
                    type: 'gated_full_text',
                    diaries: ['UnknownDiary'],
                    gateThreshold: 0.5,
                    modifiers: {}
                }])
            });

            const result = await service.executeRecall({ agentId: 'AgentGFT3', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, true);
            assert.strictEqual(result.diagnostics.rules[0].gateSimilarity, null);
            assert.strictEqual(mockCollectRagItemsCalls.length, 0);
            assert.strictEqual(mockFullTextCalls.length, 1);
        });
    });

    describe('S02 modifier integration in executeRecall', () => {
        it('roleValve filters items within rule execution', async () => {
            resetMocks([
                { text: 'a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md', role: 'user' },
                { text: 'b', score: 0.8, sourceDiary: 'TestDiary', sourceFile: 'b.md', role: 'system' },
                { text: 'c', score: 0.7, sourceDiary: 'TestDiary', sourceFile: 'c.md', role: 'user' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: { roleValve: ['user'] }
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentRV', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 2);
            const texts = result.items.map((i) => i.text);
            assert.deepStrictEqual(texts, ['a', 'c']);
        });

        it('mixed S01 and S02 modifiers work together', async () => {
            const now = Date.now();
            const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();

            resetMocks([
                { text: 'old user', score: 1.0, sourceDiary: 'TestDiary', sourceFile: 'old.md', timestamp: tenDaysAgo, role: 'user' },
                { text: 'new user', score: 1.0, sourceDiary: 'TestDiary', sourceFile: 'new.md', timestamp: new Date(now).toISOString(), role: 'user' },
                { text: 'new system', score: 1.0, sourceDiary: 'TestDiary', sourceFile: 'sys.md', timestamp: new Date(now).toISOString(), role: 'system' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: {
                        time: true,
                        rerank: true,
                        timeDecay: { halfLifeDays: 7 },
                        roleValve: ['user'],
                        truncate: 5
                    }
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentMixed', query: 'query' });
            assert.strictEqual(result.success, true);
            // roleValve should filter out 'new system'
            // timeDecay should reduce 'old user' score
            assert.strictEqual(result.items.length, 2);
            // Higher score (new) comes first
            assert.strictEqual(result.items[0].text, 'new user');
            assert.strictEqual(result.items[1].text, 'old user');
            assert.ok(result.items[0].score > result.items[1].score);
        });
    });

    describe('backward compatibility — S01 rules still work', () => {
        it('rag rule with S01 modifiers works unchanged', async () => {
            resetMocks([
                { text: 'rag result', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

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

            const result = await service.executeRecall({ agentId: 'AgentBC', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'rag result');
            assert.strictEqual(result.diagnostics.rules[0].type, 'rag');
            assert.strictEqual(result.diagnostics.rules[0].status, 'ok');
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, undefined); // non-gated

            // Verify S01 ragOptions still work
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.timeAware, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.rerank, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.tagMemo, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].ragOptions.k, 5); // rag baseK
        });

        it('gated_rag gate behavior unchanged', async () => {
            resetMocks([
                { text: 'gated', score: 0.85, sourceDiary: 'TestDiary', sourceFile: 'x.md' }
            ]);

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

            const result = await service.executeRecall({ agentId: 'AgentBC2', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].gatePassed, true);
        });
    });

    describe('diagnostics enrichment for S02', () => {
        it('rule diagnostic includes attachmentCount for base64Memo', async () => {
            resetMocks([
                { text: 'data:image/png;base64,zz=', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'img.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: { base64Memo: true }
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentDiag', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.diagnostics.rules[0].attachmentCount, 1);
            assert.ok(result.diagnostics.attachments, 'root diagnostics should have attachments');
            assert.strictEqual(result.diagnostics.attachments.length, 1);
        });

        it('diagnostics omits attachments when none found', async () => {
            resetMocks([
                { text: 'plain text', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'plain.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: { base64Memo: true }
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentDiag2', query: 'query' });
            assert.strictEqual(result.diagnostics.attachments, undefined);
            assert.strictEqual(result.diagnostics.rules[0].attachmentCount, undefined);
        });
    });

    describe('applyBudgetPostProcessing', () => {
        it('skips when no budget fields are set', () => {
            const items = [
                { text: 'a', score: 0.9 },
                { text: 'b', score: 0.8 }
            ];
            const result = applyBudgetPostProcessing(items, {});
            assert.strictEqual(result.skipped, true);
            assert.deepStrictEqual(result.items, items);
            assert.strictEqual(result.inputItemCount, 2);
            assert.strictEqual(result.outputItemCount, 2);
        });

        it('filters items below minScore', () => {
            const items = [
                { text: 'high', score: 0.9 },
                { text: 'low', score: 0.5 },
                { text: 'medium', score: 0.7 }
            ];
            const result = applyBudgetPostProcessing(items, { minScore: 0.6 });
            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.outputItemCount, 2);
            assert.strictEqual(result.items[0].text, 'high');
            assert.strictEqual(result.items[1].text, 'medium');
            assert.strictEqual(result.minScoreApplied, true);
            assert.strictEqual(result.tokenBudgetApplied, false);
        });

        it('applies token budget and skips items that would exceed', () => {
            // Each ASCII char = ~0.25 tokens, so 'aaaa' = 1 token
            const items = [
                { text: 'aaaaaaaa', score: 0.9 }, // 2 tokens
                { text: 'bbbbbbbb', score: 0.8 }, // 2 tokens
                { text: 'cccccccc', score: 0.7 }  // 2 tokens
            ];
            const result = applyBudgetPostProcessing(items, { tokenBudget: 4, maxTokenRatio: 0.5 });
            // maxInjectedTokens = 2
            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.outputItemCount, 1);
            assert.strictEqual(result.items[0].text, 'aaaaaaaa');
            assert.strictEqual(result.consumedTokens, 2);
            assert.strictEqual(result.tokenBudgetApplied, true);
            assert.strictEqual(result.maxTokenRatioApplied, true);
        });

        it('truncates a single oversized item to fit remaining budget', () => {
            const items = [
                { text: 'aaaaaaaaaaaaaaaa', score: 0.9 } // 4 tokens
            ];
            const result = applyBudgetPostProcessing(items, { tokenBudget: 4, maxTokenRatio: 0.5 });
            // maxInjectedTokens = 2, item is 4 tokens > 2, so truncate to remaining 2 tokens
            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.outputItemCount, 1);
            assert.strictEqual(result.items[0].text, 'aaaaaaaa');
            assert.strictEqual(result.truncatedCount, 1);
            assert.strictEqual(result.consumedTokens, 2);
        });

        it('skips subsequent items when budget is exhausted', () => {
            const items = [
                { text: 'aaaaaaaa', score: 0.9 }, // 2 tokens
                { text: 'bbbbbbbb', score: 0.8 }  // 2 tokens, would exceed
            ];
            const result = applyBudgetPostProcessing(items, { tokenBudget: 4, maxTokenRatio: 0.5 });
            // maxInjectedTokens = 2
            // First item fits exactly (2 tokens), second would exceed (2+2=4 > 2) so skipped
            assert.strictEqual(result.skipped, false);
            assert.strictEqual(result.outputItemCount, 1);
            assert.strictEqual(result.items[0].text, 'aaaaaaaa');
            assert.strictEqual(result.consumedTokens, 2);
        });

        it('combines minScore and token budget', () => {
            const items = [
                { text: 'high', score: 0.9 },
                { text: 'low but long text', score: 0.5 },
                { text: 'med', score: 0.7 }
            ];
            const result = applyBudgetPostProcessing(items, { tokenBudget: 10, maxTokenRatio: 0.5, minScore: 0.6 });
            // maxInjectedTokens = 5
            // high = 1 token, med = 1 token → both fit
            assert.strictEqual(result.outputItemCount, 2);
            assert.strictEqual(result.minScoreApplied, true);
            assert.strictEqual(result.tokenBudgetApplied, true);
        });
    });

    describe('executeRecall budgetFilter pipeline stage', () => {
        it('adds budgetFilter stage when profile has budget fields', async () => {
            resetMocks([
                { text: 'item a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' },
                { text: 'item b', score: 0.5, sourceDiary: 'TestDiary', sourceFile: 'b.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: {
                    resolveForAgent: () => ({
                        resolved: true,
                        agentId: 'AgentBudget',
                        profileName: 'budget-profile',
                        rules: [{
                            type: 'rag',
                            diaries: ['TestDiary'],
                            modifiers: {}
                        }],
                        minScore: 0.6,
                        tokenBudget: 100,
                        maxTokenRatio: 0.5
                    })
                },
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentBudget', query: 'query' });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'item a');

            const budgetStage = result.diagnostics.pipelineStages.find((s) => s.name === 'budgetFilter');
            assert.ok(budgetStage, 'should have budgetFilter stage');
            assert.strictEqual(budgetStage.detail.inputItemCount, 2);
            assert.strictEqual(budgetStage.detail.outputItemCount, 1);
            assert.strictEqual(budgetStage.detail.minScoreApplied, true);
            assert.strictEqual(budgetStage.detail.tokenBudgetApplied, true);
            assert.strictEqual(budgetStage.detail.maxTokenRatioApplied, true);
            assert.strictEqual(budgetStage.detail.tokensConsumed > 0, true);
        });

        it('skips budgetFilter stage when profile has no budget fields', async () => {
            resetMocks([
                { text: 'item a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([{
                    type: 'rag',
                    diaries: ['TestDiary'],
                    modifiers: {}
                }]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentNoBudget', query: 'query' });
            assert.strictEqual(result.success, true);
            const budgetStage = result.diagnostics.pipelineStages.find((s) => s.name === 'budgetFilter');
            assert.strictEqual(budgetStage, undefined);
        });

        it('includes budget fields in profileMeta when set', async () => {
            resetMocks([
                { text: 'item a', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: {
                    resolveForAgent: () => ({
                        resolved: true,
                        agentId: 'AgentMeta',
                        profileName: 'meta-profile',
                        rules: [{
                            type: 'rag',
                            diaries: ['TestDiary'],
                            modifiers: {}
                        }],
                        minScore: 0.6,
                        tokenBudget: 100,
                        maxTokenRatio: 0.5
                    })
                },
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({ agentId: 'AgentMeta', query: 'query' });
            assert.strictEqual(result.success, true);
            const meta = result.diagnostics.profileMeta;
            assert.strictEqual(meta.tokenBudget, 100);
            assert.strictEqual(meta.maxTokenRatio, 0.5);
            assert.strictEqual(meta.minScore, 0.6);
        });
    });

    describe('inlineRule execution path', () => {
        it('skips profileResolver and uses inline rule directly', async () => {
            resetMocks([
                { text: 'inline result', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            let resolverCalled = false;
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: {
                    resolveForAgent: () => {
                        resolverCalled = true;
                        return { resolved: false, code: 'RECALL_NO_PROFILE', rules: [] };
                    }
                },
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: { time: true } }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(resolverCalled, false, 'profileResolver should not be called for inlineRule');
            assert.strictEqual(result.profileName, '_inline_');
            assert.strictEqual(result.items.length, 1);
            assert.strictEqual(result.items[0].text, 'inline result');
        });

        it('passes authContext and agentPolicyResolver to collectRagItems', async () => {
            resetMocks([
                { text: 'auth result', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const mockAuthContext = { agentId: 'AgentInline', role: 'admin' };
            const mockPolicyResolver = { resolvePolicy: async () => ({ allowedDiaryNames: ['TestDiary'] }) };

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} },
                authContext: mockAuthContext,
                agentPolicyResolver: mockPolicyResolver,
                adapterAppliedDefaultDiaryPolicy: true
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            const call = mockCollectRagItemsCalls[0];
            assert.strictEqual(call.authContext, mockAuthContext);
            assert.strictEqual(call.agentPolicyResolver, mockPolicyResolver);
            assert.strictEqual(call.adapterAppliedDefaultDiaryPolicy, true);
        });

        it('falls back to requestContext when authContext is omitted', async () => {
            resetMocks([
                { text: 'fallback result', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const requestContext = { agentId: 'AgentInline', source: 'test' };
            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} },
                requestContext
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls[0].authContext, requestContext);
            assert.strictEqual(mockCollectRagItemsCalls[0].agentPolicyResolver, null);
        });

        it('falls back to the service-level agentPolicyResolver when executeRecall does not override it', async () => {
            resetMocks([
                { text: 'default policy result', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
            ]);

            const defaultPolicyResolver = { resolvePolicy: async () => ({ allowedDiaryNames: ['TestDiary'] }) };
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({}),
                agentPolicyResolver: defaultPolicyResolver
            });

            const result = await service.executeRecall({
                agentId: 'AgentInline',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} },
                authContext: { agentId: 'AgentInline' }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(mockCollectRagItemsCalls.length, 1);
            assert.strictEqual(mockCollectRagItemsCalls[0].agentPolicyResolver, defaultPolicyResolver);
        });

        it('enriches rule diagnostics with collectRagItems fields', async () => {
            const activatedGroups = new Map([['g1', { score: 0.9 }]]);
            resetMocks(
                [{ text: 'enriched', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }],
                {
                    timeRanges: [{ start: '2024-01-01', end: '2024-01-02' }],
                    activatedGroups,
                    rerankApplied: true,
                    coreTags: ['tagA', 'tagB']
                }
            );

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
            const diag = result.diagnostics.rules[0];
            assert.strictEqual(diag.timeRangesCount, 1);
            assert.strictEqual(diag.activatedGroupCount, 1);
            assert.strictEqual(diag.rerankApplied, true);
            assert.strictEqual(diag.tagMemoCount, 2);
            assert.deepStrictEqual(diag.coreTags, ['tagA', 'tagB']);
        });

        it('skips vector precompute for inlineRule path', async () => {
            resetMocks([
                { text: 'no vector', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
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
            const precomputeStage = result.diagnostics.pipelineStages.find(
                (s) => s.name === 'precomputeVector'
            );
            assert.ok(precomputeStage, 'should have precomputeVector stage');
            assert.strictEqual(precomputeStage.detail.skipped, true);
            assert.strictEqual(result.diagnostics.vectorPrecomputed, false);
        });

        it('skips aiMemo for inlineRule path even when modifier is present', async () => {
            resetMocks([
                { text: 'no aiMemo', score: 0.9, sourceDiary: 'TestDiary', sourceFile: 'a.md' }
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
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: { aiMemo: true } }
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.diagnostics.summary, undefined);
            const aiMemoStage = result.diagnostics.pipelineStages.find(
                (s) => s.name === 'aiMemo'
            );
            assert.strictEqual(aiMemoStage, undefined);
        });

        it('validates agentId and query for inlineRule', async () => {
            const service = createRecallRuntimeService({
                pluginManager: createMockPluginManager(),
                recallProfileResolver: createMockResolver([]),
                contextRuntimeService: createMockContextRuntimeService(),
                embeddingUtilsLoader: () => ({})
            });

            const noAgent = await service.executeRecall({
                agentId: '',
                query: 'query',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
            });
            assert.strictEqual(noAgent.success, false);
            assert.strictEqual(noAgent.status, 400);
            assert.strictEqual(noAgent.code, 'AGW_RECALL_INVALID_QUERY');

            const noQuery = await service.executeRecall({
                agentId: 'AgentInline',
                query: '',
                inlineRule: { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
            });
            assert.strictEqual(noQuery.success, false);
            assert.strictEqual(noQuery.status, 400);
            assert.strictEqual(noQuery.code, 'AGW_RECALL_INVALID_QUERY');
        });
    });
});
