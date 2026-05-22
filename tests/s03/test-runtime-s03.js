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
    applyS02Modifiers,
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

function resetMocks(mockItems) {
    mockCollectRagItemsCalls.length = 0;
    mockCollectRagItemsResult = {
        success: true,
        items: mockItems || []
    };
    mockCollectRagItemsImpl = async (args) => {
        mockCollectRagItemsCalls.push(args);
        return { ...mockCollectRagItemsResult };
    };
}

describe('RecallRuntimeService S03 diagnostics', () => {
    describe('applyS02Modifiers modifierDetails', () => {
        it('returns modifierDetails array even with no modifiers', () => {
            const items = [{ text: 'A', score: 0.9 }];
            const result = applyS02Modifiers(items, {});
            assert.ok(Array.isArray(result.modifierDetails));
            assert.strictEqual(result.modifierDetails.length, 0);
        });

        it('returns modifierDetails array for null modifiers', () => {
            const items = [{ text: 'A', score: 0.9 }];
            const result = applyS02Modifiers(items, null);
            assert.ok(Array.isArray(result.modifierDetails));
            assert.strictEqual(result.modifierDetails.length, 0);
        });

        it('records duration and counts for each applied modifier', () => {
            const items = [
                { text: 'A', score: 0.9, role: 'user' },
                { text: 'B', score: 0.8, role: 'assistant' }
            ];
            const result = applyS02Modifiers(items, {
                timeDecay: { halfLifeDays: 30 },
                roleValve: ['user']
            });
            assert.ok(Array.isArray(result.modifierDetails));
            assert.strictEqual(result.modifierDetails.length, 2);

            const timeDecayDetail = result.modifierDetails.find((d) => d.modifier === 'timeDecay');
            assert.ok(timeDecayDetail);
            assert.strictEqual(typeof timeDecayDetail.durationMs, 'number');
            assert.ok(timeDecayDetail.durationMs >= 0);
            assert.strictEqual(timeDecayDetail.inputCount, 2);
            assert.strictEqual(timeDecayDetail.outputCount, 2);

            const roleValveDetail = result.modifierDetails.find((d) => d.modifier === 'roleValve');
            assert.ok(roleValveDetail);
            assert.strictEqual(typeof roleValveDetail.durationMs, 'number');
            assert.ok(roleValveDetail.durationMs >= 0);
            assert.strictEqual(roleValveDetail.inputCount, 2);
            assert.strictEqual(roleValveDetail.outputCount, 1);
        });

        it('records base64Memo modifier detail with attachment extraction', () => {
            const items = [
                { text: 'data:image/png;base64,abc123', score: 0.9 }
            ];
            const result = applyS02Modifiers(items, { base64Memo: true });
            assert.strictEqual(result.modifierDetails.length, 1);
            assert.strictEqual(result.modifierDetails[0].modifier, 'base64Memo');
            assert.strictEqual(result.modifierDetails[0].inputCount, 1);
            assert.strictEqual(result.modifierDetails[0].outputCount, 1);
            assert.ok(result.modifierDetails[0].durationMs >= 0);
        });

        it('skips modifiers not present in modifiers object', () => {
            const items = [{ text: 'A', score: 0.9 }];
            const result = applyS02Modifiers(items, { timeDecay: { halfLifeDays: 30 } });
            assert.strictEqual(result.modifierDetails.length, 1);
            assert.strictEqual(result.modifierDetails[0].modifier, 'timeDecay');
        });
    });

    describe('buildRecallResult diagnostics defaults', () => {
        it('includes pipelineStages in default diagnostics', () => {
            const result = buildRecallResult({ success: true });
            assert.ok(Array.isArray(result.diagnostics.pipelineStages));
            assert.deepStrictEqual(result.diagnostics.pipelineStages, []);
        });

        it('includes profileMeta in default diagnostics', () => {
            const result = buildRecallResult({ success: true });
            assert.strictEqual(result.diagnostics.profileMeta, null);
        });

        it('preserves provided diagnostics including pipelineStages and profileMeta', () => {
            const diagnostics = {
                totalDurationMs: 150,
                rules: [{ type: 'rag', status: 'ok' }],
                pipelineStages: [{ name: 'test', durationMs: 10, status: 'ok' }],
                profileMeta: { profileName: 'test-profile', ruleCount: 1 }
            };
            const result = buildRecallResult({ success: true, diagnostics });
            assert.deepStrictEqual(result.diagnostics.pipelineStages, diagnostics.pipelineStages);
            assert.deepStrictEqual(result.diagnostics.profileMeta, diagnostics.profileMeta);
        });
    });

    describe('executeRecall pipelineStages', () => {
        const mockPluginManager = createMockPluginManager();
        const mockContextService = createMockContextRuntimeService();

        it('includes resolveProfile stage in successful execution', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'rag' }]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            assert.strictEqual(result.success, true);
            assert.ok(Array.isArray(result.diagnostics.pipelineStages));
            assert.ok(result.diagnostics.pipelineStages.length >= 3);

            const resolveStage = result.diagnostics.pipelineStages.find((s) => s.name === 'resolveProfile');
            assert.ok(resolveStage);
            assert.strictEqual(resolveStage.status, 'ok');
            assert.ok(typeof resolveStage.durationMs === 'number');
            assert.ok(resolveStage.durationMs >= 0);
            assert.strictEqual(resolveStage.detail.profileName, 'default');
            assert.strictEqual(resolveStage.detail.ruleCount, 1);
        });

        it('includes precomputeVector stage', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'rag' }]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const vectorStage = result.diagnostics.pipelineStages.find((s) => s.name === 'precomputeVector');
            assert.ok(vectorStage);
            assert.strictEqual(vectorStage.status, 'ok');
            assert.ok(typeof vectorStage.durationMs === 'number');
            assert.ok(vectorStage.durationMs >= 0);
            assert.strictEqual(vectorStage.detail.vectorPrecomputed, true);
        });

        it('includes ruleExecution stages for each rule', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', diaries: ['DiaryA'] },
                { type: 'full_text', diaries: ['DiaryB'] }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const ruleStages = result.diagnostics.pipelineStages.filter((s) => s.name === 'ruleExecution');
            assert.strictEqual(ruleStages.length, 2);
            assert.strictEqual(ruleStages[0].ruleIndex, 0);
            assert.strictEqual(ruleStages[0].type, 'rag');
            assert.strictEqual(ruleStages[0].status, 'ok');
            assert.strictEqual(ruleStages[1].ruleIndex, 1);
            assert.strictEqual(ruleStages[1].type, 'full_text');
            assert.strictEqual(ruleStages[1].status, 'ok');
        });

        it('includes mergeResults stage', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'rag' }]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const mergeStage = result.diagnostics.pipelineStages.find((s) => s.name === 'mergeResults');
            assert.ok(mergeStage);
            assert.strictEqual(mergeStage.status, 'ok');
            assert.ok(typeof mergeStage.durationMs === 'number');
            assert.ok(mergeStage.durationMs >= 0);
            assert.ok(typeof mergeStage.detail.inputItemCount === 'number');
            assert.ok(typeof mergeStage.detail.outputItemCount === 'number');
        });

        it('records gated status for blocked rules', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'gated_rag', gateThreshold: 0.99, diaries: ['AnotherDiary'] }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const ruleStage = result.diagnostics.pipelineStages.find((s) => s.name === 'ruleExecution');
            assert.ok(ruleStage);
            assert.strictEqual(ruleStage.status, 'gated');
        });

        it('stages are ordered correctly', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([{ type: 'rag' }]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const stageNames = result.diagnostics.pipelineStages.map((s) => s.name);
            const resolveIdx = stageNames.indexOf('resolveProfile');
            const vectorIdx = stageNames.indexOf('precomputeVector');
            const ruleIdx = stageNames.indexOf('ruleExecution');
            const mergeIdx = stageNames.indexOf('mergeResults');
            assert.ok(resolveIdx < vectorIdx, 'resolveProfile before precomputeVector');
            assert.ok(vectorIdx < ruleIdx, 'precomputeVector before ruleExecution');
            assert.ok(ruleIdx < mergeIdx, 'ruleExecution before mergeResults');
        });
    });

    describe('executeRecall profileMeta', () => {
        const mockPluginManager = createMockPluginManager();
        const mockContextService = createMockContextRuntimeService();

        it('includes profileMeta with profileName and ruleCount', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag' },
                { type: 'full_text' }
            ], 'my-profile');
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            assert.ok(result.diagnostics.profileMeta);
            assert.strictEqual(result.diagnostics.profileMeta.profileName, 'my-profile');
            assert.strictEqual(result.diagnostics.profileMeta.ruleCount, 2);
        });

        it('includes modifierKeys from all rules', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', modifiers: { timeDecay: { halfLifeDays: 30 } } },
                { type: 'full_text', modifiers: { base64Memo: true, truncate: 10 } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            const modifierKeys = result.diagnostics.profileMeta.modifierKeys;
            assert.ok(Array.isArray(modifierKeys));
            assert.ok(modifierKeys.includes('timeDecay'));
            assert.ok(modifierKeys.includes('base64Memo'));
            assert.ok(modifierKeys.includes('truncate'));
        });
    });

    describe('executeRecall modifierDetails in rule diagnostics', () => {
        const mockPluginManager = createMockPluginManager();
        const mockContextService = createMockContextRuntimeService();

        it('includes modifierDetails in rule diagnostic when modifiers are applied', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', modifiers: { timeDecay: { halfLifeDays: 30 } } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            assert.strictEqual(result.diagnostics.rules.length, 1);
            assert.ok(Array.isArray(result.diagnostics.rules[0].modifierDetails));
            assert.strictEqual(result.diagnostics.rules[0].modifierDetails.length, 1);
            assert.strictEqual(result.diagnostics.rules[0].modifierDetails[0].modifier, 'timeDecay');
        });

        it('includes empty modifierDetails when no S02 modifiers are used', async () => {
            resetMocks([{ text: 'Result', score: 0.9, sourceDiary: 'TestDiary' }]);
            const resolver = createMockResolver([
                { type: 'rag', modifiers: { rerank: true } }
            ]);
            const service = createRecallRuntimeService({
                pluginManager: mockPluginManager,
                recallProfileResolver: resolver,
                contextRuntimeService: mockContextService
            });
            const result = await service.executeRecall({
                agentId: 'TestAgent',
                query: 'test query'
            });
            assert.strictEqual(result.diagnostics.rules.length, 1);
            assert.ok(Array.isArray(result.diagnostics.rules[0].modifierDetails));
            assert.strictEqual(result.diagnostics.rules[0].modifierDetails.length, 0);
        });
    });
});
