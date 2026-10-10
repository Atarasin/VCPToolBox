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
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: { prompt: 'SaaS 落地页设计方案', gradingDimensions: ['眼前一亮', '去 AI 味', '可落地'] },
        acceptanceSample: '眼前一亮、去 AI 味的设计图'
    };
}

const EXAM_JSON = JSON.stringify({
    questions: [
        { id: 'q1', subskillId: 'color-theory', kind: 'concept', prompt: '解释色轮与三属性', referencePoints: ['色相', '饱和度', '明度'], searchKeywords: ['色轮'] },
        { id: 'q2', subskillId: 'color-theory', kind: 'applied', prompt: '为登录页选主色', referencePoints: ['品牌'], searchKeywords: ['主色'] },
        { id: 'qp', subskillId: 'practical', kind: 'practical', prompt: 'SaaS 落地页设计方案（眼前一亮/去 AI 味/可落地）', gradingDimensions: ['眼前一亮', '去 AI 味', '可落地'], referencePoints: ['完整方案'], searchKeywords: ['落地页'] }
    ]
});

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

function gradeJson(ratio) {
    const score = Math.round(ratio * 5 * 2) / 2;
    const graded = ['q1', 'q2', 'qp'].map((id) => ({
        id,
        scores: { correctness: score, completeness: score, professionalism: score, antiAiFlavor: score, actionability: score },
        comment: '评语',
        citedKnowledgeCards: ['色轮与色彩三属性']
    }));
    return JSON.stringify({ gradedQuestions: graded, overallComment: '总评' });
}

function buildEnv(baseDir, { gradeRatio, jevPort = null } = {}) {
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
                output = EXAM_JSON;
            } else if (content.includes('判卷官')) {
                output = gradeJson(gradeRatio);
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
            invoke: async () => ({ content: [{ type: 'text', text: 'A\nhttps://a.com/x\ns\n\nB\nhttps://b.com/y\ns2\n\nC\nhttps://c.io/z\ns3' }] })
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
    assert.match(md, /## q1（concept \/ color-theory）/, '每题得分章节');
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
    assert.equal(gaps.gaps.length, 1);
    assert.equal(gaps.gaps[0].subskillId, 'color-theory');
    assert.match(gaps.gaps[0].reason, /低于 80%/);

    // M4.S2 T1：缺口 → forge.expert.learn 定向任务（只补缺口）
    const jobs = await env.forgeRuntimeService.listJobs();
    const learnJob = jobs.find((j) => j.type === 'learn' && j.expertName === 'UIDesigner');
    assert.ok(learnJob, '应自动创建 learn job');
    const learnRun = JSON.parse(fs.readFileSync(path.join(baseDir, 'forge', 'runs', learnJob.jobId, 'run.json'), 'utf8'));
    assert.deepEqual(learnRun.scope.subskillIds, ['color-theory']);
    assert.equal(learnRun.scope.reason, 'trial-failed-gap-backfill');
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
    assert.equal(comparison.llm.gradedQuestions.length, 3);
    assert.equal(comparison.jev.skipped, false, 'Jev 判决留档');
    assert.equal(comparison.jev.decision.answers.isProfessional.choice, 'professional');
    assert.ok(comparison.note.includes('D7 方案 C'));
    assert.equal(jevCalls.length, 1);
    assert.ok(Object.keys(jevCalls[0].questions).includes('isAiFlavored'), '三维度类型化问题');
    assert.match(jevCalls[0].state.answers, /\[q1\]/, 'state 含答卷摘要');
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
