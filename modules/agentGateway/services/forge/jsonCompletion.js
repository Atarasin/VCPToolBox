'use strict';

/**
 * 结构化 JSON 调用的弹性阶梯（2026-10-17 缺陷修复，蒸馏/判卷/出题共用）。
 *
 * 事故：铸造 LLM 是思考型模型，思考 token 与正文共享 max_tokens 上限。难任务
 * （长答卷判卷、单篇长材料蒸馏）上思考段可吃满 8000，`message.content` 一个字
 * 不剩——留档实测 reasoning_tokens 7999/8000/8001、正文 0 字符。旧实现在此形态
 * 下只会「同 prompt、同上限」重试，等于把同一场失败确定性重演三遍（10-16 定期
 * 进修那次三次尝试合计烧掉约 22k 输出 token，零产出，整单报废）。
 *
 * 本模块把重试改成真正的阶梯：
 * - 第 1 次：budget = maxTokens（缺省 8000）；
 * - 第 2 次起：正文为空或被截断时把预算抬到 retryMaxTokens（缺省 32000），
 *   供应商拒收高上限则回落 retryFallbackTokens（缺省 12000）再试；
 * - 正文为空但推理段有内容 → 从推理段抢救 JSON（模型常把结构化结果写在思考里）；
 * - 正文为空时可选关思考（thinking.type=disabled，见 resolveThinkingMode）——
 *   纯抽取/结构化任务直接掐掉推理段，供应商拒收该字段则去字段重试一次并记忆；
 * - 全部尝试正文为空 → failureReason='empty-content'（调用方抛
 *   FORGE_LLM_EMPTY_CONTENT，与「有正文但不可解析」区分）；否则 'unparseable'。
 *
 * 留档由调用方做：每次尝试（含失败）经 onAttempt 回调外抛，调用方累积后按既有
 * 形态写 distill-failed/ 或 trial-failed/（本模块不碰文件系统）。
 * onAttempt 返回 'stop' 可立即中止阶梯——调用方自会接管（如蒸馏的拆半重蒸）。
 */

const { extractJsonObject } = require('./jsonUtils');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_RETRY_MAX_TOKENS = 32000;
const DEFAULT_RETRY_FALLBACK_TOKENS = 12000;

const THINKING_DISABLED = Object.freeze({ type: 'disabled' });

// 供应商对 thinking 开关的接受度（按 endpoint|model 记忆）：被 4xx 拒收后该模型
// 不再携带该字段——否则换到不认这个字段的供应商时，整批蒸馏直接失败。
const thinkingRejectedModels = new Set();

function resetThinkingSupportCache() {
    thinkingRejectedModels.clear();
}

/**
 * 思考开关策略（调用方按步骤读 env）：'disabled' 关思考、'enabled' 保持默认。
 * 缺省值由调用方给（蒸馏关、判卷/出题保持）。
 */
function resolveThinkingMode(name, fallback = 'enabled', env = process.env) {
    const raw = String(env?.[name] ?? '').trim().toLowerCase();
    if (!raw) {
        return fallback;
    }
    return ['disabled', 'off', '0', 'false', 'no'].includes(raw) ? 'disabled' : 'enabled';
}

function providerStatus(error) {
    const status = Number(error?.response?.status);
    return Number.isFinite(status) ? status : null;
}

// 供应商拒收请求体（上限过高/不认识 thinking 字段）——4xx 即判定为请求被拒。
function isProviderRejection(error) {
    const status = providerStatus(error);
    return status === 400 || status === 422;
}

// FORGE_* 是业务信号（预算耗尽/协作取消/端口不可用）——原样上抛，不参与降级重试。
function isForgeBusinessError(error) {
    return typeof error?.code === 'string' && error.code.startsWith('FORGE_');
}

function attemptReasoningTokens(usage) {
    const tokens = Number(usage?.completion_tokens_details?.reasoning_tokens);
    return Number.isFinite(tokens) ? tokens : null;
}

/**
 * 弹性 JSON 补全：解析 → 元素级抢救 → 推理段兜底 → 抬预算重试。
 *
 * 返回 { payload, attempts, failureReason, emptyContentCount, salvagedFrom }；
 * payload 为 null 时 failureReason ∈ {'empty-content', 'unparseable'}，
 * attempts 为每次尝试的原始记录（含 content/usage/finishReason/maxTokens）。
 */
async function completeJsonResilient({
    llm,
    llmConfig,
    prompt,
    temperature = 0.2,
    validate,
    salvage = null,
    logger = null,
    label = 'json',
    maxTokens = DEFAULT_MAX_TOKENS,
    retryMaxTokens = DEFAULT_RETRY_MAX_TOKENS,
    retryFallbackTokens = DEFAULT_RETRY_FALLBACK_TOKENS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryNote = '',
    thinking = null,
    onAttempt = null
} = {}) {
    if (typeof validate !== 'function') {
        throw new Error('completeJsonResilient 需要 validate 回调');
    }
    const attempts = [];
    const thinkingKey = `${llmConfig?.url || ''}|${llmConfig?.model || ''}`;
    let thinkingDisabled = thinking === 'disabled' && !thinkingRejectedModels.has(thinkingKey);
    let currentPrompt = prompt;
    let currentMaxTokens = maxTokens;
    let emptyContentCount = 0;
    let halted = false;

    const callOnce = async () => {
        const requestPayload = {
            model: llmConfig.model,
            messages: [{ role: 'user', content: currentPrompt }],
            temperature,
            max_tokens: currentMaxTokens
        };
        if (thinkingDisabled) {
            requestPayload.thinking = THINKING_DISABLED;
        }
        return llm.complete(llmConfig, requestPayload);
    };

    for (let index = 1; index <= maxAttempts; index += 1) {
        let response;
        try {
            response = await callOnce();
        } catch (error) {
            if (isForgeBusinessError(error)) {
                throw error;
            }
            if (thinkingDisabled && isProviderRejection(error)) {
                thinkingRejectedModels.add(thinkingKey);
                thinkingDisabled = false;
                logger?.(`${label}: 供应商拒收 thinking 开关（${error.message}），去掉开关重试`);
                response = await callOnce();
            } else if (isProviderRejection(error) && currentMaxTokens > retryFallbackTokens) {
                logger?.(`${label}: max_tokens=${currentMaxTokens} 被拒（${error.message}），回落 ${retryFallbackTokens} 再试`);
                currentMaxTokens = retryFallbackTokens;
                response = await callOnce();
            } else {
                throw error;
            }
        }

        const choice = response?.data?.choices?.[0];
        const message = choice?.message || {};
        const content = typeof message.content === 'string' ? message.content : '';
        // 推理段字段名随供应商而异（reasoning_content 为主流，部分网关叫 reasoning）。
        const reasoningField = typeof message.reasoning_content === 'string'
            ? message.reasoning_content
            : (typeof message.reasoning === 'string' ? message.reasoning : '');
        const finishReason = choice?.finish_reason || null;
        const usage = response?.data?.usage ?? null;
        const blank = content.trim().length === 0;
        if (blank) {
            emptyContentCount += 1;
        }
        const attempt = {
            index,
            finishReason,
            usage,
            content,
            maxTokens: currentMaxTokens,
            thinking: thinkingDisabled ? 'disabled' : null,
            reasoningTokens: attemptReasoningTokens(usage),
            blank
        };
        attempts.push(attempt);

        let payload = extractJsonObject(content);
        let source = 'content';
        if (!validate(payload) && typeof salvage === 'function') {
            payload = salvage(content);
            source = 'content-salvage';
        }
        if (!validate(payload) && blank && reasoningField.trim().length > 0) {
            payload = extractJsonObject(reasoningField);
            source = 'reasoning';
            if (!validate(payload) && typeof salvage === 'function') {
                payload = salvage(reasoningField);
                source = 'reasoning-salvage';
            }
        }
        if (validate(payload)) {
            if (source !== 'content') {
                const where = source.startsWith('reasoning') ? '推理段' : '截断输出';
                logger?.(`${label}: 正文不可用（${blank ? '正文为空（推理段占用输出预算）' : `finish_reason=${finishReason ?? 'unknown'}`}），从${where}抢救出结构化结果`);
                if (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.salvaged === undefined) {
                    payload = { ...payload, salvaged: true };
                }
            }
            return { payload, attempts, failureReason: null, emptyContentCount, salvagedFrom: source === 'content' ? null : source };
        }

        // 调用方接管（如蒸馏的拆半重蒸）：立即中止阶梯，不再抬预算/重试。
        if (typeof onAttempt === 'function' && onAttempt(attempt) === 'stop') {
            halted = true;
            break;
        }

        if (index < maxAttempts) {
            const unusable = finishReason === 'length' || blank;
            if (unusable && currentMaxTokens < retryMaxTokens) {
                logger?.(`${label}: 第 ${index} 次${blank ? '正文为空（推理段占用输出预算）' : '输出被截断'}（finish_reason=${finishReason ?? 'unknown'}），输出预算抬到 ${retryMaxTokens} 重试`);
                currentMaxTokens = retryMaxTokens;
            } else {
                logger?.(`${label}: 第 ${index} 次输出不可解析（finish_reason=${finishReason ?? 'unknown'}），重试（${index}/${maxAttempts - 1}）`);
            }
            if (retryNote) {
                currentPrompt = prompt + retryNote;
            }
        }
    }

    const allBlank = attempts.length > 0 && attempts.every((attempt) => attempt.blank);
    return {
        payload: null,
        attempts,
        failureReason: allBlank ? 'empty-content' : 'unparseable',
        emptyContentCount,
        salvagedFrom: null,
        halted
    };
}

/**
 * 失败原因人话化（错误消息与留档共用）：把「正文为空」与「JSON 不可解析」分开，
 * 面板/日志一眼可辨模型到底吐了什么。
 */
function describeAttemptFailure(attempts) {
    const reasons = attempts.map((attempt) => attempt.finishReason ?? 'unknown').join('/');
    const reasoningTokens = attempts
        .map((attempt) => (attempt.reasoningTokens === null ? '?' : attempt.reasoningTokens))
        .join('/');
    const blankCount = attempts.filter((attempt) => attempt.blank).length;
    return {
        finishReasons: reasons,
        reasoningTokens,
        blankCount,
        summary: blankCount === attempts.length && attempts.length > 0
            ? `正文为空（${attempts.length} 次尝试均无正文，推理段 token ${reasoningTokens}）`
            : `输出不可解析（finish_reason=${reasons}）`
    };
}

module.exports = {
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_MAX_TOKENS,
    DEFAULT_RETRY_MAX_TOKENS,
    DEFAULT_RETRY_FALLBACK_TOKENS,
    THINKING_DISABLED,
    completeJsonResilient,
    describeAttemptFailure,
    isProviderRejection,
    resetThinkingSupportCache,
    resolveThinkingMode
};
