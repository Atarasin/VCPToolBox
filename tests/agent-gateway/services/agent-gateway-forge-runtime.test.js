const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JOB_STATUS, createJobRuntimeService } = require('../../../modules/agentGateway/services/jobRuntimeService');
const {
    FORGE_JOB_OPERATIONS,
    createForgeRuntimeService
} = require('../../../modules/agentGateway/services/forge/service');

// ── 测试基建 ─────────────────────────────────────────────────────────────

function createTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-runtime-'));
}

function createFakeAuditLogger() {
    const events = [];
    return {
        events,
        logGatewayOperation(event, payload) {
            events.push({ event: `gateway.${event}`, payload });
        }
    };
}

// 模拟 OpenAI 兼容响应（vcpPortBindings 的 llmCompletion 返回 axios response 形状）。
function llmResponse(content, usage = { prompt_tokens: 1000, completion_tokens: 500 }) {
    return { data: { choices: [{ message: { content } }], usage } };
}

function validBlueprintJson(name = 'UIDesigner') {
    return JSON.stringify({
        name,
        displayName: 'UI 设计专家',
        scope: {
            responsibilities: ['落地页/UI 界面设计评审'],
            boundaries: ['不做前端代码实现']
        },
        subskills: [
            { id: 'color-theory', title: '配色理论', searchQueries: ['color theory UI design'] }
        ],
        examOutline: [
            { subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }
        ],
        practicalExam: {
            prompt: '为一个 SaaS 落地页产出设计方案',
            gradingDimensions: ['眼前一亮', '去 AI 味', '可落地']
        },
        acceptanceSample: '能给出一份眼前一亮、去AI味的 UI 设计图'
    });
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

function statusOf(jobRuntimeService, jobId) {
    return jobRuntimeService.pollJob(jobId, null).data.job.status;
}

function forgeMeta(jobRuntimeService, jobId) {
    return jobRuntimeService.pollJob(jobId, null).data.job.metadata.forge;
}

function buildService({ baseDir, llmPort = null, prices = null, stepRunners = {} } = {}) {
    const jobRuntimeService = createJobRuntimeService();
    const auditLogger = createFakeAuditLogger();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        auditLogger,
        llmCompletionPort: llmPort || { available: true, complete: async () => llmResponse(validBlueprintJson()) },
        baseDir,
        prices,
        llmConfig: { url: 'http://test', apiKey: 'test-key', model: 'test-model' },
        stepRunners
    });
    return { jobRuntimeService, auditLogger, forgeRuntimeService };
}

// ── 验收：发起只跑 blueprint 步骤的测试 job，能查询进度 ────────────────────

test('forge create job：blueprint 步骤完成后转 pending_confirm，进度/费用可查', async () => {
    const baseDir = createTempDir();
    let llmCalls = 0;
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        llmPort: {
            available: true,
            complete: async () => {
                llmCalls += 1;
                return llmResponse(validBlueprintJson());
            }
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    const reached = await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM);
    assert.equal(reached, true, `应到达 pending_confirm，实际 ${statusOf(jobRuntimeService, jobId)}`);

    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.operation, FORGE_JOB_OPERATIONS.EXPERT_CREATE);
    const meta = job.metadata.forge;
    assert.equal(meta.expertName, 'UIDesigner');
    assert.equal(meta.steps[0].id, 'blueprint');
    assert.equal(meta.steps[0].status, 'completed');
    assert.equal(meta.steps[1].status, 'pending');
    assert.ok(Number.isFinite(meta.progress.costSoFarCny));
    assert.equal(meta.pendingConfirm.kind, 'blueprint');
    assert.equal(llmCalls, 1);

    const blueprintPath = path.join(baseDir, 'blueprints', 'UIDesigner.json');
    assert.equal(fs.existsSync(blueprintPath), true, '画像应已落盘');
    const onDisk = JSON.parse(fs.readFileSync(blueprintPath, 'utf8'));
    assert.equal(onDisk.budget.maxModelCostCny, 10);

    const markerDir = path.join(baseDir, 'runs', jobId, 'steps');
    assert.deepEqual(fs.readdirSync(markerDir), ['blueprint.json']);
});

// ── 验收：能取消（协作式取消，blueprint 门禁态也允许取消）──────────────────

test('forge job 可在运行中被取消，状态保持 cancelled', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        llmPort: {
            available: true,
            complete: async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                return llmResponse(validBlueprintJson());
            }
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    const cancelResult = jobRuntimeService.cancelJob(jobId, null);
    assert.equal(cancelResult.success, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(statusOf(jobRuntimeService, jobId), JOB_STATUS.CANCELLED, '取消不被后续状态迁移覆盖');
});

test('pending_confirm / paused_budget 状态下的 job 仍可取消（红线 5）', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({ baseDir });
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM);

    const cancelResult = jobRuntimeService.cancelJob(jobId, null);
    assert.equal(cancelResult.success, true);
    assert.equal(statusOf(jobRuntimeService, jobId), JOB_STATUS.CANCELLED);
});

// ── 验收：失败后能只重试该步骤（断点续跑，不从头烧钱）──────────────────────

test('forge job 失败后续跑只重跑失败步骤，已完成步骤跳过', async () => {
    const baseDir = createTempDir();
    const calls = { harvest: 0, distill: 0 };
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        stepRunners: {
            harvest: async () => {
                calls.harvest += 1;
                if (calls.harvest === 1) {
                    const error = new Error('搜索插件全部失败');
                    error.code = 'FORGE_HARVEST_FAILED';
                    throw error;
                }
                return { summary: '采集完成', artifacts: ['raw/color-theory/'] };
            },
            distill: async () => {
                calls.distill += 1;
                return { summary: '提炼完成', artifacts: ['knowledge/'] };
            },
            synthesize: async () => ({ summary: '合成完成', artifacts: ['persona.txt'] }),
            trial: async () => ({ summary: '试岗完成', artifacts: ['exams/'] })
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM), true);

    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.FAILED), true);
    assert.equal(forgeMeta(jobRuntimeService, jobId).error.code, 'FORGE_HARVEST_FAILED');
    assert.equal(calls.harvest, 1);

    // 断点续跑：blueprint 标记存在 → 跳过；只重跑失败的 harvest，然后继续 distill。
    await forgeRuntimeService.resumeJob(jobId);
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.COMPLETED), true);
    assert.equal(calls.harvest, 2, '失败步骤重跑一次');
    assert.equal(calls.distill, 1, '后续步骤只执行一次');

    const meta = forgeMeta(jobRuntimeService, jobId);
    assert.equal(meta.steps.filter((s) => s.status === 'completed').length, 5);
    const stepFiles = fs.readdirSync(path.join(baseDir, 'runs', jobId, 'steps')).sort();
    assert.deepEqual(stepFiles, ['blueprint.json', 'distill.json', 'harvest.json', 'synthesize.json', 'trial.json']);
});

// ── 验收：预算护栏 ≥90% 告警、≥100% 自动 paused_budget 且携带费用明细 ──────

test('预算护栏：≥90% 告警继续执行，≥100% 自动转 paused_budget 并附明细', async () => {
    const baseDir = createTempDir();
    // 单价 1 元/1K tokens：1000+500 tokens = 1.5 元；预算 1.6 → 93.75% 告警后继续。
    const warnPrices = { fallback: { input: 1, output: 1 }, models: { 'test-model': { input: 1, output: 1 } } };
    const warnCase = buildService({
        baseDir: path.join(baseDir, 'warn'),
        prices: warnPrices
    });
    const warnJob = await warnCase.forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        budgetCny: 1.6
    });
    assert.equal(await waitFor(() => statusOf(warnCase.jobRuntimeService, warnJob.jobId) === JOB_STATUS.PENDING_CONFIRM), true,
        '90% 告警不阻断执行');
    assert.ok(warnCase.auditLogger.events.some((e) => e.event === 'gateway.forge.budget.warning'));

    // 单价 10 元/1K tokens：1500 tokens = 15 元 > 预算 10 → 蓝图步骤内触发 paused_budget。
    const exceededPrices = { fallback: { input: 10, output: 10 }, models: { 'test-model': { input: 10, output: 10 } } };
    const exceededCase = buildService({
        baseDir: path.join(baseDir, 'exceeded'),
        prices: exceededPrices
    });
    const exceededJob = await exceededCase.forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    assert.equal(await waitFor(() => statusOf(exceededCase.jobRuntimeService, exceededJob.jobId) === JOB_STATUS.PAUSED_BUDGET), true,
        '预算耗尽自动转 paused_budget');
    const meta = forgeMeta(exceededCase.jobRuntimeService, exceededJob.jobId);
    assert.ok(meta.budgetPaused, 'metadata 应携带预算暂停明细');
    assert.ok(meta.budgetPaused.breakdown.costSoFarCny >= 10, '费用明细应显示已超上限');
    assert.ok(meta.budgetPaused.breakdown.entries.length >= 1, '明细应含逐次调用条目');
    assert.ok(exceededCase.auditLogger.events.some((e) => e.event === 'gateway.forge.budget.paused'));
    assert.equal(fs.existsSync(path.join(baseDir, 'exceeded', 'blueprints', 'UIDesigner.json')), false,
        '未完成的步骤不落产物');

    // 上调后续跑：预算恢复 → blueprint 重跑成功 → pending_confirm。
    await exceededCase.forgeRuntimeService.resumeJob(exceededJob.jobId, { raiseBudgetToCny: 100 });
    assert.equal(await waitFor(() => statusOf(exceededCase.jobRuntimeService, exceededJob.jobId) === JOB_STATUS.PENDING_CONFIRM), true,
        '上调预算后续跑成功');
    const run = JSON.parse(fs.readFileSync(path.join(baseDir, 'exceeded', 'runs', exceededJob.jobId, 'run.json'), 'utf8'));
    assert.equal(run.budgetCny, 100);
    assert.equal(run.budgetRaises.length, 1);
});

// ── 五步状态机：未交付能力的步骤以明确错误失败（M2.S1 后 harvest 已接入）──

test('toolInvoker 缺失时 harvest 报 FORGE_TOOL_INVOKER_UNAVAILABLE；distill/synthesize/trial 仍为待接入桩', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({ baseDir });
    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM);
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.FAILED), true);
    assert.equal(forgeMeta(jobRuntimeService, jobId).error.code, 'FORGE_TOOL_INVOKER_UNAVAILABLE');
    assert.equal(forgeMeta(jobRuntimeService, jobId).error.step, 'harvest');
});

test('forge.expert.learn 增量学习 job 走 harvest→distill 两步', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({ baseDir });
    // learn 需要既有画像（subskills/来源策略）——先落一份。
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'blueprints', 'UIDesigner.json'), JSON.parse(validBlueprintJson()));
    const { jobId } = await forgeRuntimeService.startExpertLearnJob({
        expertName: 'UIDesigner',
        scope: { subskillIds: ['color-theory'] }
    });
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.FAILED), true);
    const meta = forgeMeta(jobRuntimeService, jobId);
    assert.equal(meta.jobKind, 'expert.learn');
    assert.equal(meta.steps.length, 2);
    assert.deepEqual(meta.steps.map((s) => s.id), ['harvest', 'distill']);
    assert.equal(jobRuntimeService.pollJob(jobId, null).data.job.operation, FORGE_JOB_OPERATIONS.EXPERT_LEARN);
});

// ── 列表 / 详情（AdminPanel 只读接口同源数据）──────────────────────────────

test('listJobs / getJobDetail 提供只读视图，learn/create 均可枚举', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({ baseDir });

    // 非 forge job 不应混入列表。
    jobRuntimeService.createAcceptedJob({ operation: 'tool.invoke', target: { type: 'tool', id: 'X' } });

    const createJob = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    await waitFor(() => statusOf(jobRuntimeService, createJob.jobId) === JOB_STATUS.PENDING_CONFIRM);
    const { writeBlueprint } = require('../../../modules/agentGateway/services/forge/blueprint');
    await writeBlueprint(path.join(baseDir, 'blueprints', 'UIDesigner.json'), {
        name: 'UIDesigner', displayName: 'UI 设计专家',
        scope: { responsibilities: ['UI 设计'], boundaries: [] },
        subskills: [{ id: 'color-theory', title: '配色理论', searchQueries: ['color theory'] }],
        examOutline: [{ subskillId: 'color-theory', conceptQuestions: 1, appliedQuestions: 1 }],
        practicalExam: { prompt: 'p', gradingDimensions: ['d'] },
        acceptanceSample: 'a'
    });
    const learnJob = await forgeRuntimeService.startExpertLearnJob({ expertName: 'UIDesigner' });
    await waitFor(() => statusOf(jobRuntimeService, createJob.jobId) === JOB_STATUS.PENDING_CONFIRM);
    await waitFor(() => statusOf(jobRuntimeService, learnJob.jobId) === JOB_STATUS.FAILED);

    const jobs = await forgeRuntimeService.listJobs();
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job) => job.operation.startsWith('forge.')));
    const createSummary = jobs.find((job) => job.jobId === createJob.jobId);
    assert.equal(createSummary.type, 'create');
    assert.equal(createSummary.expertName, 'UIDesigner');
    assert.equal(createSummary.status, JOB_STATUS.PENDING_CONFIRM);
    assert.ok(createSummary.steps.length === 5);
    assert.equal(createSummary.costSoFarCny > 0 || createSummary.costSoFarCny === 0, true);

    const detail = await forgeRuntimeService.getJobDetail(createJob.jobId);
    assert.equal(detail.job.jobId, createJob.jobId);
    assert.equal(detail.cost.budgetCny, 10);
    assert.ok(detail.artifacts.some((file) => file.path.endsWith('run.json')));
    assert.ok(detail.events.length >= 2, '详情应包含 runtime 事件时间线');
    assert.ok(detail.events.every((event) => event.jobId === createJob.jobId));

    await assert.rejects(
        forgeRuntimeService.getJobDetail('job_missing'),
        (error) => error.status === 404
    );
});

// ── job 运行时扩展：新状态与 listJobs 过滤 ────────────────────────────────

test('jobRuntimeService 新增 pending_confirm / paused_budget 状态与事件类型', () => {
    const service = createJobRuntimeService();
    const job = service.createAcceptedJob({ operation: 'forge.expert.create' });
    service.updateJob(job.jobId, { status: JOB_STATUS.PENDING_CONFIRM });
    let polled = service.pollJob(job.jobId, null).data.job;
    assert.equal(polled.status, 'pending_confirm');
    assert.equal(polled.terminal, false);

    const events = service.listEvents({ filters: { jobId: job.jobId } }).data.events;
    assert.ok(events.some((event) => event.eventType === 'job.pending_confirm'));

    service.updateJob(job.jobId, { status: JOB_STATUS.PAUSED_BUDGET });
    events.push(...service.listEvents({ filters: { jobId: job.jobId } }).data.events);
    assert.ok(events.some((event) => event.eventType === 'job.paused_budget'));

    // paused_budget → cancelled 可达。
    const cancelResult = service.cancelJob(job.jobId, null);
    assert.equal(cancelResult.success, true);

    const listed = service.listJobs({ filters: { operationPrefix: 'forge.' } }).data.jobs;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].jobId, job.jobId);
});

// ── 红线 3：重名冲突暂停待人工确认，改名后续跑（§3.1）─────────────────────

test('专家名与既有 agent 冲突时转 pending_confirm，改名确认后完成 blueprint', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        llmPort: {
            available: true,
            complete: async () => llmResponse(validBlueprintJson('Nexus')) // 与既有 agent 重名
        }
    });
    // 注入冲突名单：ForgeMaster 服务的 agentDirectoryPort 在 buildService 里不可配，
    // 这里直接用文件冲突路径验证：在 Agent 根（baseDir/..）放同名 txt。
    // buildService 未暴露 agentDirectoryPort，采用文件冲突分支：
    const agentRoot = require('node:path').join(baseDir, '..');
    // baseDir 的父目录是临时目录本身（非 Agent/），因此用 forge 根下的同名文件分支：
    require('node:fs').writeFileSync(require('node:path').join(baseDir, 'Nexus.txt'), 'existing persona');

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM), true,
        '重名冲突应暂停待确认而非直接失败');
    let meta = forgeMeta(jobRuntimeService, jobId);
    assert.equal(meta.pendingConfirm.kind, 'name-conflict');
    assert.ok(meta.pendingConfirm.conflicts.length >= 1);
    assert.equal(fs.existsSync(path.join(baseDir, 'blueprints', 'Nexus.json')), false, '冲突画像不落盘');

    // 改名确认 → blueprint 以新名重跑 → 到达画像确认门禁。
    // 注意等待谓词必须区分新旧门禁（确认前 job 本就处于 name-conflict 的 pending_confirm）。
    await forgeRuntimeService.confirmBlueprint(jobId, { approved: true, renameTo: 'UIDesigner' });
    assert.equal(
        await waitFor(() => forgeMeta(jobRuntimeService, jobId)?.pendingConfirm?.kind === 'blueprint'),
        true,
        '改名重跑后应到达 blueprint 确认门禁'
    );
    meta = forgeMeta(jobRuntimeService, jobId);
    assert.equal(meta.pendingConfirm.kind, 'blueprint', '改名后应到达正常画像确认门禁');
    assert.equal(meta.expertName, 'UIDesigner');
    assert.equal(fs.existsSync(path.join(baseDir, 'blueprints', 'UIDesigner.json')), true);

    // 缺 renameTo 的确认被拒绝。
    const { jobId: jobId2 } = await forgeRuntimeService.startExpertCreateJob({ requirement: '再造一个' });
    // 第二个 job 用同名 Nexus → 同样冲突
    assert.equal(await waitFor(() => statusOf(jobRuntimeService, jobId2) === JOB_STATUS.PENDING_CONFIRM), true);
    await assert.rejects(
        forgeRuntimeService.confirmBlueprint(jobId2, { approved: true }),
        (error) => error.status === 400
    );
});

// ── 终态保护：迟到回写不可覆盖取消（红线 5）──────────────────────────────

test('updateJob 终态迁出需显式 resumeFromTerminal，防止迟到回写覆盖取消', () => {
    const service = createJobRuntimeService();
    const job = service.createAcceptedJob({ operation: 'forge.expert.create' });
    service.cancelJob(job.jobId, null);

    const blocked = service.updateJob(job.jobId, { status: JOB_STATUS.RUNNING });
    assert.equal(blocked.success, false);
    assert.equal(blocked.status, 409);

    const allowed = service.updateJob(job.jobId, { status: JOB_STATUS.RUNNING, resumeFromTerminal: true });
    assert.equal(allowed.success, true);

    // 同状态的 metadata 合并不受影响（幂等 complete 场景）。
    const job2 = service.createAcceptedJob({ operation: 'forge.expert.create' });
    service.completeJob(job2.jobId, { forge: { done: true } });
    const recomplete = service.completeJob(job2.jobId, { forge: { done: true, extra: 1 } });
    assert.equal(recomplete.success, true);
});

// ── 红线 1：toolInvoker 检索白名单（非检索插件被拒）──────────────────────

test('铸造流程 toolInvoker 仅允许检索类插件（AnySearch/FlashDeepSearch/BrowserSearch）', async () => {
    const baseDir = createTempDir();
    const invoked = [];
    const captured = {};
    const { createForgeRuntimeService: rebuild } = require('../../../modules/agentGateway/services/forge/service');
    const svc = rebuild({
        jobRuntimeService: createJobRuntimeService(),
        llmCompletionPort: { available: true, complete: async () => llmResponse(validBlueprintJson()) },
        toolInvokerPort: {
            invoke: async (toolName) => { invoked.push(toolName); return 'ok'; }
        },
        baseDir: path.join(baseDir, 'probe'),
        llmConfig: { url: 'http://t', apiKey: 'k', model: 'm' },
        stepRunners: {
            // 抓取步骤 ctx 暴露的 metered toolInvoker，验证白名单包装。
            blueprint: async (ctx) => {
                captured.toolInvoker = ctx.toolInvoker;
                return { summary: 'skip', artifacts: [] };
            }
        }
    });
    await svc.startExpertCreateJob({ requirement: '探针' });
    assert.equal(await waitFor(() => captured.toolInvoker), true);
    await assert.rejects(
        captured.toolInvoker.invoke('DailyNote', {}),
        (error) => error.code === 'FORGE_TOOL_NOT_ALLOWED'
    );
    const ok = await captured.toolInvoker.invoke('AnySearch', { query: 'color theory' });
    assert.equal(ok, 'ok');
    assert.deepEqual(invoked, ['AnySearch']);
    assert.deepEqual(svc.FORGE_ALLOWED_TOOLS, new Set(['AnySearch', 'FlashDeepSearch', 'BrowserSearch']));
});
