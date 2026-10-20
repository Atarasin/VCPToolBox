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

function buildEnv(baseDir, { gradeRatio, gradeRatios = null, jevPort = null, knowledgeStoreOverrides = null, llmDelayMs = 0, gradeOutputFn = null } = {}) {
    const jobRuntimeService = createJobRuntimeService();
    const llmCalls = [];
    const llmPort = {
        available: true,
        complete: async (config, payload) => {
            llmCalls.push(payload);
            if (llmDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, llmDelayMs));
            }
            // 按 prompt 内容路由：起草画像 → 蒸馏 → 出题 → 盲测作答 → 判卷
            const content = payload.messages[0].content;
            let output;
            if (content.includes('专家铸造师')) {
                output = JSON.stringify(blueprint());
            } else if (content.includes('出题官') || content.includes('考纲')) {
                output = scopeAwareExamOutput(content);
            } else if (content.includes('判卷官')) {
                // 支持分数序列：首考 → 重测（回填后同一套考题）；gradeOutputFn
                // 供用例注入「丢题/截断」等判卷形态（缺陷 4 场景）。
                output = typeof gradeOutputFn === 'function'
                    ? gradeOutputFn(content)
                    : gradeJson(gradeRatios && gradeRatios.length > 0 ? gradeRatios.shift() : gradeRatio, content);
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
            search: async () => [{ title: '色轮与色彩三属性', text: '色轮组织颜色……', score: 0.9 }],
            ...(knowledgeStoreOverrides || {})
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
        assert.ok(!content.includes('gateway_recall_run'), '无召回工具');
        assert.ok(!content.includes('# 工作日志纪律'), '工作日志章节整章剥除（上岗后才适用的指令不进考场）');
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

test('trial：判卷缺失题显式失败 FORGE_GRADE_MISSING——绝不静默按 0 分计（缺陷 4 ①）', async () => {
    const baseDir = createTempDir();
    // 按卷面 id 永远漏判末题（5 题考卷缺 practical-qp，补判轮也漏——模拟持续丢题）
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
    assert.equal(job.status, 'failed', '判卷缺失即显式失败，不产出被 0 分稀释的成绩');
    assert.equal(job.metadata.forge.error.code, 'FORGE_GRADE_MISSING');
    assert.ok(job.metadata.forge.error.message.includes('practical-qp'), '错误点名缺失题');
    // 答卷已落盘——补判（forge.regrade）有原料，无需整卷重考。
    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const saved = JSON.parse(fs.readFileSync(path.join(examsDir, 'answers.json'), 'utf8'));
    assert.equal(Object.keys(saved.answers || {}).length, 5, '五题答卷完整保存');
    assert.ok(!fs.existsSync(path.join(examsDir, 'grade-report.json')), '不再产出按 0 分计的成绩单');
});

// 2026-10-17（缺陷 4 加固）：块判卷整体不可用时按题拆半重判——此前一块判不动
// 就让整单失败（10-12 事故：判卷第 3/3 块正文为空，已花 ¥0.55 的整单报废）。
test('trial：判卷整块输出不可用时拆半重判，成绩仍完整', async () => {
    const baseDir = createTempDir();
    const gradeOutput = (content) => {
        const uniqueIds = new Set([...content.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean));
        // 5 题整块：正文为空（模型把输出预算耗在推理段）；拆到 ≤3 题才正常判卷。
        return uniqueIds.size > 3 ? '' : gradeJson(0.9, content);
    };
    const { jrs, svc, llmCalls } = buildTrialParseEnv(baseDir, { gradeOutput });
    const jobId = await driveInlineToTerminal(jrs, svc);
    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'pending_confirm', `拆半重判后应完成，实际 ${job.status}：${job.metadata.forge.error?.message}`);

    const examsDir = path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const report = JSON.parse(fs.readFileSync(path.join(examsDir, 'grade-report.json'), 'utf8'));
    assert.equal(report.grading.gradedQuestions.length, 5, '拆半重判拼出完整成绩（5 题）');
    // 整块的失败尝试已留档（5 题块：8k → 32k → 32k 三次尝试）
    const failedDir = path.join(baseDir, 'forge', 'runs', jobId, 'trial-failed');
    const dumps = fs.readdirSync(failedDir).filter((name) => name.startsWith('grade-chunk-1.attempt-')).sort();
    assert.equal(dumps.length, 3, `整块失败留档三次尝试，实际 ${dumps.length}`);
    const budgets = llmCalls.filter((call) => call.messages[0].content.includes('判卷官')).map((call) => call.max_tokens);
    assert.ok(budgets.includes(32000), '判卷正文为空时抬预算重试（8k → 32k）');
});

test('trial：判卷全块正文为空 → FORGE_LLM_EMPTY_CONTENT（不空转补判轮）', async () => {
    const baseDir = createTempDir();
    const { jrs, svc } = buildTrialParseEnv(baseDir, { gradeOutput: () => '' });
    const jobId = await driveInlineToTerminal(jrs, svc);
    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_LLM_EMPTY_CONTENT');
    assert.equal(job.metadata.forge.error.step, 'trial');
    assert.match(job.metadata.forge.error.message, /正文为空/);
    assert.ok(!fs.existsSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.json')), '不产出成绩单');
    // 答卷已留盘：补判/重考有原料
    const saved = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'answers.json'), 'utf8'));
    assert.equal(Object.keys(saved.answers || {}).length, 5);
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

// ── P1.1 完整性门禁与考卷元数据（残卷曾以完整卷外观流出两轮无效成绩）──────

test('trial：残卷被完整性门禁拦截——FORGE_EXAM_INCOMPLETE，不进入评分，残卷留盘取证', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    // 劫持出题：layout-typography 条目返回的题目挂错 subskillId → 该条目零覆盖
    const originalComplete = env.forgeRuntimeService;
    const examsDirOf = (jobId) => path.join(baseDir, 'forge', 'runs', jobId, 'exams');
    const jrs = env.jobRuntimeService;
    // 用独立桩替换：直接再建一个 service 太重——改用 buildEnv 的 llm 输出不可注入，
    // 因此这里内联最小环境（出题仅覆盖 color-theory，实操正常）。
    const svc = createForgeRuntimeService({
        jobRuntimeService: jrs,
        llmCompletionPort: {
            available: true,
            complete: async (config, payload) => {
                const content = payload.messages[0].content;
                let output;
                if (content.includes('出题官') || content.includes('考纲')) {
                    if (content.includes('【本次范围】只出 1 道 kind=practical')) {
                        output = PRACTICAL_EXAM_JSON;
                    } else if (content.includes('- layout-typography（')) {
                        // 题目挂错 subskillId → layout-typography 条目零覆盖
                        output = entryExamJson('color-theory');
                    } else {
                        output = entryExamJson('color-theory');
                    }
                } else if (content.includes('判卷官')) {
                    output = gradeJson(0.9, content);
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    output = DISTILL_JSON;
                } else {
                    output = 'ans';
                }
                return { data: { choices: [{ message: { content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
            }
        },
        toolInvokerPort: { async invoke() { return { content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns' }] }; } },
        knowledgeStorePort: { available: true, listLibraries: async () => ['UIDesigner知识库'], search: async () => [{ title: 't', text: 'x', score: 1 }] },
        baseDir: path.join(baseDir, 'forge2'),
        knowledgeRoot: path.join(baseDir, 'knowledge2'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        agentMapPath: path.join(baseDir, 'agent_map.json'),
        knowledgePolicyPath: path.join(baseDir, 'policy.json'),
        guidanceConfigPath: path.join(baseDir, 'guidance.json')
    });
    const { jobId } = await svc.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        blueprintOverride: blueprint()
    });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal), true);

    const job = jrs.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_EXAM_INCOMPLETE');
    assert.equal(job.metadata.forge.error.step, 'trial');
    assert.match(job.metadata.forge.error.message, /缺失：layout-typography/);

    const examsDir = path.join(baseDir, 'forge2', 'runs', jobId, 'exams');
    const exam = JSON.parse(fs.readFileSync(path.join(examsDir, 'exam.json'), 'utf8'));
    assert.equal(exam.meta.incomplete, true, '残卷留盘取证');
    assert.ok(!fs.existsSync(path.join(examsDir, 'grade-report.md')), '残卷不进入评分');
    assert.ok(!fs.existsSync(path.join(examsDir, 'answers.json')), '残卷不作答');
    void env; void originalComplete;
});

test('trial：完整考卷带元数据——exam.json meta + 报告考卷行 + 步骤 summary/状态', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const jobId = await driveToTrial(env);
    const runDir = path.join(baseDir, 'forge', 'runs', jobId);
    const exam = JSON.parse(fs.readFileSync(path.join(runDir, 'exams', 'exam.json'), 'utf8'));
    assert.equal(exam.meta.questionCount, 5);
    assert.deepEqual(exam.meta.coveredSubskills, ['color-theory', 'layout-typography']);
    assert.equal(exam.meta.practicalIncluded, true);
    assert.deepEqual(exam.meta.degradedEntries, []);
    assert.match(exam.meta.examHash, /^[a-f0-9]{16}$/);

    const md = fs.readFileSync(path.join(runDir, 'exams', 'grade-report.md'), 'utf8');
    assert.match(md, /- 考卷：5 题 \/ 覆盖 2\/2 子技能 \/ 哈希 [a-f0-9]{16}/);

    // 检索归因（反馈 3）：每题记录当时检索命中的知识卡，报告逐题可查
    const answersFile = JSON.parse(fs.readFileSync(path.join(runDir, 'exams', 'answers.json'), 'utf8'));
    assert.deepEqual(answersFile.retrievals['color-theory-q1'], ['色轮与色彩三属性']);
    assert.match(md, /\*\*检索命中\*\*：色轮与色彩三属性/);

    const marker = JSON.parse(fs.readFileSync(path.join(runDir, 'steps', 'trial.json'), 'utf8'));
    assert.equal(marker.state.examMeta.questionCount, 5);
    assert.match(marker.summary, /考卷 5 题覆盖 2\/2 子技能（哈希 [a-f0-9]{8}）/);
});

// ── P1.3 索引就绪闸门：队列未清空 → 等待；超时 → 放行但显式告警 ────────────

test('trial：TDB 队列短时未清空 → 等待后开考（无告警）；持续未清空 → 超时放行并告警', async () => {
    const previousTimeout = process.env.FORGE_INDEX_READINESS_TIMEOUT_MS;
    const previousInterval = process.env.FORGE_INDEX_READINESS_INTERVAL_MS;
    process.env.FORGE_INDEX_READINESS_TIMEOUT_MS = '150';
    process.env.FORGE_INDEX_READINESS_INTERVAL_MS = '40';
    const baseDir = createTempDir();
    let pending = 3;
    const env = buildEnv(baseDir, {
        gradeRatio: 0.9,
        knowledgeStoreOverrides: {
            pendingIngestCount: () => pending
        }
    });
    // 队列两次轮询后归零 → 正常开考
    setTimeout(() => { pending = 0; }, 100);
    const jobId = await driveToTrial(env);
    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'pending_confirm', '队列清零后正常开考');
    const marker = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'steps', 'trial.json'), 'utf8'));
    assert.equal(marker.state.indexReadiness.ready, true);
    assert.ok(!marker.summary.includes('索引队列未清空'));

    // 持续未清空 → 超时放行 + summary/报告告警
    const baseDir2 = createTempDir();
    const env2 = buildEnv(baseDir2, {
        gradeRatio: 0.9,
        knowledgeStoreOverrides: { pendingIngestCount: () => 7 }
    });
    const jobId2 = await driveToTrial(env2);
    const runDir2 = path.join(baseDir2, 'forge', 'runs', jobId2);
    const marker2 = JSON.parse(fs.readFileSync(path.join(runDir2, 'steps', 'trial.json'), 'utf8'));
    assert.match(marker2.summary, /⚠️ 开考时索引队列未清空（剩余 7 项）/);
    assert.equal(marker2.state.indexReadiness.ready, false);
    const md = fs.readFileSync(path.join(runDir2, 'exams', 'grade-report.md'), 'utf8');
    assert.match(md, /开考时索引队列未清空（剩余 7 项）/, '报告头显式告警');

    if (previousTimeout === undefined) delete process.env.FORGE_INDEX_READINESS_TIMEOUT_MS;
    else process.env.FORGE_INDEX_READINESS_TIMEOUT_MS = previousTimeout;
    if (previousInterval === undefined) delete process.env.FORGE_INDEX_READINESS_INTERVAL_MS;
    else process.env.FORGE_INDEX_READINESS_INTERVAL_MS = previousInterval;
});

// ── P2.4 步内心跳：长步骤期间作业记录的 updatedAt/进度/费用不再冻结 ─────────

test('driveJob：步内心跳——长步骤执行中作业元数据持续刷新（heartbeatAt）', async () => {
    const previous = process.env.FORGE_STEP_HEARTBEAT_MS;
    process.env.FORGE_STEP_HEARTBEAT_MS = '10';
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9, llmDelayMs: 200 });
    // 不传 blueprintOverride：blueprint 步经 LLM 起草（每次调用延迟 200ms），
    // 10ms 心跳在该步执行期间应多次刷新作业元数据。
    const { jobId } = await env.forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家'
    });
    let sawHeartbeat = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
        if (job.metadata?.forge?.heartbeatAt) {
            sawHeartbeat = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(sawHeartbeat, true, '步骤执行期间应看到 heartbeatAt 刷新');
    await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await env.forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.terminal);
    if (previous === undefined) delete process.env.FORGE_STEP_HEARTBEAT_MS;
    else process.env.FORGE_STEP_HEARTBEAT_MS = previous;
});

// ── 反馈 2：固定考卷重考（复用源任务 exam.json，跨轮可比、零出题费）────────

test('retrial：固定考卷重考——复用源任务考卷（哈希校验通过），零出题调用', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'forge', 'blueprints', 'UIDesigner.json'), blueprint());
    const sourceJobId = await driveToTrial(env); // 停在 trial-report 抽查门禁
    const sourceExam = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', sourceJobId, 'exams', 'exam.json'), 'utf8'));
    const examGenBefore = env.llmCalls.filter((p) => p.messages[0].content.includes('【本次范围】')).length;

    const { jobId } = await env.forgeRuntimeService.startExpertRetrialJob({
        expertName: 'UIDesigner',
        reuseExamFromJobId: sourceJobId,
        expectExamHash: sourceExam.meta.examHash
    });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'pending_confirm'), true,
        '固定卷判卷 0.9 → 及格待抽查');
    const runDir = path.join(baseDir, 'forge', 'runs', jobId);
    const reusedExam = JSON.parse(fs.readFileSync(path.join(runDir, 'exams', 'exam.json'), 'utf8'));
    assert.deepEqual(reusedExam.questions, sourceExam.questions, '题目与源考卷逐字一致');
    assert.equal(reusedExam.meta.examHash, sourceExam.meta.examHash);
    assert.equal(reusedExam.meta.reusedFrom, sourceJobId);
    const examGenAfter = env.llmCalls.filter((p) => p.messages[0].content.includes('【本次范围】')).length;
    assert.equal(examGenAfter, examGenBefore, '固定卷重考零出题调用');
    const marker = JSON.parse(fs.readFileSync(path.join(runDir, 'steps', 'trial.json'), 'utf8'));
    assert.match(marker.summary, /固定考卷 [a-f0-9]{8}/);

    // 哈希不匹配 → 409 拒绝（防串卷）
    await assert.rejects(
        () => env.forgeRuntimeService.startExpertRetrialJob({
            expertName: 'UIDesigner', reuseExamFromJobId: sourceJobId, expectExamHash: 'deadbeef'
        }),
        (error) => error.status === 409 && /考卷哈希不匹配/.test(error.message)
    );
});

// ── 反馈 4：抽考范围（冒烟/定向）——subskillIds 过滤考纲，实操始终包含 ────────

test('retrial：subskillIds 抽考——只出指定子技能 + 实操，门禁按有效条目集', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'forge', 'blueprints', 'UIDesigner.json'), blueprint());

    // 未命中任何考纲条目 → 同步 400
    await assert.rejects(
        () => env.forgeRuntimeService.startExpertRetrialJob({ expertName: 'UIDesigner', subskillIds: ['not-exist'] }),
        (error) => error.status === 400 && /未命中任何考纲条目/.test(error.message)
    );

    const { jobId } = await env.forgeRuntimeService.startExpertRetrialJob({
        expertName: 'UIDesigner',
        subskillIds: ['color-theory']
    });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === 'pending_confirm'), true);
    const runDir = path.join(baseDir, 'forge', 'runs', jobId);
    const exam = JSON.parse(fs.readFileSync(path.join(runDir, 'exams', 'exam.json'), 'utf8'));
    assert.deepEqual(exam.questions.map((q) => q.id), ['color-theory-q1', 'color-theory-q2', 'practical-qp'], '抽考只含指定子技能 + 实操');
    assert.equal(exam.meta.scoped, true);
    const marker = JSON.parse(fs.readFileSync(path.join(runDir, 'steps', 'trial.json'), 'utf8'));
    assert.match(marker.summary, /考卷 3 题覆盖 1\/1 子技能/);
});

// ── 根因 A：DSML 工具调用标记泄漏（补考 6 两题 0 分的答卷本体是未执行的
// 调用标记）——采集侧拦截 + 带考试环境说明重答；持续泄漏剥离留痕且不入缺口。

const DSML_LEAK_SAMPLE = [
    '<｜｜DSML｜｜ calls>',
    '<｜｜DSML｜｜ invoke name="gateway_knowledge_search">',
    '<｜｜DSML｜｜ parameter name="agentId" string="true">FullStackUIDesignExpert</｜｜DSML｜｜ parameter>',
    '<｜｜DSML｜｜ parameter name="query" string="true">视觉层级 对比手段</｜｜DSML｜｜ parameter>',
    '</｜｜DSML｜｜ invoke>',
    '</｜｜DSML｜｜ calls>'
].join('\n');

test('trial：DSML 工具调用泄漏——首答泄漏触发重答恢复；持续泄漏剥离留痕不入缺口', async () => {
    const baseDir = createTempDir();
    const jrs = createJobRuntimeService();
    const answerCalls = {};
    const retryPrompts = [];
    const scores = (ratio) => ({ correctness: ratio * 5, completeness: ratio * 5, professionalism: ratio * 5, antiAiFlavor: ratio * 5, actionability: ratio * 5 });
    const mixedGrade = JSON.stringify({
        gradedQuestions: [
            { id: 'color-theory-q1', scores: scores(0.9), comment: 'ok', citedKnowledgeCards: [] },
            { id: 'color-theory-q2', scores: scores(0.5), comment: '泄漏', citedKnowledgeCards: [] },
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
                let message = { content: 'ans' };
                if (content.includes('# 知识库检索结果')) {
                    const qid = (content.match(/# 考题（(.*?)）/u) || [])[1] || '?';
                    answerCalls[qid] = (answerCalls[qid] || 0) + 1;
                    if (content.includes('【考试环境说明】')) {
                        retryPrompts.push(qid);
                    }
                    if (qid === 'color-theory-q1') {
                        // 首答 DSML 泄漏 → 重答恢复
                        message = answerCalls[qid] === 1
                            ? { content: DSML_LEAK_SAMPLE }
                            : { content: '恢复后的正常答案：视觉层级是留白、对比与节奏的协同。' };
                    } else if (qid === 'color-theory-q2') {
                        // 两轮都泄漏 → 剥离留痕（残余正文为空）
                        message = { content: DSML_LEAK_SAMPLE };
                    }
                } else if (content.includes('专家铸造师')) {
                    message = { content: JSON.stringify(blueprint()) };
                } else if (content.includes('出题官') || content.includes('考纲')) {
                    message = { content: scopeAwareExamOutput(content) };
                } else if (content.includes('判卷官')) {
                    message = { content: mixedGrade };
                } else if (content.includes('知识蒸馏') || content.includes('材料清单')) {
                    message = { content: DISTILL_JSON };
                }
                return { data: { choices: [{ message: { content: message.content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
            }
        },
        toolInvokerPort: {
            invoke: async (toolName, args) => {
                const isLayout = String(args?.query || '').includes('layout');
                return { content: [{ type: 'text', text: isLayout ? 'D\nhttps://d.dev/g\ns' : 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2' }] };
            }
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
    const { jobId } = await svc.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.status === 'pending_confirm');
    await svc.confirmBlueprint(jobId, { approved: true });
    await waitFor(() => jrs.pollJob(jobId, null).data.job.terminal);

    // q1：首答泄漏 → 重答带考试环境说明 → 恢复（无 issue）
    assert.equal(answerCalls['color-theory-q1'], 2);
    assert.ok(retryPrompts.includes('color-theory-q1'), '重答 prompt 必须带考试环境说明');
    const answersFile = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'answers.json'), 'utf8'));
    assert.match(answersFile.answers['color-theory-q1'], /恢复后的正常答案/);
    assert.equal(answersFile.answerMeta['color-theory-q1'], undefined);

    // q2：持续泄漏 → 剥离标记后残余为空，issue=tool-leak，不入缺口
    assert.equal(answersFile.answerMeta['color-theory-q2'].issue, 'tool-leak');
    assert.equal(answersFile.answers['color-theory-q2'], '');
    const gaps = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'gaps.json'), 'utf8'));
    assert.ok(!gaps.gaps.some((gap) => gap.reason.includes('color-theory-q2')), '泄漏题不触发知识回填缺口');
    const marker = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'steps', 'trial.json'), 'utf8'));
    assert.match(marker.summary, /color-theory-q2:tool-leak/);
    const md = fs.readFileSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.md'), 'utf8');
    assert.match(md, /⚠️ 工具调用标记泄漏/);
    assert.ok(!md.includes('<｜｜DSML｜｜'), '报告中的答卷展示不应保留 DSML 标记本体');
});

test('trial：答题要求含通行原则边界火候与禁工具语法（根因 C + A 提示侧）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, { gradeRatio: 0.9 });
    await driveToTrial(env);
    const answerCalls = env.llmCalls.map((payload) => payload.messages[0].content)
        .filter((content) => content.includes('# 知识库检索结果'));
    assert.ok(answerCalls.length >= 5);
    for (const prompt of answerCalls) {
        assert.match(prompt, /通行原则，库内无直接资料/, '边界火候：未覆盖部分用通行原则作答并标注');
        assert.match(prompt, /严禁输出工具调用语法/, '禁工具语法');
        assert.match(prompt, /本环境无任何可调用工具/, '明示无工具');
    }
});

// ── 缺陷 4（2026-10-12）：单题判卷失败被静默按 0 分计 ──────────────────────

// 按卷面 id 出分的可定制判卷桩：dropIds 模拟截断抢救丢题（缺失题被判卷官略过）。
function gradeFor(content, { ratio = 0.9, dropIds = [] } = {}) {
    const score = Math.round(ratio * 5 * 2) / 2;
    const ids = [...String(content).matchAll(/"id":\s*"([^"]+)"/g)]
        .map((m) => m[1])
        .filter((id) => id && !dropIds.includes(id));
    return JSON.stringify({
        gradedQuestions: ids.map((id) => ({
            id,
            scores: { correctness: score, completeness: score, professionalism: score, antiAiFlavor: score, actionability: score },
            comment: '评语',
            citedKnowledgeCards: []
        })),
        overallComment: '总评'
    });
}

test('trial：判卷块丢题进入补判轮补齐——不再静默按 0 分计（缺陷 4 ①）', async () => {
    const baseDir = createTempDir();
    let gradeCalls = 0;
    const env = buildEnv(baseDir, {
        gradeOutputFn: (content) => {
            gradeCalls += 1;
            // 首轮判卷丢 1 题（模拟截断抢救只救回部分）；补判轮只送缺失题，判全。
            return gradeCalls === 1
                ? gradeFor(content, { ratio: 0.9, dropIds: ['layout-typography-q2'] })
                : gradeFor(content, { ratio: 0.9 });
        }
    });
    const jobId = await driveToTrial(env);

    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'pending_confirm', `丢 1 题经补判后应照常及格，实际 ${job.status}`);
    assert.equal(job.metadata.forge.pendingConfirm.kind, 'trial-report');
    assert.equal(gradeCalls, 2, '首轮整卷 + 补判轮缺失题');

    const report = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.json'), 'utf8'));
    assert.equal(report.grading.gradedQuestions.length, 5, '五题全部有判卷条目');
    assert.ok(!report.grading.overallComment.includes('按 0 分计'), '总评不再出现静默 0 分注记');
    assert.ok(report.ratio >= 0.8, `补判后总分 ${(report.ratio * 100).toFixed(1)}% 应及格`);
});

test('trial：补判两轮仍缺失 → FORGE_GRADE_MISSING 显式失败，答卷留档可补判（缺陷 4 ①）', async () => {
    const baseDir = createTempDir();
    const env = buildEnv(baseDir, {
        gradeOutputFn: (content) => gradeFor(content, { ratio: 0.9, dropIds: ['layout-typography-q2'] })
    });
    const jobId = await driveToTrial(env);

    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, 'failed');
    assert.equal(job.metadata.forge.error.code, 'FORGE_GRADE_MISSING');
    assert.equal(job.metadata.forge.error.step, 'trial');
    assert.ok(job.metadata.forge.error.message.includes('layout-typography-q2'), '错误点名缺失题');
    // 答卷已先行落盘——补判的原料在（不是重考）。
    const answersPath = path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'answers.json');
    const saved = JSON.parse(fs.readFileSync(answersPath, 'utf8'));
    assert.equal(Object.keys(saved.answers).length, 5, '五题答卷完整保存');
});

test('regrade：对源任务已保存答卷仅补判缺失题——翻转及格进 D3 门禁（缺陷 4 ②）', async () => {
    const baseDir = createTempDir();
    // 模拟生产事故源：5 题考卷、答卷完整、判卷报告缺 2 题（曾被按 0 分计为 60%）。
    const forgeRoot = path.join(baseDir, 'forge');
    const sourceExams = path.join(forgeRoot, 'runs', 'job_incident', 'exams');
    fs.mkdirSync(sourceExams, { recursive: true });
    fs.mkdirSync(path.join(forgeRoot, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(forgeRoot, 'blueprints', 'UIDesigner.json'), JSON.stringify(blueprint(), null, 2));
    fs.writeFileSync(path.join(forgeRoot, 'runs', 'job_incident', 'run.json'), JSON.stringify({
        jobId: 'job_incident',
        jobKind: 'expert.create',
        expertName: 'UIDesigner',
        requirement: '造一个 UI 设计专家',
        budgetCny: 10,
        blueprintApproved: true,
        finalStatus: 'completed',
        createdAt: '2026-10-12T00:00:00.000Z'
    }));
    const examQuestions = [
        { id: 'color-theory-q1', subskillId: 'color-theory', kind: 'concept', prompt: '解释配色核心概念', referencePoints: ['要点'] },
        { id: 'color-theory-q2', subskillId: 'color-theory', kind: 'applied', prompt: '为登录页应用配色', referencePoints: ['品牌'] },
        { id: 'layout-typography-q1', subskillId: 'layout-typography', kind: 'concept', prompt: '解释栅格系统', referencePoints: ['要点'] },
        { id: 'layout-typography-q2', subskillId: 'layout-typography', kind: 'applied', prompt: '为落地页应用栅格', referencePoints: ['响应式'] },
        { id: 'practical-qp', subskillId: 'practical', kind: 'practical', prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮', '去 AI 味', '可落地'] }
    ];
    fs.writeFileSync(path.join(sourceExams, 'exam.json'), JSON.stringify({ questions: examQuestions }));
    fs.writeFileSync(path.join(sourceExams, 'answers.json'), JSON.stringify({
        answers: Object.fromEntries(examQuestions.map((q) => [q.id, `「${q.id}」的完整答卷：结构清晰、依据充分，质量与其余题相当。`])),
        retrievals: {},
        answerMeta: {}
    }));
    // 已判 3 题 = 双配色题 + 实操题；缺 layout 两题（对齐生产事故形态）。
    const gradedThree = [examQuestions[0], examQuestions[1], examQuestions[4]].map((q) => ({
        id: q.id,
        scores: { correctness: 4, completeness: 4, professionalism: 4, antiAiFlavor: 4, actionability: 4 },
        comment: '评语',
        citedKnowledgeCards: []
    }));
    fs.writeFileSync(path.join(sourceExams, 'grade-report.json'), JSON.stringify({
        passed: false,
        ratio: 0.6,
        passLine: 0.8,
        grading: { gradedQuestions: gradedThree, overallComment: '总评（判卷缺失 2 题：layout-typography-q1、layout-typography-q2，按 0 分计）' },
        gaps: [],
        libraryName: 'UIDesigner知识库'
    }));

    const gradePrompts = [];
    const env = buildEnv(baseDir, {
        gradeOutputFn: (content) => {
            gradePrompts.push(content);
            return gradeFor(content, { ratio: 0.9 });
        }
    });
    const { jobId } = await env.forgeRuntimeService.startExpertRegradeJob({
        expertName: 'UIDesigner',
        sourceJobId: 'job_incident'
    });
    assert.equal(await waitFor(() => env.jobRuntimeService.pollJob(jobId, null).data.job.status === JOB_STATUS.PENDING_CONFIRM), true,
        `补判后应翻转及格进 D3 门禁，实际 ${env.jobRuntimeService.pollJob(jobId, null).data.job.status}`);

    const job = env.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.operation, 'forge.expert.regrade');
    assert.equal(job.metadata.forge.pendingConfirm.kind, 'trial-report');
    assert.match(job.metadata.forge.steps[0].summary, /60\.0% → 8\d\.0%/);
    assert.match(job.metadata.forge.steps[0].summary, /翻转为及格/);

    // 只重判了缺失的 2 题：判卷 prompt 从未包含其余 3 题。
    assert.equal(gradePrompts.length, 1, '缺失题凑一块，单次判卷调用');
    for (const prompt of gradePrompts) {
        const ids = [...prompt.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
        assert.deepEqual(ids.sort(), ['layout-typography-q1', 'layout-typography-q2'], '判卷范围仅缺失题');
    }

    const report = JSON.parse(fs.readFileSync(
        path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.json'), 'utf8'));
    assert.equal(report.grading.gradedQuestions.length, 5, '既有 3 题 + 补判 2 题合并');
    assert.equal(report.regraded.fromJobId, 'job_incident');
    assert.deepEqual(report.regraded.regradedQuestionIds, ['layout-typography-q1', 'layout-typography-q2']);
    assert.equal(report.regraded.previousRatio, 0.6);
    assert.ok(report.ratio >= 0.8 && report.passed === true, `补判后 ${(report.ratio * 100).toFixed(1)}% 应及格`);
    assert.ok(fs.existsSync(path.join(baseDir, 'forge', 'runs', jobId, 'exams', 'grade-report.md')), '用户可读报告重写');
});

test('regrade：判卷完整的源任务拒绝启动（无判可补）', async () => {
    const baseDir = createTempDir();
    const forgeRoot = path.join(baseDir, 'forge');
    const sourceExams = path.join(forgeRoot, 'runs', 'job_full', 'exams');
    fs.mkdirSync(sourceExams, { recursive: true });
    fs.mkdirSync(path.join(forgeRoot, 'blueprints'), { recursive: true });
    fs.writeFileSync(path.join(forgeRoot, 'blueprints', 'UIDesigner.json'), JSON.stringify(blueprint(), null, 2));
    fs.writeFileSync(path.join(forgeRoot, 'runs', 'job_full', 'run.json'), JSON.stringify({ jobId: 'job_full', jobKind: 'expert.create', expertName: 'UIDesigner', budgetCny: 10 }));
    const questions = [{ id: 'color-theory-q1', subskillId: 'color-theory', kind: 'concept', prompt: 'p', referencePoints: [] }];
    fs.writeFileSync(path.join(sourceExams, 'exam.json'), JSON.stringify({ questions }));
    fs.writeFileSync(path.join(sourceExams, 'answers.json'), JSON.stringify({ answers: { 'color-theory-q1': '答' } }));
    fs.writeFileSync(path.join(sourceExams, 'grade-report.json'), JSON.stringify({
        passed: true, ratio: 0.9, passLine: 0.8,
        grading: { gradedQuestions: [{ id: 'color-theory-q1', scores: { correctness: 4 }, comment: '', citedKnowledgeCards: [] }], overallComment: '' },
        gaps: [], libraryName: 'UIDesigner知识库'
    }));
    const env = buildEnv(baseDir, {});
    await assert.rejects(
        env.forgeRuntimeService.startExpertRegradeJob({ expertName: 'UIDesigner', sourceJobId: 'job_full' }),
        (error) => error.code === 'FORGE_REGRADE_NOTHING_MISSING'
    );
});
