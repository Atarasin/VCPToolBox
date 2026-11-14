'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const qualityModel = require('../../../modules/agentGateway/services/forge/qualityModel');
const knowledgeStates = require('../../../modules/agentGateway/services/forge/knowledgeStates');

const SHA = 'sha256:' + 'a'.repeat(64);
const ISO = '2026-11-15T00:00:00.000Z';

// ── qualityModel（T9 数据契约） ──────────────────────────────────────────

test('qualityModel：五个工厂接受合法输入并冻结', () => {
    const item = qualityModel.createDiscoveryItem({
        title: 'Understanding SC 2.1.1', url: 'https://w3.org/x', provider: 'ParallelSearch',
        query: 'WCAG keyboard', rank: 1, publishedAt: null, structured: { raw: 1 }
    });
    assert.equal(item.rank, 1);

    const evidence = qualityModel.createEvidenceDocument({
        url: 'https://w3.org/x', finalUrl: 'https://w3.org/x/final', fetchedAt: ISO,
        fetchTool: 'UrlFetch', fetchMode: 'text', contentPath: 'Agent/forge/runs/j1/evidence/f.md',
        contentHash: SHA, truncated: false, fetchError: null, sourceType: 'official-standard'
    });
    assert.equal(evidence.fetchTool, 'UrlFetch');

    const claim = qualityModel.createClaim({
        id: 'claim-001', text: 'WCAG 2.1.1 存在路径依赖例外', kind: 'normative',
        scope: 'WCAG 2.2，除自由手绘等路径依赖场景',
        evidence: [{ url: 'https://w3.org/x', contentHash: SHA, quote: 'except where the underlying function...' }],
        support: 'supported'
    });
    assert.equal(claim.evidence.length, 1);

    const verdict = qualityModel.createQualityVerdict({
        subjectType: 'knowledgeUnit', subjectId: 'yanchi_ui知识库/K_x.md', status: 'pass',
        topic: { verdict: 'in_scope', reason: '视觉层级主题在蓝图职责内' },
        claims: [claim], issues: [], createdAt: ISO
    });
    assert.equal(verdict.ruleVersion, 'forge-quality-v1');

    const manifest = qualityModel.createPublicationManifest({
        schemaVersion: 1, expertName: 'yanchi_ui', libraryName: 'yanchi_ui知识库', revision: 1,
        status: 'active', sourceJobId: 'job_1', qualityReport: 'runs/job_1/quality-report.json',
        cards: [{
            cardId: 'K_x', activePath: 'knowledge/yanchi_ui知识库/K_x.md', contentHash: SHA,
            qualityStatus: 'active', indexStatus: 'verified', publishedAt: ISO
        }],
        createdAt: ISO
    });
    assert.equal(manifest.cards.length, 1);
});

test('qualityModel：必填缺失/格式错误在构造期拒绝', () => {
    assert.throws(() => qualityModel.createDiscoveryItem({ title: 't', url: 'notaurl', provider: 'p', query: 'q', rank: 1 }),
        /url/);
    assert.throws(() => qualityModel.createDiscoveryItem({ title: 't', url: 'https://x', provider: 'p', query: 'q', rank: 0 }),
        /rank/);
    assert.throws(() => qualityModel.createEvidenceDocument({
        url: 'https://x', fetchedAt: 'yesterday', fetchTool: 'UrlFetch', fetchMode: 'text',
        contentPath: 'p', contentHash: 'deadbeef', truncated: false, sourceType: 'other'
    }), /fetchedAt/);
    assert.throws(() => qualityModel.createEvidenceDocument({
        url: 'https://x', fetchedAt: ISO, fetchTool: 'Curl', fetchMode: 'text',
        contentPath: 'p', contentHash: SHA, truncated: false, sourceType: 'other'
    }), /fetchTool/);
    assert.throws(() => qualityModel.createClaim({
        id: 'c', text: 't', kind: 'factual', scope: 's', evidence: [], support: 'supported'
    }), /evidence/); // §3.5.3 factual/normative supported 必须带证据
    assert.throws(() => qualityModel.createQualityVerdict({
        subjectType: 'material', subjectId: 'm1', status: 'pass',
        topic: { verdict: 'in_scope', reason: 'r' },
        issues: [{ code: 'X', message: 'm', blocking: true }]
    }), /blocking/); // blocking issue 不得 pass
    assert.throws(() => qualityModel.createPublicationManifest({
        schemaVersion: 1, expertName: 'e', libraryName: 'l', revision: 1, status: 'active',
        sourceJobId: 'j', qualityReport: 'r',
        cards: [{ cardId: 'c', activePath: 'p', contentHash: SHA, qualityStatus: 'active', indexStatus: 'pending', publishedAt: ISO }],
        createdAt: ISO
    }), /indexStatus/); // active 卡必须 verified
});

// ── knowledgeStates（T11 状态机/区域/台账/demote） ──────────────────────

function makeTemp() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-states-'));
}

test('knowledgeStates：流转表拒绝非法迁移（隔离区不得直发、publishing 失败必 demote）', () => {
    assert.doesNotThrow(() => knowledgeStates.assertTransition('candidate', 'publishing'));
    assert.doesNotThrow(() => knowledgeStates.assertTransition('publishing', 'needs_review'));
    assert.doesNotThrow(() => knowledgeStates.assertTransition('quarantine', 'needs_review'));
    assert.throws(() => knowledgeStates.assertTransition('quarantine', 'publishing'), /不允许/);
    assert.throws(() => knowledgeStates.assertTransition('active', 'publishing'), /不允许/);
    assert.throws(() => knowledgeStates.assertTransition('candidate', 'active'), /不允许/);
});

test('knowledgeStates：区域解析全部在 knowledge 之外，且库内隔离被守卫拒绝', () => {
    const forgeRoot = path.join(makeTemp(), 'Agent', 'forge');
    const knowledgeRoot = path.join(makeTemp(), 'knowledge');
    const quarantinePath = knowledgeStates.resolveZonePath({
        state: 'quarantine', forgeRoot, expertName: 'yanchi_ui', library: 'yanchi_ui知识库', fileName: 'K_x.md'
    });
    assert.ok(quarantinePath.startsWith(forgeRoot));
    assert.doesNotThrow(() => knowledgeStates.assertOutsideKnowledge(quarantinePath, knowledgeRoot));
    assert.throws(
        () => knowledgeStates.assertOutsideKnowledge(path.join(knowledgeRoot, 'yanchi_ui知识库', 'quarantine', 'K_x.md'), knowledgeRoot),
        /之外/
    ); // §2.2 禁止：knowledge/<lib>/quarantine/
});

test('knowledgeStates：移动 + 台账 + 拒绝覆盖 + demote 等 unlink 收敛', async () => {
    const base = makeTemp();
    const forgeRoot = path.join(base, 'Agent', 'forge');
    const knowledgeRoot = path.join(base, 'knowledge', 'yanchi_ui知识库');
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.writeFileSync(path.join(knowledgeRoot, 'K_a.md'), '# A\n', 'utf-8');

    const ledger = knowledgeStates.createDispositionLedger(path.join(forgeRoot, 'yanchi_ui', 'disposition-ledger.jsonl'));
    const reviewPath = knowledgeStates.resolveZonePath({
        state: 'needs_review', forgeRoot, expertName: 'yanchi_ui', library: 'yanchi_ui知识库', fileName: 'K_a.md'
    });

    const record = await knowledgeStates.moveKnowledgeFile({
        ledger, from: path.join(knowledgeRoot, 'K_a.md'), to: reviewPath,
        reason: '证据不足待复核', fromState: 'active', toState: 'needs_review'
    });
    assert.ok(record.id.startsWith('disp_'));
    assert.equal(fs.existsSync(reviewPath), true);
    assert.equal(fs.existsSync(path.join(knowledgeRoot, 'K_a.md')), false);

    // 目标已存在 → 拒绝覆盖（红线 6）。
    fs.writeFileSync(path.join(knowledgeRoot, 'K_b.md'), '# B\n', 'utf-8');
    await assert.rejects(
        knowledgeStates.moveKnowledgeFile({
            ledger, from: path.join(knowledgeRoot, 'K_b.md'), to: reviewPath,
            reason: 'x', fromState: 'active', toState: 'needs_review'
        }),
        (error) => error.code === 'FORGE_KNOWLEDGE_MOVE_TARGET_EXISTS'
    );
    assert.equal(fs.existsSync(path.join(knowledgeRoot, 'K_b.md')), true);

    // 台账可回读，恢复路径可定位。
    const all = await ledger.readAll();
    assert.equal(all.length, 1);
    assert.match(all[0].restoreHint, /移回/);

    // demote：publishing 失败 → needs_review + 等待 unlink 收敛（连续两次 0）。
    fs.writeFileSync(path.join(knowledgeRoot, 'K_c.md'), '# C\n', 'utf-8');
    let polls = 0;
    const result = await knowledgeStates.demoteFromPublishing({
        ledger,
        activePath: 'yanchi_ui知识库/K_c.md',
        knowledgeRoot: path.dirname(knowledgeRoot),
        forgeRoot,
        expertName: 'yanchi_ui',
        reason: '索引探针未命中',
        pollUnlink: () => { polls += 1; return 0; },
        pollIntervalMs: 10
    });
    assert.equal(result.converged, true);
    assert.ok(polls >= 2);
    assert.ok(fs.existsSync(result.toPath));

    // pollUnlink 持续非零 → 不收敛（fail closed，等待而非放行）。
    fs.writeFileSync(path.join(knowledgeRoot, 'K_d.md'), '# D\n', 'utf-8');
    const stuck = await knowledgeStates.demoteFromPublishing({
        ledger,
        activePath: 'yanchi_ui知识库/K_d.md',
        knowledgeRoot: path.dirname(knowledgeRoot),
        forgeRoot,
        expertName: 'yanchi_ui',
        reason: 'x',
        pollUnlink: () => 3,
        timeoutMs: 60,
        pollIntervalMs: 10
    });
    assert.equal(stuck.converged, false);
    await fsp.rm(base, { recursive: true, force: true });
});
