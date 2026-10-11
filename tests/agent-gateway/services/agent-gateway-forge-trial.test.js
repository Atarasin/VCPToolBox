const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createForgeRuntimeService } = require('../../../modules/agentGateway/services/forge/service');
const { createJobRuntimeService, JOB_STATUS } = require('../../../modules/agentGateway/services/jobRuntimeService');

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trial-'));
}

function blueprint() {
    return {
        name: 'UIDesigner',
        displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] },
            { id: 'layout-typography', title: '版式与排版', searchQueries: ['layout typography'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 },
            { subskillId: 'layout-typography', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: { prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮', '去 AI 味', '可落地'] },
        acceptanceSample: '眼前一亮、去 AI 味的设计图'
    };
}

// 出题按生产路径分批：考纲条目调用（概念+应用，id 由模型自定 q1/q2）+
// 实操单独调用；合并时 collectQuestions 会按条目命名空间化（final id =
// <subskillId>-<rawId>），考卷不再因跨条目 id 冲突缩水（2026-10-11 修复）。
function entryExamJson(subskillId) {
    return JSON.stringify({
        questions: [
            { id: 'q1', subskillId, kind: 'concept', prompt: `解释${subskillId}核心概念`, referencePoints: ['要点'], searchKeywords: [subskillId] },
            { id: 'q2', subskillId, kind: 'applied', prompt: `为登录页应用${subskillId}`, referencePoints: ['品牌'], searchKeywords: [`${subskillId} 应用`] }
        ]
    });
}
const PRACTICAL_EXAM_JSON = JSON.stringify({
    questions: [
        { id: 'qp', subskillId: 'practical', kind: 'practical', prompt: 'SaaS 落地页设计方案（眼前一亮/去 AI 味/可落地）', gradingDimensions: ['眼前一亮', '去 AI 味', '可落地'], referencePoints: ['完整方案'], searchKeywords: ['落地页'] }
    ]
});
// 按 prompt 路由的出题输出：实操调用带专属范围注记；条目调用从考纲行解析 subskillId。
function scopeAwareExamOutput(content) {
    // 实操调用按其专属范围注记路由（两条注记在正式/fallback 模板下都逐字拼接）
    if (content.includes('【本次范围】只出 1 道 kind=practical')) {
        return PRACTICAL_EXAM_JSON;
    }
    const sub = (content.match(/- ([a-z0-9-]+)（/u) || [])[1] || 'color-theory';
    return entryExamJson(sub);
}

const DISTILL_JSON = JSON.stringify({
    knowledgeUnits: [{
        type: 'concept',
        title: '色轮与色彩三属性',
        oneLiner: '色相/饱和度/明度。',
        content: '色轮组织颜色……',
        tags: ['配色'],
        sourceUrls: ['https://a.com/x'],
        mergeInto: null
    }],
    droppedSources: []
});

// 判卷桩按卷面实际 id 出分（id 命名空间化后不硬编码；模板示例里的空 "id":"" 过滤掉）。
function gradeJson(ratio, prompt = '') {
    const score = Math.round(ratio * 5 * 2) / 2;
    const ids = [...String(prompt).matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    const useIds = ids.length > 0 ? ids : ['color-theory-q1', 'color-theory-q2', 'layout-typography-q1', 'layout-typography-q2', 'practical-qp'];
    const graded = useIds.map((id) => ({
        id,
        scores: { correctness: score, completeness: score, professionalism: score, antiAiFlavor: score, actionability: score },
        comment: '评语',
        citedKnowledgeCards: ['色轮与色彩三属性']
    }));
    return JSON.stringify({ gradedQuestions: graded, overallComment: '总评' });
}

function buildEnv(baseDir, { gradeRatio, gradeRatios = null, jevPort = null } = {}) {
    const jobRuntimeService = createJobRuntimeService();
    const llmCalls = [];
    const llmPort = {
        available: true,
        complete: async (config, payload) => {
            llmCalls.push(payload);
            // 按 prompt 内容路由：蒸馏 → 出题 → 盲测作答 → 判卷
            const content = payload.messages[0].content;
            let output;
            if (content.includes('出题官') || content.includes('考纲')) {
                output = scopeAwareExamOutput(content);
            } else if (content.includes('判卷官')) {
                // 支持分数序列：首考 → 重测（回填后同一套考题）
                output = gradeJson(gradeRatios && gradeRatios.length > 0 ? gradeRatios.shift() : gradeRatio, content);
            } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                output = DISTILL_JSON;
            } else {
                output = '这是基于知识卡的作答：色轮以色相环组织颜色，三属性为色相、饱和度、明度。';
            }
            return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 500, completion_tokens: 300 } } };
        }
    };
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        llmCompletionPort: llmPort,
        toolInvokerPort: {
            // 按子技能查询词返回不同域名集（避免跨子技能同域 2s 节流拖慢测试）
            invoke: async (toolName, args) => {
                const isLayout = String(args?.query || '').includes('layout');
                const text = isLayout
                    ? 'D\nhttps://d.dev/grid\ns\n\nE\nhttps://e.org/type\ns2\n\nF\nhttps://f.io/scale\ns3'
                    : 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3';
                return { content: [{ type: 'text', text }] };
            }
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: '色轮与色彩三属性', text: '色轮组织颜色……', score: 0.9 }]
        },
        jevPort,
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    return { jobRuntimeService, forgeRuntimeService, llmCalls };
}


async function waitForLearnJob(env, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const listed = env.jobRuntimeService.listJobs({ filters: { operationPrefix: 'forge.expert.learn' } }).data.jobs;
            if (listed.length > 0) {
                return listed[0].jobId;
            }
        } catch {
            // 轮询期竞态，忽略
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
}

async function waitFor(predicate, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

async function driveToTrial(env) {
    const { jobId } = await env.forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM);
    await env.forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.terminal);
    return jobId;
}

// 验收（M4.S1）：一份含每题得分、依据、缺口清单的验收报告落盘且用户可读。
test('trial：及格（80%）→ 报告落盘（JSON+markdown）→ pending_confirm 待用户抽查（D3）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const jobId = await driveToTrial(env);

    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'pending_confirm', `及格应停用户抽查，实际 ${job.status}`);
    assert.equal(job.metadata.forge.pendingConfirm.kind, 'trial-report');
    assert.ok(job.metadata.forge.pendingConfirm.reportPath.includes('grade-report.md'));

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    for (const file of ['exam.json', 'answers.json', 'grade-report.json', 'grade-report.md', 'comparison.json', 'gaps.json']) {
        assert.ok(fs.existsSync(path.join(examsDir, file)), `${file} 应落盘`);
    }
    const report = JSON.parse(fs.readFileSync(path.join(examsDir, 'grade-report.json'), 'utf8'));
    assert.equal(report.passed, true);
    assert.ok(Math.abs(report.ratio - 0.9) < 0.001);
    assert.deepEqual(report.gaps, []);
    const md = fs.readFileSync(path.join(examsDir, 'grade-report.md'), 'utf8');
    assert.match(md, /# UI 设计专家（UIDesigner）上岗验收报告/, '用户可读 markdown');
    assert.match(md, /## color-theory-q1（concept \/ color-theory）/, '每题得分章节');
    assert.match(md, /✅ 及格，待用户抽查/);
    assert.match(md, /引用知识卡/, '知识卡引用');

    // 用户抽查确认 → job 完成
    await env.forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'completed'), true);
});

test('trial：不及格 → 不推送用户（直接 completed）+ 缺口清单 + 自动发起定向回填 learn job', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.5 });
    const jobId = await driveToTrial(env);

    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'completed', `不及格不推送用户，job 完成，实际 ${job.status}`);

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const gaps = JSON.parse(fs.readFileSync(path.join(examsDir, 'gaps.json'), 'utf8'));
    // 考卷按考纲全覆盖（id 命名空间化后不再缩水）：两个子技能的题都判 0.5 → 双缺口
    assert.equal(gaps.gaps.length, 2);
    assert.deepEqual(gaps.gaps.map((gap) => gap.subskillId), ['color-theory', 'layout-typography']);
    assert.match(gaps.gaps[0].reason, /低于 80%/);

    // M4.S2 T1：缺口 → forge.expert.learn 定向任务（只补缺口）→ 采→炼→同套重测 全链路
    const learnJobId = await waitForLearnJob(env);
    assert.ok(learnJobId, '应自动创建 learn job');
    assert.equal(await waitFor(() => {
        const polled = env.jobRuntimeService.pollJob(learnJobId, null);
        return polled?.success && polled.data.job.terminal;
    }, 15000), true);
    const learnJob = env.jobRuntimeService.pollJob(learnJobId, null).data.job;
    assert.equal(learnJob.status, 'completed', `learn job 应完成（重测不及格不阻断），实际 ${learnJob.status}：${JSON.stringify(learnJob.metadata.forge?.error)}`);
    const learnRun = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', learnJobId, 'run.json'), 'utf8'));
    assert.deepEqual(learnRun.scope.subskillIds, ['color-theory', 'layout-typography']);
    assert.equal(learnRun.scope.reason, 'trial-failed-gap-backfill');
    assert.ok(learnRun.retestOf.examPath.includes('exams/exam.json'), '携带原考卷路径');
    // scope 过滤：只采缺口子技能的 raw（blueprint 第二子技能 layout-typography 不采）
    const rawDir = path.join(baseDir, 'forge', 'runs', learnJobId, 'raw');
    assert.deepEqual(fs.readdirSync(rawDir).sort(), ['color-theory', 'layout-typography'], '只采缺口子技能');
    // 同套重测留档
    const retestSummary = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', learnJobId, 'exams', 'retest-summary.json'), 'utf8'));
    assert.equal(retestSummary.retestOf, jobId);
    assert.ok(Math.abs(retestSummary.previousRatio - 0.5) < 0.001, '记录首考分数');
});

test('trial：Jev 对照（D7 方案 C）——LLM 与 Jev 分数双双留档 comparison.json', async () => {
    const baseDir = createTempDir();
    const jevCalls = [];
    const env = buildEnv(baseDir, {
        gradeRatio: 0.9,
        jevPort: {
            decide: async (state, questions) => {
                jevCalls.push({ state, questions });
                return {
                    answers: {
                        isProfessional: { choice: 'professional', probability: 0.88 },
                        isAiFlavored: { choice: 'none', probability: 0.72 },
                        isActionable: { choice: 'actionable', probability: 0.81 }
                    }
                };
            }
        }
    });
    const jobId = await driveToTrial(env);

    const comparison = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'comparison.json'), 'utf8'));
    assert.equal(comparison.llm.passed, true, 'LLM 分数留档');
    assert.equal(comparison.llm.gradedQuestions.length, 5);
    assert.equal(comparison.jev.skipped, false, 'Jev 判决留档');
    assert.equal(comparison.jev.decision.answers.isProfessional.choice, 'professional');
    assert.ok(comparison.note.includes('D7 方案 C'));
    assert.equal(jevCalls.length, 1);
    assert.ok(Object.keys(jevCalls[0].questions).includes('isAiFlavored'), '三维度类型化问题');
    assert.match(jevCalls[0].state.answers, /\[color-theory-q1\]/, 'state 含答卷摘要');
});

test('trial：jevPort 缺失 → comparison.json 记 skipped 原因，不阻断', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9, jevPort: null });
    const jobId = await driveToTrial(env);
    const comparison = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'comparison.json'), 'utf8'));
    assert.equal(comparison.jev.skipped, true);
    assert.match(comparison.jev.reason, /jevPort 未配置/);
});

test('trial：盲测作答上下文只含专属库知识卡（红线 1 白名单语义）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    await driveToTrial(env);
    // 作答调用（非出题/判卷）的 prompt 结构验证
    const answerCalls = env.llmCalls.filter((payload) => {
        const content = payload.messages[0].content;
        return content.includes('# 考题') && content.includes('# 知识库检索结果');
    });
    assert.ok(answerCalls.length >= 3, `每题一次盲测作答，实际 ${answerCalls.length}`);
    for (const payload of answerCalls) {
        const content = payload.messages[0].content;
        assert.ok(content.includes('色轮与色彩三属性'), '上下文注入知识卡');
        assert.ok(content.includes('唯一的专业资料来源'), '明示只用知识库');
        assert.ok(!content.includes('gateway_memory'), '无记忆工具');
    }
});

test('trial：回填后同一套考题重测弱项分数提升（M4.S2 验收）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.5, gradeRatios: [0.5, 0.9] });
    const jobId = await driveToTrial(env);
    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'completed', '首考不及格不推送用户');

    const learnJobId = await waitForLearnJob(env);
    assert.ok(learnJobId, '应自动创建 learn job');
    // 重测及格 → learn job 停在 pending_confirm 待用户抽查（D3）→ 确认后完成
    assert.equal(await waitFor(() => {
        const polled = env.jobRuntimeService.pollJob(learnJobId, null);
        return polled?.success && polled.data.job.status === 'pending_confirm';
    }, 15000), true, '重测及格应停用户抽查门禁');
    await env.forgeRuntimeService.confirmBlueprint(learnJobId, { approved: true });
    assert.equal(await waitFor(() => {
        const polled = env.jobRuntimeService.pollJob(learnJobId, null);
        return polled?.success && polled.data.job.terminal;
    }, 15000), true);

    const retestSummary = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', learnJobId, 'exams', 'retest-summary.json'), 'utf8'));
    assert.ok(Math.abs(retestSummary.previousRatio - 0.5) < 0.001, '首考 50%');
    assert.ok(Math.abs(retestSummary.ratio - 0.9) < 0.001, '重测 90%');
    assert.ok(retestSummary.improvement > 0, '弱项分数提升');
    assert.equal(retestSummary.passed, true, '重测及格');
    const retestMarker = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', learnJobId, 'steps', 'retest.json'), 'utf8'));
    assert.match(retestMarker.summary, /50\.0% → 90\.0%/);
    // 同一套考题：learn 的 exam 与首考考卷内容一致（retest 不重新出题）
    const learnExam = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', learnJobId, 'exams', 'answers.json'), 'utf8'));
    assert.ok(Object.keys(learnExam.answers).length >= 3, '重测作答全部题目');
});

test('trial：判卷输出不可解析时重试一次（logger 回归用例）', async () => {
    const baseDir = createTempDir();
    const jrs = createJobRuntimeService();
    let gradeCalls = 0;
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                let output;
                if (content.includes('出题官') || content.includes('考纲')) {
                    output = scopeAwareExamOutput(content);
                } else if (content.includes('判卷官')) {
                    gradeCalls += 1;
                    output = gradeCalls === 1 ? '判卷官无法输出 JSON 的抖动输出' : gradeJson(0.9, content);
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    output = DISTILL_JSON;
                } else {
                    output = 'answer';
                }
                return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
            }
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3' }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: 't', text: 'x', score: 1 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);
    const job = jrs.pollJob(jobId, null).data.job;
    // 判卷第一次垃圾 → 重试一次成功 → 应及格停在用户抽查（若 logger 未解构会以 INTERNAL 失败）
    assert.equal(job.status, 'pending_confirm', `判卷重试后应正常完成，实际 ${job.status}：${job.metadata.forge.error?.message}`);
    assert.equal(gradeCalls, 2, '判卷恰好两次');
});

test('learn：scope 未命中任何子技能报 FORGE_SCOPE_EMPTY', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'forge', 'blueprints', 'UIDesigner.json'), blueprint());
    // scope 未命中在 harvest 步骤报错（job 异步失败，不抛到调用方）
    await env.forgeRuntimeService.startExpertLearnJob({ expertName: 'UIDesigner', scope: { subskillIds: ['not-exist'] } });
    await waitFor(() => {
        const listed = env.jobRuntimeService.listJobs({ filters: { operationPrefix: 'forge.expert.learn' } }).data.jobs;
        const learn = listed[0];
        return learn && learn.terminal;
    }, 8000);
    const learn = env.jobRuntimeService.listJobs({ filters: { operationPrefix: 'forge.expert.learn' } }).data.jobs[0];
    const detail = env.jobRuntimeService.pollJob(learn.jobId, null).data.job;
    assert.equal(detail.status, 'failed');
    assert.equal(detail.metadata.forge.error.code, 'FORGE_SCOPE_EMPTY');
});

test('retest：回填重测不重新出题（出题官调用次数为 0）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.5, gradeRatios: [0.5, 0.9] });
    const jobId = await driveToTrial(env);
    const examinerCallsBefore = env.llmCalls.filter((p) => p.messages[0].content.includes('出题官') || p.messages[0].content.includes('考纲')).length;
    assert.ok(examinerCallsBefore >= 1, '首考出题至少一次');

    const learnJobId = await waitForLearnJob(env);
    assert.ok(learnJobId);
    await waitFor(() => {
        const polled = env.jobRuntimeService.pollJob(learnJobId, null);
        return polled?.success && polled.data.job.status === 'pending_confirm';
    }, 15000);
    await env.forgeRuntimeService.confirmBlueprint(learnJobId, { approved: true });
    await waitFor(() => {
        const polled = env.jobRuntimeService.pollJob(learnJobId, null);
        return polled?.success && polled.data.job.terminal;
    }, 15000);

    const examinerCallsAfter = env.llmCalls.filter((p) => p.messages[0].content.includes('出题官') || p.messages[0].content.includes('考纲')).length;
    assert.equal(examinerCallsAfter, examinerCallsBefore, '回填重测全程零出题调用（同一套考题）');
    // 同一套考题：重测作答题目数与首考一致（retest 复用原卷，不重新出题）
    const learnAnswers = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', learnJobId, 'exams', 'answers.json'), 'utf8'));
    assert.equal(Object.keys(learnAnswers.answers).length, 5, '重测作答全部 5 题');
    const retestSummary2 = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', learnJobId, 'exams', 'retest-summary.json'), 'utf8'));
    assert.ok(retestSummary2.retestOf, '重测关联原 job');
    void jobId;
});

// ── 2026-10-11 事故回归：出题整卷单次输出顶满 max_tokens 被截断（completion
// 恰为上限 6000 ×2），同 prompt 重试必然再截。分批出题 + 截断抢救 + 3 次尝试。────

function buildTrialParseEnv(baseDir, { examOutput, examFinishReason = null, gradeOutput } = {}) {
    const jrs = createJobRuntimeService();
    const llmCalls = [];
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                llmCalls.push(payload);
                const content = payload.messages[0].content;
                let output;
                let finishReason = null;
                if (content.includes('出题官') || content.includes('考纲')) {
                    output = typeof examOutput === 'function' ? examOutput(content) : (examOutput || scopeAwareExamOutput(content));
                    finishReason = examFinishReason;
                } else if (content.includes('判卷官')) {
                    output = typeof gradeOutput === 'function' ? gradeOutput(content) : (gradeOutput || gradeJson(0.9, content));
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    output = DISTILL_JSON;
                } else {
                    output = 'answer';
                }
                return {
                    data: {
                        choices: [{ message: { content: output }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
                        usage: { prompt_tokens: 1, completion_tokens: 1 }
                    }
                };
            }
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3' }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: 't', text: 'x', score: 1 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    return { jrs, svc, llmCalls };
}

async function driveInlineToTerminal(jrs, svc) {
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);
    return jobId;
}

test('trial：出题输出被截断 → 抢救完整题目继续（分批出题不放大截断面）', async () => {
    const baseDir = createTempDir();
    // 只截断 color-theory 条目的输出（在 q2 题干中途切断）：该条目 q1 完整可
    // 抢救、q2 丢失；其余条目与实操题输出完整——考卷缩为 4 题而非 1 题。
    const truncatedEntry = entryExamJson('color-theory').slice(0, entryExamJson('color-theory').indexOf('为登录页应用color-theory') + 3);
    assert.ok(!truncatedEntry.trim().endsWith('}'), '模拟输出应是非完整 JSON');
    const { jrs, svc } = buildTrialParseEnv(baseDir, {
        examOutput: (content) => (content.includes('- color-theory（') ? truncatedEntry : scopeAwareExamOutput(content)),
        examFinishReason: 'length',
        gradeOutput: gradeJson(0.9)
    });
    const jobId = await driveInlineToTerminal(jrs, svc);
    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'pending_confirm', `抢救后 trial 应完成（判卷 0.9 及格），实际 ${job.status}：${job.metadata.forge.error?.message}`);

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const exam = JSON.parse(fs.readFileSync(path.join(examsDir, 'exam.json'), 'utf8'));
    assert.equal(exam.questions.length, 4, '截断条目只损失被切开的 q2，其余条目完整保留');
    assert.ok(exam.questions.some((q) => q.id === 'color-theory-q1'), '抢救出的完整题保留');
    assert.ok(!exam.questions.some((q) => q.id === 'color-theory-q2'), '被截断的 q2 丢弃');
    assert.ok(exam.questions.some((q) => q.id === 'practical-qp'), '实操题完整');
    assert.ok(!fs.existsSync(path.join(baseDir, 'forge', 'runs', jobId, 'trial-failed')), '抢救成功不留失败档');
});

test('trial：判卷缺失题目不静默——总评注明缺失题号并按 0 分计', async () => {
    const baseDir = createTempDir();
    // 按卷面 id 只判前 4 题（5 题考卷缺末题 practical-qp）
    const scoreFull = { correctness: 4.5, completeness: 4.5, professionalism: 4.5, antiAiFlavor: 4.5, actionability: 4.5 };
    const partialGrade = (content) => {
        const ids = [...content.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
        return JSON.stringify({
            gradedQuestions: ids.slice(0, -1).map((id) => ({ id, scores: scoreFull, comment: '评语', citedKnowledgeCards: [] })),
            overallComment: '总评'
        });
    };
    const { jrs, svc } = buildTrialParseEnv(baseDir, {
        gradeOutput: partialGrade
    });
    const jobId = await driveInlineToTerminal(jrs, svc);
    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'completed', '缺失两题按 0 分 → 总分不及格 → 直接完成');

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const report = JSON.parse(fs.readFileSync(path.join(examsDir, 'grade-report.json'), 'utf8'));
    assert.ok(Math.abs(report.ratio - 0.72) < 0.001, `4 题 90% + 缺失 1 题 0 分 → 72%，实际 ${report.ratio}`);
    assert.match(report.grading.overallComment, /判卷缺失 1 题：practical-qp/);
    const md = fs.readFileSync(path.join(examsDir, 'grade-report.md'), 'utf8');
    assert.match(md, /判卷缺失 1 题/);
});

test('retrial：已注册专家仅重跑 trial——不采集不合成不触发重名冲突', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'forge', 'blueprints', 'UIDesigner.json'), blueprint());

    // 画像缺失 → 404
    await assert.rejects(
        () => env.forgeRuntimeService.startExpertRetrialJob({ expertName: 'NotForged' }),
        (error) => error.status === 404
    );

    const { jobId } = await env.forgeRuntimeService.startExpertRetrialJob({ expertName: 'UIDesigner' });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'pending_confirm'), true,
        '判卷及格 → 待用户抽查');
    const run = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', jobId, 'run.json'), 'utf8'));
    assert.equal(run.jobKind, 'expert.retrial');
    assert.equal(run.expertName, 'UIDesigner');
    const stepsDir = path.join(baseDir, 'forge', 'runs', jobId, 'steps');
    assert.deepEqual(fs.readdirSync(stepsDir), ['trial.json'], '只有 trial 一步');
    assert.ok(!fs.existsSync(path.join(baseDir, 'forge', 'runs', jobId, 'raw')), 'retrial 不采集');
    assert.ok(fs.existsSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'exam.json')), '考卷落盘');

    await env.forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'completed'), true);
    const summary = (await env.forgeRuntimeService.listJobs()).find((job) => job.jobId === jobId);
    assert.equal(summary.type, 'retrial');
});

// ── 盲测作答弹性回归（2026-10-11 补考实测：两题正文为空被判 0 分"未作答"、
// 一题答卷中途截断 56 分——推理型模型把输出预算耗在推理段 + max_tokens=3000 太小）。

test('trial：盲测作答弹性——空正文重试/推理段兜底/作答失败不入缺口/截断标注', async () => {
    const baseDir = createTempDir();
    const jrs = createJobRuntimeService();
    const answerCalls = {};   // qid -> 次
    const answerPrompts = []; // 每次作答调用的 prompt（校验重试带直接输出指令）
    // 判卷只有 q2 低分（0.5）：q2 是 empty 作答失败 → 不应计入缺口 →
    // 无弱项缺口 → 不触发自动回填 learn（答题调用计数稳定在本轮试岗）。
    const scores = (ratio) => ({ correctness: ratio * 5, completeness: ratio * 5, professionalism: ratio * 5, antiAiFlavor: ratio * 5, actionability: ratio * 5 });
    const mixedGrade = JSON.stringify({
        gradedQuestions: [
            { id: 'color-theory-q1', scores: scores(0.9), comment: 'ok', citedKnowledgeCards: [] },
            { id: 'color-theory-q2', scores: scores(0.5), comment: '未作答', citedKnowledgeCards: [] },
            { id: 'layout-typography-q1', scores: scores(0.9), comment: 'ok', citedKnowledgeCards: [] },
            { id: 'layout-typography-q2', scores: scores(0.9), comment: 'ok', citedKnowledgeCards: [] },
            { id: 'practical-qp', scores: scores(0.9), comment: 'ok', citedKnowledgeCards: [] }
        ],
        overallComment: '总评'
    });
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                let message = { content: 'answer' };
                let finishReason = null;
                if (content.includes('# 知识库检索结果')) {
                    const qid = (content.match(/# 考题（(.*?)）/u) || [])[1] || '?';
                    answerCalls[qid] = (answerCalls[qid] || 0) + 1;
                    answerPrompts.push(content);
                    const attempt = answerCalls[qid];
                    if (qid === 'color-theory-q1') {
                        // 空正文一次 → 重试成功
                        message = attempt === 1
                            ? { content: '' }
                            : { content: '完整答案：色轮以色相环组织颜色，三属性为色相、饱和度、明度。' };
                        if (attempt === 1) finishReason = 'length';
                    } else if (qid === 'color-theory-q2') {
                        // 两轮空且无推理段 → 作答失败（不入缺口）
                        message = { content: '' };
                        finishReason = 'length';
                    } else if (qid === 'practical-qp') {
                        // 两轮都有正文但都被截断 → truncated 标注
                        message = { content: `部分评审内容（第 ${attempt} 轮）` };
                        finishReason = 'length';
                    }
                } else if (content.includes('出题官') || content.includes('考纲')) {
                    message = { content: scopeAwareExamOutput(content) };
                } else if (content.includes('判卷官')) {
                    message = { content: mixedGrade };
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    message = { content: DISTILL_JSON };
                }
                return {
                    data: {
                        choices: [{ message, ...(finishReason ? { finish_reason: finishReason } : {}) }],
                        usage: { prompt_tokens: 1, completion_tokens: 1 }
                    }
                };
            }
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3' }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: 't', text: 'x', score: 1 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const answersFile = JSON.parse(fs.readFileSync(path.join(examsDir, 'answers.json'), 'utf8'));

    // color-theory-q1：空正文一次 → 带直接输出指令重试成功（无 issue 留痕）
    assert.equal(answerCalls['color-theory-q1'], 2, 'color-theory-q1 恰好两次作答调用');
    assert.match(answersFile.answers['color-theory-q1'], /完整答案/);
    assert.equal(answersFile.answerMeta['color-theory-q1'], undefined, '重试成功不留 issue');

    // color-theory-q2：两轮皆空 → 作答失败留痕，且不计入缺口（执行面问题 ≠ 知识缺口）
    assert.equal(answersFile.answerMeta['color-theory-q2'].issue, 'empty');
    const gaps = JSON.parse(fs.readFileSync(path.join(examsDir, 'gaps.json'), 'utf8'));
    assert.ok(!gaps.gaps.some((gap) => gap.reason.includes('color-theory-q2')), '作答失败题不触发知识回填缺口');

    // practical-qp：两轮截断 → truncated 留痕
    assert.equal(answersFile.answerMeta['practical-qp'].issue, 'truncated');
    assert.match(answersFile.answers['practical-qp'], /第 2 轮/);

    // 重试调用必须带「直接输出正文」强指令
    const retryPrompts = answerPrompts.filter((p) => p.includes('【输出要求】'));
    assert.ok(retryPrompts.length >= 3, `三道注入题的重试都应带直接输出指令，实际 ${retryPrompts.length}`);

    // 判卷 prompt 携带异常注记；报告显式标注
    const marker = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', jobId, 'steps', 'trial.json'), 'utf8'));
    assert.match(marker.summary, /作答异常 2 题（color-theory-q2:empty、practical-qp:truncated）/);
    const md = fs.readFileSync(path.join(examsDir, 'grade-report.md'), 'utf8');
    assert.match(md, /⚠️ 作答失败（模型未输出正文，非知识缺口）/);
    assert.match(md, /⚠️ 答卷被输出上限截断/);
});

test('trial：两轮空正文但推理段可用 → 以推理段兜底作答并显式标注', async () => {
    const baseDir = createTempDir();
    const jrs = createJobRuntimeService();
    let q1Calls = 0;
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                let message = { content: 'answer' };
                let finishReason = null;
                if (content.includes('# 知识库检索结果')) {
                    const qid = (content.match(/# 考题（(.*?)）/u) || [])[1] || '?';
                    if (qid === 'color-theory-q1') {
                        q1Calls += 1;
                        message = { content: '', reasoning_content: '推理段：色轮以色相环组织颜色，三属性为色相、饱和度、明度……' };
                        finishReason = 'length';
                    }
                } else if (content.includes('出题官') || content.includes('考纲')) {
                    message = { content: scopeAwareExamOutput(content) };
                } else if (content.includes('判卷官')) {
                    message = { content: gradeJson(0.9, content) };
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    message = { content: DISTILL_JSON };
                }
                return {
                    data: {
                        choices: [{ message, ...(finishReason ? { finish_reason: finishReason } : {}) }],
                        usage: { prompt_tokens: 1, completion_tokens: 1 }
                    }
                };
            }
        },
        toolInvokerPort: {
            invoke: async () => ({ content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3' }] })
        },
        knowledgeStorePort: {
            available: true,
            listLibraries: async () => ['UIDesigner知识库'],
            search: async () => [{ title: 't', text: 'x', score: 1 }]
        },
        baseDir: path.join(baseDir, 'forge'),
        knowledgeRoot: path.join(baseDir, 'knowledge'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    for (const [file, content] of [
        ['agent_map.json', '{}'],
        ['policy.json', JSON.stringify({ restrictedLibraries: {} })],
        ['guidance.json', JSON.stringify({ version: 1, shared: { workflow: [], memoryWritePolicy: { write: [], skip: [] } }, agents: {} })]
    ]) {
        fs.writeFileSync(path.join(baseDir, file), content);
    }
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);

    assert.equal(q1Calls, 2, '正文为空先重试一次再兜底');
    const answersFile = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'answers.json'), 'utf8'));
    assert.match(answersFile.answers['color-theory-q1'], /推理段：色轮/);
    assert.equal(answersFile.answerMeta['color-theory-q1'].issue, 'reasoning-only');
    const md = fs.readFileSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.md'), 'utf8');
    assert.match(md, /⚠️ 以推理段作答（正文未输出）/);
});

// 2026-10-11 第二代回归：跨条目 id 冲突曾把 13 题考卷静默缩水成 5 题（模型
// 在每条目输出里都自复用 q1/q2，按 id 去重吞掉整个子技能），两次补考覆盖的
// 子技能随机漂移、进度不可比——id 按考纲条目命名空间化后考卷必须全量覆盖。
test('trial：考卷按考纲全量覆盖——每条目概念+应用+实操各就位，id 命名空间唯一', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const jobId = await driveToTrial(env);
    const exam = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'exam.json'), 'utf8'));
    const ids = exam.questions.map((q) => q.id);
    assert.deepEqual(ids, [
        'color-theory-q1', 'color-theory-q2',
        'layout-typography-q1', 'layout-typography-q2',
        'practical-qp'
    ], '考纲每条目 2 题 + 实操 1 题，id 按条目命名空间化');
    for (const question of exam.questions) {
        assert.match(question.id, question.kind === 'practical' ? /^practical-/ : new RegExp(`^${question.subskillId}-`));
    }
});
