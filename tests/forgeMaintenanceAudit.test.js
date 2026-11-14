'use strict';

/**
 * forge_maintenance audit / estimate-rebuild / smoke 的离线端到端测试。
 *
 * 必须用与原生模块 ABI 一致的 Node 运行（生产 Node 22；Node 24 会
 * NODE_MODULE_VERSION 不匹配）。套件通过先 patch EmbeddingUtils 再触发
 * TDBKnowledge 惰性 require 的方式离线运行，不访问真实 embedding API。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');

// 先 patch，再让 CLI 触发 TDBKnowledge 的惰性 require（其模块级解构会拿到 stub）。
const STUB_DIM = 64;
const embeddingUtils = require(path.join(REPO_ROOT, 'EmbeddingUtils'));
embeddingUtils.getEmbeddingsBatch = async (texts) => {
    await new Promise((resolve) => setTimeout(resolve, 5)); // 模拟网络节拍
    return texts.map((text) => {
        const vector = [];
        let state = 0;
        for (let i = 0; i < text.length; i++) state = (state * 31 + text.charCodeAt(i)) % 2147483647;
        for (let i = 0; i < STUB_DIM; i++) {
            state = (state * 1103515245 + 12345) % 2147483648;
            vector.push((state / 2147483648) * 2 - 1);
        }
        return vector;
    });
};
const cli = require(path.join(REPO_ROOT, 'scripts', 'forge_maintenance'));

async function makeFixtureRoot() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-audit-root-'));
    await fsp.mkdir(path.join(root, 'knowledge', '库A'), { recursive: true });
    await fsp.mkdir(path.join(root, 'knowledge', '库B'), { recursive: true });
    await fsp.writeFile(path.join(root, 'knowledge', '库A', 'a1.md'), [
        '# 键盘可达性',
        '',
        'WCAG 2.1.1 Keyboard 要求所有功能都可通过键盘接口操作，路径依赖例外适用于自由手绘场景。',
        '对比度大文本要求为 3:1，普通文本为 4.5:1，这是确定性事实。'
    ].join('\n'), 'utf-8');
    await fsp.writeFile(path.join(root, 'knowledge', '库B', 'b1.txt'), [
        'VCP 分布式架构采用星型网络拓扑，WebSocketServer 负责节点注册与远程工具桥接。'
    ].join('\n'), 'utf-8');
    await fsp.writeFile(path.join(root, 'config.env'), [
        'TDB_KNOWLEDGE_DIMENSION=64',
        'VECTORDB_DIMENSION=64',
        'TDB_KNOWLEDGE_MODEL=stub-embed-64',
        'API_URL=http://stub.invalid/v1',
        'API_Key=stub-key'
    ].join('\n'), 'utf-8');
    return root;
}

test('estimate-rebuild → audit → smoke 全链路（离线 stub embedding）', async () => {
    const root = await makeFixtureRoot();
    const store = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-audit-store-'));
    try {
        // 1) 临时 store 全量摄取演练。
        const estimate = await cli.cmdEstimateRebuild({ root, store, 'poll-ms': '200', 'timeout-ms': '60000', json: true });
        assert.equal(estimate.exitCode, 0, `estimate 应成功：${JSON.stringify(estimate.report)}`);
        assert.equal(estimate.report.converged, true);
        assert.equal(estimate.report.filesIndexed, 2);
        assert.ok(estimate.report.chunksIndexed >= 2);
        assert.ok(estimate.report.elapsedMs > 0);

        // 2) 三层一致性审计（干净 store 应全绿）。
        const auditOk = await cli.cmdAudit({ root, store, json: true });
        assert.equal(auditOk.exitCode, 0, `干净 store 审计应通过：${JSON.stringify(auditOk.report.issues)}`);
        assert.equal(auditOk.report.ok, true);
        const libs = Object.keys(auditOk.report.layers.sqliteVsTrivium.libraries);
        assert.deepEqual([...libs].sort(), ['库A', '库B']);

        // 3) 重开后查询冒烟（文本+向量混合检索）。
        const smoke = await cli.cmdSmoke({ root, store, json: true });
        assert.equal(smoke.exitCode, 0, `smoke 应通过：${JSON.stringify(smoke.report)}`);
        assert.equal(smoke.report.ok, true);
        assert.equal(smoke.report.libraries['库A'].topFile, path.join('库A', 'a1.md'));

        // 4) 审计负例：新增未入索引文件 → L1 new；删除已索引文件 → L1 missing。
        await fsp.writeFile(path.join(root, 'knowledge', '库A', 'a2-new.md'), '# 未索引新文件\n', 'utf-8');
        await fsp.rm(path.join(root, 'knowledge', '库B', 'b1.txt'));
        const auditDirty = await cli.cmdAudit({ root, store, json: true });
        assert.equal(auditDirty.exitCode, 1);
        assert.equal(auditDirty.report.ok, false);
        assert.ok(auditDirty.report.issues.some((issue) => issue.includes('L1 new') && issue.includes('a2-new.md')));
        assert.ok(auditDirty.report.issues.some((issue) => issue.includes('L1 missing') && issue.includes('b1.txt')));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(store, { recursive: true, force: true });
    }
});

test('audit 负例：篡改已索引文件内容 → L1 changed', async () => {
    const root = await makeFixtureRoot();
    const store = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-audit-store-'));
    try {
        const estimate = await cli.cmdEstimateRebuild({ root, store, 'poll-ms': '200', 'timeout-ms': '60000', json: true });
        assert.equal(estimate.exitCode, 0);

        await fsp.appendFile(path.join(root, 'knowledge', '库A', 'a1.md'), '\n追加的未索引内容。', 'utf-8');
        const audit = await cli.cmdAudit({ root, store, json: true });
        assert.equal(audit.exitCode, 1);
        assert.ok(audit.report.issues.some((issue) => issue.includes('L1 changed') && issue.includes('a1.md')));
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
        await fsp.rm(store, { recursive: true, force: true });
    }
});
