const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    DEFAULT_RAG_K,
    MAX_RAG_K,
    extractRagOptions
} = require('../../../modules/agentGateway/core/recall/ragRetriever');
const { buildRagOptionsFromModifiers } = require('../../../modules/agentGateway/core/recall/runtimeSupport');
const { RecallProfileResolver } = require('../../../modules/agentGateway/policy/recallProfileResolver');
const { createRecallRuntimeService } = require('../../../modules/agentGateway/core/recall/recallRuntimeService');

test('retrieval budget constants follow D6 conservative expansion (k 5→8, cap 20→50)', () => {
    assert.equal(DEFAULT_RAG_K, 8);
    assert.equal(MAX_RAG_K, 50);
    // runtimeSupport 以字面量镜像同一预算（测试桩原因不复用导出），两处必须一致防漂移
    const support = require('../../../modules/agentGateway/core/recall/runtimeSupport');
    assert.equal(support.DEFAULT_RAG_K, DEFAULT_RAG_K);
    assert.equal(support.MAX_RAG_K, MAX_RAG_K);
    // 默认 k 生效
    assert.equal(extractRagOptions({}).k, 8);
    // 上限 50 可达且封顶
    assert.equal(extractRagOptions({ k: 50 }).k, 50);
    assert.equal(extractRagOptions({ k: 999 }).k, 50);
    assert.equal(extractRagOptions({ k: 1 }).k, 1);
});

test('profile rule targets.k is preserved by the resolver', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-budget-'));
    const configPath = path.join(dir, 'recall_profiles.json');
    fs.writeFileSync(configPath, JSON.stringify({
        agents: { AgentK: { defaultProfile: 'p', targets: ['D1'] } },
        profiles: {
            p: {
                rules: [
                    { baseMode: 'rag', targets: { diaries: ['D1'], k: 12 }, modifiers: { tagMemo: { weight: 0.4 } } },
                    { baseMode: 'rag', targets: { diaries: ['D1'], k: 'bogus' } }
                ]
            }
        }
    }), 'utf8');
    const resolved = new RecallProfileResolver({ configPath }).resolveForAgent('AgentK', 'p');
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.rules[0].targets.k, 12);
    assert.equal(resolved.rules[0].k, 12);
    // 非法 k 被丢弃，不影响 rule 有效性
    assert.equal(resolved.rules[1].targets.k, undefined);
});

test('recall runtime honors rule targets.k and clamps to the global cap', async () => {
    const observed = [];
    const makeService = (rules) => createRecallRuntimeService({
        pluginManager: {},
        recallProfileResolver: {
            resolveForAgent() {
                return { resolved: true, profileName: 'p', rules };
            }
        },
        async collectRagItems(params) {
            observed.push({ k: params.ragOptions.k, diaries: params.requestedDiaries });
            return { success: true, items: [] };
        }
    });

    // rule 级绝对 k=12 → ragOptions.k=12
    observed.length = 0;
    let result = await makeService([{ type: 'rag', diaries: ['D1'], targets: { diaries: ['D1'], k: 12 } }])
        .executeRecall({ agentId: 'a', query: 'q' });
    assert.equal(result.success, true);
    assert.equal(observed[0].k, 12);

    // 未配置 k → 默认 8（kMultiplier 默认 1.0）
    observed.length = 0;
    result = await makeService([{ type: 'rag', diaries: ['D1'], targets: { diaries: ['D1'] } }])
        .executeRecall({ agentId: 'a', query: 'q' });
    assert.equal(observed[0].k, 8);

    // 未配置 k 但 kMultiplier=2 → 16
    observed.length = 0;
    result = await makeService([{ type: 'rag', diaries: ['D1'], targets: { diaries: ['D1'], kMultiplier: 2 } }])
        .executeRecall({ agentId: 'a', query: 'q' });
    assert.equal(observed[0].k, 16);

    // rule k=999 → 夹取 50（上限可达且不可突破）
    observed.length = 0;
    result = await makeService([{ type: 'rag', diaries: ['D1'], targets: { diaries: ['D1'], k: 999 } }])
        .executeRecall({ agentId: 'a', query: 'q' });
    assert.equal(observed[0].k, 50);
});

test('tagBoost weight remains exposed via modifiers.tagMemo.weight', () => {
    const { options } = buildRagOptionsFromModifiers({ tagMemo: { weight: 0.4, geodesic: true } });
    assert.equal(options.tagMemo, true);
    assert.equal(options.tagMemoWeight, 0.4);
    assert.equal(options.tagMemoGeodesic, true);
    const plain = buildRagOptionsFromModifiers({ tagMemo: true });
    assert.equal(plain.options.tagMemo, true);
    assert.equal(plain.options.tagMemoWeight, undefined);
});
