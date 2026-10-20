'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const { JOB_STATUS } = require('../jobRuntimeService');
const { createRunStore } = require('./runStore');
const { createCostMeter } = require('./costMeter');
const { createStepRegistry } = require('./steps');
const { ForgeNameConflictError } = require('./nameConflict');
const { blueprintLibraryName, readBlueprint } = require('./blueprint');
const { renameAtSynthesize } = require('./synthesize');
const {
    createGapRegistry,
    listExpertNames,
    readExpertArchive,
    writeExpertArchive,
    removeExpertArchive
} = require('./gapRegistry');
const { PASS_RATIO } = require('./trial');
const { isTransientLlmError, resolveLlmRetryPolicy, backoffDelay, sleep } = require('./llmRetry');

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
    EXPERT_RETRIAL: 'forge.expert.retrial',
    EXPERT_REGRADE: 'forge.expert.regrade'
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

// 单次铸造 LLM 调用超时（2026-10-14）：60s 对大调用（蒸馏单批可达 5k+ token
// 输出）过紧，撞线即 ECONNABORTED；默认抬到 180s，FORGE_LLM_TIMEOUT_MS 可配。
const DEFAULT_FORGE_LLM_TIMEOUT_MS = 180000;

function resolveForgeLlmTimeoutMs(env = process.env) {
    const raw = Number(env.FORGE_LLM_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_FORGE_LLM_TIMEOUT_MS;
}

function resolveForgeLlmConfig(env = process.env) {
    const url = (env.FORGE_LLM_URL || env.AIMemoUrl || '').trim();
    const apiKey = (env.FORGE_LLM_API || env.AIMemoApi || '').trim();
    const model = (env.FORGE_LLM_MODEL || env.AIMemoModel || '').trim();
    return url && apiKey && model
        ? { url, apiKey, model, timeoutMs: resolveForgeLlmTimeoutMs(env) }
        : null;
}

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

// run 记录只持久化身份字段（不含 credentialRecord），供重启恢复重建 owner 快照。
function trimAuthContextForRun(authContext) {
    if (!authContext || typeof authContext !== 'object') {
        return null;
    }
    const fields = [
        'requestId', 'sessionId', 'agentId', 'source', 'runtime', 'gatewayId',
        'authMode', 'authSource', 'credentialSubject', 'credentialId', 'credentialRevision',
        'effectiveAgentId', 'trustedSessionId'
    ];
    const trimmed = {};
    for (const field of fields) {
        const value = normalizeString(authContext[field]);
        if (value) {
            trimmed[field] = value;
        }
    }
    return Object.keys(trimmed).length > 0 ? trimmed : null;
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
        memoryPolicyPath = null,
        recallProfilesPath = null,
        jevPort = null,
        prices = null,
        defaultBudgetCny = DEFAULT_BUDGET_CNY,
        llmConfig = null,
        llmRetryPolicy = null,
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
    // 瞬时失败退避重试策略（2026-10-14）：env 缺省 2 次 / 2s 起，可注入覆盖（测试用）。
    const effectiveLlmRetryPolicy = llmRetryPolicy || resolveLlmRetryPolicy(process.env);
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
        memoryPolicyPath,
        recallProfilesPath,
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
                // 瞬时网络失败退避重试（2026-10-14）：此前一次超时/连接重置直接
                // 终止整个 distill 步骤——04:00 无人值守的定期进修因此整批报废。
                for (let attempt = 0; ; attempt += 1) {
                    ensureActive(jobId, authContext);
                    let response;
                    try {
                        response = await llmCompletionPort.complete(config, payload);
                    } catch (error) {
                        if (attempt >= effectiveLlmRetryPolicy.retries || !isTransientLlmError(error)) {
                            throw error;
                        }
                        const delayMs = backoffDelay(effectiveLlmRetryPolicy.baseDelayMs, attempt + 1);
                        log('forge.llm.retry', {
                            jobId,
                            step: stepId,
                            attempt: attempt + 1,
                            delayMs,
                            code: error.code || null,
                            message: error.message
                        });
                        await sleep(delayMs);
                        continue;
                    }
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
        if (runRecord.jobKind === 'expert.regrade') {
            // 补判（缺陷 4 ②）：对源任务已保存答卷仅重判缺失题。
            return stepRegistry.REGRADE_STEPS;
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

    // ── 重启恢复（2026-10-12 缺陷 2）────────────────────────────────────────
    // job 注册表是进程内存态（Map），重启即丢——磁盘产物（runDir/steps 标记）
    // 完好但 pending_confirm 等门禁态无法追认（404）。启动时扫描 runs/ 重建
    // 注册表：门禁/暂停态原样恢复可确认；跑到一半的按 failed(重启中断)恢复，
    // 保留断点续跑能力；已有终态标记的按原终态恢复（记录可查）。

    function operationForJobKind(jobKind) {
        if (jobKind === 'expert.learn') {
            return FORGE_JOB_OPERATIONS.EXPERT_LEARN;
        }
        if (jobKind === 'expert.retrial') {
            return FORGE_JOB_OPERATIONS.EXPERT_RETRIAL;
        }
        if (jobKind === 'expert.regrade') {
            return FORGE_JOB_OPERATIONS.EXPERT_REGRADE;
        }
        return FORGE_JOB_OPERATIONS.EXPERT_CREATE;
    }

    function classifyRestoredRun({ runRecord, steps, markers }) {
        // ① 已落终态标记：按原终态恢复（记录可查，语义不漂移）。
        if (runRecord.finalStatus === 'completed' || runRecord.finalStatus === 'failed' || runRecord.finalStatus === 'cancelled') {
            return { status: runRecord.finalStatus, extra: { restoredFromRestart: true } };
        }
        // ② 门禁/暂停态（非终态、等待用户决断）——恢复后确认/续跑照常可用。
        if (runRecord.pendingNameConflict) {
            return {
                status: JOB_STATUS.PENDING_CONFIRM,
                extra: {
                    pendingConfirm: {
                        kind: 'name-conflict',
                        conflicts: runRecord.pendingNameConflict.conflicts,
                        hint: '专家名与既有 agent/文件冲突，等待改名确认（进程重启后恢复）'
                    },
                    restoredFromRestart: true
                }
            };
        }
        if (runRecord.budgetPausedAtStep) {
            return {
                status: JOB_STATUS.PAUSED_BUDGET,
                extra: {
                    budgetPaused: { step: runRecord.budgetPausedAtStep, restored: true },
                    restoredFromRestart: true
                }
            };
        }
        const allDone = steps.every((step) => markers.has(step.id));
        // D3 及格待抽查门禁：trial/retest/regrade 步标记的 state.userGate 均可能
        // 携带（泛化识别，避免 retest/regrade 门禁恢复时漏判）。
        const gateMarker = [...markers.values()].find((marker) => marker?.state?.userGate);
        if (!allDone && markers.has('blueprint') && runRecord.jobKind !== 'expert.learn' && !runRecord.blueprintApproved) {
            return {
                status: JOB_STATUS.PENDING_CONFIRM,
                extra: {
                    pendingConfirm: {
                        kind: 'blueprint',
                        blueprintPath: runRecord.blueprintPath || null,
                        hint: '画像初稿已生成，等待用户确认后继续采集（进程重启后恢复）'
                    },
                    restoredFromRestart: true
                }
            };
        }
        if (gateMarker && !runRecord.trialApproved) {
            return {
                status: JOB_STATUS.PENDING_CONFIRM,
                extra: {
                    pendingConfirm: { ...gateMarker.state.userGate, restored: true },
                    restoredFromRestart: true
                }
            };
        }
        if (allDone) {
            return { status: JOB_STATUS.COMPLETED, extra: { restoredFromRestart: true } };
        }
        // ③ 跑到一半进程消失：如实置 failed（可 resume 断点续跑，已完成步骤不重烧）。
        return {
            status: JOB_STATUS.FAILED,
            extra: {
                error: {
                    step: null,
                    code: 'FORGE_RESTART_INTERRUPTED',
                    message: '进程重启时任务仍在执行，已按失败恢复；可 resume 断点续跑（已完成步骤不重烧）'
                },
                restoredFromRestart: true
            }
        };
    }

    // §3.8 学习档案的失败分支（2026-10-14）：失败的进修也留一条 status=failed
    // 记录（含失败步骤/原因/已花费用），面板专家档案页签据此显示「失败」，
    // 否则失败在档案里完全不可见，会被长期误读为「定期进修没有触发」。
    // 失败的进修不关闭缺口（闭环只认完成的进修）。
    // 幂等：归档后写 run.json 的 learningArchive 标记，跨重启/多次实例化只写一次。
    // partial（2026-10-17）：失败步骤带回的部分进度——distill 边蒸边写盘，失败时
    // 前面已完成子技能的卡片其实已落盘，此前一律记 distilledFiles: 0，面板看起来
    // 整批白跑（实测失败单已写 11 个文件却记 0）。
    async function recordLearnFailureArchive(runRecord, jobId, { step = null, code = null, message = null, costBreakdown = null, partial = null } = {}) {
        if (runRecord?.jobKind !== 'expert.learn' || !runRecord.expertName) {
            return false;
        }
        try {
            const harvestMarker = await runStore.readStepMarker(jobId, 'harvest');
            const sourceCount = (harvestMarker?.state?.manifests || []).reduce((sum, m) => sum + (m.materials || 0), 0);
            const writtenCount = Number(partial?.writtenCount) || 0;
            await gapRegistry.appendLearningHistory(runRecord.expertName, {
                trigger: runRecord.scope?.reason || 'manual',
                scope: runRecord.scope || null,
                status: 'failed',
                error: { step, code, message },
                sources: sourceCount,
                distilledFiles: writtenCount,
                ...(writtenCount > 0
                    ? { partial: { writtenCount, mergedCount: Number(partial?.mergedCount) || 0 } }
                    : {}),
                costCny: Number(costBreakdown?.costSoFarCny) || 0,
                jobId
            });
            await runStore.updateRun(jobId, {
                learningArchive: { status: 'failed', code: code || null, at: new Date().toISOString() }
            }).catch(() => undefined);
            return true;
        } catch (error) {
            log('forge.history.append_failed', { jobId, message: error.message });
            return false;
        }
    }

    async function restoreJobsFromDisk() {
        if (typeof jobRuntimeService.restoreJob !== 'function') {
            return; // 旧注入的 job 运行时不支持恢复——优雅降级（保持旧行为）。
        }
        let entries;
        try {
            entries = await fs.promises.readdir(runStore.runsRoot, { withFileTypes: true });
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
            return;
        }
        const byStatus = {};
        let identityLostCount = 0;
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('job_')) {
                continue;
            }
            const jobId = entry.name;
            let runRecord;
            try {
                runRecord = await runStore.readRun(jobId);
            } catch {
                continue; // 单条损坏不阻断整批恢复。
            }
            if (!runRecord) {
                continue;
            }
            // 持久化改造前的历史记录没有身份（缺陷 3）——统计并在恢复后放行已识别请求方。
            const hasRestorableIdentity = ['agentId', 'sessionId', 'gatewayId', 'credentialSubject']
                .some((field) => normalizeString(runRecord.authContext?.[field]));
            if (!hasRestorableIdentity) {
                identityLostCount += 1;
            }
            const steps = stepsForJobKind(runRecord);
            const completed = await runStore.scanCompletedSteps(jobId);
            const markers = new Map();
            for (const stepId of completed) {
                markers.set(stepId, await runStore.readStepMarker(jobId, stepId));
            }
            const classification = classifyRestoredRun({ runRecord, steps, markers });
            byStatus[classification.status] = (byStatus[classification.status] || 0) + 1;
            jobRuntimeService.restoreJob({
                jobId,
                status: classification.status,
                operation: operationForJobKind(runRecord.jobKind),
                target: { type: 'forge', id: 'expert' },
                authContext: runRecord.authContext || null,
                metadata: {
                    forge: buildForgeMetadata({
                        runRecord,
                        steps,
                        completedSteps: markers,
                        currentStep: null,
                        costBreakdown: runRecord.cost,
                        extra: classification.extra
                    })
                },
                createdAt: runRecord.createdAt
            });
            // 重启中断的 learn job 也留档——但只归档 ③「跑到一半进程消失」的
            // 新鲜中断：① 终态恢复的历史失败不在此重复归档（每次实例化都补写
            // 会让档案随重启/测试次数线性膨胀，2026-10-14 曾刷出 249 条重复）；
            // learningArchive 标记再做一层跨重启幂等兜底。
            if (classification.extra?.error?.code === 'FORGE_RESTART_INTERRUPTED' && !runRecord.learningArchive) {
                await recordLearnFailureArchive(runRecord, jobId, {
                    step: classification.extra?.error?.step || null,
                    code: classification.extra?.error?.code || 'FORGE_RESTART_INTERRUPTED',
                    message: classification.extra?.error?.message || '进程重启时任务仍在执行',
                    costBreakdown: runRecord.cost
                });
            }
        }
        const restoredCount = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
        if (restoredCount > 0) {
            log('forge.jobs.restored', { count: restoredCount, byStatus, identityLost: identityLostCount });
        }
        return byStatus;
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
        // 固定考卷（反馈 2）：retrial 复用源任务考卷——driveJob 侧加载一次，
        // 读取失败按「无固定卷」处理并由 trial 步的常规出题兜底（不静默换卷
        // 评分：examRef 存在但读不到时显式失败，避免误当新卷）。
        let fixedExam = null;
        if (runRecord.examRef?.sourceJobId) {
            try {
                fixedExam = JSON.parse(await fs.promises.readFile(
                    path.join(runStore.runDir(runRecord.examRef.sourceJobId), 'exams', 'exam.json'), 'utf8'));
            } catch (error) {
                const wrapped = new Error(`固定考卷不可读（源任务 ${runRecord.examRef.sourceJobId}）：${error.message}`);
                wrapped.code = 'FORGE_EXAM_SOURCE_MISSING';
                wrapped.status = 502;
                throw wrapped;
            }
        }
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
                    regradeOf: runRecord.regradeOf || null,
                    examRef: runRecord.examRef || null,
                    fixedExam,
                    examSubskillIds: runRecord.examSubskillIds || null,
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
                // 步内心跳（P2.4）：长步骤（蒸馏分钟级）期间作业记录不再冻结——
                // 定时刷新 updatedAt/进度/费用；心跳失败不阻断步骤。
                const heartbeatIntervalMs = Number.parseInt(process.env.FORGE_STEP_HEARTBEAT_MS || '', 10);
                const heartbeatMs = Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
                    ? heartbeatIntervalMs
                    : 30000;
                let heartbeatTimer = null;
                if (heartbeatMs > 0) {
                    heartbeatTimer = setInterval(() => {
                        try {
                            updateForgeMetadata(jobId, buildForgeMetadata({
                                runRecord, steps, completedSteps: markers, currentStep: step.id, costBreakdown: meter.getBreakdown(),
                                extra: {
                                    progressDetail: `${step.name}（${markers.size + 1}/${steps.length}）进行中`,
                                    heartbeatAt: new Date().toISOString()
                                }
                            }));
                        } catch {
                            // 心跳失败不阻断。
                        }
                    }, heartbeatMs);
                    heartbeatTimer.unref?.();
                }
                let result;
                try {
                    result = await stepRegistry.getRunner(step.id)(ctx) || {};
                } finally {
                    if (heartbeatTimer) {
                        clearInterval(heartbeatTimer);
                    }
                }
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
                    // 持久化暂停标记：重启恢复时按 paused_budget 重建（不误判为中断失败）。
                    await runStore.updateRun(jobId, {
                        budgetPausedAtStep: step.id,
                        budgetPausedAt: new Date().toISOString()
                    });
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
                    // 状态已由取消方置为 cancelled；同步落终态标记供重启恢复。
                    await runStore.updateRun(jobId, { finalStatus: 'cancelled' }).catch(() => undefined);
                    return;
                }
                log('forge.job.failed', { jobId, step: step.id, code: error.code || 'INTERNAL', message: error.message });
                await runStore.updateRun(jobId, { finalStatus: 'failed' }).catch(() => undefined);
                // §3.8 失败也留档（2026-10-14）：此前失败只落 run.json/审计，
                // 面板上看不到——整批超时失败会被长期误读为「没有触发」。
                await recordLearnFailureArchive(runRecord, jobId, {
                    step: step.id,
                    code: error.code || 'INTERNAL',
                    message: error.message,
                    costBreakdown: meter.getBreakdown(),
                    // 失败步骤带回的部分进度（distill 已写盘的卡片数），档案/面板据此
                    // 显示「部分入库」而不是 0（2026-10-17）。
                    partial: error.details?.partial || null
                });
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
                    status: 'completed',
                    sources: sourceCount,
                    distilledFiles: distillMarker?.state?.writtenCount ?? 0,
                    costCny: meter.getBreakdown().costSoFarCny,
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

        await runStore.updateRun(jobId, { finalStatus: 'completed' }).catch(() => undefined);
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
                authContext: trimAuthContextForRun(authContext),
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
            // 归档专家退役：不再接受新的进修（定期批次已在名单层排除，这里兜底手动发起）。
            const expertArchive = readExpertArchive(baseDir, normalizedExpertName);
            if (expertArchive) {
                const error = new Error(`专家已归档（${expertArchive.archivedAt}）：不再接受新的进修；如确需继续学习，先解除归档`);
                error.status = 409;
                error.code = 'FORGE_EXPERT_ARCHIVED';
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
                authContext: trimAuthContextForRun(authContext),
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_LEARN, expertName: normalizedExpertName });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        // 补试岗入口：已注册专家（如 synthesize 完成但 trial 失败/缺成绩）只重跑
        // trial——重新 create 会撞重名（红线 3），此处不触碰注册面。
        // reuseExamFromJobId：固定考卷重考（复用源任务 exam.json，消除重新出卷
        // 噪声）；expectExamHash：期望哈希前缀，不匹配拒绝；subskillIds：抽考
        // 范围（冒烟试岗/定向验证，实操题始终包含）。
        async startExpertRetrialJob({ expertName, budgetCny = null, reuseExamFromJobId = null,
                                       expectExamHash = null, subskillIds = null, authContext = null } = {}) {
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

            // 固定考卷：读取并校验源任务考卷（形状 + 哈希前缀防串卷/防篡改）
            let examRef = null;
            if (reuseExamFromJobId) {
                const sourceExamPath = path.join(runStore.runDir(String(reuseExamFromJobId)), 'exams', 'exam.json');
                let sourceExam;
                try {
                    sourceExam = JSON.parse(await fs.promises.readFile(sourceExamPath, 'utf8'));
                } catch (error) {
                    const wrapped = new Error(`源任务考卷不可读：${sourceExamPath}（${error.message}）`);
                    wrapped.status = 404;
                    wrapped.code = 'AGW_NOT_FOUND';
                    throw wrapped;
                }
                if (!Array.isArray(sourceExam.questions) || sourceExam.questions.length === 0) {
                    const wrapped = new Error('源任务考卷无效（无 questions）');
                    wrapped.status = 400;
                    wrapped.code = 'AGW_VALIDATION_ERROR';
                    throw wrapped;
                }
                const actualHash = crypto.createHash('sha256').update(JSON.stringify(sourceExam.questions)).digest('hex').slice(0, 16);
                if (expectExamHash && !actualHash.startsWith(String(expectExamHash))) {
                    const wrapped = new Error(`考卷哈希不匹配：期望 ${expectExamHash}…，实际 ${actualHash}`);
                    wrapped.status = 409;
                    wrapped.code = 'AGW_VALIDATION_ERROR';
                    wrapped.details = { expectExamHash, actualHash };
                    throw wrapped;
                }
                examRef = { sourceJobId: String(reuseExamFromJobId), examHash: actualHash };
            }

            // 抽考范围：须命中考纲条目
            if (Array.isArray(subskillIds)) {
                const outlined = new Set(expertBlueprint.examOutline.map((entry) => entry.subskillId));
                const hit = subskillIds.filter((id) => outlined.has(id));
                if (hit.length === 0) {
                    const error = new Error(`subskillIds 未命中任何考纲条目：${JSON.stringify(subskillIds)}`);
                    error.status = 400;
                    error.code = 'AGW_VALIDATION_ERROR';
                    throw error;
                }
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
                ...(examRef ? { examRef } : {}),
                ...(Array.isArray(subskillIds) ? { examSubskillIds: subskillIds } : {}),
                budgetCny: Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0 ? Number(budgetCny) : defaultBudgetCny,
                authContext: trimAuthContextForRun(authContext),
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_RETRIAL, expertName: normalizedExpertName });
            scheduleDrive(job.jobId, authContext);
            return { jobId: job.jobId, runRecord };
        },
        // 补判入口（2026-10-12 缺陷 4 ②）：判卷缺失题导致误判不及格后，对源任务
        // 已保存答卷仅重判缺失题——合并既有判卷重算总分，远便宜于整卷重考。
        // expectExamHash：期望的源考卷哈希前缀，不匹配拒绝（防串卷，同补试岗口径）。
        async startExpertRegradeJob({ expertName, sourceJobId, expectExamHash = null, budgetCny = null, authContext = null } = {}) {
            const normalizedExpertName = normalizeString(expertName);
            const normalizedSourceJobId = normalizeString(sourceJobId);
            if (!normalizedExpertName || !normalizedSourceJobId) {
                const error = new Error('expertName 与 sourceJobId 不能为空');
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
            if (!runStore.runExists(normalizedSourceJobId)) {
                const error = new Error(`源任务不存在：${normalizedSourceJobId}`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const sourceExamsDir = path.join(runStore.runDir(normalizedSourceJobId), 'exams');
            for (const file of ['exam.json', 'answers.json', 'grade-report.json']) {
                if (!fs.existsSync(path.join(sourceExamsDir, file))) {
                    const error = new Error(`源任务缺少考试产物 ${file}（${sourceExamsDir}）——补判需要考卷/答卷/判卷报告齐备`);
                    error.status = 404;
                    error.code = 'AGW_NOT_FOUND';
                    throw error;
                }
            }
            let sourceExam;
            let sourceReport;
            try {
                sourceExam = JSON.parse(await fs.promises.readFile(path.join(sourceExamsDir, 'exam.json'), 'utf8'));
                sourceReport = JSON.parse(await fs.promises.readFile(path.join(sourceExamsDir, 'grade-report.json'), 'utf8'));
            } catch (error) {
                const wrapped = new Error(`源任务考试产物解析失败：${error.message}`);
                wrapped.status = 502;
                wrapped.code = 'AGW_VALIDATION_ERROR';
                throw wrapped;
            }
            if (!Array.isArray(sourceExam.questions) || sourceExam.questions.length === 0) {
                const error = new Error('源任务考卷无效（无 questions）');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            if (expectExamHash) {
                const actualHash = crypto.createHash('sha256').update(JSON.stringify(sourceExam.questions)).digest('hex').slice(0, 16);
                if (!actualHash.startsWith(String(expectExamHash))) {
                    const error = new Error(`考卷哈希不匹配：期望前缀 ${expectExamHash}，实际 ${actualHash}（防串卷校验）`);
                    error.status = 409;
                    error.code = 'AGW_VALIDATION_ERROR';
                    throw error;
                }
            }
            // 缺失题预检：判卷完整则无判可补，拒绝启动（省 job）。
            const existingGradedIds = new Set(
                (Array.isArray(sourceReport?.grading?.gradedQuestions) ? sourceReport.grading.gradedQuestions : [])
                    .filter((g) => g && typeof g.id === 'string' && g.scores && typeof g.scores === 'object')
                    .map((g) => g.id)
            );
            const missingIds = sourceExam.questions
                .filter((question) => !existingGradedIds.has(question.id))
                .map((question) => question.id);
            if (missingIds.length === 0) {
                const error = new Error('源任务判卷完整，无缺失题可补判（如需重考请走补试岗）');
                error.status = 400;
                error.code = 'FORGE_REGRADE_NOTHING_MISSING';
                throw error;
            }

            const job = jobRuntimeService.createAcceptedJob({
                operation: FORGE_JOB_OPERATIONS.EXPERT_REGRADE,
                authContext,
                target: { type: 'forge', id: 'expert' },
                metadata: {
                    forge: {
                        jobKind: 'expert.regrade',
                        expertName: normalizedExpertName,
                        sourceJobId: normalizedSourceJobId,
                        missingIds
                    }
                }
            });
            const runRecord = await runStore.initRun({
                jobId: job.jobId,
                jobKind: 'expert.regrade',
                expertName: normalizedExpertName,
                requirement: `regrade: ${normalizedExpertName}（源任务 ${normalizedSourceJobId}，补判 ${missingIds.length} 题）`,
                blueprintPath,
                blueprintApproved: true,
                regradeOf: { jobId: normalizedSourceJobId, examsDir: sourceExamsDir },
                budgetCny: Number.isFinite(Number(budgetCny)) && Number(budgetCny) > 0 ? Number(budgetCny) : defaultBudgetCny,
                authContext: trimAuthContextForRun(authContext),
                runDir: path.relative(path.join(baseDir, '..'), runStore.runDir(job.jobId))
            });
            log('forge.job.started', { jobId: job.jobId, operation: FORGE_JOB_OPERATIONS.EXPERT_REGRADE, expertName: normalizedExpertName, sourceJobId: normalizedSourceJobId, missingIds });
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
                await runStore.updateRun(jobId, {
                    blueprintRejected: true,
                    rejectionFeedback: normalizeString(feedback),
                    finalStatus: 'cancelled'
                });
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
            // 续跑即脱离旧终态/暂停态：清掉重启恢复用的持久化标记。
            const patch = { finalStatus: null, budgetPausedAtStep: null };
            if (Number.isFinite(Number(raiseBudgetToCny)) && Number(raiseBudgetToCny) > 0) {
                patch.budgetCny = Number(raiseBudgetToCny);
                patch.budgetRaises = [...(runRecord.budgetRaises || []), {
                    to: Number(raiseBudgetToCny),
                    at: new Date().toISOString()
                }];
            }
            await runStore.updateRun(jobId, patch);
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
        // ── 专家归档（2026-10-14）──────────────────────────────────────────
        // 归档 = 退役标记，不删除任何产物：定期进修的专家名单默认排除归档者
        // （listExpertNames），新的 learn 一律 409 拒绝；缺口与学习档案仍可回看。
        async archiveExpert(expertName, { reason = null, archivedBy = null } = {}) {
            const name = normalizeString(expertName);
            if (!name || !listExpertNames({ baseDir, includeArchived: true }).includes(name)) {
                const error = new Error(`未知专家：${expertName || ''}（无缺口档案与画像）`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            const marker = await writeExpertArchive(baseDir, name, { reason, archivedBy });
            log('forge.expert.archived', { expertName: name, archivedAt: marker.archivedAt, reason: marker.reason || null });
            return { expertName: name, archived: true, ...marker };
        },
        async unarchiveExpert(expertName) {
            const name = normalizeString(expertName);
            if (!name) {
                const error = new Error('expertName 不能为空');
                error.status = 400;
                error.code = 'AGW_VALIDATION_ERROR';
                throw error;
            }
            const removed = await removeExpertArchive(baseDir, name);
            if (removed) {
                log('forge.expert.unarchived', { expertName: name });
            }
            return { expertName: name, archived: false, removed };
        },
        // ── 专家档案（2026-10-13，AdminPanel 只读视图）──────────────────────
        // 缺口与进修记录一直落在 Agent/forge/<name>/（gaps.json、
        // learning-history.jsonl），此前只有铸造师对话侧能看到；这里给管理面
        // 提供只读汇总与明细，不新增状态存储（与 §3.10 只读观察窗口同口径）。
        async listExperts() {
            const experts = [];
            // 只读展示面（AdminPanel）全量取，含已归档——归档专家仍可回看档案。
            for (const name of listExpertNames({ baseDir, includeArchived: true })) {
                let displayName = null;
                try {
                    const blueprint = await readBlueprint(path.join(baseDir, 'blueprints', `${name}.json`));
                    displayName = blueprint?.displayName || null;
                } catch {
                    // 只有缺口登记、画像缺失（或损坏）的专家：显示名留空，不阻断列表。
                }
                const [gaps, history] = await Promise.all([
                    gapRegistry.readGaps(name),
                    gapRegistry.readLearningHistory(name)
                ]);
                const archive = readExpertArchive(baseDir, name);
                experts.push({
                    expertName: name,
                    displayName,
                    archived: Boolean(archive),
                    archivedAt: archive?.archivedAt || null,
                    totalGaps: gaps.length,
                    openGaps: gaps.filter((gap) => gap?.status === 'open').length,
                    learningCount: history.length,
                    failedCount: history.filter((entry) => entry?.status === 'failed').length,
                    lastLearningAt: history.length > 0 ? history[history.length - 1]?.ts || null : null
                });
            }
            return experts;
        },
        async getExpertRecord(expertName) {
            const name = normalizeString(expertName);
            if (!name || !listExpertNames({ baseDir, includeArchived: true }).includes(name)) {
                const error = new Error(`未知专家：${expertName || ''}（无缺口档案与画像）`);
                error.status = 404;
                error.code = 'AGW_NOT_FOUND';
                throw error;
            }
            let displayName = null;
            try {
                const blueprint = await readBlueprint(path.join(baseDir, 'blueprints', `${name}.json`));
                displayName = blueprint?.displayName || null;
            } catch {
                // 同上：画像缺失不阻断明细读取。
            }
            const [gaps, learningHistory] = await Promise.all([
                gapRegistry.readGaps(name),
                gapRegistry.readLearningHistory(name)
            ]);
            return { expertName: name, displayName, gaps, learningHistory };
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
    // 缺陷 2 修复：启动时从 runDir 恢复 job 注册表（fire-and-forget——扫描
    // 失败只留审计日志，不阻断服务启动）。测试可用 restoreJobsOnBoot: false 关闭。
    if (options.restoreJobsOnBoot !== false) {
        restoreJobsFromDisk().catch((error) => {
            log('forge.jobs.restore_failed', { message: error?.message || String(error) });
        });
    }
    return serviceApi;
}

module.exports = {
    FORGE_JOB_OPERATIONS,
    DEFAULT_BASE_DIR,
    DEFAULT_BUDGET_CNY,
    DEFAULT_FORGE_LLM_TIMEOUT_MS,
    BudgetExceededError,
    JobCancelledError,
    resolveForgeLlmConfig,
    resolveForgeLlmTimeoutMs,
    createForgeRuntimeService
};
