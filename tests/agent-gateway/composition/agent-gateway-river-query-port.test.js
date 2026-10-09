const assert = require('node:assert/strict');
const test = require('node:test');

const { createRagBindings } = require('../../../modules/agentGateway/composition/vcpPortBindings');
const { createRagRetrieverPort } = require('../../../modules/agentGateway/ports');

function createMockKnowledgeBaseManager({ riverError } = {}) {
    const calls = { river: [], search: [] };
    return {
        calls,
        listDiaryNames: () => ['D1', 'D2'],
        search: async (diary, vector, k, tagBoost, coreTags, fusion, extra) => {
            calls.search.push({ diary, vector, k, tagBoost, coreTags, fusion, extra });
            return [{ text: `knn:${diary}`, sourceFile: `${diary}.md`, score: 0.5, sourceDiary: diary }];
        },
        executeNativeRiverQuery: async (query, options) => {
            calls.river.push({ query, options });
            if (riverError) throw riverError;
            return {
                results: [
                    { text: 'river-hit', diaryName: 'D1', sourceFile: 'f.md', score: 0.9 },
                    { text: 'river-hit-2', diaryName: 'D2', sourceFile: 'g.md', score: 0.8 }
                ],
                artifactSig: 'sig-1',
                queryId: 'q-1'
            };
        },
        applyTagBoostAsync: async () => ({
            vector: [0.1, 0.2],
            info: { matchedTags: ['t'] },
            preparedMemoObservation: { marker: 'prepared' }
        })
    };
}

const MOCK_EMBEDDING_UTILS = { getEmbeddingsBatch: async () => [[0.1, 0.2]] };

test('riverQuery binding is exposed when the host provides executeNativeRiverQuery', async () => {
    const manager = createMockKnowledgeBaseManager();
    const bindings = createRagBindings(manager, null, MOCK_EMBEDDING_UTILS);
    assert.equal(typeof bindings.riverQuery, 'function');
    const port = createRagRetrieverPort(bindings);
    assert.equal(port.capabilities().riverQuery, true);
    assert.equal(typeof port.riverQuery, 'function');
});

test('riverQuery binding stays null on legacy hosts without the native river engine', () => {
    const manager = createMockKnowledgeBaseManager();
    delete manager.executeNativeRiverQuery;
    const bindings = createRagBindings(manager, null, MOCK_EMBEDDING_UTILS);
    assert.equal(bindings.riverQuery, null);
    const port = createRagRetrieverPort(bindings);
    assert.equal(port.capabilities().riverQuery, false);
    assert.equal(port.riverQuery, null);
});

test('riverQuery happy path forwards the production query shape', async () => {
    const manager = createMockKnowledgeBaseManager();
    const bindings = createRagBindings(manager, null, MOCK_EMBEDDING_UTILS);
    const result = await bindings.riverQuery(
        { text: 'query', vector: [0.1, 0.2] },
        { diaryNames: ['D1', 'D2'], topK: 8, coreTags: ['t'], enabled: true }
    );
    assert.equal(manager.calls.river.length, 1);
    assert.deepEqual(manager.calls.river[0].query, { text: 'query', vector: [0.1, 0.2] });
    assert.deepEqual(manager.calls.river[0].options.diaryNames, ['D1', 'D2']);
    assert.equal(result.artifactSig, 'sig-1');
    assert.equal(manager.calls.search.length, 0);
});

test('river failure degrades to KNN with audit trace and locked 1.33 fusion coefficient', async () => {
    const originalWarn = console.warn;
    const originalLog = console.log;
    const warnings = [];
    const auditLines = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    console.log = (line) => { auditLines.push(String(line)); };
    try {
        const failure = Object.assign(
            new Error('native river joint execution failed'),
            { code: 'NATIVE_RIVER_JOINT_FAILED' }
        );
        const manager = createMockKnowledgeBaseManager({ riverError: failure });
        const bindings = createRagBindings(manager, null, MOCK_EMBEDDING_UTILS);
        const result = await bindings.riverQuery(
            { text: 'query', vector: [0.1, 0.2] },
            {
                diaryNames: ['D1', 'D2'],
                topK: 6,
                coreTags: ['t'],
                sourceObservationConfig: { baseTagBoost: 0.15, coreBoostFactor: 1.33 },
                enabled: true
            }
        );

        assert.equal(manager.calls.river.length, 1);
        assert.equal(manager.calls.search.length, 2);
        assert.deepEqual(manager.calls.search.map((call) => call.diary), ['D1', 'D2']);
        for (const call of manager.calls.search) {
            assert.equal(call.k, 6);
            assert.equal(call.tagBoost, 0.15);
            assert.deepEqual(call.coreTags, ['t']);
            // 红线：KNN 回退路径的 1.33 融合系数锁定
            assert.equal(call.fusion, 1.33);
            assert.equal(call.extra, null);
        }
        assert.equal(result.results.length, 2);
        assert.deepEqual(result.results.map((item) => item.text), ['knn:D1', 'knn:D2']);
        assert.equal(result.degraded.engine, 'knn');
        assert.equal(result.degraded.reason, 'river_query_failed');
        assert.equal(result.degraded.errorCode, 'NATIVE_RIVER_JOINT_FAILED');

        assert.ok(warnings.some((line) => line.includes('Native river query failed') && line.includes('degrading to KNN')));
        assert.ok(auditLines.some((line) => line.includes('rag.search.river.degraded') && line.includes('NATIVE_RIVER_JOINT_FAILED')));
    } finally {
        console.warn = originalWarn;
        console.log = originalLog;
    }
});
