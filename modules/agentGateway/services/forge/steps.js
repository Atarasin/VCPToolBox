'use strict';

const fs = require('fs');
const path = require('path');

const {
    validateBlueprint,
    writeBlueprint
} = require('./blueprint');
const { createHarvestStepRunner } = require('./harvest');
const { createDistillStepRunner } = require('./distill');
const { createSynthesizeStepRunner } = require('./synthesize');
const { ForgeNameConflictError, detectNameConflicts, listExistingAgentNames } = require('./nameConflict');
const { extractJsonObject } = require('./jsonUtils');

/**
 * 铸造五步状态机的步骤定义（§3.2）。
 * M1 交付编排骨架；逐步接入真实能力：blueprint（M1，LLM 起草画像）、
 * harvest（M2.S1，检索采集）、distill（M2.S2，蒸馏入库）与 synthesize
 * （M3.S1，人设合成与注册绑定）已实现；trial 由 M4.S1 交付
 * （经 options.stepRunners 可再覆盖）。
 */

const BLUEPRINT_DRAFT_PROMPT = `你是一名「专家铸造师」。请根据用户的一句话需求，起草一份专家画像（blueprint）JSON。

要求：
- 只输出一个 JSON 对象，不要输出任何其他文字或代码围栏；
- 严格遵循以下结构（全部字段必填，sourceHints 可省略）：
{
  "name": "英文标识，字母开头，仅字母/数字/下划线/连字符，将作为 agent 名",
  "displayName": "中文显示名",
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

function createPendingStepRunner(stepId, milestone) {
    return async function pendingStep() {
        throw new ForgeCapabilityPendingError(stepId, milestone);
    };
}

function createBlueprintStepRunner({ baseDir }) {
    return async function runBlueprintStep(ctx) {
        const { requirement, llm, llmConfig, logger } = ctx;

        let draft = ctx.blueprintOverride || null;
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
            const response = await llm.complete(llmConfig, {
                model: llmConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.4,
                max_tokens: 4000
            });
            draft = extractJsonObject(response?.data?.choices?.[0]?.message?.content || '');
            if (!draft) {
                const error = new Error('LLM 未返回可解析的画像 JSON');
                error.code = 'FORGE_BLUEPRINT_DRAFT_INVALID';
                error.status = 502;
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
            const error = new Error(`画像起草未通过校验：${verdict.errors.map((e) => `${e.field}: ${e.message}`).join('；')}`);
            error.code = 'FORGE_BLUEPRINT_INVALID';
            error.status = 400;
            error.details = { errors: verdict.errors };
            throw error;
        }

        const blueprintPath = path.join(baseDir, 'blueprints', `${draft.name}.json`);
        const written = await writeBlueprint(blueprintPath, draft, { existingAgentNames });
        return {
            summary: `画像已落盘：${draft.displayName}（${draft.subskills.length} 项子技能）`,
            artifacts: [path.relative(baseDir, blueprintPath)],
            state: {
                expertName: written.name,
                displayName: written.displayName,
                blueprintPath
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
    agentMapPath = null,
    knowledgePolicyPath = null,
    guidanceConfigPath = null,
    stepRunners = {}
}) {
    const defaults = {
        blueprint: createBlueprintStepRunner({ baseDir }),
        harvest: createHarvestStepRunner(),
        distill: createDistillStepRunner({
            knowledgeRoot,
            ...(smokeRetries != null ? { smokeRetries } : {}),
            ...(smokeIntervalMs != null ? { smokeIntervalMs } : {})
        }),
        synthesize: createSynthesizeStepRunner({
            agentMapPath: agentMapPath || path.join(path.resolve(baseDir, '..', '..'), 'agent_map.json'),
            knowledgePolicyPath: knowledgePolicyPath || path.join(__dirname, '..', '..', 'config', 'mcp_agent_knowledge_policy.json'),
            guidanceConfigPath: guidanceConfigPath || path.join(__dirname, '..', '..', 'config', 'agent_guidance.json')
        }),
        trial: createPendingStepRunner('trial', 'M4.S1')
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

    function getRunner(stepId) {
        const runner = runners[stepId];
        if (typeof runner !== 'function') {
            throw new Error(`[ForgeSteps] 未注册的步骤：${stepId}`);
        }
        return runner;
    }

    return { CREATE_STEPS, LEARN_STEPS, getRunner };
}

module.exports = {
    BLUEPRINT_DRAFT_PROMPT,
    ForgeCapabilityPendingError,
    ForgeNameConflictError,
    extractJsonObject,
    detectNameConflicts,
    listExistingAgentNames,
    createStepRegistry
};
