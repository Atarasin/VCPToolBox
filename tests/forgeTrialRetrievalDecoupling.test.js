'use strict';

/**
 * M5.S1 检索作答分离测试（§3.7）：
 * 多关键词检索与错误分离、通行原则边界、高作答分低检索分总体不通过、
 * regrade legacy/unverified 标注。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const trial = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/trial'));

// ── blindSearch：多关键词 + 错误/零命中分离（§3.7 1/2） ──────────────────

test('blindSearch：遍历全部关键词并按标题去重合并', async () => {
    const calls = [];
    const port = {
        available: true,
        search: async (keyword) => {
            calls.push(keyword);
            if (keyword === '对比度') return [{ title: '对比度卡', text: '内容', sourceFile: 'L/a.md', score: 1 }];
            if (keyword === 'WCAG 键盘') return [{ title: '键盘卡', text: '内容', sourceFile: 'L/b.md', score: 1 }];
            return [];
        }
    };
    const { cards, queries, skipped } = await trial.blindSearch(port, 'L', ['对比度', 'WCAG 键盘', '无关词']);
    assert.equal(skipped, false);
    assert.deepEqual(calls, ['对比度', 'WCAG 键盘', '无关词'], '全部关键词都检索（不再只取 keywords[0]）');
    assert.equal(cards.length, 2);
    assert.deepEqual(queries.map((q) => [q.keyword, q.ok, q.hitCount]), [
        ['对比度', true, 1],
        ['WCAG 键盘', true, 1],
        ['无关词', true, 0]
    ]);
});

test('blindSearch：检索异常与真实零命中分开报告（不吞成无知识）', async () => {
    const port = {
        available: true,
        search: async (keyword) => {
            if (keyword === '坏词') {
                const error = new Error('store not ready');
                error.code = 'TDB_INGEST_NOT_READY';
                throw error;
            }
            return [];
        }
    };
    const { cards, queries } = await trial.blindSearch(port, 'L', ['坏词', '好词']);
    assert.equal(cards.length, 0);
    const failed = queries.find((q) => q.keyword === '坏词');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /TDB_INGEST_NOT_READY/);
    assert.equal(queries.find((q) => q.keyword === '好词').ok, true, '真实零命中（ok 但 hitCount 0）');
});

// ── 高作答分低检索分 → 总体不通过（§3.7 5，DoD） ────────────────────────

const { createForgeRuntimeService } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/service'));
const { createJobRuntimeService } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/jobRuntimeService'));
const { writeBlueprint } = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/blueprint'));

function blueprint() {
    return {
        name: 'UIDesigner', displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 视觉设计与配色'], boundaries: [] },
        subskills: [{ id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }],
        examOutline: [{ subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }],
        practicalExam: { prompt: 'p', gradingDimensions: ['d'] }, acceptanceSample: 'a'
    };
}

function fixedExam(keywords) {
    return JSON.stringify({
        questions: [
            { id: 'q1', subskillId: 'color-theory', kind: 'concept', prompt: '解释配色理论', gradingDimensions: ['correctness'], referencePoints: [], searchKeywords: [keywords[0]] },
            { id: 'q2', subskillId: 'color-theory', kind: 'applied', prompt: '应用配色理论', gradingDimensions: ['correctness'], referencePoints: [], searchKeywords: [keywords[1]] },
            { id: 'qp', subskillId: 'practical', kind: 'practical', prompt: '实操：给出配色方案', gradingDimensions: ['correctness'], referencePoints: [], searchKeywords: [keywords[0]] }
        ]
    });
}

// 判卷官动态回显：从判卷 prompt 里提取全部题号，全部满分；
// unsupportedOn 指定的那题带 unsupportedClaims。
function judgeOutput(prompt, unsupportedOn) {
    const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    const unique = [...new Set(ids)];
    return JSON.stringify({
        gradedQuestions: unique.map((id) => ({
            id,
            scores: { correctness: 5, completeness: 5, professionalism: 5, antiAiFlavor: 5, actionability: 5 },
            comment: id === unsupportedOn ? '含编造主张' : 'ok',
            citedKnowledgeCards: [],
            unsupportedClaims: id === unsupportedOn ? ['答卷声称 WCAG 要求 9.9:1（库内无此主张）'] : []
        })),
        overallComment: 'x'
    });
}

const FETCH_TEXT = '配色理论完整指南（证据归档全文）：色轮以色相环组织颜色，色相决定色系，饱和度决定纯度，明度决定深浅，三者构成配色坐标系。UI 配色先定品牌主色，再生成完整色阶，语义色沿用色板体系，对比度按 WCAG 阈值校验（普通文本 4.5:1，大字号 3:1）。深色模式先降大面积背景明度再提前景对比度。色彩可访问性不依赖纯色相传递信息。本全文超过取证链 200 字符最小阈值，用于证据归档与主张核验，确保 UrlFetch 首链成功并写入 evidence 目录。';

function buildM5Env({ baseDir, keywords, unsupportedOn }) {
    const forgeRoot = path.join(baseDir, 'forge');
    const jrs = createJobRuntimeService();
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                let output = 'answer';
                if (content.includes('你是出题官')) output = fixedExam(keywords);
                else if (content.includes('判卷官')) output = judgeOutput(content, unsupportedOn);
                else if (content.includes('知识主张提取器')) output = JSON.stringify({ claims: [] });
                else if (content.includes('独立主张核验员')) output = JSON.stringify({ judged: [] });
                else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    output = JSON.stringify({
                        knowledgeUnits: [{ type: 'concept', title: '配色理论卡', oneLiner: 'o', content: '配色理论以色轮、饱和度与明度构成色彩坐标系，指导 UI 配色与对比度校验。', tags: [], sourceUrls: ['https://a.com/x'], mergeInto: null }],
                        droppedSources: []
                    });
                } else if (content.includes('# 知识库检索结果')) output = '完整的满分答案：配色理论三属性构成坐标系。';
                return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
            }
        },
        toolInvokerPort: {
            invoke: async (toolName, args) => {
                const isFetch = ['UrlFetch', 'ChromeBridge'].includes(toolName) || args?.command === 'web_fetch' || args?.command === 'extract';
                if (isFetch) return { content: [{ type: 'text', text: FETCH_TEXT }] };
                return { content: [{ type: 'text', text: 'Color theory A\nhttps://a.com/x\n配色理论要点。' }] };
            }
        },
        knowledgeStorePort: {
            available: true, listLibraries: async () => ['UIDesigner知识库'],
            // 盲测关键词「未命中词」零命中；其余查询（就绪探针/命中词）回目录命中。
            search: async (query) => {
                if (String(query).includes('未命中词')) return [];
                try {
                    return fs.readdirSync(path.join(baseDir, 'knowledge', 'UIDesigner知识库'))
                        .map((f) => ({ sourceFile: `UIDesigner知识库/${f}`, text: f, score: 1 }));
                } catch { return []; }
            },
            getInitializationStatus: () => ({ state: 'compatible', initialized: true }),
            pendingIngestCount: () => 0
        },
        baseDir: forgeRoot,
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        // §3.8.1 红线 10：注册与策略路径全部临时化——synthesize 会写 agent_map、
        // guidance、knowledge/memory policy 与 recall profiles，缺省路径是
        // modules/agentGateway/config/ 的受控生产配置（本测试曾因此污染配置）。
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json'),
        memoryPolicyPath: path.join(baseDir, 'memory-policy.json'),
        recallProfilesPath: path.join(baseDir, 'recall-profiles.json')
    });
    return { jrs, svc, forgeRoot };
}

async function driveToTerminal(jrs, svc) {
    const { jobId } = await svc.startExpertCreateJob({ requirement: 'r', blueprintOverride: blueprint() });
    await new Promise((r) => setTimeout(r, 150));
    await svc.confirmBlueprint(jobId, { approved: true });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !jrs.pollJob(jobId, null).data.job.terminal) {
        await new Promise((r) => setTimeout(r, 100));
    }
    return jobId;
}

test('trial：高作答分但非实操题零核心命中 → 总体不通过且分数另报（§3.7 DoD）', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m5-'));
    await writeBlueprint(path.join(path.join(baseDir, 'forge'), 'blueprints', 'UIDesigner.json'), blueprint());
    const { jrs, svc, forgeRoot } = buildM5Env({ baseDir, keywords: ['命中词', '未命中词'], unsupportedOn: null });
    const jobId = await driveToTerminal(jrs, svc);

    const report = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'runs', jobId, 'exams', 'grade-report.json'), 'utf-8'));
    assert.equal(report.scorePassed, true, '作答分数本身达线');
    assert.equal(report.passed, false, '高作答分不得抵消检索失败');
    assert.equal(report.retrievalVerdict.coverageOk, false);
    assert.ok(report.retrievalVerdict.coverageFailures.some((f) => f.reason === 'zero-core（知识库零命中）'));
    const answers = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'runs', jobId, 'exams', 'answers.json'), 'utf-8'));
    const zeroCore = Object.entries(answers.retrievalEvidence).filter(([, e]) => e.zeroCore);
    assert.ok(zeroCore.length >= 1, '零核心证据可回放');
    assert.deepEqual(zeroCore[0][1].keywords, ['未命中词']);
    fs.rmSync(baseDir, { recursive: true, force: true });
});

test('trial：判卷官标记 unsupportedClaims → 总体不通过（§3.7 5）', async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-m5b-'));
    await writeBlueprint(path.join(path.join(baseDir, 'forge'), 'blueprints', 'UIDesigner.json'), blueprint());
    const { jrs, svc, forgeRoot } = buildM5Env({ baseDir, keywords: ['命中词', '命中词'], unsupportedOn: 'color-theory-q2' });
    const jobId = await driveToTerminal(jrs, svc);

    const report = JSON.parse(fs.readFileSync(path.join(forgeRoot, 'runs', jobId, 'exams', 'grade-report.json'), 'utf-8'));
    assert.equal(report.scorePassed, true);
    assert.equal(report.passed, false, 'unsupported claims 约束最终通过');
    assert.equal(report.retrievalVerdict.unsupportedClaimsFound, true);
    fs.rmSync(baseDir, { recursive: true, force: true });
});


// §3.8.2/§6.6：生产模板与内置 fallback 必须同步——判卷的 unsupportedClaims/
// 分别评价/general reference 指令若只存在于 fallback，生产运行时（loadTemplate
// 优先读 Agent/forge/templates/）将静默失去这些能力（M5 评审发现的假绿路径）。
test('模板同步：生产判卷模板含 unsupportedClaims/分别评价/general reference（防漂移）', () => {
    const template = fs.readFileSync(path.join(REPO_ROOT, 'Agent', 'forge', 'templates', 'grade.md'), 'utf8');
    assert.match(template, /unsupportedClaims/, '输出格式含 unsupportedClaims');
    assert.match(template, /通行原则/, '含分别评价库内依据/通行原则的指令');
    assert.match(template, /general reference/, '含 referencePoints 标注要求');
    assert.match(template, /retrievalEvidence|zeroCore|检索证据/, '含检索证据使用说明');
});
