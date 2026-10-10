const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    resolveGlobalRecallMode,
    DEFAULT_RECALL_MODE
} = require('../../../modules/agentGateway/policy/recallProfileResolver');
const { collectRagItems } = require('../../../modules/agentGateway/core/recall/ragRetriever');

function writeTempConfig(payload) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-recall-mode-'));
    const configPath = path.join(dir, 'recall_profiles.json');
    fs.writeFileSync(configPath, JSON.stringify(payload), 'utf8');
    return configPath;
}

test('global recall mode defaults to knn and honors env/config precedence', () => {
    const previousEnv = process.env.AGENT_GATEWAY_RECALL_MODE;
    try {
        delete process.env.AGENT_GATEWAY_RECALL_MODE;
        const knnConfig = writeTempConfig({ recallMode: 'knn', agents: {}, profiles: {} });
        const riverConfig = writeTempConfig({ recallMode: 'river', agents: {}, profiles: {} });
        const invalidConfig = writeTempConfig({ recallMode: 'bogus', agents: {}, profiles: {} });

        // 2026-10-09 用户决策：默认 knn（M2.S4 实测后，M3 完成后重评）
        assert.equal(DEFAULT_RECALL_MODE, 'knn');
        assert.equal(resolveGlobalRecallMode(knnConfig), 'knn');
        assert.equal(resolveGlobalRecallMode(riverConfig), 'river');
        assert.equal(resolveGlobalRecallMode(invalidConfig), 'knn');

        // env 覆盖 config（一键切换开关）
        process.env.AGENT_GATEWAY_RECALL_MODE = 'river';
        assert.equal(resolveGlobalRecallMode(knnConfig), 'river');
        process.env.AGENT_GATEWAY_RECALL_MODE = 'knn';
        assert.equal(resolveGlobalRecallMode(riverConfig), 'knn');
        // env 非法值被忽略，回落到 config
        process.env.AGENT_GATEWAY_RECALL_MODE = 'nope';
        assert.equal(resolveGlobalRecallMode(riverConfig), 'river');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.AGENT_GATEWAY_RECALL_MODE;
        } else {
            process.env.AGENT_GATEWAY_RECALL_MODE = previousEnv;
        }
    }
});

function createRiverTestPort({ riverQuery } = {}) {
    const calls = { river: [], searchDiary: [], tagBoostOptions: [] };
    const port = {
        available: true,
        embedQuery: async () => [0.1, 0.2],
        listDiaries: () => ['D1', 'D2'],
        searchDiary: async (diary, vector, options = {}) => {
            calls.searchDiary.push({ diary, options });
            return [{ text: `knn:${diary}`, sourceFile: `${diary}.md`, score: 0.42, sourceDiary: diary }];
        },
        applyTagBoost: async (vector, weight, options = {}) => {
            calls.tagBoostOptions.push(options);
            return {
                vector: [0.1, 0.2],
                info: { matchedTags: ['t'] },
                preparedMemoObservation: { marker: 'prepared', queryText: options.queryText }
            };
        },
        parseTimeRanges: () => [],
        cosineSimilarity: () => 0.5
    };
    if (riverQuery !== null) {
        port.riverQuery = riverQuery || (async (query, options = {}) => {
            calls.river.push({ query, options });
            return {
                results: [
                    { text: 'river-hit', diaryName: 'D1', sourceFile: 'f.md', score: 0.9 },
                    { text: 'river-hit-2', diaryName: 'D2', sourceFile: 'g.md', score: 0.8 }
                ],
                artifactSig: 'sig-1',
                queryId: 'q-1'
            };
        });
    }
    return { port, calls };
}

const BASE_PARAMS = (port) => ({
    query: 'quant query',
    requestedDiaries: ['D1', 'D2'],
    agentId: 'MCPMidas',
    ragOptions: { mode: 'rag', k: 5, timeAware: false, groupAware: false, rerank: false, tagMemo: true },
    ragRetrieverPort: port,
    ragConfig: { allowCrossRoleAccess: true }
});

test('river mode routes the semantic stage through one riverQuery call for the whole diary scope', async () => {
    const previousEnv = process.env.AGENT_GATEWAY_RECALL_MODE;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        process.env.AGENT_GATEWAY_RECALL_MODE = 'river';
        const { port, calls } = createRiverTestPort();
        const result = await collectRagItems(BASE_PARAMS(port));

        assert.equal(result.success, true);
        assert.equal(calls.river.length, 1);
        assert.deepEqual(calls.river[0].query, { text: 'quant query', vector: [0.1, 0.2] });
        assert.deepEqual(calls.river[0].options.diaryNames, ['D1', 'D2']);
        assert.equal(calls.river[0].options.topK, 5);
        assert.deepEqual(calls.river[0].options.coreTags, ['t']);
        // preparedMemoObservation 复用：tagMemo 已用同一 query 文本做过 applyTagBoostAsync sensing
        assert.equal(calls.tagBoostOptions.length, 1);
        assert.equal(calls.tagBoostOptions[0].queryText, 'quant query');
        assert.deepEqual(calls.river[0].options.preparedMemoObservation, { marker: 'prepared', queryText: 'quant query' });
        assert.equal(calls.river[0].options.sourceObservationConfig.coreBoostFactor, 1.33);
        // KNN 路径不应被触发
        assert.equal(calls.searchDiary.length, 0);
        // river 结果按 diaryName 归一 sourceDiary
        assert.ok(result.items.every((item) => item.sourceDiary === 'D1' || item.sourceDiary === 'D2'));
        assert.equal(result.riverEngine.mode, 'river');
        assert.equal(result.riverEngine.artifactSig, 'sig-1');
        assert.equal(warnings.length, 0);
    } finally {
        console.warn = originalWarn;
        if (previousEnv === undefined) {
            delete process.env.AGENT_GATEWAY_RECALL_MODE;
        } else {
            process.env.AGENT_GATEWAY_RECALL_MODE = previousEnv;
        }
    }
});

test('rollback switch to knn restores the per-diary KNN path without restart', async () => {
    const previousEnv = process.env.AGENT_GATEWAY_RECALL_MODE;
    try {
        process.env.AGENT_GATEWAY_RECALL_MODE = 'knn';
        const { port, calls } = createRiverTestPort();
        const result = await collectRagItems(BASE_PARAMS(port));

        assert.equal(result.success, true);
        assert.equal(calls.river.length, 0);
        assert.equal(calls.searchDiary.length, 2);
        assert.deepEqual(calls.searchDiary.map((call) => call.diary), ['D1', 'D2']);
        assert.equal(result.riverEngine, null);
        assert.ok(result.items.length > 0);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.AGENT_GATEWAY_RECALL_MODE;
        } else {
            process.env.AGENT_GATEWAY_RECALL_MODE = previousEnv;
        }
    }
});

test('river mode on a legacy port without riverQuery silently uses KNN and stays observable', async () => {
    const previousEnv = process.env.AGENT_GATEWAY_RECALL_MODE;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
        process.env.AGENT_GATEWAY_RECALL_MODE = 'river';
        const { port, calls } = createRiverTestPort({ riverQuery: null });
        const result = await collectRagItems(BASE_PARAMS(port));

        assert.equal(result.success, true);
        assert.equal(calls.searchDiary.length, 2);
        assert.equal(result.riverEngine, null);
        assert.ok(warnings.some((line) => line.includes('port lacks riverQuery')));
    } finally {
        console.warn = originalWarn;
        if (previousEnv === undefined) {
            delete process.env.AGENT_GATEWAY_RECALL_MODE;
        } else {
            process.env.AGENT_GATEWAY_RECALL_MODE = previousEnv;
        }
    }
});

test('river degradation from the binding layer surfaces engine metadata without failing the request', async () => {
    const previousEnv = process.env.AGENT_GATEWAY_RECALL_MODE;
    try {
        process.env.AGENT_GATEWAY_RECALL_MODE = 'river';
        const { port, calls } = createRiverTestPort({
            riverQuery: async () => ({
                results: [{ text: 'fallback-hit', sourceDiary: 'D1', sourceFile: 'f.md', score: 0.4 }],
                degraded: { engine: 'knn', reason: 'river_query_failed', errorCode: 'NATIVE_RIVER_JOINT_FAILED' }
            })
        });
        const result = await collectRagItems(BASE_PARAMS(port));

        assert.equal(result.success, true);
        assert.equal(calls.searchDiary.length, 0);
        assert.equal(result.riverEngine.mode, 'river');
        assert.equal(result.riverEngine.degraded.engine, 'knn');
        assert.equal(result.riverEngine.degraded.errorCode, 'NATIVE_RIVER_JOINT_FAILED');
        assert.ok(result.items.some((item) => item.text === 'fallback-hit'));
    } finally {
        if (previousEnv === undefined) {
            delete process.env.AGENT_GATEWAY_RECALL_MODE;
        } else {
            process.env.AGENT_GATEWAY_RECALL_MODE = previousEnv;
        }
    }
});
