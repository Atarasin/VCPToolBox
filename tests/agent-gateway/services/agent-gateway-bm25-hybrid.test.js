const assert = require('node:assert/strict');
const test = require('node:test');

const { buildRagOptionsFromModifiers } = require('../../../modules/agentGateway/core/recall/runtimeSupport');
const { ALLOWED_MODIFIERS } = require('../../../modules/agentGateway/policy/recallProfileResolver');
const { collectRagItems } = require('../../../modules/agentGateway/core/recall/ragRetriever');
const { RecallProfileResolver } = require('../../../modules/agentGateway/policy/recallProfileResolver');

test('bm25 modifier parses boolean and structured forms into ragOptions', () => {
    assert.equal(ALLOWED_MODIFIERS.has('bm25'), true);
    const flag = buildRagOptionsFromModifiers({ bm25: true });
    assert.equal(flag.options.bm25, true);
    assert.equal(flag.options.bm25Mode, undefined);
    assert.equal(flag.options.bm25Weight, undefined);

    const structured = buildRagOptionsFromModifiers({ bm25: { mode: 'body', weight: 0.8 } });
    assert.equal(structured.options.bm25, true);
    assert.equal(structured.options.bm25Mode, 'body');
    assert.equal(structured.options.bm25Weight, 0.8);

    const disabled = buildRagOptionsFromModifiers({ bm25: { enabled: false } });
    assert.equal(disabled.options.bm25, false);
});

function createHybridPort({ bm25Files, keywordBoost = () => [] } = {}) {
    const calls = { river: [], bm25: [], timePaths: [] };
    const port = {
        available: true,
        embedQuery: async () => [0.1, 0.2],
        listDiaries: () => ['D1'],
        searchDiary: async () => [],
        applyTagBoost: async () => ({ vector: [0.1, 0.2], info: { matchedTags: [] }, preparedMemoObservation: { m: 1 } }),
        parseTimeRanges: () => [],
        cosineSimilarity: () => 0.5,
        getBM25FileCandidates: async (diaries, queryText, limit, mode, weight) => {
            calls.bm25.push({ diaries, queryText, limit, mode, weight });
            return {
                files: (bm25Files || []).map((file) => ({ ...file })),
                matched: true
            };
        },
        riverQuery: async (query, options = {}) => {
            calls.river.push({ query, options });
            // 模拟 Rust 联合层：hybridPlan 携带的关键词文件被展开进结果
            const hybridHits = (options.hybridPlan?.fileCandidates || []).map((candidate) => ({
                text: `bm25:${candidate.path}`,
                diaryName: 'D1',
                sourceFile: candidate.path.split('/').pop(),
                score: 0.7 + candidate.normalizedBM25Score * 0.2
            }));
            return { results: [...hybridHits, ...keywordBoost(query)] };
        }
    };
    return { port, calls };
}

const RIVER_PARAMS = (port, ragOptionsOverrides) => ({
    query: '凌烟阁2.5 A4混合臂 回测',
    requestedDiaries: ['D1'],
    agentId: 'MCPMidas',
    ragOptions: { mode: 'rag', k: 5, timeAware: false, groupAware: false, rerank: false, tagMemo: true, ...ragOptionsOverrides },
    ragRetrieverPort: port,
    ragConfig: { allowCrossRoleAccess: true }
});

async function withRiverEnv(fn) {
    const previous = process.env.AGENT_GATEWAY_RECALL_MODE;
    process.env.AGENT_GATEWAY_RECALL_MODE = 'river';
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env.AGENT_GATEWAY_RECALL_MODE;
        else process.env.AGENT_GATEWAY_RECALL_MODE = previous;
    }
}

test('bm25 modifier feeds sparse file candidates into the river hybridPlan', async () => {
    await withRiverEnv(async () => {
        const { port, calls } = createHybridPort({
            bm25Files: [{ path: 'D1/2026-10-03-00_07_43.txt', bm25Score: 3.2, normalizedBM25Score: 1, source: 'bm25_body' }]
        });
        const result = await collectRagItems(RIVER_PARAMS(port, { bm25: true, bm25Mode: 'body', bm25Weight: 0.7 }));

        assert.equal(result.success, true);
        assert.equal(calls.bm25.length, 1);
        assert.deepEqual(calls.bm25[0].diaries, ['D1']);
        assert.equal(calls.bm25[0].mode, 'body');
        assert.equal(calls.bm25[0].weight, 0.7);
        // bm25Limit 对齐生产：max(semanticSearchK, k × 3)（rerank 关）
        assert.equal(calls.bm25[0].limit, 15);

        const plan = calls.river[0].options.hybridPlan;
        assert.ok(plan, 'hybridPlan should be present');
        assert.equal(plan.bm25Mode, 'body');
        assert.equal(plan.bm25Weight, 0.7);
        assert.equal(plan.fileCandidates.length, 1);
        assert.equal(plan.fileCandidates[0].path, 'D1/2026-10-03-00_07_43.txt');
        assert.equal(plan.fileCandidates[0].source, 'bm25_body');
        // 含明确关键词的 query 命中改善：关键词文件出现在结果中
        assert.ok(result.items.some((item) => item.sourceFile === '2026-10-03-00_07_43.txt'));
    });
});

test('without the bm25 modifier no sparse candidates are requested and hybridPlan stays minimal', async () => {
    await withRiverEnv(async () => {
        const { port, calls } = createHybridPort({
            bm25Files: [{ path: 'D1/x.txt', bm25Score: 1, normalizedBM25Score: 1 }]
        });
        const result = await collectRagItems(RIVER_PARAMS(port));
        assert.equal(result.success, true);
        assert.equal(calls.bm25.length, 0);
        assert.equal(calls.river[0].options.hybridPlan, null);
    });
});

test('timeLimits merge time-scored files into the hybridPlan candidates', async () => {
    await withRiverEnv(async () => {
        const { port, calls } = createHybridPort({
            bm25Files: [{ path: 'D1/shared.txt', bm25Score: 2, normalizedBM25Score: 0.9, source: 'bm25_tag' }]
        });
        port.parseTimeRanges = () => [{ start: '2026-10-01', end: '2026-10-09' }];
        port.getTimeRangeFilePaths = async (diary, range) => {
            calls.timePaths.push({ diary, range });
            return ['D1/shared.txt', 'D1/timed.txt'];
        };
        const result = await collectRagItems(RIVER_PARAMS(port, { bm25: true, timeAware: true }));

        const plan = calls.river[0].options.hybridPlan;
        const byPath = new Map(plan.fileCandidates.map((candidate) => [candidate.path, candidate]));
        // 同一文件 BM25 与 time 分数合并（max），time 来源优先标注
        assert.equal(byPath.get('D1/shared.txt').timeScore, 1);
        assert.equal(byPath.get('D1/shared.txt').normalizedBM25Score, 0.9);
        assert.equal(byPath.get('D1/shared.txt').source, 'time');
        assert.equal(byPath.get('D1/timed.txt').source, 'time');
        assert.equal(result.success, true);
    });
});

test('bm25 failure degrades silently without breaking the main river query', async () => {
    await withRiverEnv(async () => {
        const originalWarn = console.warn;
        const warnings = [];
        console.warn = (...args) => { warnings.push(args.join(' ')); };
        try {
            const { port, calls } = createHybridPort({});
            port.getBM25FileCandidates = async () => { throw new Error('fts down'); };
            const result = await collectRagItems(RIVER_PARAMS(port, { bm25: true }));
            assert.equal(result.success, true);
            assert.equal(calls.river[0].options.hybridPlan, null);
            assert.ok(warnings.some((line) => line.includes('BM25 file candidates unavailable')));
        } finally {
            console.warn = originalWarn;
        }
    });
});
