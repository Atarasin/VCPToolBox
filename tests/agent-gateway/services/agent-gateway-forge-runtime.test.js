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

function buildService({ baseDir, llmPort = null, prices = null, stepRunners = {}, ...rest } = {}) {
    const jobRuntimeService = createJobRuntimeService();
    const auditLogger = createFakeAuditLogger();
    const forgeRuntimeService = createForgeRuntimeService({
        jobRuntimeService,
        auditLogger,
        llmCompletionPort: llmPort || { available: true, complete: async () => llmResponse(validBlueprintJson()) },
        baseDir,
        prices,
        llmConfig: { url: 'http://test', apiKey: 'test-key', model: 'test-model' },
        stepRunners,
        ...rest
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

test('toolInvoker 缺失时 harvest 报 FORGE_TOOL_INVOKER_UNAVAILABLE（端口前置检查）', async () => {
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

// ── 费用计量：DeepSeek 双档时段计价（元/1K，高峰/空闲动态判定）──────────

test('costMeter：deepseek 双档单价按北京时间时段判定，节假日按高峰保守处理', () => {
    const { createCostMeter, isPeakBeijingTime } = require('../../../modules/agentGateway/services/forge/costMeter');
    // 时段边界：工作日 9-12 / 14-18 高峰；午休、清晨、周末空闲
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T00:59:00Z')), false, '北京 08:59 空闲');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T01:00:00Z')), true, '北京 09:00 整进入高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T02:00:00Z')), true, '北京周三 10:00 高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T03:59:00Z')), true, '北京 11:59 高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T04:00:00Z')), false, '北京 12:00 午休空闲');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T06:00:00Z')), true, '北京 14:00 高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T09:59:00Z')), true, '北京 17:59 仍在高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-14T10:00:00Z')), false, '北京 18:00 整退出高峰');
    assert.equal(isPeakBeijingTime(new Date('2026-10-17T02:00:00Z')), false, '周六空闲');
    assert.equal(isPeakBeijingTime(new Date('2026-10-18T02:00:00Z')), false, '周日空闲');

    // 双档计价：同样 1K+1K tokens，空闲价 = 高峰价一半
    const peak = createCostMeter({ budgetCny: 10, nowFn: () => new Date('2026-10-14T02:00:00Z') });
    peak.recordLlm({ model: 'deepseek-flash', promptTokens: 1000, completionTokens: 1000 });
    assert.ok(Math.abs(peak.getBreakdown().costSoFarCny - 0.01) < 1e-9, '高峰 flash 1K+1K = 0.01 元');

    const offpeak = createCostMeter({ budgetCny: 10, nowFn: () => new Date('2026-10-17T02:00:00Z') });
    offpeak.recordLlm({ model: 'deepseek-flash', promptTokens: 1000, completionTokens: 1000 });
    assert.ok(Math.abs(offpeak.getBreakdown().costSoFarCny - 0.005) < 1e-9, '空闲 flash 1K+1K = 0.005 元（半价）');

    // 前缀变体同样命中双档
    const variant = createCostMeter({ budgetCny: 10, nowFn: () => new Date('2026-10-17T02:00:00Z') });
    variant.recordLlm({ model: 'deepseek-v4-pro-0813', promptTokens: 1000, completionTokens: 1000 });
    assert.ok(Math.abs(variant.getBreakdown().costSoFarCny - (0.0045 + 0.0135)) < 1e-9, 'v4-pro-0813 空闲档前缀命中');
});

// ── 缺陷 1（2026-10-12）：blueprint 起草的截断韧性 ────────────────────────

test('forge blueprint：输出截断/不可解析时重试并抬升预算，第三次成功', async () => {
    const baseDir = createTempDir();
    const calls = [];
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        llmPort: {
            available: true,
            complete: async (config, payload) => {
                calls.push({ maxTokens: payload.max_tokens, prompt: payload.messages[0].content });
                if (calls.length === 1) {
                    // 模拟 max_tokens 截断：JSON 中段被切断 + finish_reason=length。
                    // 截断残留可能被宽松解析救出嵌套子对象（无 name 签名）——应视为不可解析。
                    return {
                        data: {
                            choices: [{ message: { content: validBlueprintJson().slice(0, 260) }, finish_reason: 'length' }],
                            usage: { prompt_tokens: 1000, completion_tokens: 4000 }
                        }
                    };
                }
                if (calls.length === 2) {
                    // 模拟「可解析但不是画像本体」：宽松解析能救出对象，但缺
                    // name/displayName 根签名——守卫应拒绝并继续重试。
                    return llmResponse(JSON.stringify({ scope: { responsibilities: ['UI 评审'] } }));
                }
                // 第三次：围栏 + 前后杂文（可解且根签名完整）。
                return llmResponse(`好的，以下是画像：\n\`\`\`json\n${validBlueprintJson()}\n\`\`\`\n以上仅供参考。`);
            }
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    const reached = await waitFor(() => statusOf(jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM);
    assert.equal(reached, true, `截断两次后第三次应成功，实际 ${statusOf(jobRuntimeService, jobId)}`);

    assert.equal(calls.length, 3, '共 3 次尝试');
    assert.ok(calls[1].maxTokens > calls[0].maxTokens, 'finish_reason=length 后抬升重试预算');
    assert.ok(calls[1].prompt.length > calls[0].prompt.length, '重试追加了重试要求');
    assert.ok(calls[1].prompt.includes('【重试要求】'), '重试提示落地');
    assert.equal(forgeMeta(jobRuntimeService, jobId).expertName, 'UIDesigner');
});

test('forge blueprint：三次均不可解析时留档原始输出并报结构化错误（runDir 可查形态）', async () => {
    const baseDir = createTempDir();
    const { jobRuntimeService, forgeRuntimeService } = buildService({
        baseDir,
        llmPort: {
            available: true,
            complete: async () => llmResponse('抱歉，我无法直接生成该配置文件……')
        }
    });

    const { jobId } = await forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob(jobId, null).data.job.terminal), true);

    const job = jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, JOB_STATUS.FAILED);
    const error = job.metadata.forge.error;
    assert.equal(error.code, 'FORGE_BLUEPRINT_DRAFT_INVALID');
    assert.ok(error.message.includes('blueprint-failed'), '错误信息指向留档目录');

    // 三次尝试的原始输出均留档（finishReason/usage/rawContent）——可区分截断/污染/拒答形态。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const dumpPath = path.join(baseDir, 'runs', jobId, 'blueprint-failed', `blueprint-draft.attempt-${attempt}.json`);
        assert.equal(fs.existsSync(dumpPath), true, `留档缺失：attempt ${attempt}`);
        const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
        assert.equal(typeof dump.rawContent, 'string');
        assert.ok(dump.promptPreview.includes('专家铸造师'));
    }
});

// ── 缺陷 2（2026-10-12）：job 注册表重启恢复 ─────────────────────────────

test('jobRuntime restoreJob：按原 jobId/状态回注，内存活记录优先不被覆盖', () => {
    const jobRuntimeService = createJobRuntimeService();
    const created = jobRuntimeService.createAcceptedJob({ operation: FORGE_JOB_OPERATIONS.EXPERT_CREATE });

    const skipped = jobRuntimeService.restoreJob({
        jobId: created.jobId,
        status: JOB_STATUS.FAILED,
        operation: FORGE_JOB_OPERATIONS.EXPERT_CREATE
    });
    assert.equal(skipped.success, true);
    assert.equal(skipped.data.restored, false, '活记录优先');
    assert.equal(statusOf(jobRuntimeService, created.jobId), JOB_STATUS.ACCEPTED, '状态未被覆盖');

    const restored = jobRuntimeService.restoreJob({
        jobId: 'job_restore-sample',
        status: JOB_STATUS.PENDING_CONFIRM,
        operation: FORGE_JOB_OPERATIONS.EXPERT_CREATE,
        authContext: { agentId: 'ForgeMaster' },
        metadata: { forge: { pendingConfirm: { kind: 'blueprint' } } },
        createdAt: '2026-10-11T00:00:00.000Z'
    });
    assert.equal(restored.data.restored, true);
    const job = jobRuntimeService.pollJob('job_restore-sample', { agentId: 'ForgeMaster' }).data.job;
    assert.equal(job.status, JOB_STATUS.PENDING_CONFIRM);
    assert.equal(job.createdAt, '2026-10-11T00:00:00.000Z');
    assert.equal(job.restoredFromRestart, true);
    assert.equal(job.metadata.forge.pendingConfirm.kind, 'blueprint');

    const invalid = jobRuntimeService.restoreJob({ jobId: 'job_bad', status: 'not-a-status' });
    assert.equal(invalid.success, false);
    assert.equal(invalid.status, 400);
});

test('forge 重启恢复：pending_confirm 任务跨重启可查可追认（blueprint 门禁）', async () => {
    const baseDir = createTempDir();
    const first = buildService({ baseDir });
    const { jobId } = await first.forgeRuntimeService.startExpertCreateJob({ requirement: '造一个 UI 设计专家' });
    assert.equal(await waitFor(() => statusOf(first.jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM), true);

    // 模拟重启：全新 job 运行时 + 全新 forge 服务，同一 baseDir（磁盘产物仍在）。
    const second = buildService({ baseDir });
    assert.equal(await waitFor(() => second.jobRuntimeService.pollJob(jobId, null).success), true, '启动恢复完成');

    const job = second.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(job.status, JOB_STATUS.PENDING_CONFIRM);
    assert.equal(job.restoredFromRestart, true);
    assert.equal(job.operation, FORGE_JOB_OPERATIONS.EXPERT_CREATE);
    assert.equal(job.metadata.forge.pendingConfirm.kind, 'blueprint');
    assert.equal(job.metadata.forge.steps[0].status, 'completed', 'blueprint 标记随恢复可见');
    assert.equal(job.metadata.forge.requirement, '造一个 UI 设计专家');

    // 追认：确认后从 harvest 续跑（测试环境无 toolInvoker → 止步 harvest 失败，即续跑证据）。
    await second.forgeRuntimeService.confirmBlueprint(jobId, { approved: true });
    assert.equal(await waitFor(() => second.jobRuntimeService.pollJob(jobId, null).data.job.terminal), true);
    const final = second.jobRuntimeService.pollJob(jobId, null).data.job;
    assert.equal(final.status, JOB_STATUS.FAILED);
    assert.equal(final.metadata.forge.error.step, 'harvest', '确认后越过 blueprint 续跑');
    const runRecord = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'run.json'), 'utf8'));
    assert.equal(runRecord.finalStatus, 'failed', '终态已落盘（下次重启按原终态恢复）');
});

test('forge 重启恢复：中断任务按 failed(FORGE_RESTART_INTERRUPTED)、暂停/终态记录按原状态恢复', async () => {
    const baseDir = createTempDir();
    const runsRoot = path.join(baseDir, 'runs');
    const writeRun = (jobId, record, stepIds = []) => {
        const dir = path.join(runsRoot, jobId);
        fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
            jobId,
            jobKind: 'expert.create',
            requirement: '造一个 UI 设计专家',
            budgetCny: 10,
            createdAt: '2026-10-11T00:00:00.000Z',
            ...record
        }));
        for (const stepId of stepIds) {
            fs.writeFileSync(path.join(dir, 'steps', `${stepId}.json`), JSON.stringify({ stepId, completedAt: '2026-10-11T00:01:00.000Z' }));
        }
    };

    // a) 跑到一半进程消失：blueprint 已确认 + harvest 标记在，无终态标记。
    writeRun('job_interrupted', { blueprintApproved: true }, ['blueprint', 'harvest']);
    // b) 预算暂停（budgetPausedAtStep 落盘）。
    writeRun('job_paused', { budgetPausedAtStep: 'distill' }, ['blueprint', 'harvest', 'distill']);
    // c) 已落终态 completed（含全部步骤标记）。
    writeRun('job_done', { finalStatus: 'completed', blueprintApproved: true, trialApproved: true },
        ['blueprint', 'harvest', 'distill', 'synthesize', 'trial']);
    // d) trial 及格待抽查（D3 门禁）：trial 标记带 userGate。
    const gateDir = path.join(runsRoot, 'job_trialgate');
    fs.mkdirSync(path.join(gateDir, 'steps'), { recursive: true });
    fs.writeFileSync(path.join(gateDir, 'run.json'), JSON.stringify({
        jobId: 'job_trialgate', jobKind: 'expert.create', requirement: 'x', budgetCny: 10,
        blueprintApproved: true, expertName: 'UIDesigner', createdAt: '2026-10-11T00:00:00.000Z'
    }));
    for (const stepId of ['blueprint', 'harvest', 'distill', 'synthesize', 'trial']) {
        fs.writeFileSync(path.join(gateDir, 'steps', `${stepId}.json`), JSON.stringify({
            stepId,
            completedAt: '2026-10-11T00:01:00.000Z',
            ...(stepId === 'trial' ? { state: { userGate: { kind: 'trial-report', reportPath: 'Agent/forge/runs/job_trialgate/exams/grade-report.md', hint: '试岗及格，请用户抽查验收报告（D3）' } } } : {})
        }));
    }

    const { jobRuntimeService } = buildService({ baseDir });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob('job_interrupted', null).success), true, '启动恢复完成');

    assert.equal(statusOf(jobRuntimeService, 'job_interrupted'), JOB_STATUS.FAILED);
    assert.equal(forgeMeta(jobRuntimeService, 'job_interrupted').error.code, 'FORGE_RESTART_INTERRUPTED');
    assert.equal(forgeMeta(jobRuntimeService, 'job_interrupted').restoredFromRestart, true);

    assert.equal(statusOf(jobRuntimeService, 'job_paused'), JOB_STATUS.PAUSED_BUDGET);
    assert.equal(statusOf(jobRuntimeService, 'job_done'), JOB_STATUS.COMPLETED);

    // D3 追认：及格待抽查的 trial 门禁恢复后可直接确认盖章。
    const gateJob = jobRuntimeService.pollJob('job_trialgate', null).data.job;
    assert.equal(gateJob.status, JOB_STATUS.PENDING_CONFIRM);
    assert.equal(gateJob.metadata.forge.pendingConfirm.kind, 'trial-report');
});

// ── 缺陷 3（2026-10-12 回归）：恢复任务的属主/身份校验 ──────────────────────

const FORGEMASTER_AUTH = {
    agentId: 'ForgeMaster',
    sessionId: 'mcp-session-1',
    gatewayId: 'vcp-gateway',
    credentialSubject: 'forgemaster-ext-2026-10',
    credentialId: 'forgemaster-ext-2026-10',
    credentialRevision: 'rev-1'
};

test('forge 重启恢复（缺陷 3）：身份丢失的历史任务对已识别凭据恢复读写', async () => {
    const baseDir = createTempDir();
    // 手工构造持久化改造前的 run：run.json 无 authContext 字段，停在 blueprint 门禁。
    const runsRoot = path.join(baseDir, 'runs');
    const dir = path.join(runsRoot, 'job_legacy_gate');
    fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
        jobId: 'job_legacy_gate',
        jobKind: 'expert.create',
        requirement: '造一个 UI 设计专家',
        budgetCny: 10,
        createdAt: '2026-10-12T00:00:00.000Z'
    }));
    fs.writeFileSync(path.join(dir, 'steps', 'blueprint.json'), JSON.stringify({
        stepId: 'blueprint',
        completedAt: '2026-10-12T00:01:00.000Z'
    }));

    const { jobRuntimeService, forgeRuntimeService } = buildService({ baseDir });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob('job_legacy_gate', null).success), true, '启动恢复完成');

    // 读路径：ForgeMaster 凭据（agentId+sessionId+credentialSubject）可查——回归现场是 403。
    const polled = jobRuntimeService.pollJob('job_legacy_gate', FORGEMASTER_AUTH);
    assert.equal(polled.success, true, 'ForgeMaster 读恢复（缺陷 3 回归）');
    assert.equal(polled.data.job.status, JOB_STATUS.PENDING_CONFIRM);
    assert.equal(polled.data.job.identityLostOnRestore, true, '标记为身份丢失的历史任务');

    // 无任何身份的请求不放行（通配仅面向已识别请求方）。
    const anonymous = jobRuntimeService.pollJob('job_legacy_gate', {});
    assert.equal(anonymous.success, false);
    assert.equal(anonymous.status, 403);

    // 写路径：确认续跑（confirm 走同一道 canAccessJob 门）。
    const confirmed = await forgeRuntimeService.confirmBlueprint('job_legacy_gate', { approved: true, authContext: FORGEMASTER_AUTH });
    assert.equal(confirmed.outcome, 'confirmed', 'ForgeMaster 写恢复（确认门禁可追认）');
    assert.equal(await waitFor(() => jobRuntimeService.pollJob('job_legacy_gate', null).data.job.terminal), true);
    const final = jobRuntimeService.pollJob('job_legacy_gate', FORGEMASTER_AUTH).data.job;
    assert.equal(final.status, JOB_STATUS.FAILED);
    assert.equal(final.metadata.forge.error.step, 'harvest', '确认后越过 blueprint 续跑');
});

test('forge 重启恢复（缺陷 3）：已持久化身份的任务按 owner 语义严格比对（不走通配）', async () => {
    const baseDir = createTempDir();
    const runsRoot = path.join(baseDir, 'runs');
    const dir = path.join(runsRoot, 'job_owned_gate');
    fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({
        jobId: 'job_owned_gate',
        jobKind: 'expert.create',
        requirement: '造一个 UI 设计专家',
        budgetCny: 10,
        createdAt: '2026-10-12T00:00:00.000Z',
        authContext: {
            agentId: 'ForgeMaster',
            credentialSubject: 'forgemaster-ext-2026-10',
            credentialId: 'forgemaster-ext-2026-10',
            credentialRevision: 'rev-1'
        }
    }));
    fs.writeFileSync(path.join(dir, 'steps', 'blueprint.json'), JSON.stringify({
        stepId: 'blueprint',
        completedAt: '2026-10-12T00:01:00.000Z'
    }));

    const { jobRuntimeService } = buildService({ baseDir });
    assert.equal(await waitFor(() => jobRuntimeService.pollJob('job_owned_gate', null).success), true, '启动恢复完成');
    const restored = jobRuntimeService.pollJob('job_owned_gate', null).data.job;
    assert.equal(restored.identityLostOnRestore, undefined, '有持久化身份——不落通配标记');

    // 同凭据主体换新会话（重启后典型形态）：owner 无 trustedSessionId → 放行。
    const sameSubjectNewSession = jobRuntimeService.pollJob('job_owned_gate', { ...FORGEMASTER_AUTH, sessionId: 'session-after-restart' });
    assert.equal(sameSubjectNewSession.success, true, '同主体新会话可读');

    // 异主体：403（owner 语义不因恢复放宽）。
    const otherSubject = jobRuntimeService.pollJob('job_owned_gate', {
        agentId: 'MCPYui', sessionId: 's2', credentialSubject: 'yui-ext-2026-08', credentialId: 'yui-ext-2026-08'
    });
    assert.equal(otherSubject.success, false);
    assert.equal(otherSubject.status, 403);
});

test('forge 新建任务：创建者身份随 run 落盘，重启后按原身份可读写（身份模型不锁新任务）', async () => {
    const baseDir = createTempDir();
    const first = buildService({ baseDir });
    const { jobId } = await first.forgeRuntimeService.startExpertCreateJob({
        requirement: '造一个 UI 设计专家',
        authContext: FORGEMASTER_AUTH
    });
    assert.equal(await waitFor(() => statusOf(first.jobRuntimeService, jobId) === JOB_STATUS.PENDING_CONFIRM), true);

    // 创建者可读（创建路径的身份不受恢复改造影响）。
    assert.equal(first.jobRuntimeService.pollJob(jobId, FORGEMASTER_AUTH).success, true);

    // 身份已随 run 落盘：下次重启走 owner 语义，而非身份丢失通配。
    const runRecord = JSON.parse(fs.readFileSync(path.join(baseDir, 'runs', jobId, 'run.json'), 'utf8'));
    assert.equal(runRecord.authContext.agentId, 'ForgeMaster');
    assert.equal(runRecord.authContext.credentialSubject, 'forgemaster-ext-2026-10');

    // 模拟重启：新进程恢复后，同凭据（新会话）仍可读、可确认。
    const second = buildService({ baseDir });
    assert.equal(await waitFor(() => second.jobRuntimeService.pollJob(jobId, FORGEMASTER_AUTH).success), true, '重启恢复完成');
    const afterRestart = second.jobRuntimeService.pollJob(jobId, { ...FORGEMASTER_AUTH, sessionId: 'session-after-restart' });
    assert.equal(afterRestart.success, true, '同凭据新会话可读');
    assert.equal(afterRestart.data.job.identityLostOnRestore, undefined, '身份来自持久化而非通配');

    const confirmed = await second.forgeRuntimeService.confirmBlueprint(jobId, {
        approved: true,
        authContext: { ...FORGEMASTER_AUTH, sessionId: 'session-after-restart' }
    });
    assert.equal(confirmed.outcome, 'confirmed', '同凭据新会话可确认');
});
