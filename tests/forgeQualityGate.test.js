'use strict';

/**
 * M4 质量硬门禁测试（§3.5/§3.6/§3.8.2）：
 * 假 URL/假引文/标题孤证/偏题样本被阻断；assertIndexReady fail closed；
 * 质量失败不关闭学习缺口、不推进水位（D4/T31）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const qualityGate = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/qualityGate'));

const BLUEPRINT = {
    name: 'UIDesigner',
    scope: {
        responsibilities: ['UI 视觉设计与配色'],
        boundaries: ['不做医疗器械法规与合规认证', '不提供法律意见']
    },
    subskills: []
};
const SUBSKILL = { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] };

// ── 材料级主题门禁 ───────────────────────────────────────────────────────

test('qualityGate.assessMaterial：命中/相邻/偏题/不确定 四态', () => {
    const inScope = qualityGate.assessMaterial({
        blueprint: BLUEPRINT, subskill: SUBSKILL,
        material: { title: 'Color Theory for UI', snippet: '配色理论与色轮实践。' }
    });
    assert.equal(inScope.status, 'pass');
    assert.equal(inScope.topic.verdict, 'in_scope');

    const offTopic = qualityGate.assessMaterial({
        blueprint: BLUEPRINT, subskill: SUBSKILL,
        material: {
            title: '医疗器械法规与合规认证指南 医疗器械分类 医疗器械注册 法律意见',
            snippet: '医疗器械风险管理与法律意见，含医疗器械注册流程的医疗器械术语。'
        }
    });
    assert.equal(offTopic.topic.verdict, 'out_of_scope');
    assert.equal(offTopic.status, 'quarantine');

    const adjacent = qualityGate.assessMaterial({
        blueprint: BLUEPRINT, subskill: SUBSKILL,
        material: { title: 'design', snippet: '' }
    });
    assert.equal(adjacent.status, 'needs_review');

    const uncertain = qualityGate.assessMaterial({
        blueprint: BLUEPRINT, subskill: SUBSKILL,
        material: { title: 'zzz', snippet: '' }
    });
    assert.equal(uncertain.topic.verdict, 'uncertain');
    assert.equal(uncertain.status, 'needs_review');
});

// ── 主张与证据门禁（§3.5.3 顺序 1-4） ───────────────────────────────────

const EVIDENCE = {
    'https://w3.example.org/contrast': 'Contrast (Minimum): The visual presentation of text has a contrast ratio of at least 4.5:1, except large-scale text at 3:1. Large scale means at least 18 point or 14 point bold.'.repeat(3)
};

function claimLlm({ claims, judged }) {
    let call = 0;
    return {
        available: true,
        complete: async () => {
            call += 1;
            if (call === 1) {
                return { data: { choices: [{ message: { content: JSON.stringify({ claims }) } }], usage: {} } };
            }
            return { data: { choices: [{ message: { content: JSON.stringify({ judged }) } }], usage: {} } };
        }
    };
}

const UNIT = { title: '对比度阈值', oneLiner: '普通文本 4.5:1', content: '普通文本对比度至少 4.5:1，大字号文本为 3:1。' };

test('qualityGate.verifyClaims：真实引文 + 独立判定 supported → 通过', async () => {
    const llm = claimLlm({
        claims: [{
            unitTitle: '对比度阈值', id: 'claim-001', text: '普通文本对比度至少 4.5:1', kind: 'factual', scope: 'WCAG',
            sourceUrl: 'https://w3.example.org/contrast',
            quote: 'contrast ratio of at least 4.5:1'
        }],
        judged: [{ id: 'claim-001', support: 'supported', reason: '引文与主张一致' }]
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT],
        evidenceBySourceUrl: EVIDENCE,
        materialUrls: Object.keys(EVIDENCE),
        llm,
        llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.equal(result.issues.filter((i) => i.blocking).length, 0);
    assert.equal(result.allClaims[0].support, 'supported');
    assert.equal(result.allClaims[0].evidence.length, 1);
});

test('qualityGate.verifyClaims：假 URL（不在本批材料）→ 阻断', async () => {
    const llm = claimLlm({
        claims: [{
            unitTitle: '对比度阈值', id: 'claim-001', text: '对比度主张', kind: 'factual', scope: 'general',
            sourceUrl: 'https://not-in-batch.example.com/fabricated',
            quote: 'contrast ratio of at least 4.5:1'
        }],
        judged: []
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT], evidenceBySourceUrl: EVIDENCE, materialUrls: Object.keys(EVIDENCE),
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.ok(result.issues.some((i) => i.code === 'CLAIM_URL_NOT_IN_BATCH' && i.blocking));
});

test('qualityGate.verifyClaims：假引文（证据全文中精确匹配失败）→ 阻断', async () => {
    const llm = claimLlm({
        claims: [{
            unitTitle: '对比度阈值', id: 'claim-001', text: '对比度主张', kind: 'factual', scope: 'general',
            sourceUrl: 'https://w3.example.org/contrast',
            quote: '对比度要求是 9.9:1，这段引文是编造的'
        }],
        judged: [{ id: 'claim-001', support: 'supported', reason: 'x' }]
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT], evidenceBySourceUrl: EVIDENCE, materialUrls: Object.keys(EVIDENCE),
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.ok(result.issues.some((i) => i.code === 'CLAIM_QUOTE_NOT_MATCHED' && i.blocking));
    assert.equal(result.allClaims.length, 0, '引文不实的主张不进入结果集');
});

test('qualityGate.verifyClaims：仅摘要来源（无归档全文）→ 阻断（红线 3）', async () => {
    const llm = claimLlm({
        claims: [{
            unitTitle: '对比度阈值', id: 'claim-001', text: '大字号文本阈值为 3:1', kind: 'normative', scope: 'WCAG',
            sourceUrl: 'https://snippet-only.example.org/x',
            quote: 'anything'
        }],
        judged: []
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT],
        evidenceBySourceUrl: { 'https://snippet-only.example.org/x': '只有摘要级别的短文本。' },
        materialUrls: ['https://snippet-only.example.org/x'],
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.ok(result.issues.some((i) => i.code === 'CLAIM_EVIDENCE_SNIPPET_ONLY' && i.blocking));
});

test('qualityGate.verifyClaims：标题孤证（normative 无引文）→ 不得通过', async () => {
    const llm = claimLlm({
        claims: [{
            unitTitle: '对比度阈值', id: 'claim-001', text: '大字号文本阈值为 3:1', kind: 'normative', scope: 'WCAG',
            sourceUrl: 'https://w3.example.org/contrast',
            quote: '' // 无引文
        }],
        judged: [{ id: 'claim-001', support: 'supported', reason: '独立判定说可以' }]
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT], evidenceBySourceUrl: EVIDENCE, materialUrls: Object.keys(EVIDENCE),
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.ok(result.issues.some((i) => i.code === 'CLAIM_NORMATIVE_WITHOUT_QUOTE' && i.blocking));
    assert.equal(result.allClaims[0].support, 'uncertain', '独立判定 supported 也不算数');
});

// ── 合并分类（T29） ──────────────────────────────────────────────────────

test('qualityGate.classifyMerge：source-only / content-revision / conflict', () => {
    const body = '对比度正文：普通文本 4.5:1。'.repeat(8);
    assert.equal(qualityGate.classifyMerge({ unit: { content: body }, targetCard: { content: body } }), 'source-only');
    const revised = '对比度正文：普通文本 4.5:1，并补充深色模式下的调整策略与更多实践细节说明。'.repeat(6);
    assert.equal(qualityGate.classifyMerge({ unit: { content: revised }, targetCard: { content: body } }), 'content-revision');
    // conflict 分支要求高相似但数值指纹分歧（§3.3.3：不得自动选"看起来更新"的）。
    const conflicted = '对比度正文：普通文本 3:1 即可，其余保持原样。'.repeat(8);
    const bodySameLen = '对比度正文：普通文本 4.5:1 即可，其余保持原样。'.repeat(8);
    assert.equal(qualityGate.classifyMerge({ unit: { content: conflicted }, targetCard: { content: bodySameLen } }), 'conflict');
    assert.equal(qualityGate.classifyMerge({ unit: { content: '' }, targetCard: { content: body } }), 'content-revision');
});

// ── 索引就绪门禁（§3.6.1 fail closed） ──────────────────────────────────

test('qualityGate.assertIndexReady：端口不可用 / 状态非 compatible / 队列未收敛 全部 fail closed', async () => {
    const probePort = (overrides = {}) => ({
        available: true,
        search: async () => [{ sourceFile: 'L/a.md' }],
        getInitializationStatus: () => ({ state: 'compatible', initialized: true }),
        pendingIngestCount: () => 0,
        ...overrides
    });

    const noPort = await qualityGate.assertIndexReady({ knowledgeStorePort: null, expectedFiles: ['L/a.md'], timeoutMs: 500 });
    assert.equal(noPort.ok, false);
    assert.match(noPort.reasons[0], /不可用/);

    const badState = await qualityGate.assertIndexReady({
        knowledgeStorePort: probePort({ getInitializationStatus: () => ({ state: 'rebuild_required', initialized: false }) }),
        expectedFiles: ['L/a.md'], timeoutMs: 500
    });
    assert.equal(badState.ok, false);
    assert.match(badState.reasons.join(' '), /rebuild_required/);

    const busyQueue = await qualityGate.assertIndexReady({
        knowledgeStorePort: probePort({ pendingIngestCount: () => 7 }),
        expectedFiles: ['L/a.md'], timeoutMs: 500
    });
    assert.equal(busyQueue.ok, false);
    assert.match(busyQueue.reasons.join(' '), /pending=7/);

    const unknownQueue = await qualityGate.assertIndexReady({
        knowledgeStorePort: probePort({ pendingIngestCount: () => null }),
        expectedFiles: ['L/a.md'], timeoutMs: 500
    });
    assert.equal(unknownQueue.ok, false);
    assert.match(unknownQueue.reasons.join(' '), /未知/);

    const ok = await qualityGate.assertIndexReady({
        knowledgeStorePort: probePort(), expectedFiles: ['L/a.md'], timeoutMs: 1000
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.probesPassed, 1);

    const neverHit = await qualityGate.assertIndexReady({
        knowledgeStorePort: probePort({ search: async () => [] }),
        expectedFiles: ['L/a.md'], timeoutMs: 600, pollIntervalMs: 200
    });
    assert.equal(neverHit.ok, false);
    assert.match(neverHit.reasons.join(' '), /探针未命中|超时/);

    const empty = await qualityGate.assertIndexReady({ knowledgeStorePort: probePort(), expectedFiles: [], timeoutMs: 300 });
    assert.equal(empty.ok, false, '零产物不构成索引就绪');
});

// ── T31：质量失败不关 gap 不推水位（D4） ────────────────────────────────

test('service：needs_review 批次不关闭缺口、档案记 completed_needs_review、水位保持', async () => {
    const { createForgeRuntimeService } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/service'));
    const { createJobRuntimeService } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/jobRuntimeService'));
    const { writeBlueprint } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/blueprint'));

    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-t31-'));
    const forgeRoot = path.join(baseDir, 'forge');
    await writeBlueprint(path.join(forgeRoot, 'blueprints', 'UIDesigner.json'), {
        name: 'UIDesigner', displayName: 'UI', scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [{ id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }],
        examOutline: [{ subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }],
        practicalExam: { prompt: 'p', gradingDimensions: ['d'] }, acceptanceSample: 'a'
    });

    // 一个合格单元 + 一个标题承诺不兑现的单元（七项清单只给两项）→ reviewCount>0。
    const distillJson = JSON.stringify({
        knowledgeUnits: [
            {
                type: 'concept', title: '深色模式配色策略', oneLiner: 'o',
                content: '深色模式配色以配色理论为基础：降低大面积背景明度，提升前景对比度，语义色按阈值校验。', tags: [],
                sourceUrls: ['https://fresh.example.com/new'], mergeInto: null
            },
            {
                type: 'checklist', title: '配色检查七项清单', oneLiner: 'o',
                content: '1. 对比度校验\n2. 色板一致性', tags: [],
                sourceUrls: ['https://fresh.example.com/new'], mergeInto: null
            }
        ],
        droppedSources: []
    });
    const jrs = createJobRuntimeService();
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => ({
                data: { choices: [{ message: { content: payload.messages[0].content.includes('知识蒸馏') ? distillJson : 'answer' } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }
            })
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: 'Color theory dark palette\nhttps://fresh.example.com/new\n配色理论深色模式实践。' }] })
        },
        knowledgeStorePort: {
            available: true, listLibraries: async () => ['UIDesigner知识库'],
            search: async () => {
                try {
                    return fs.readdirSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库')).map((f) => ({ sourceFile: `UIDesigner知识库/${f}` }));
                } catch { return []; }
            },
            getInitializationStatus: () => ({ state: 'compatible', initialized: true }),
            pendingIngestCount: () => 0
        },
        baseDir: forgeRoot,
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' }
    });

    const { gap } = await svc.reportGap({ agentId: 'UIDesigner', subskillId: 'color-theory', question: '深色模式配色', whyInsufficient: '查不到' });
    assert.equal(gap.status, 'open');
    const learn = await svc.startExpertLearnJob({ expertName: 'UIDesigner', scope: { subskillIds: ['color-theory'], reason: 'manual' } });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !jrs.pollJob(learn.jobId, null).data.job.terminal) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(jrs.pollJob(learn.jobId, null).data.job.terminal, true, 'learn 应终止');

    // D4/§3.6.3：存在 needs_review 项 → 缺口保持 open，档案非 completed，水位不推。
    const gaps = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'gaps.json'), 'utf8'));
    assert.equal(gaps[0].status, 'open', '质量失败不关闭学习缺口');
    const history = fs.readFileSync(path.join(forgeRoot, 'UIDesigner', 'learning-history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const entry = history[history.length - 1];
    assert.equal(entry.status, 'completed_needs_review');
    assert.equal(entry.waterAdvance, false);
    assert.ok(entry.reviewItems >= 1, '档案记录待复核项数');
    const water = await svc.gapRegistry.lastSuccessfulLearningAt('UIDesigner');
    assert.equal(water, null, '无成功批次时不推水位');
    fs.rmSync(baseDir, { recursive: true, force: true });
});


test('qualityGate.assertIndexReady：端口缺 getInitializationStatus 必须 fail closed（复审遗留补口）', async () => {
    const port = {
        available: true,
        search: async () => [{ sourceFile: 'L/a.md' }],
        pendingIngestCount: () => 0
        // 故意不提供 getInitializationStatus
    };
    const result = await qualityGate.assertIndexReady({ knowledgeStorePort: port, expectedFiles: ['L/a.md'], timeoutMs: 500 });
    assert.equal(result.ok, false);
    assert.match(result.reasons[0], /getInitializationStatus|未知/);
});

test('qualityGate.verifyClaims：确定性阻断 issue 携带 unitTitle（同批合格单元不连带，D4）', async () => {
    const llm = claimLlm({
        claims: [
            { unitTitle: '坏单元', id: 'claim-bad', text: 'x', kind: 'factual', scope: 'g', sourceUrl: 'https://not-in-batch.example.com/x', quote: 'q' },
            { unitTitle: '好单元', id: 'claim-good', text: 'y', kind: 'factual', scope: 'g', sourceUrl: 'https://w3.example.org/contrast', quote: 'contrast ratio of at least 4.5:1' }
        ],
        judged: [{ id: 'claim-good', support: 'supported', reason: 'ok' }]
    });
    const result = await qualityGate.verifyClaims({
        units: [{ title: '坏单元' }, { title: '好单元' }],
        evidenceBySourceUrl: EVIDENCE,
        materialUrls: Object.keys(EVIDENCE),
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    const badIssues = result.issues.filter((i) => i.unitTitle === '坏单元' && i.blocking);
    assert.ok(badIssues.length >= 1, '坏单元的阻断 issue 带 unitTitle');
    assert.ok(result.issues.every((i) => i.unitTitle !== '好单元' || !i.blocking), '好单元不被连带');
});

test('qualityGate.verifyClaims：低置信主张阻断（CLAIM_LOW_CONFIDENCE，§3.5.3 顺序 5）', async () => {
    const llm = claimLlm({
        claims: [{ unitTitle: '对比度阈值', id: 'claim-001', text: '大字号文本阈值', kind: 'normative', scope: 'WCAG', sourceUrl: 'https://w3.example.org/contrast', quote: 'contrast ratio of at least 4.5:1' }],
        judged: [{ id: 'claim-001', support: 'uncertain', reason: '证据与主张的对应关系不明确' }]
    });
    const result = await qualityGate.verifyClaims({
        units: [UNIT], evidenceBySourceUrl: EVIDENCE, materialUrls: Object.keys(EVIDENCE),
        llm, llmConfig: { url: 't', apiKey: 'k', model: 'm' }
    });
    assert.ok(result.issues.some((i) => i.code === 'CLAIM_LOW_CONFIDENCE' && i.blocking));
    assert.equal(result.allClaims[0].support, 'uncertain');
});

test('qualityGate.classifyMerge：单元为旧卡超集 → content-revision（不静默丢弃新增）', () => {
    const oldBody = '对比度正文：普通文本 4.5:1。'.repeat(8);
    const superset = oldBody + '新增小节：深色模式下的对比度调整策略与实现细节。'.repeat(4);
    assert.equal(qualityGate.classifyMerge({ unit: { content: superset } }, { targetCard: { content: oldBody } }), 'content-revision');
    // 反方向（单元⊂旧卡）仍可纯重复合并（截断子集，无新增主张；子集分支
    // 要求规范化正文 ≥200 字符，用足够长的旧卡验证）。
    const oldLong = '对比度正文：普通文本 4.5:1。'.repeat(60);
    const subset = oldLong.slice(0, Math.floor(oldLong.length * 0.5));
    // 注意单对象参数形制：classifyMerge({ unit, targetCard })。
    assert.equal(qualityGate.classifyMerge({ unit: { content: subset }, targetCard: { content: oldLong } }), 'source-only');
});
