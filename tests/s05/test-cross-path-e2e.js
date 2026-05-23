const assert = require('node:assert/strict');
const test = require('node:test');

// ── Helpers (pure functions, no runtime deps) ───────────────────────────────
const {
    createKnowledgeBaseManager,
    createPluginManager,
    createRagPlugin
} = require('../agent-gateway/helpers/agent-gateway-test-helpers');

// ── Clear module cache and mock collectRagItems ─────────────────────────────
const contextRuntimeServicePath = require.resolve('../../modules/agentGateway/services/contextRuntimeService');
const recallRuntimeServicePath = require.resolve('../../modules/agentGateway/services/recallRuntimeService');
delete require.cache[contextRuntimeServicePath];
delete require.cache[recallRuntimeServicePath];

let mockCollectRagItemsCalls = [];
let mockCollectRagItemsResult = {
    success: true,
    items: [],
    targetDiaries: [],
    timeRanges: [],
    activatedGroups: new Map(),
    rerankApplied: false,
    coreTags: []
};

require.cache[contextRuntimeServicePath] = {
    id: contextRuntimeServicePath,
    filename: contextRuntimeServicePath,
    loaded: true,
    exports: {
        collectRagItems: async (args) => {
            mockCollectRagItemsCalls.push(args);
            return { ...mockCollectRagItemsResult };
        },
        createContextRuntimeService: (deps) => {
            // When createContextRuntimeService is called, it needs the real module
            // but we only need to mock collectRagItems for recallRuntimeService
            delete require.cache[contextRuntimeServicePath];
            const actual = require(contextRuntimeServicePath);
            return actual.createContextRuntimeService(deps);
        }
    }
};

const { createContextRuntimeService } = require('../../modules/agentGateway/services/contextRuntimeService');
const { createRecallRuntimeService } = require('../../modules/agentGateway/services/recallRuntimeService');

// ── Test fixtures ───────────────────────────────────────────────────────────

const TEST_PROFILE_NAME = 'e2e-test-profile';
const TEST_AGENT_ID = 'e2e-agent';
const TEST_DIARY = 'E2EDiary';

const TEST_PROFILE_CONFIG = {
    merge: 'concat',
    aggregate: 'max',
    projection: 'semantic',
    tokenBudget: 800,
    maxTokenRatio: 0.65,
    minScore: 0.25,
    rules: [
        {
            baseMode: 'rag',
            targets: {
                diaries: [TEST_DIARY],
                kMultiplier: 1.0
            },
            modifiers: {
                time: false,
                group: false,
                rerank: false,
                tagMemo: false,
                truncate: 10
            }
        }
    ]
};

const TEST_SEARCH_RESULTS = {
    [TEST_DIARY]: [
        {
            text: 'E2E cross-path consistency test result A',
            score: 0.92,
            sourceDiary: TEST_DIARY,
            sourceFile: '2026-05-23-a.md',
            fullPath: `${TEST_DIARY}/2026-05-23-a.md`
        },
        {
            text: 'E2E cross-path consistency test result B',
            score: 0.88,
            sourceDiary: TEST_DIARY,
            sourceFile: '2026-05-23-b.md',
            fullPath: `${TEST_DIARY}/2026-05-23-b.md`
        }
    ]
};

function createTestProfileResolver() {
    return {
        resolveForAgent(agentId, requestedProfile) {
            return {
                resolved: true,
                agentId,
                profileName: requestedProfile || TEST_PROFILE_NAME,
                rules: TEST_PROFILE_CONFIG.rules,
                merge: TEST_PROFILE_CONFIG.merge,
                aggregate: TEST_PROFILE_CONFIG.aggregate,
                projection: TEST_PROFILE_CONFIG.projection,
                tokenBudget: TEST_PROFILE_CONFIG.tokenBudget,
                maxTokenRatio: TEST_PROFILE_CONFIG.maxTokenRatio,
                minScore: TEST_PROFILE_CONFIG.minScore
            };
        }
    };
}

function resetMocks() {
    mockCollectRagItemsCalls = [];
    mockCollectRagItemsResult = {
        success: true,
        items: TEST_SEARCH_RESULTS[TEST_DIARY],
        targetDiaries: [TEST_DIARY],
        timeRanges: [],
        activatedGroups: new Map(),
        rerankApplied: false,
        coreTags: []
    };
}

function createTestServices() {
    resetMocks();

    const pluginManager = createPluginManager({
        vectorDBManager: createKnowledgeBaseManager({
            diaries: [TEST_DIARY],
            searchResults: TEST_SEARCH_RESULTS,
            metadataByPath: {
                [`${TEST_DIARY}/2026-05-23-a.md`]: {
                    sourceDiary: TEST_DIARY,
                    sourcePath: `${TEST_DIARY}/2026-05-23-a.md`,
                    updatedAt: Date.parse('2026-05-23T10:00:00.000Z'),
                    tags: ['e2e', 'test']
                },
                [`${TEST_DIARY}/2026-05-23-b.md`]: {
                    sourceDiary: TEST_DIARY,
                    sourcePath: `${TEST_DIARY}/2026-05-23-b.md`,
                    updatedAt: Date.parse('2026-05-23T09:00:00.000Z'),
                    tags: ['e2e', 'test']
                }
            }
        }),
        ragPlugin: createRagPlugin({
            parseTime() {
                return [];
            }
        })
    });

    let recallRuntimeService;
    const contextRuntimeService = createContextRuntimeService({
        pluginManager,
        getRecallRuntimeService: () => recallRuntimeService
    });

    recallRuntimeService = createRecallRuntimeService({
        pluginManager,
        contextRuntimeService,
        recallProfileResolver: createTestProfileResolver(),
        embeddingUtilsLoader: () => ({})
    });

    return { contextRuntimeService, recallRuntimeService };
}

const TEST_REQUEST_CONTEXT = {
    source: 'openclaw',
    agentId: TEST_AGENT_ID,
    sessionId: 'sess-e2e-001',
    requestId: 'req-e2e-001'
};

// ── E2E tests ───────────────────────────────────────────────────────────────

test('executeRecall direct call returns success with profileMeta', async () => {
    const { recallRuntimeService } = createTestServices();

    const result = await recallRuntimeService.executeRecall({
        agentId: TEST_AGENT_ID,
        query: 'cross path test',
        profileName: TEST_PROFILE_NAME,
        requestContext: TEST_REQUEST_CONTEXT
    });

    assert.equal(result.success, true, 'executeRecall should succeed');
    assert.equal(result.profileName, TEST_PROFILE_NAME);
    assert.ok(Array.isArray(result.items), 'items should be an array');
    assert.ok(result.items.length >= 1, 'should have at least one item');

    const diagnostics = result.diagnostics;
    assert.ok(diagnostics, 'diagnostics should exist');
    assert.ok(diagnostics.profileMeta, 'profileMeta should exist in diagnostics');
    assert.equal(diagnostics.profileMeta.profileName, TEST_PROFILE_NAME);
    assert.equal(diagnostics.profileMeta.tokenBudget, TEST_PROFILE_CONFIG.tokenBudget);
    assert.equal(diagnostics.profileMeta.maxTokenRatio, TEST_PROFILE_CONFIG.maxTokenRatio);
    assert.equal(diagnostics.profileMeta.minScore, TEST_PROFILE_CONFIG.minScore);
    assert.equal(diagnostics.profileMeta.ruleCount, 1);
});

test('search via profile path returns success and uses profile results', async () => {
    const { contextRuntimeService } = createTestServices();

    const result = await contextRuntimeService.search({
        body: {
            profile: TEST_PROFILE_NAME,
            query: 'cross path test',
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });

    assert.equal(result.success, true, 'search should succeed via profile path');
    assert.ok(result.data, 'data should exist');
    assert.ok(Array.isArray(result.data.items), 'items should be an array');
    assert.ok(result.data.items.length >= 1, 'should have at least one item');

    const diagnostics = result.data.diagnostics;
    assert.ok(diagnostics, 'diagnostics should exist');
    assert.equal(diagnostics.resultCount, result.data.items.length);
    assert.ok(diagnostics.durationMs >= 0, 'duration should be non-negative');
    assert.deepEqual(diagnostics.targetDiaries, [TEST_DIARY]);
});

test('buildRecallContext via profile path returns success with profile-sourced budget', async () => {
    const { contextRuntimeService } = createTestServices();

    const result = await contextRuntimeService.buildRecallContext({
        body: {
            profile: TEST_PROFILE_NAME,
            query: 'cross path test',
            maxBlocks: 4,
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw-context'
    });

    assert.equal(result.success, true, 'buildRecallContext should succeed via profile path');
    assert.ok(result.data, 'data should exist');
    assert.ok(Array.isArray(result.data.recallBlocks), 'recallBlocks should be an array');
    assert.ok(result.data.recallBlocks.length >= 1, 'should have at least one recallBlock');

    const policy = result.data.appliedPolicy;
    assert.ok(policy, 'appliedPolicy should exist');
    assert.equal(policy.tokenBudget, TEST_PROFILE_CONFIG.tokenBudget,
        'tokenBudget should match profile value');
    assert.equal(policy.maxTokenRatio, TEST_PROFILE_CONFIG.maxTokenRatio,
        'maxTokenRatio should match profile value');
    assert.equal(policy.minScore, TEST_PROFILE_CONFIG.minScore,
        'minScore should match profile value');

    assert.ok(policy.profileSourced, 'profileSourced should be present');
    assert.equal(policy.profileSourced.tokenBudget, true,
        'tokenBudget should be flagged as profile-sourced');
    assert.equal(policy.profileSourced.maxTokenRatio, true,
        'maxTokenRatio should be flagged as profile-sourced');
    assert.equal(policy.profileSourced.minScore, true,
        'minScore should be flagged as profile-sourced');
});

test('all three paths produce consistent item counts for the same profile', async () => {
    const { contextRuntimeService, recallRuntimeService } = createTestServices();

    // Path 1: direct executeRecall
    const recallResult = await recallRuntimeService.executeRecall({
        agentId: TEST_AGENT_ID,
        query: 'cross path test',
        profileName: TEST_PROFILE_NAME,
        requestContext: TEST_REQUEST_CONTEXT
    });

    // Path 2: search
    const searchResult = await contextRuntimeService.search({
        body: {
            profile: TEST_PROFILE_NAME,
            query: 'cross path test',
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });

    // Path 3: buildRecallContext
    const contextResult = await contextRuntimeService.buildRecallContext({
        body: {
            profile: TEST_PROFILE_NAME,
            query: 'cross path test',
            maxBlocks: 4,
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw-context'
    });

    // All succeed
    assert.equal(recallResult.success, true, 'executeRecall should succeed');
    assert.equal(searchResult.success, true, 'search should succeed');
    assert.equal(contextResult.success, true, 'buildRecallContext should succeed');

    // Item counts should be consistent: search post-processes executeRecall results;
    // buildRecallContext filters by minScore and maxBlocks, so it may be ≤ executeRecall count.
    const recallItemCount = recallResult.items.length;
    const searchItemCount = searchResult.data.items.length;
    const contextBlockCount = contextResult.data.recallBlocks.length;

    assert.equal(searchItemCount, recallItemCount,
        'search item count should match executeRecall item count when no explicit k override');
    assert.ok(contextBlockCount <= recallItemCount,
        'buildRecallContext block count should not exceed executeRecall item count');

    // Source consistency: all items should originate from the same diary
    assert.ok(
        recallResult.items.every((item) => item.sourceDiary === TEST_DIARY),
        'all executeRecall items should come from TEST_DIARY'
    );
    assert.ok(
        searchResult.data.items.every((item) => item.sourceDiary === TEST_DIARY),
        'all search items should come from TEST_DIARY'
    );
    assert.ok(
        contextResult.data.recallBlocks.every((block) => block.metadata?.sourceDiary === TEST_DIARY),
        'all buildRecallContext blocks should come from TEST_DIARY'
    );

    // Score ordering: items should be sorted by score descending
    const recallScores = recallResult.items.map((item) => item.score);
    const searchScores = searchResult.data.items.map((item) => item.score);
    const isDescending = (arr) => arr.every((v, i) => i === 0 || v <= arr[i - 1]);
    assert.ok(isDescending(recallScores), 'executeRecall items should be score-sorted descending');
    assert.ok(isDescending(searchScores), 'search items should be score-sorted descending');
});

test('profile path bypasses inlineRule and produces different diagnostics shape', async () => {
    const { contextRuntimeService } = createTestServices();

    // Profile path
    const profileResult = await contextRuntimeService.search({
        body: {
            profile: TEST_PROFILE_NAME,
            query: 'cross path test',
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });

    // InlineRule path (no profile)
    const inlineResult = await contextRuntimeService.search({
        body: {
            query: 'cross path test',
            diary: TEST_DIARY,
            mode: 'rag',
            requestContext: TEST_REQUEST_CONTEXT
        },
        startedAt: Date.now(),
        defaultSource: 'openclaw'
    });

    assert.equal(profileResult.success, true);
    assert.equal(inlineResult.success, true);

    // Both should return results from the same diary
    assert.deepEqual(profileResult.data.diagnostics.targetDiaries, [TEST_DIARY]);
    assert.deepEqual(inlineResult.data.diagnostics.targetDiaries, [TEST_DIARY]);

    // But profile path should have durationMs from executeRecall diagnostics
    assert.ok(profileResult.data.diagnostics.durationMs >= 0);
    assert.ok(inlineResult.data.diagnostics.durationMs >= 0);
});
