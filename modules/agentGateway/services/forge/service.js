'use strict';

const path = require('path');

const { JOB_STATUS } = require('../jobRuntimeService');
const { createRunStore } = require('./runStore');
const { createCostMeter } = require('./costMeter');
const { createStepRegistry } = require('./steps');

/**
 * forge job 编排服务（§3.2）：
 * - forge.expert.create：五步状态机 blueprint → harvest → distill → synthesize → trial；
 * - forge.expert.learn：增量学习（scope = 缺口或主题，仅采集→提炼）；
 * - 跑在 agentGateway job 运行时之上（可查进度 / 取消 / 重试，红线 5）；
 * - 断点续跑：每步产物落盘（steps/<stepId>.json 标记）即视为完成，
 *   重试只重跑未完成步骤，不从头烧钱；
 * - 预算护栏（§3.2 / Q2）：逐次模型调用累计估算费用，≥90% 告警、
 *   ≥100% 自动转 paused_budget 并附已花费明细；
 * - 协作式取消：job 被外部 cancelJob 后，worker 在安全检查点感知并停止。
 *
 * 红线 1：铸造流程全程不调用任何记忆写工具——本服务的端口面只有
 * llmCompletion / toolInvoker / agentDirectory（只读），不接触 memory 端口。
 */

const FORGE_JOB_OPERATIONS = Object.freeze({
    EXPERT_CREATE: 'forge.expert.create',
    EXPERT_LEARN: 'forge.expert.learn'
});

const DEFAULT_BASE_DIR = path.join(__dirname, '..', '..', '..', '..', 'Agent', 'forge');
const DEFAULT_BUDGET_CNY = 10;

const RESUMABLE_JOB_STATUSES = new Set([
    JOB_STATUS.FAILED,
    JOB_STATUS.CANCELLED,
    JOB_STATUS.PAUSED_BUDGET
]);

class BudgetExceededError extends Error {
    constructor(breakdown) {
        super(`铸造预算已耗尽（${breakdown.costSoFarCny}/${breakdown.budgetCny} 元），job 转入 paused_budget`);
        this.name = 'BudgetExceededError';
        this.code = 'FORGE_BUDGET_EXCEEDED';
        this.details = { breakdown };
    }
}

class JobCancelledError extends Error {
    constructor(jobId) {
        super(`job 已被取消：${jobId}`);
        this.name = 'JobCancelledError';
        this.code = 'FORGE_JOB_CANCELLED';
    }
}

function resolveForgeLlmConfig(env = process.env) {
    const url = (env.FORGE_LLM_URL || env.AIMemoUrl || '').trim();
    const apiKey = (env.FORGE_LLM_API || env.AIMemoApi || '').trim();
    const model = (env.FORGE_LLM_MODEL || env.AIMemoModel || '').trim();
    return url && apiKey && model ? { url, apiKey, model } : null;
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function buildForgeMetadata({ runRecord, steps, completedSteps, currentStep, costBreakdown, extra = {} }) {
    const stepStates = steps.map((step) => {
        const marker = completedSteps.get(step.id);
        return {
            id: step.id,
            name: step.name,
            status: marker ? 'completed' : (step.id === currentStep ? 'running' : 'pending'),
            completedAt: marker?.completedAt || null,
            summary: marker?.summary || null,
            artifacts: marker?.artifacts || []
        };
    });
    // progressDetail 只用于进度 detail 文案，不进 metadata 顶层。
    const { progressDetail, ...extraRest } = extra;
    const metadata = {
        jobKind: runRecord.jobKind,
        expertName: runRecord.expertName || null,
        displayName: runRecord.displayName || null,
        requirement: runRecord.requirement || null,
        steps: stepStates,
        runDir: runRecord.runDir || null,
        cost: costBreakdown ? {
            costSoFarCny: costBreakdown.costSoFarCny,
            budgetCny: costBreakdown.budgetCny,
            warnThresholdCny: costBreakdown.warnThresholdCny,
            byModel: costBreakdown.byModel
        } : null,
        ...extraRest
    };
    // §3.2 进度事件体 {step, detail, costSoFarCny}：门禁/终态时 step 为空但费用仍可见。
    metadata.progress = {
        step: currentStep || null,
        detail: progressDetail || (currentStep ? (stepStates.find((s) => s.id === currentStep)?.name || '') : ''),
        costSoFarCny: costBreakdown?.costSoFarCny ?? 0
    };
    return metadata;
}

function createForgeRuntimeService(options = {}) {
    const {
        jobRuntimeService,
        auditLogger = null,
        llmCompletionPort = null,
        toolInvokerPort = null,
        agentDirectoryPort = null,
        baseDir = DEFAULT_BASE_DIR,
        prices = null,
        defaultBudgetCny = DEFAULT_BUDGET_CNY,
        llmConfig = null,
        stepRunners = {}
    } = options;

    if (!jobRuntimeService) {
        throw new Error('[ForgeRuntimeService] jobRuntimeService 是必需依赖');
    }
    if (typeof jobRuntimeService.createAcceptedJob !== 'function' ||
        typeof jobRuntimeService.updateJob !== 'function' ||
        typeof jobRuntimeService.pollJob !== 'function') {
        throw new Error('[ForgeRuntimeService] jobRuntimeService 缺少必需 API');
    }

    const runStore = createRunStore({ baseDir });
    const stepRegistry = createStepRegistry({ baseDir, stepRunners });
    const effectiveLlmConfig = llmConfig !== null ? llmConfig : resolveForgeLlmConfig();

    function log(event, payload) {
        auditLogger?.logGatewayOperation?.(event, payload);
    }

    function getJobOrThrow(jobId, authContext = null) {
        const result = jobRuntimeService.pollJob(jobId, authContext);
        if (!result?.success) {
            const error = new Error(result?.error || 'Job not found');
            error.status = result?.status || 404;
            error.code = result?.code;
            error.details = result?.details;
            throw error;
        }
        return result.data.job;
    }

    async function persistCost(jobId, meter) {
        await runStore.updateRun(jobId, { cost: meter.getBreakdown() });
    }

    // 用给定 authContext 感知外部取消（协作式取消）。
    function ensureActive(jobId, authContext) {
        const result = jobRuntimeService.pollJob(jobId, authContext);
        if (result?.success && result.data.job.status === JOB_STATUS.CANCELLED) {
            throw new JobCancelledError(jobId);
        }
    }

    function wrapLlm(meter, jobId, authContext, stepId) {
        let warned = false;
        return {
            available: llmCompletionPort?.available !== false && typeof llmCompletionPort?.complete === 'function',
            async complete(config, payload) {
                if (llmCompletionPort?.available === false || typeof llmCompletionPort?.complete !== 'function') {
                    const error = new Error('llmCompletion 端口不可用');
                    error.code = 'FORGE_LLM_UNAVAILABLE';
                    error.status = 503;
                    throw error;
                }
                ensureActive(jobId, authContext);
                const response = await llmCompletionPort.complete(config, payload);
                meter.recordLlm({
                    model: payload?.model || config?.model,
                    promptTokens: response?.data?.usage?.prompt_tokens,
                    completionTokens: response?.data?.usage?.completion_tokens,
                    step: stepId
                });
                await persistCost(jobId, meter);
                const check = meter.check();
                if (check.level === 'warning' && !warned) {
                    warned = true;
                    log('forge.budget.warning', { jobId, step: stepId, ...check });
                }
                if (check.level === 'exceeded') {
                    throw new BudgetExceededError(meter.getBreakdown());
                }
                return response;
            }
        };
    }

    function wrapToolInvoker(meter, jobId, authContext, stepId) {
        if (!toolInvokerPort || typeof toolInvokerPort.invoke !== 'function') {
            return null;
        }
        return {
            async invoke(toolName, args, clientIp) {
                ensureActive(jobId, authContext);
                const result = await toolInvokerPort.invoke(toolName, args, clientIp);
                meter.recordTool({ plugin: toolName, step: stepId });
                await persistCost(jobId, meter);
                const check = meter.check();
                if (check.level === 'exceeded') {
                    throw new BudgetExceededError(meter.getBreakdown());
                }
                return result;
            }
        };
    }

    function stepsForJobKind(jobKind) {
        return jobKind === 'expert.learn' ? stepRegistry.LEARN_STEPS : stepRegistry.CREATE_STEPS;
    }

    async function updateForgeMetadata(jobId, metadataPatch) {
        jobRuntimeService.updateJob(jobId, { metadata: { forge: metadataPatch } });
    }

    async function driveJob(jobId, { authContext, startAfterStep = null }) {
        const runRecord = await runStore.readRun(jobId);
        if (!runRecord) {
            jobRuntimeService.failJob(jobId, { forge: { error: { code: 'FORGE_RUN_MISSING' } } });
            return;
        }
        const meter = createCostMeter({
            budgetCny: runRecord.budgetCny,
            prices,
            initialEntries: runRecord.cost?.entries
        });
        const steps = stepsForJobKind(runRecord.jobKind);
        const completedSteps = await runStore.scanCompletedSteps(jobId);
        const markers = new Map();
        for (const stepId of completedSteps) {
            markers.set(stepId, await runStore.readStepMarker(jobId, stepId));
        }

        let reachedStart = !startAfterStep;
        for (const step of steps) {
            if (!reachedStart) {
                if (step.id !== startAfterStep) {
                    continue;
                }
                reachedStart = true;
            }
            if (markers.has(step.id)) {
                continue;
            }

            ensureActive(jobId, authContext);
            if (jobRuntimeService.pollJob(jobId, authContext)?.data?.job?.status !== JOB_STATUS.RUNNING) {
                jobRuntimeService.updateJob(jobId, { status: JOB_STATUS.RUNNING });
            }

            await updateForgeMetadata(jobId, buildForgeMetadata({
                runRecord, steps, completedSteps: markers, currentStep: step.id, costBreakdown: meter.getBreakdown(),
                extra: { progressDetail: `${step.name}（${markers.size + 1}/${steps.length}）` }
            }));

            try {
                const ctx = {
                    jobId,
                    jobKind: runRecord.jobKind,
                    requirement: runRecord.requirement,
                    scope: runRecord.scope || null,
                    since: runRecord.since || null,
                    blueprintOverride: runRecord.blueprintOverride || null,
                    blueprintPath: runRecord.blueprintPath || null,
                    expertName: runRecord.expertName || null,
                    baseDir,
                    runDir: runStore.runDir(jobId),
                    llm: wrapLlm(meter, jobId, authContext, step.id),
                    toolInvoker: wrapToolInvoker(meter, jobId, authContext, step.id),
                    agentDirectoryPort,
                    llmConfig: effectiveLlmConfig,
                    logger: (message) => log('forge.step.running', { jobId, step: step.id, message })
                };
                const result = await stepRegistry.getRunner(step.id)(ctx) || {};
                ensureActive(jobId, authContext); // 执行期间被取消则不覆盖 cancelled 状态。
                const marker = await runStore.markStepComplete(jobId, step.id, {
                    summary: result.summary || null,
                    artifacts: result.artifacts || []
                });
                markers.set(step.id, marker);
                log('forge.step.completed', {
                    jobId,
                    step: step.id,
                    costSoFarCny: meter.getBreakdown().costSoFarCny
                });
                if (result.state?.expertName) {
                    runRecord.expertName = result.state.expertName;
                    runRecord.displayName = result.state.displayName || runRecord.expertName;
                    runRecord.blueprintPath = result.state.blueprintPath || runRecord.blueprintPath;
                    await runStore.updateRun(jobId, {
                        expertName: runRecord.expertName,
                        displayName: runRecord.displayName,
                        blueprintPath: runRecord.blueprintPath
                    });
                }
            } catch (error) {
                if (error instanceof BudgetExceededError) {
                    const breakdown = meter.getBreakdown();
                    log('forge.budget.paused', { jobId, step: step.id, ...breakdown });
                    jobRuntimeService.updateJob(jobId, {
                        status: JOB_STATUS.PAUSED_BUDGET,
                        metadata: { forge: buildForgeMetadata({
                            runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: breakdown,
                            extra: { budgetPaused: { step: step.id, breakdown } }
                        }) }
                    });
                    return;
                }
                if (error instanceof JobCancelledError) {
                    return; // 状态已由取消方置为 cancelled。
                }
                log('forge.job.failed', { jobId, step: step.id, code: error.code || 'INTERNAL', message: error.message });
                await updateForgeMetadata(jobId, buildForgeMetadata({
                    runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                    extra: { error: { step: step.id, code: error.code || 'INTERNAL', message: error.message } }
                }));
                jobRuntimeService.failJob(jobId, {
                    forge: buildForgeMetadata({
                        runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                        extra: { error: { step: step.id, code: error.code || 'INTERNAL', message: error.message } }
                    })
                });
                return;
            }

            if (step.requiresUserConfirm) {
                jobRuntimeService.updateJob(jobId, {
                    status: JOB_STATUS.PENDING_CONFIRM,
                    metadata: { forge: buildForgeMetadata({
                        runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                        extra: {
                            pendingConfirm: {
                                kind: 'blueprint',
                                blueprintPath: runRecord.blueprintPath || null,
                                hint: '画像初稿已生成，等待用户确认后继续采集'
                            }
                        }
                    }) }
                });
                return; // 用户确认后经 confirmBlueprint 续跑。
            }
        }

        await updateForgeMetadata(jobId, buildForgeMetadata({
            runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
            extra: { completedAt: new Date().toISOString() }
        }));
        jobRuntimeService.completeJob(jobId, {
            forge: buildForgeMetadata({
                runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                extra: { completedAt: new Date().toISOString() }
            })
        });
        log(runRecord.jobKind === 'expert.learn' ? 'forge.learn.completed' : 'forge.job.completed', {
            jobId,
            expertName: runRecord.expertName || null,
            costSoFarCny: meter.getBreakdown().costSoFarCny
        });
    }

    // 异步驱动 job；取消/竞态类错误不改写终态，其余崩溃才 failJob。
    function scheduleDrive(jobId, authContext, driveOptions = {}) {
        setImmediate(() => {
            driveJob(jobId, { authContext, ...driveOptions }).catch((error) => {
                if (error instanceof JobCancelledError) {
                    return;
                }
                console.error('[ForgeRuntimeService] driveJob crashed:', error);
                const current = jobRuntimeService.pollJob(jobId, authContext);
                if (current?.success && current.data.job.status !== JOB_STATUS.CANCELLED) {
                    jobRuntimeService.failJob(jobId, {
                        forge: { error: { code: 'INTERNAL', message: error.message } }
                    });
                }
            });
        });
    }

    function parseJobSummary(job) {
        const forge = job?.metadata?.forge || {};
        const operation = job.operation || '';
        const jobKind = operation === FORGE_JOB_OPERATIONS.EXPERT_LEARN ? 'expert.learn' : 'expert.create';
        return {
            jobId: job.jobId,
            operation,
            jobKind: forge.jobKind || jobKind,
            type: jobKind === 'expert.learn' ? 'learn' : 'create',
            expertName: forge.expertName || null,
            displayName: forge.displayName || null,
            status: job.status,
            terminal: Boolean(job.terminal),
            currentStep: forge.progress?.step || null,
            steps: forge.steps || [],
            costSoFarCny: forge.cost?.costSoFarCny ?? 0,
            budgetCny: forge.cost?.budgetCny ?? null,
            pendingConfirm: forge.pendingConfirm || null,
            budgetPaused: forge.budgetPaused || null,
            error: forge.error || null,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            completedAt: job.completedAt || null,
            failedAt: job.failedAt || null,
            cancelledAt: job.cancelledAt || null
        };
    }

    return {
        FORGE_JOB_OPERATIONS,
        baseDir,
        async startExpertCreateJob({ requirement, authContext = null, blueprintOverride = null, budgetCny = null } = {}) {
            const normalizedRequirement = normalizeString(requirement);
            if (!normalizedRequirement) {
                const error = new Error('requirement（一句话需求）不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const budget = Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0
                ? Number(budgetCny)
                : (blueprintOverride?.budget?.maxModelCostCny || defaultBudgetCny);

            const job = jobRuntimeService.createAcceptedJob({
                operation: FORGE_JOB_OPERATIONS.EXPERT_CREATE,
                authContext,
                target: { type: 'forge', id: 'expert' },
                metadata: {
                    forge: {
                        jobKind: 'expert.create',
                        requirement: normalizedRequirement
                    }
                }
            });
            const runRecord = await runStore.initRun({
                jobId: job.jobId,
                jobKind: 'expert.create',
                requirement: normalizedRequirement,
                budgetCny: budget,
                blueprintOverride,
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_CREATE, requirement: normalizedRequirement });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        async startExpertLearnJob({ expertName, scope = null, since = null, authContext = null, budgetCny = null } = {}) {
            const normalizedExpertName = normalizeString(expertName);
            if (!normalizedExpertName) {
                const error = new Error('expertName 不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const job = jobRuntimeService.createAcceptedJob({
                operation: FORGE_JOB_OPERATIONS.EXPERT_LEARN,
                authContext,
                target: { type: 'forge', id: 'expert' },
                metadata: {
                    forge: {
                        jobKind: 'expert.learn',
                        expertName: normalizedExpertName
                    }
                }
            });
            const runRecord = await runStore.initRun({
                jobId: job.jobId,
                jobKind: 'expert.learn',
                expertName: normalizedExpertName,
                scope,
                since,
                budgetCny: Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0 ? Number(budgetCny) : defaultBudgetCny,
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_LEARN, expertName: normalizedExpertName });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        async confirmBlueprint(jobId, { approved, feedback = null, authContext = null } = {}) {
            const job = getJobOrThrow(jobId, authContext);
            if (job.status !== JOB_STATUS.PENDING_CONFIRM) {
                const error = new Error(`job 当前状态 ${job.status}，不在画像确认门禁`);
                error.status = 409;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const runRecord = await runStore.readRun(jobId);
            if (!runRecord) {
                const error = new Error('运行档案缺失');
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            if (!approved) {
                await runStore.updateRun(jobId, { blueprintRejected: true, rejectionFeedback: normalizeString(feedback) });
                jobRuntimeService.updateJob(jobId, {
                    status: JOB_STATUS.CANCELLED,
                    metadata: { forge: { rejection: { feedback: normalizeString(feedback) || null } } }
                });
                log('forge.blueprint.rejected', { jobId, feedback: normalizeString(feedback) || null });
                return { jobId, outcome: 'rejected' };
            }
            await runStore.updateRun(jobId, { blueprintApproved: true });
            log('forge.blueprint.confirmed', { jobId, expertName: runRecord.expertName });
            scheduleDrive(jobId, authContext, { startAfterStep: 'blueprint' });
            return { jobId, outcome: 'confirmed' };
        },
        async resumeJob(jobId, { raiseBudgetToCny = null, authContext = null } = {}) {
            const job = getJobOrThrow(jobId, authContext);
            if (!RESUMABLE_JOB_STATUSES.has(job.status)) {
                const error = new Error(`job 当前状态 ${job.status}，不可续跑（仅 failed / cancelled / paused_budget）`);
                error.status = 409;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const runRecord = await runStore.readRun(jobId);
            if (!runRecord) {
                const error = new Error('运行档案缺失');
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const patch = {};
            if (Number.isFinite(Number(raiseBudgetToCny)) && Number(raiseBudgetToCny) > 0) {
                patch.budgetCny = Number(raiseBudgetToCny);
                patch.budgetRaises = [...(runRecord.budgetRaises || []), {
                    to: Number(raiseBudgetToCny),
                    at: new Date().toISOString()
                }];
            }
            if (Object.keys(patch).length > 0) {
                await runStore.updateRun(jobId, patch);
            }
            log('forge.job.resumed', { jobId, fromStatus: job.status, raiseBudgetToCny: patch.budgetCny || null });
            scheduleDrive(jobId, authContext);
            return { jobId, outcome: 'resumed' };
        },
        async listJobs({ authContext = null } = {}) {
            const result = jobRuntimeService.listJobs({ authContext, filters: { operationPrefix: 'forge.' } });
            if (!result?.success) {
                return [];
            }
            return result.data.jobs.map(parseJobSummary);
        },
        async getJobDetail(jobId, { authContext = null } = {}) {
            const job = getJobOrThrow(jobId, authContext);
            if (!String(job.operation || '').startsWith('forge.')) {
                const error = new Error('非 forge job');
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const runRecord = await runStore.readRun(jobId);
            const artifacts = await runStore.listRunFiles(jobId);
            const eventsResult = jobRuntimeService.listEvents({ authContext, filters: { jobId } });
            const breakdown = runRecord?.cost || job.metadata?.forge?.cost || null;
            return {
                job: parseJobSummary(job),
                forge: job.metadata?.forge || {},
                run: runRecord ? {
                    jobId: runRecord.jobId,
                    jobKind: runRecord.jobKind,
                    requirement: runRecord.requirement || null,
                    expertName: runRecord.expertName || null,
                    budgetCny: runRecord.budgetCny ?? null,
                    blueprintApproved: Boolean(runRecord.blueprintApproved),
                    budgetRaises: runRecord.budgetRaises || []
                } : null,
                cost: breakdown ? {
                    costSoFarCny: breakdown.costSoFarCny,
                    budgetCny: breakdown.budgetCny,
                    warnThresholdCny: breakdown.warnThresholdCny,
                    byModel: breakdown.byModel || {},
                    entries: breakdown.entries || []
                } : null,
                artifacts,
                events: eventsResult?.success ? eventsResult.data.events : []
            };
        }
    };
}

module.exports = {
    FORGE_JOB_OPERATIONS,
    DEFAULT_BASE_DIR,
    DEFAULT_BUDGET_CNY,
    BudgetExceededError,
    JobCancelledError,
    resolveForgeLlmConfig,
    createForgeRuntimeService
};
