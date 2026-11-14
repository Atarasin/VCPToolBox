'use strict';

/**
 * disposition 处置执行器测试（M3.S1/S2）：金标护栏、dry-run、apply 的
 * 隔离/复核/修订（含改名）与台账、索引收敛等待。离线，不碰生产。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const cli = require(path.join(REPO_ROOT, 'scripts', 'forge_quality'));

async function makeFixture() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'disp-root-'));
    const lib = path.join(root, 'knowledge', 'UI库');
    const forgeRoot = path.join(root, 'Agent', 'forge');
    await fsp.mkdir(lib, { recursive: true });
    await fsp.mkdir(path.join(forgeRoot, 'e1'), { recursive: true });
    await fsp.writeFile(path.join(lib, 'K_a_对比度.md'), '---\ntitle: 对比度\nsources:\n  - url: https://w/1\n---\n\n正文对比度内容。', 'utf-8');
    await fsp.writeFile(path.join(lib, 'K_b_api治理.md'), '---\ntitle: API 治理\nsources:\n  - url: https://w/2\n---\n\nAPI 治理内容。', 'utf-8');
    await fsp.writeFile(path.join(lib, 'K_c_相邻理论.md'), '---\ntitle: 相邻理论\nsources:\n  - url: https://w/3\n---\n\n相邻内容。', 'utf-8');
    await fsp.writeFile(path.join(lib, '70_架构治理.md'), '# 架构治理\n\n> 来源：https://w/4\n\n架构内容。', 'utf-8');
    // 让 pollUnlink 找到空队列 → 收敛。
    const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
    const storeDir = path.join(root, 'VectorStoreTDB');
    await fsp.mkdir(storeDir, { recursive: true });
    const db = new Database(path.join(storeDir, 'tdb_knowledge_meta.sqlite'));
    db.exec('CREATE TABLE ingest_queue (status TEXT)');
    db.close();
    return { root, forgeRoot, lib };
}

function planFor(root, { goldenGuardHit = false } = {}) {
    return {
        schemaVersion: 1,
        expertName: 'e1',
        createdAt: new Date().toISOString(),
        reason: 'test',
        quarantine: [
            { path: 'UI库/K_b_api治理.md', reason: '偏题：API 治理' },
            { path: 'UI库/70_架构治理.md', reason: '偏题：架构治理' }
        ],
        review: [{ path: 'UI库/K_c_相邻理论.md', reason: '相邻：理论卡' }],
        revise: [{
            path: 'UI库/K_a_对比度.md',
            newPath: 'UI库/K_a_对比度要求.md',
            reason: '测试修订改名',
            evidenceRefs: [],
            newContent: '---\ntitle: 对比度要求（修订）\nsources:\n  - url: https://w/1\n---\n\n修订后的正文。'
        }],
        mergeProposals: [{ paths: ['UI库/x.md', 'UI库/y.md'], reason: '内容型合并候选', proposal: '等待复核' }]
    };
}

test('disposition：金标护栏拒绝引用被隔离文件的探针', async () => {
    const { root } = await makeFixture();
    try {
        // 临时往金标里塞一条引用待隔离文件的 required 探针。
        const goldenPath = path.join(REPO_ROOT, 'modules/agentGateway/services/forge/golden/yanchi_ui.json');
        const original = await fsp.readFile(goldenPath, 'utf-8');
        const golden = JSON.parse(original);
        golden.queries.push({
            id: 'test-guard-probe', library: 'UI库', query: 'x', topK: 5, expand: false, kind: 'required',
            requiredSourceFiles: ['UI库/K_b_api治理.md']
        });
        await fsp.writeFile(goldenPath, JSON.stringify(golden), 'utf-8');
        try {
            const planPath = path.join(root, 'plan.json');
            await fsp.writeFile(planPath, JSON.stringify(planFor(root)), 'utf-8');
            await assert.rejects(
                cli.cmdDisposition({ plan: planPath, root }),
                (error) => /金标探针冲突/.test(error.message)
            );
        } finally {
            await fsp.writeFile(goldenPath, original, 'utf-8');
        }
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});

test('disposition：dry-run 零修改；apply 执行隔离/复核/修订并留台账', async () => {
    const { root, forgeRoot, lib } = await makeFixture();
    try {
        const planPath = path.join(root, 'plan.json');
        await fsp.writeFile(planPath, JSON.stringify(planFor(root)), 'utf-8');

        // dry-run：零修改。
        const dry = await cli.cmdDisposition({ plan: planPath, root, 'forge-root': forgeRoot });
        assert.equal(dry.exitCode, 0);
        assert.equal(dry.report.quarantine, 2);
        assert.ok(fs.existsSync(path.join(lib, 'K_b_api治理.md')), 'dry-run 不得动文件');

        // apply。
        const applied = await cli.cmdDisposition({
            plan: planPath, root, 'forge-root': forgeRoot, apply: true, 'settle-timeout-ms': '30000'
        });
        assert.equal(applied.exitCode, 0, JSON.stringify(applied.report));
        assert.equal(applied.report.indexConverged, true);

        // 隔离区/复核区在 knowledge 外、文件已移出。
        assert.equal(fs.existsSync(path.join(lib, 'K_b_api治理.md')), false);
        assert.equal(fs.existsSync(path.join(lib, '70_架构治理.md')), false);
        assert.equal(fs.existsSync(path.join(lib, 'K_c_相邻理论.md')), false);
        assert.ok(fs.existsSync(path.join(forgeRoot, 'e1', 'quarantine', 'UI库', 'K_b_api治理.md')));
        assert.ok(fs.existsSync(path.join(forgeRoot, 'e1', 'quarantine', 'UI库', '70_架构治理.md')));
        assert.ok(fs.existsSync(path.join(forgeRoot, 'e1', 'review', 'UI库', 'K_c_相邻理论.md')));

        // 修订：旧文件消失、新文件带新内容。
        assert.equal(fs.existsSync(path.join(lib, 'K_a_对比度.md')), false);
        const revised = await fsp.readFile(path.join(lib, 'K_a_对比度要求.md'), 'utf-8');
        assert.match(revised, /修订后的正文/);

        // 台账：隔离 2 + 复核 1 + 修订 1 + 合并候选 1。
        const ledger = (await fsp.readFile(path.join(forgeRoot, 'e1', 'disposition-ledger.jsonl'), 'utf-8'))
            .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
        const actions = ledger.map((r) => r.action);
        assert.equal(actions.filter((a) => a === 'move').length, 3);
        assert.equal(actions.filter((a) => a === 'revise').length, 1);
        assert.ok(actions.includes('merge-proposal-recorded'));
        const reviseRecord = ledger.find((r) => r.action === 'revise');
        assert.match(reviseRecord.oldContentHash, /^sha256:/);
        assert.match(reviseRecord.newContentHash, /^sha256:/);
        // 移动记录带恢复路径。
        for (const move of ledger.filter((r) => r.action === 'move')) {
            assert.match(move.restoreHint, /恢复|原件/);
        }

        // 处置完成后租约释放（cleanup 模式不残留）。
        assert.equal(fs.existsSync(path.join(forgeRoot, 'e1', 'maintenance-lease.json')), false);
    } finally {
        await fsp.rm(root, { recursive: true, force: true });
    }
});
