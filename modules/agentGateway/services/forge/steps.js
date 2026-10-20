'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const {
    validateBlueprint,
    writeBlueprint
} = require('./blueprint');
const { createHarvestStepRunner } = require('./harvest');
const { createDistillStepRunner } = require('./distill');
const { createSynthesizeStepRunner } = require('./synthesize');
const { createTrialStepRunner, createRetestStepRunner, createRegradeStepRunner } = require('./trial');
const { ForgeNameConflictError, detectNameConflicts, listExistingAgentNames } = require('./nameConflict');
const { extractJsonObject } = require('./jsonUtils');

/**
 * 铸造五步状态机的步骤定义（§3.2）。
 * M1 交付编排骨架；逐步接入真实能力：blueprint（M1，LLM 起草画像）、
 * harvest（M2.S1，检索采集）、distill（M2.S2，蒸馏入库）与 synthesize
 * （M3.S1，人设合成与注册绑定）与 trial（M4.S1，试岗验收）已实现
 * （经 options.stepRunners 可再覆盖）。
 */

const BLUEPRINT_DRAFT_PROMPT = `你是一名「专家铸造师」。请根据用户的一句话需求，起草一份专家画像（blueprint）JSON。

要求：
- 只输出一个 JSON 对象，不要输出任何其他文字或代码围栏；
- 严格遵循以下结构（全部字段必填，sourceHints 与 persona 的 title/appearance/backstory/quirks 可省略）：
{
  "name": "英文标识，字母开头，仅字母/数字/下划线/连字符，将作为 agent 名",
  "displayName": "中文显示名（职能名）",
  "persona": {
    "name": "人格名，2-6 个汉字，好记有辨识度",
    "title": "人格称号，如：像素炼金术士",
    "appearance": "虚拟形象与自我意象描述",
    "backstory": "身世背景，与专家铸造炉世界观衔接",
    "coreMotto": "核心箴言，一句话",
    "cognitiveStyle": ["思考与工作风格条目1", "条目2"],
    "toneAndExpression": ["语气与交互准则1", "准则2"],
    "quirks": ["标志性口癖或表达习惯"]
  },
  "scope": { "responsibilities": ["职责1", "职责2"], "boundaries": ["明确不做的边界"] },
  "subskills": [
    { "id": "小写slug", "title": "子技能名", "searchQueries": ["检索关键词1", "关键词2"], "sourceHints": ["来源偏好"] }
  ],
  "sourcePolicy": { "preferOfficialDocs": true, "minDomainsPerSubskill": 3, "qualityFilter": "质量过滤规则" },
  "examOutline": [ { "subskillId": "须覆盖全部子技能", "conceptQuestions": 1, "appliedQuestions": 1 } ],
  "practicalExam": { "prompt": "一道实操题", "gradingDimensions": ["维度1", "维度2"] },
  "acceptanceSample": "及格线样例描述"
}
- subskills 拆 4–8 项，每项配 2–3 条中英文检索关键词；
- 考纲 examOutline 必须逐一覆盖全部 subskills；
- 不要编造预算字段（系统会注入默认预算）。

人格设计要求（persona，必填）：
- 为专家设计一个有人格魅力的名字与性格；用户需求中若点名了名字或性格偏好，必须遵从；
- 人格名 2~6 个汉字、有辨识度、与专业领域气质相配；name（agent 英文标识）建议与人格名呼应（音译或意译），仍满足字符约束；
- 身世（backstory）衔接专家铸造炉世界观——从铸造炉中醒来、专属知识库是被铸出来的记忆，与专业领域自然融合，不强行煽情；
- 性格只体现在称呼、语气、表达习惯与思考风格上，不得削弱专业严谨、溯源纪律与边界意识——人设是让专业表达更有辨识度，不是更随意；
- quirks（口癖）0~3 条即可，过密的口癖会干扰专业输出。

用户需求：{{requirement}}`;

class ForgeCapabilityPendingError extends Error {
    constructor(stepId, milestone) {
        super(`步骤「${stepId}」的能力实现属于 ${milestone} 交付范围，当前里程碑尚未接入`);
        this.name = 'ForgeCapabilityPendingError';
        this.code = 'FORGE_STEP_CAPABILITY_PENDING';
        this.status = 501;
        this.details = { stepId, milestone };
    }
}

// ── blueprint 起草的截断韧性（与 trial 作答/出题同款，2026-10-12 缺陷 1）──
// 长结构化需求会诱导更长的画像 JSON，顶满输出上限被切断 → 单次调用直接
// FORGE_BLUEPRINT_DRAFT_INVALID。加固：共 3 次尝试；finish_reason=length 时
// 抬高重试预算；供应商拒收高 max_tokens 时回落；彻底失败把每次原始输出
// 留档 runDir/blueprint-failed/（与 trial-failed/、distill-failed/ 同构）。

const BLUEPRINT_DRAFT_MAX_ATTEMPTS = 3;
const BLUEPRINT_DRAFT_MAX_TOKENS = 4000;
const BLUEPRINT_DRAFT_RETRY_MAX_TOKENS = 12000;
const BLUEPRINT_DRAFT_RETRY_FALLBACK_TOKENS = 8000;

const BLUEPRINT_DRAFT_RETRY_NOTE = '\n\n【重试要求】上一次输出不可解析（可能被输出长度上限截断，或夹带了 JSON 以外的文字）。请重新输出：只输出一个完整可解析的 JSON 对象，不要代码围栏、不要注释、不要在 JSON 前后附加任何文字；内容保持紧凑（searchQueries 等字段只写关键词，不写长句）。';

// 彻底失败前把每次原始输出留档（留档失败不掩盖原始错误）。
async function dumpBlueprintFailure(runDir, attempts, promptPreview) {
    if (!runDir) {
        return;
    }
    try {
        const dir = path.join(runDir, 'blueprint-failed');
        await fsp.mkdir(dir, { recursive: true });
        for (const attempt of attempts) {
            await fsp.writeFile(
                path.join(dir, `blueprint-draft.attempt-${attempt.index}.json`),
                `${JSON.stringify({
                    attempt: attempt.index,
                    finishReason: attempt.finishReason,
                    usage: attempt.usage ?? null,
                    promptPreview,
                    rawContent: attempt.content
                }, null, 2)}\n`,
                'utf8'
            );
        }
    } catch {
        // 尽力而为。
    }
}

async function completeBlueprintDraftResilient({ llm, llmConfig, prompt, logger }) {
    const attempts = [];
    let currentPrompt = prompt;
    let nextMaxTokens = BLUEPRINT_DRAFT_MAX_TOKENS;
    for (let index = 1; index <= BLUEPRINT_DRAFT_MAX_ATTEMPTS; index += 1) {
        const maxTokens = nextMaxTokens;
        const call = async (tokens) => llm.complete(llmConfig, {
            model: llmConfig.model,
            messages: [{ role: 'user', content: currentPrompt }],
            temperature: 0.4,
            max_tokens: tokens
        });
        let response;
        try {
            response = await call(maxTokens);
        } catch (error) {
            // 预算耗尽/协作取消等业务信号必须上抛（不吞进 token 回退重试）。
            if (typeof error?.code === 'string' && error.code.startsWith('FORGE_')) {
                throw error;
            }
            if (maxTokens <= BLUEPRINT_DRAFT_RETRY_FALLBACK_TOKENS) {
                throw error; // 传输/配置类错误快速失败，不吞。
            }
            // 供应商可能拒收超过其输出上限的 max_tokens——回落到既有安全上限再试。
            logger?.(`forge blueprint 第 ${index} 次以 max_tokens=${maxTokens} 被拒（${error.message}），回落 ${BLUEPRINT_DRAFT_RETRY_FALLBACK_TOKENS}`);
            response = await call(BLUEPRINT_DRAFT_RETRY_FALLBACK_TOKENS);
        }
        const choice = response?.data?.choices?.[0];
        const content = choice?.message?.content || '';
        const finishReason = choice?.finish_reason || null;
        attempts.push({ index, finishReason, usage: response?.data?.usage ?? null, content });

        const draft = extractJsonObject(content);
        // 根对象签名守卫：截断残片可能被宽松解析救出嵌套子对象（如 scope），
        // 无 name/displayName 的不是画像本体——视为不可解析，交给重试。
        if (draft && typeof draft === 'object' && !Array.isArray(draft) &&
            typeof draft.name === 'string' && typeof draft.displayName === 'string') {
            return { draft, attempts };
        }
        // 截断（length）→ 抬高重试预算；其余形态 → 追加重试要求后同预算重试。
        nextMaxTokens = finishReason === 'length'
            ? BLUEPRINT_DRAFT_RETRY_MAX_TOKENS
            : maxTokens;
        currentPrompt = prompt + BLUEPRINT_DRAFT_RETRY_NOTE;
        logger?.(`forge blueprint 第 ${index} 次输出不可解析（finish_reason=${finishReason ?? 'unknown'}），${index < BLUEPRINT_DRAFT_MAX_ATTEMPTS ? `重试（${index}/${BLUEPRINT_DRAFT_MAX_ATTEMPTS - 1}）` : '留档失败'}`);
    }
    return { draft: null, attempts };
}

function createPendingStepRunner(stepId, milestone) {
    return async function pendingStep() {
        throw new ForgeCapabilityPendingError(stepId, milestone);
    };
}

function createBlueprintStepRunner({ baseDir }) {
    return async function runBlueprintStep(ctx) {
        const { requirement, llm, llmConfig, logger } = ctx;

        let draft = ctx.blueprintOverride || null;
        let draftAttempts = null;
        if (!draft) {
            if (!llm || llm.available !== true || typeof llm.complete !== 'function') {
                const error = new Error('llmCompletion 端口不可用，无法起草画像');
                error.code = 'FORGE_LLM_UNAVAILABLE';
                error.status = 503;
                throw error;
            }
            if (!llmConfig || !llmConfig.url || !llmConfig.apiKey || !llmConfig.model) {
                const error = new Error('未配置铸造 LLM（ForgeLLMUrl/ForgeLLMApi/ForgeLLMModel 或 AIMemo* 回退），无法起草画像');
                error.code = 'FORGE_LLM_UNAVAILABLE';
                error.status = 503;
                throw error;
            }
            const prompt = BLUEPRINT_DRAFT_PROMPT.replace('{{requirement}}', String(requirement || '').slice(0, 4000));
            logger?.(`forge blueprint drafting for job ${ctx.jobId}`);
            // 截断韧性（缺陷 1）：多次尝试 + 预算抬升 + 失败留档，替代旧的单次调用。
            const outcome = await completeBlueprintDraftResilient({ llm, llmConfig, prompt, logger });
            draftAttempts = outcome.attempts;
            draft = outcome.draft;
            if (!draft) {
                await dumpBlueprintFailure(ctx.runDir, draftAttempts, prompt.slice(0, 2000));
                const error = new Error('LLM 未返回可解析的画像 JSON（原始输出已留档 blueprint-failed/）');
                error.code = 'FORGE_BLUEPRINT_DRAFT_INVALID';
                error.status = 502;
                error.details = {
                    attempts: draftAttempts.map(({ index, finishReason, usage }) => ({
                        attempt: index,
                        finishReason,
                        usage
                    }))
                };
                throw error;
            }
        }

        const existingAgentNames = await listExistingAgentNames(ctx.agentDirectoryPort);
        const conflicts = detectNameConflicts(draft.name, { baseDir: ctx.baseDir, existingAgentNames });
        if (conflicts.length > 0) {
            // 红线 3：默认绝不覆盖，暂停待人工确认（改名或显式覆盖走 confirmBlueprint）。
            throw new ForgeNameConflictError(draft, conflicts);
        }
        const verdict = validateBlueprint(draft, { existingAgentNames });
        if (!verdict.valid) {
            // 解析成功但校验失败同样留档——便于区分「截断/污染」与「结构不合规」两种形态。
            await dumpBlueprintFailure(ctx.runDir, draftAttempts || [], (BLUEPRINT_DRAFT_PROMPT.replace('{{requirement}}', String(requirement || '').slice(0, 4000))).slice(0, 2000));
            const error = new Error(`画像起草未通过校验：${verdict.errors.map((e) => `${e.field}: ${e.message}`).join('；')}`);
            error.code = 'FORGE_BLUEPRINT_INVALID';
            error.status = 400;
            error.details = { errors: verdict.errors };
            throw error;
        }

        const blueprintPath = path.join(baseDir, 'blueprints', `${draft.name}.json`);
        const written = await writeBlueprint(blueprintPath, draft, { existingAgentNames });
        // 人格摘要随 state 进 job 元数据：pending_confirm 时 ForgeMaster 可向用户呈现名字与性格要点。
        const persona = written.persona && typeof written.persona === 'object' ? written.persona : null;
        return {
            summary: `画像已落盘：${persona?.name ? `${persona.name}·` : ''}${draft.displayName}（${draft.subskills.length} 项子技能）`,
            artifacts: [path.relative(baseDir, blueprintPath)],
            state: {
                expertName: written.name,
                displayName: written.displayName,
                blueprintPath,
                ...(persona ? {
                    persona: {
                        name: persona.name,
                        coreMotto: persona.coreMotto,
                        tone: Array.isArray(persona.toneAndExpression) && persona.toneAndExpression.length > 0
                            ? persona.toneAndExpression[0]
                            : ''
                    }
                } : {})
            }
        };
    };
}

/**
 * 步骤注册表。stepRunners 允许后续里程碑替换默认（capability-pending）实现。
 */
function createStepRegistry({
    baseDir,
    knowledgeRoot,
    smokeRetries = null,
    smokeIntervalMs = null,
    distillBatchMaterials = null,
    agentMapPath = null,
    knowledgePolicyPath = null,
    guidanceConfigPath = null,
    memoryPolicyPath = null,
    recallProfilesPath = null,
    stepRunners = {}
}) {
    const defaults = {
        blueprint: createBlueprintStepRunner({ baseDir }),
        harvest: createHarvestStepRunner(),
        distill: createDistillStepRunner({
            knowledgeRoot,
            ...(smokeRetries != null ? { smokeRetries } : {}),
            ...(smokeIntervalMs != null ? { smokeIntervalMs } : {}),
            ...(distillBatchMaterials != null ? { batchMaterials: distillBatchMaterials } : {})
        }),
        // 配置同目录规则：记忆策略/召回档案/guidance 缺省跟随 knowledgePolicyPath
        // 所在目录（生产=agentGateway/config/，测试传临时 policy.json 即整套隔离）。
        // 不各自独立回落 __dirname 默认——否则漏传新路径的测试会把测试专家写进
        // 生产配置（2026-10-20 实发：UIDesigner 条目污染 recall_profiles.json）。
        synthesize: (() => {
            const effectiveKnowledgePolicyPath = knowledgePolicyPath
                || path.join(__dirname, '..', '..', 'config', 'mcp_agent_knowledge_policy.json');
            const configDir = path.dirname(path.resolve(effectiveKnowledgePolicyPath));
            return createSynthesizeStepRunner({
                agentMapPath: agentMapPath || path.join(path.resolve(baseDir, '..', '..'), 'agent_map.json'),
                knowledgePolicyPath: effectiveKnowledgePolicyPath,
                guidanceConfigPath: guidanceConfigPath || path.join(configDir, 'agent_guidance.json'),
                memoryPolicyPath: memoryPolicyPath || path.join(configDir, 'mcp_agent_memory_policy.json'),
                recallProfilesPath: recallProfilesPath || path.join(configDir, 'recall_profiles.json')
            });
        })(),
        trial: createTrialStepRunner(),
        retest: createRetestStepRunner(),
        regrade: createRegradeStepRunner()
    };
    const runners = { ...defaults, ...stepRunners };

    const CREATE_STEPS = Object.freeze([
        { id: 'blueprint', name: '构思', requiresUserConfirm: true },
        { id: 'harvest', name: '采集' },
        { id: 'distill', name: '提炼' },
        { id: 'synthesize', name: '合成' },
        { id: 'trial', name: '试岗' }
    ]);
    const LEARN_STEPS = Object.freeze([
        { id: 'harvest', name: '增量采集' },
        { id: 'distill', name: '增量提炼' }
    ]);
    // §3.7 补试岗：专家已注册，仅重跑 trial（不触碰注册面/重名冲突）。
    const RETRIAL_STEPS = Object.freeze([
        { id: 'trial', name: '试岗（补考）' }
    ]);
    // §3.7：缺口回填的 learn 任务在采集→提炼后附「同一套考题重测」尾步。
    const LEARN_RETEST_STEPS = Object.freeze([
        ...LEARN_STEPS,
        { id: 'retest', name: '回填重测' }
    ]);
    // 2026-10-12 缺陷 4 ②：补判——对源任务已保存答卷仅重判缺失题（不出卷不作答）。
    const REGRADE_STEPS = Object.freeze([
        { id: 'regrade', name: '补判' }
    ]);

    function getRunner(stepId) {
        const runner = runners[stepId];
        if (typeof runner !== 'function') {
            throw new Error(`[ForgeSteps] 未注册的步骤：${stepId}`);
        }
        return runner;
    }

    return { CREATE_STEPS, LEARN_STEPS, LEARN_RETEST_STEPS, RETRIAL_STEPS, REGRADE_STEPS, getRunner };
}

module.exports = {
    BLUEPRINT_DRAFT_PROMPT,
    BLUEPRINT_DRAFT_MAX_ATTEMPTS,
    ForgeCapabilityPendingError,
    ForgeNameConflictError,
    completeBlueprintDraftResilient,
    dumpBlueprintFailure,
    extractJsonObject,
    detectNameConflicts,
    listExistingAgentNames,
    createStepRegistry
};
