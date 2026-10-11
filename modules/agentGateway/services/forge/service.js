'use strict';

const fs = require('fs');
const path = require('path');

const { JOB_STATUS } = require('../jobRuntimeService');
const { createRunStore } = require('./runStore');
const { createCostMeter } = require('./costMeter');
const { createStepRegistry } = require('./steps');
const { ForgeNameConflictError } = require('./nameConflict');
const { blueprintLibraryName } = require('./blueprint');
const { renameAtSynthesize } = require('./synthesize');
const { createGapRegistry } = require('./gapRegistry');
const { PASS_RATIO } = require('./trial');

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
    EXPERT_LEARN: 'forge.expert.learn',
    EXPERT_RETRIAL: 'forge.expert.retrial'
});

const DEFAULT_BASE_DIR = path.join(__dirname, '..', '..', '..', '..', 'Agent', 'forge');
const DEFAULT_BUDGET_CNY = 10;

// 红线 1：铸造流程的 toolInvoker 只允许检索类插件（§3.3 fallback 顺序即此三者）。
// M2 harvest 接入后如需扩展，在此白名单显式追加。
const FORGE_ALLOWED_TOOLS = new Set(['AnySearch', 'FlashDeepSearch', 'BrowserSearch']);

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

// 知识库根：与 TDB 同源（TDB_KNOWLEDGE_ROOT_PATH，相对 CWD 解析），
// 缺省 <repo>/knowledge（baseDir = <repo>/Agent/forge）。
function resolveKnowledgeRoot(baseDir) {
    const envRoot = (process.env.TDB_KNOWLEDGE_ROOT_PATH || '').trim();
    if (envRoot) {
        return path.resolve(process.cwd(), envRoot);
    }
    return path.resolve(baseDir, '..', '..', 'knowledge');
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
        knowledgeStorePort = null,
        baseDir = DEFAULT_BASE_DIR,
        knowledgeRoot = null,
        smokeRetries = null,
        smokeIntervalMs = null,
        distillBatchMaterials = null,
        agentMapPath = null,
        knowledgePolicyPath = null,
        guidanceConfigPath = null,
        jevPort = null,
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
    const gapRegistry = createGapRegistry({ baseDir });
    const effectiveKnowledgeRoot = knowledgeRoot || resolveKnowledgeRoot(baseDir);
    const stepRegistry = createStepRegistry({
        baseDir,
        knowledgeRoot: effectiveKnowledgeRoot,
        smokeRetries,
        smokeIntervalMs,
        ...(distillBatchMaterials != null ? { distillBatchMaterials } : {}),
        agentMapPath,
        knowledgePolicyPath,
        guidanceConfigPath,
        stepRunners
    });
    const effectiveLlmConfig = llmConfig !== null ? llmConfig : resolveForgeLlmConfig();

    let serviceApi = null; // driveJob 内经此发起不及格回填的 learn job

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
                if (!FORGE_ALLOWED_TOOLS.has(toolName)) {
                    const error = new Error(`铸造流程不允许调用插件：${toolName}（白名单：${Array.from(FORGE_ALLOWED_TOOLS).join(' / ')}）`);
                    error.code = 'FORGE_TOOL_NOT_ALLOWED';
                    error.status = 403;
                    log('forge.tool.rejected', { jobId, step: stepId, toolName });
                    throw error;
                }
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

    function stepsForJobKind(runRecord) {
        if (runRecord.jobKind === 'expert.retrial') {
            // 补试岗：专家已注册（synthesize 曾完成），只重跑 trial；不触发注册
            // 与重名冲突（红线 3），失败缺口回填链路照常可用。
            return stepRegistry.RETRIAL_STEPS;
        }
        if (runRecord.jobKind !== 'expert.learn') {
            return stepRegistry.CREATE_STEPS;
        }
        // §3.7：缺口回填的 learn 带同一套考题重测；手动/定期进修只采集→提炼。
        return runRecord.retestOf ? stepRegistry.LEARN_RETEST_STEPS : stepRegistry.LEARN_STEPS;
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
        const steps = stepsForJobKind(runRecord);
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
                // resumeFromTerminal：failed/cancelled 续跑是显式意图；
                // 取消竞态由上一行 ensureActive（同步）先行拦截。
                jobRuntimeService.updateJob(jobId, { status: JOB_STATUS.RUNNING, resumeFromTerminal: true });
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
                    retestOf: runRecord.retestOf || null,
                    blueprintOverride: runRecord.blueprintOverride || null,
                    blueprintPath: runRecord.blueprintPath || null,
                    expertName: runRecord.expertName || null,
                    baseDir,
                    runDir: runStore.runDir(jobId),
                    knowledgeRoot: effectiveKnowledgeRoot,
                    knowledgeStorePort,
                    jevPort,
                    overwriteApproved: Boolean(runRecord.overwriteApproved),
                    llm: wrapLlm(meter, jobId, authContext, step.id),
                    toolInvoker: wrapToolInvoker(meter, jobId, authContext, step.id),
                    agentDirectoryPort,
                    llmConfig: effectiveLlmConfig,
                    logger: (message) => log('forge.step.running', { jobId, step: step.id, message }),
                    audit: (event, payload) => log(event, { jobId, step: step.id, ...payload })
                };
                const result = await stepRegistry.getRunner(step.id)(ctx) || {};
                ensureActive(jobId, authContext); // 执行期间被取消则不覆盖 cancelled 状态。
                const marker = await runStore.markStepComplete(jobId, step.id, {
                    summary: result.summary || null,
                    artifacts: result.artifacts || [],
                    state: result.state && typeof result.state === 'object' ? result.state : null
                });
                markers.set(step.id, marker);

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
                // 动态用户门禁（trial 及格 → 待抽查 D3；blueprint 静态门禁沿用）。
                const dynamicGate = result.state?.userGate || null;
                if (step.requiresUserConfirm || dynamicGate) {
                    const gate = dynamicGate || {
                        kind: 'blueprint',
                        blueprintPath: runRecord.blueprintPath || null,
                        hint: '画像初稿已生成，等待用户确认后继续采集'
                    };
                    jobRuntimeService.updateJob(jobId, {
                        status: JOB_STATUS.PENDING_CONFIRM,
                        metadata: { forge: buildForgeMetadata({
                            runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                            extra: { pendingConfirm: gate }
                        }) }
                    });
                    return; // 用户确认后经 confirmBlueprint 续跑（markers 决定续点）。
                }

                // 试岗不及格 → 自动发起定向回填 learn job（§3.7：只补缺口不推倒重来）。
                if (step.id === 'trial' && result.state && result.state.passed === false &&
                    Array.isArray(result.state.gaps) && result.state.gaps.length > 0 && serviceApi) {
                    try {
                        await serviceApi.startExpertLearnJob({
                            expertName: runRecord.expertName,
                            scope: {
                                subskillIds: result.state.gaps.map((gap) => gap.subskillId),
                                reason: 'trial-failed-gap-backfill',
                                gaps: result.state.gaps
                            },
                            retestOf: {
                                jobId,
                                examPath: path.join(runStore.runDir(jobId), 'exams', 'exam.json'),
                                previousRatio: result.state.ratio
                            },
                            budgetCny: runRecord.budgetCny
                        });
                        log('forge.learn.scheduled', {
                            jobId,
                            expertName: runRecord.expertName,
                            subskillIds: result.state.gaps.map((gap) => gap.subskillId)
                        });
                    } catch (error) {
                        log('forge.learn.schedule_failed', { jobId, message: error.message });
                    }
                }
                log('forge.step.completed', {
                    jobId,
                    step: step.id,
                    costSoFarCny: meter.getBreakdown().costSoFarCny
                });
            } catch (error) {
                if (error instanceof ForgeNameConflictError) {
                    // 红线 3：默认绝不覆盖——暂停待人工确认（改名或人工明确覆盖）。
                    const { conflicts, draft } = error.details;
                    await runStore.updateRun(jobId, { pendingNameConflict: { step: step.id, draft, conflicts } });
                    log('forge.name.conflict', { jobId, step: step.id, conflicts });
                    jobRuntimeService.updateJob(jobId, {
                        status: JOB_STATUS.PENDING_CONFIRM,
                        metadata: { forge: buildForgeMetadata({
                            runRecord, steps, completedSteps: markers, currentStep: null, costBreakdown: meter.getBreakdown(),
                            extra: {
                                pendingConfirm: {
                                    kind: 'name-conflict',
                                    conflicts,
                                    hint: '专家名与既有 agent/文件冲突，等待改名确认'
                                }
                            }
                        }) }
                    });
                    return;
                }
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

        }

        // §3.8 学习档案：learn job 完成时追加（读过什么/学过什么/为什么学）。
        if (runRecord.jobKind === 'expert.learn' && runRecord.expertName) {
            try {
                const harvestMarker = markers.get('harvest');
                const distillMarker = markers.get('distill');
                const sourceCount = (harvestMarker?.state?.manifests || []).reduce((sum, m) => sum + (m.materials || 0), 0);
                await gapRegistry.appendLearningHistory(runRecord.expertName, {
                    trigger: runRecord.scope?.reason || 'manual',
                    scope: runRecord.scope || null,
                    sources: sourceCount,
                    distilledFiles: distillMarker?.state?.writtenCount ?? 0,
                    jobId
                });
                // 进修完成 → 关闭相关 subskill 的 open 缺口（§3.8 触发 a 闭环）。
                const scopeIds = Array.isArray(runRecord.scope?.subskillIds) ? runRecord.scope.subskillIds : null;
                const closed = await gapRegistry.closeGaps(runRecord.expertName, scopeIds || []);
                if (closed > 0) {
                    log('forge.gap.closed', { jobId, expertName: runRecord.expertName, closed });
                }
            } catch (error) {
                log('forge.history.append_failed', { jobId, message: error.message });
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
        const jobKind = operation === FORGE_JOB_OPERATIONS.EXPERT_LEARN ? 'expert.learn'
            : (operation === FORGE_JOB_OPERATIONS.EXPERT_RETRIAL ? 'expert.retrial' : 'expert.create');
        const jobType = jobKind === 'expert.learn' ? 'learn' : (jobKind === 'expert.retrial' ? 'retrial' : 'create');
        return {
            jobId: job.jobId,
            operation,
            jobKind: forge.jobKind || jobKind,
            type: jobType,
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

    serviceApi = {
        FORGE_JOB_OPERATIONS,
        FORGE_ALLOWED_TOOLS,
        gapRegistry,
        baseDir,
        knowledgeRoot: effectiveKnowledgeRoot,
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
        async startExpertLearnJob({ expertName, scope = null, since = null, retestOf = null, authContext = null, budgetCny = null } = {}) {
            const normalizedExpertName = normalizeString(expertName);
            if (!normalizedExpertName) {
                const error = new Error('expertName 不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            // learn 的步骤需要画像（subskills/来源策略）——从既有画像解析。
            const learnBlueprintPath = path.join(baseDir, 'blueprints', `${normalizedExpertName}.json`);
            if (!fs.existsSync(learnBlueprintPath)) {
                const error = new Error(`未找到专家画像：Agent/forge/blueprints/${normalizedExpertName}.json（须先完成全量铸造）`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
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
                blueprintPath: learnBlueprintPath,
                scope,
                since,
                retestOf: retestOf || null,
                budgetCny: Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0 ? Number(budgetCny) : defaultBudgetCny,
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_LEARN, expertName: normalizedExpertName });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        // 补试岗入口：已注册专家（如 synthesize 完成但 trial 失败/缺成绩）只重跑
        // trial——重新 create 会撞重名（红线 3），此处不触碰注册面。
        async startExpertRetrialJob({ expertName, budgetCny = null, authContext = null } = {}) {
            const normalizedExpertName = normalizeString(expertName);
            if (!normalizedExpertName) {
                const error = new Error('expertName 不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const blueprintPath = path.join(baseDir, 'blueprints', `${normalizedExpertName}.json`);
            if (!fs.existsSync(blueprintPath)) {
                const error = new Error(`未找到专家画像：Agent/forge/blueprints/${normalizedExpertName}.json（须先完成全量铸造）`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const { readBlueprint } = require('./blueprint');
            let expertBlueprint;
            try {
                expertBlueprint = await readBlueprint(blueprintPath);
            } catch (error) {
                const wrapped = new Error(`画像不可读：${error.message}`);
                wrapped.status = 400;
                wrapped.code = 'AGW_VALIDATION_ERROR';
                throw wrapped;
            }
            const job = jobRuntimeService.createAcceptedJob({
                operation: FORGE_JOB_OPERATIONS.EXPERT_RETRIAL,
                authContext,
                target: { type: 'forge', id: 'expert' },
                metadata: {
                    forge: {
                        jobKind: 'expert.retrial',
                        expertName: normalizedExpertName,
                        displayName: expertBlueprint.displayName || normalizedExpertName
                    }
                }
            });
            const runRecord = await runStore.initRun({
                jobId: job.jobId,
                jobKind: 'expert.retrial',
                expertName: normalizedExpertName,
                displayName: expertBlueprint.displayName || normalizedExpertName,
                requirement: `retrial: ${normalizedExpertName}`,
                blueprintPath,
                blueprintApproved: true,
                budgetCny: Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0 ? Number(budgetCny) : defaultBudgetCny,
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_RETRIAL, expertName: normalizedExpertName });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        async confirmBlueprint(jobId, { approved, feedback = null, renameTo = null, overwrite = false, authContext = null } = {}) {
            const job = getJobOrThrow(jobId, authContext);
            if (job.status !== JOB_STATUS.PENDING_CONFIRM) {
                const error = new Error(`job 当前状态 ${job.status}，不在确认门禁`);
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

            // 红线 3 的重名确认分支。
            if (runRecord.pendingNameConflict) {
                const conflictStep = runRecord.pendingNameConflict.step || 'blueprint';
                const newName = normalizeString(renameTo);

                if (conflictStep === 'synthesize') {
                    // synthesize 阶段冲突：改名（迁移画像与知识库目录后仅重跑 synthesize）
                    // 或人工明确覆盖（红线 3 的显式例外）。
                    if (newName) {
                        const oldName = runRecord.expertName;
                        await renameAtSynthesize({
                            baseDir,
                            knowledgeRoot: effectiveKnowledgeRoot,
                            runRecord,
                            runStore,
                            jobId,
                            newName
                        });
                        await runStore.updateRun(jobId, { pendingNameConflict: null });
                        log('forge.name.renamed', { jobId, step: conflictStep, from: oldName, to: newName });
                        scheduleDrive(jobId, authContext);
                        return { jobId, outcome: 'renamed' };
                    }
                    if (approved === true && overwrite === true) {
                        await runStore.updateRun(jobId, { pendingNameConflict: null, overwriteApproved: true });
                        log('forge.name.overwrite_approved', { jobId, expertName: runRecord.expertName });
                        scheduleDrive(jobId, authContext);
                        return { jobId, outcome: 'overwrite_approved' };
                    }
                    const error = new Error('synthesize 阶段重名冲突的确认必须提供 renameTo（新专家名）或 overwrite: true（人工明确覆盖）');
                    error.status = 400;
                    error.code = 'AGW_VALIDATION_ERROR';
                    throw error;
                }

                // blueprint 阶段冲突：必须提供新名字，改写画像草稿后从 blueprint 重跑。
                if (!newName) {
                    const error = new Error('重名冲突的确认必须提供 renameTo（新专家名）');
                    error.status = 400;
                    error.code = 'AGW_VALIDATION_ERROR';
                    throw error;
                }
                const renamedDraft = { ...runRecord.pendingNameConflict.draft, name: newName };
                await runStore.updateRun(jobId, {
                    blueprintOverride: renamedDraft,
                    pendingNameConflict: null
                });
                log('forge.name.renamed', { jobId, step: conflictStep, from: runRecord.pendingNameConflict.draft?.name, to: newName });
                scheduleDrive(jobId, authContext);
                return { jobId, outcome: 'renamed' };
            }

            const pendingKind = job.metadata?.forge?.pendingConfirm?.kind || 'blueprint';
            if (pendingKind === 'trial-report') {
                // D3：及格报告的用户抽查确认 → job 走向完成。
                await runStore.updateRun(jobId, { trialApproved: true });
                log('forge.trial.report_confirmed', { jobId, expertName: runRecord.expertName });
            } else {
                await runStore.updateRun(jobId, { blueprintApproved: true });
                log('forge.blueprint.confirmed', { jobId, expertName: runRecord.expertName });
            }
            scheduleDrive(jobId, authContext); // markers 决定续点（blueprint 后从 harvest，trial 后直接完成）
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
        // §3.8 缺口登记（gateway_gap_report 的服务端）：向 Agent/forge/<name>/gaps.json
        // 追加一条 open 缺口并触发审计 forge.gap.reported。
        async reportGap({ agentId, subskillId, question, whyInsufficient }, authContext = null) {
            const expertName = normalizeString(agentId);
            if (!expertName || !normalizeString(question)) {
                const error = new Error('agentId 与 question 不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            if (!fs.existsSync(path.join(baseDir, 'blueprints', `${expertName}.json`))) {
                const error = new Error(`未知专家：${expertName}（无画像）`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const gap = await gapRegistry.appendGap({
                expertName,
                subskillId: normalizeString(subskillId) || null,
                question: normalizeString(question),
                whyInsufficient: normalizeString(whyInsufficient) || null
            });
            log('forge.gap.reported', { expertName, gapId: gap.id, subskillId: gap.subskillId });
            return { expertName, gap };
        },
        async listOpenGaps(expertName) {
            return gapRegistry.listOpenGaps(normalizeString(expertName));
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
    return serviceApi;
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
