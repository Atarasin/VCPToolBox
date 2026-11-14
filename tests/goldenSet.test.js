'use strict';

/**
 * goldenSet 离线端到端：stub embedding 建库 → 跑金标（required/preview/
 * negative 语义与指标）。Node 22 运行（原生模块 ABI）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

const STUB_DIM = 64;
const embeddingUtils = require(path.join(REPO_ROOT, 'EmbeddingUtils'));
delete process.env.TDB_KNOWLEDGE_DIMENSION;
delete process.env.VECTORDB_DIMENSION;
delete process.env.TDB_KNOWLEDGE_MODEL;
delete process.env.API_URL;
delete process.env.API_Key;
embeddingUtils.getEmbeddingsBatch = async (texts) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return texts.map((text) => {
        const vector = [];
        let state = 7;
        for (let i = 0; i < text.length; i++) state = (state * 31 + text.charCodeAt(i)) % 2147483647;
        for (let i = 0; i < STUB_DIM; i++) {
            state = (state * 1103515245 + 12345) % 2147483648;
            vector.push((state / 2147483648) * 2 - 1);
        }
        return vector;
    });
};

const goldenSet = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/goldenSet'));
const maintenance = require(path.join(REPO_ROOT, 'scripts', 'forge_maintenance'));

async function buildFixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'golden-root-'));
    const store = await fsp.mkdtemp(path.join(os.tmpdir(), 'golden-store-'));
    await fsp.mkdir(path.join(root, 'knowledge', 'UI库'), { recursive: true });
    await fsp.writeFile(path.join(root, 'knowledge', 'UI库', 'K_a_对比度.md'), [
        '---',
        'title: WCAG 对比度',
        'sources:',
        '  - url: https://www.w3.org/x',
        '    fetchedAt: 2026-11-01T00:00:00.000Z',
        'tags: [a]',
        '---',
        '',
        '## 定义',
        '普通文本对比度至少 4.5:1，大文本 3:1。这是键盘可达性之外的对比度要求。'
    ].join('\n'), 'utf-8');
    await fsp.writeFile(path.join(root, 'knowledge', 'UI库', '70_API网关治理.md'), [
        '# API 网关治理',
        '',
        '> 来源：https://api-gov.example/x',
        '> 抓取时间：2026-11-01T00:00:00.000Z',
        '',
        'API 网关的流量治理与安全职责……'
    ].join('\n'), 'utf-8');
    await fsp.writeFile(path.join(root, 'config.env'), [
        'TDB_KNOWLEDGE_DIMENSION=64',
        'VECTORDB_DIMENSION=64',
        'TDB_KNOWLEDGE_MODEL=stub-64',
        'API_URL=http://stub.invalid',
        'API_Key=k'
    ].join('\n'), 'utf-8');
    return { root, store };
}

test('goldenSet：required/preview/negative 语义与指标（离线建库）', async () => {
    const { root, store } = await buildFixture();
    try {
        const estimate = await maintenance.cmdEstimateRebuild({ root, store, 'poll-ms': '200', 'timeout-ms': '60000', json: true });
        assert.equal(estimate.exitCode, 0, JSON.stringify(estimate.report));

        const { TDBKnowledgeManager } = require(path.join(REPO_ROOT, 'TDBKnowledge'));
        const manager = new TDBKnowledgeManager({
            enabled: true,
            rootPath: path.join(root, 'knowledge'),
            storePath: store,
            model: 'stub-64',
            dimension: STUB_DIM,
            apiUrl: 'http://stub.invalid',
            apiKey: 'k',
            fullScanOnStartup: false
        });
        await manager.initialize();
        try {
            assert.equal(manager.initializationState, 'compatible');

            const queries = goldenSet.loadGoldenSet({
                queries: [
                    {
                        id: 'req-contrast', library: 'UI库', subskill: 'a', query: 'WCAG 文本对比度要求是多少',
                        topK: 5, expand: false, kind: 'required',
                        requiredSourceFiles: ['UI库/K_a_对比度.md'], requiredText: ['4.5']
                    },
                    {
                        id: 'prev-no-header', library: 'UI库', query: '对比度',
                        topK: 5, expand: false, kind: 'preview',
                        requiredSourceFiles: ['UI库/K_a_对比度.md']
                    },
                    {
                        id: 'neg-gateway', library: 'UI库', query: '对比度与栅格设计',
                        topK: 5, expand: false, kind: 'negative',
                        forbiddenSourceFiles: ['UI库/70_API网关治理.md']
                    }
                ]
            });

            // Expand 契约（§3.2.1）：expand:true 必须回读原始全文（含 sources 头）。
            const expanded = await manager.search('对比度', { libraries: ['UI库'], topK: 5, expand: true });
            assert.equal(expanded.length > 0, true);
            assert.equal(expanded[0]._expanded, true);
            assert.ok(
                expanded.some((hit) => /fetchedAt|>\s*来源[：:]/.test(String(hit.text || ''))),
                'expand:true 应回读含来源头（K 卡 fetchedAt 或长文档 > 来源：）的原始全文'
            );

            const report = await goldenSet.runGoldenSet(manager, queries, {});
            assert.equal(report.ok, true, JSON.stringify(report.results, null, 1));
            const req = report.results.find((r) => r.id === 'req-contrast');
            assert.equal(req.passed, true);
            assert.equal(req.reciprocalRank, 1); // 唯一相关文件应为 top-1
            const prev = report.results.find((r) => r.id === 'prev-no-header');
            assert.equal(prev.sourcesHeaderLeak, false, '规范化后 preview 不得含 sources 头');
            assert.ok(report.summary.mrr > 0);
            assert.equal(report.summary.noise, 0, '唯一命中即必需文件时 noise 应为 0（修复 r._required 缺陷的回归）');
            assert.ok(report.summary.ndcg <= 1, 'nDCG 不得超 1（修复同文件多 chunk 去重缺陷的回归）');
            assert.equal(report.provenance.expand, false);
            assert.match(report.provenance.storeManifestHash, /^sha256:/);
        } finally {
            await manager.shutdown();
        }
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(store, { recursive: true, force: true });
    }
});

test('goldenSet：验证器拒绝 expand 未显式关闭与缺字段', () => {
    assert.throws(
        () => goldenSet.loadGoldenSet({ queries: [{ id: 'a', library: 'L', query: 'q', topK: 5, kind: 'required', requiredSourceFiles: ['x'] }] }),
        /expand:false/
    );
    assert.throws(
        () => goldenSet.loadGoldenSet({ queries: [{ id: 'a', library: 'L', query: 'q', topK: 5, expand: false, kind: 'negative' }] }),
        /forbiddenSourceFiles/
    );
    assert.throws(
        () => goldenSet.loadGoldenSet({ queries: [{ id: 'a', library: 'L', query: 'q', topK: 5, expand: false, kind: 'weird' }] }),
        /kind/
    );
    assert.throws(() => goldenSet.loadGoldenSet({ queries: [{ id: 'dup' }, { id: 'dup' }] }), /重复|缺/);
});

test('goldenSet：随库分发的砚尺基线集本身合法', () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/golden/yanchi_ui.json'), 'utf-8'));
    const queries = goldenSet.loadGoldenSet(parsed);
    const kinds = queries.reduce((acc, q) => { acc[q.kind] = (acc[q.kind] || 0) + 1; return acc; }, {});
    assert.equal(queries.length, 60);
    assert.equal(kinds.required, 21);
    assert.equal(kinds.incremental, 34); // 23 新增 + 11 变更
    assert.equal(kinds.negative, 3);
    assert.equal(kinds.preview, 2);
    // 23/11 探针覆盖设计指定的文件集。
    const incrementalFiles = new Set(queries.filter((q) => q.kind === 'incremental').flatMap((q) => q.requiredSourceFiles));
    assert.equal(incrementalFiles.size, 34);
});


test('goldenSet ndcgAtK：同文件多 chunk 命中按文件去重，不得超过 1', () => {
    const hits = [
        { sourceFile: 'L/a.md', score: 2 },
        { sourceFile: 'L/a.md', score: 1.8 },
        { sourceFile: 'L/b.md', score: 1.5 }
    ];
    const value = goldenSet.ndcgAtK(hits, ['L/a.md'], 5);
    assert.ok(value <= 1, `去重后 nDCG 必须 ≤1，实际 ${value}`);
    assert.ok(value > 0, '必需文件命中时 nDCG 应 >0');
});
