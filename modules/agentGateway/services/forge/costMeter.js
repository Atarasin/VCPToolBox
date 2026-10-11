'use strict';

/**
 * 铸造预算护栏：逐环节累计模型调用费用估算。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.2（Q2 默认 10 元/次）。
 *
 * - LLM 调用按 token 用量 × 模型单价（元 / 1K tokens）估算；
 * - 插件调用按单价表中的固定条目估算（缺省 0——搜索插件费用计入宿主插件自身账）；
 * - ≥90% 上限 → warning（继续执行）；≥100% → exceeded（调用方应暂停 job）。
 */

const BUDGET_WARN_RATIO = 0.9;

// 保守默认单价表（元 / 1K tokens，输入/输出）。真实单价随供应商变动，
// 可经 config JSON 覆盖；未知模型走 fallback。
const DEFAULT_MODEL_PRICES = Object.freeze({
    fallback: { input: 0.008, output: 0.024 },
    models: {
        'gpt-4o-mini': { input: 0.0011, output: 0.0033 },
        'gpt-4o': { input: 0.0175, output: 0.07 },
        'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
        'gpt-4.1': { input: 0.002, output: 0.008 },
        'claude-sonnet-4-5': { input: 0.003, output: 0.015 },
        'claude-haiku-4-5': { input: 0.001, output: 0.005 },
        'gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
        'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
        'deepseek-chat': { input: 0.00027, output: 0.0011 },
        // DeepSeek 官方价（元/百万 tokens）换算为元/1K，双档按调用时刻判定：
        // flash: 输入未命中 1(空闲)/2(高峰)、输出 4/8 元/M
        // v4-pro: 输入 4.5/9、输出 13.5/27 元/M（缓存命中价忽略，保守按未命中）
        'deepseek-flash': {
            peak: { input: 0.002, output: 0.008 },
            offpeak: { input: 0.001, output: 0.004 }
        },
        'deepseek-v4-flash': {
            peak: { input: 0.002, output: 0.008 },
            offpeak: { input: 0.001, output: 0.004 }
        },
        'deepseek-v4-pro': {
            peak: { input: 0.009, output: 0.027 },
            offpeak: { input: 0.0045, output: 0.0135 }
        },
        'glm-4.7': { input: 0.0006, output: 0.0022 },
        'qwen-plus': { input: 0.0004, output: 0.0012 }
    }
});

// DeepSeek 官方时段定义：北京时间周一至五 9:00-12:00、14:00-18:00 为高峰，
// 其余（含周末）为空闲（价格为高峰一半）；法定节假日无法本地判定，按高峰
// 处理——估算偏保守（护栏宁高勿漏）。
function isPeakBeijingTime(date) {
    const beijing = new Date(date.getTime() + 8 * 3600 * 1000);
    const day = beijing.getUTCDay(); // 0=周日 … 6=周六
    const hour = beijing.getUTCHours();
    if (day === 0 || day === 6) {
        return false;
    }
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

// 条目支持双档：{ peak: {input, output}, offpeak: {...} } 或单档 {input, output}。
function resolveTier(entry, now) {
    if (entry && entry.peak && entry.offpeak) {
        return isPeakBeijingTime(now) ? entry.peak : entry.offpeak;
    }
    return entry;
}

function resolveModelPrice(prices, model, now = new Date()) {
    const table = prices && typeof prices === 'object' ? prices : DEFAULT_MODEL_PRICES;
    const models = table.models && typeof table.models === 'object' ? table.models : {};
    const direct = resolveTier(models[model], now);
    if (direct && Number.isFinite(direct.input) && Number.isFinite(direct.output)) {
        return direct;
    }
    // 前缀匹配（覆盖带日期后缀等变体，如 gpt-4o-2024-08-06）。
    const matchedKey = Object.keys(models)
        .filter((key) => typeof model === 'string' && model.startsWith(key))
        .sort((a, b) => b.length - a.length)[0];
    if (matchedKey) {
        const matched = resolveTier(models[matchedKey], now);
        if (matched && Number.isFinite(matched.input)) {
            return matched;
        }
    }
    const fallback = table.fallback && Number.isFinite(table.fallback.input)
        ? table.fallback
        : DEFAULT_MODEL_PRICES.fallback;
    return fallback;
}

function createCostMeter({ budgetCny, prices = null, warnRatio = BUDGET_WARN_RATIO, initialEntries = null, nowFn = null } = {}) {
    if (!Number.isFinite(budgetCny) || budgetCny <= 0) {
        throw new Error(`[ForgeCostMeter] 预算必须是正数，收到：${budgetCny}`);
    }
    const entries = [];
    let totalCny = 0;

    // 断点续跑：从 run.json 恢复历史费用（预算按累计口径，不因重试清零）。
    for (const entry of Array.isArray(initialEntries) ? initialEntries : []) {
        if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.costCny)) {
            continue;
        }
        entries.push({ ...entry });
        totalCny += entry.costCny;
    }

    function getBreakdown() {
        const byModel = {};
        for (const entry of entries) {
            const key = entry.kind === 'llm' ? `llm:${entry.model}` : `tool:${entry.plugin}`;
            if (!byModel[key]) {
                byModel[key] = { kind: entry.kind, calls: 0, costCny: 0 };
            }
            byModel[key].calls += 1;
            byModel[key].costCny = Math.round((byModel[key].costCny + entry.costCny) * 1e6) / 1e6;
        }
        return {
            budgetCny,
            warnThresholdCny: Math.round(budgetCny * warnRatio * 1e6) / 1e6,
            costSoFarCny: Math.round(totalCny * 1e6) / 1e6,
            entries: entries.map((entry) => ({ ...entry })),
            byModel
        };
    }

    return {
        get budgetCny() {
            return budgetCny;
        },
        recordLlm({ model, promptTokens, completionTokens, step }) {
            const price = resolveModelPrice(prices, model, nowFn ? nowFn() : new Date());
            const input = Math.max(0, Number(promptTokens) || 0);
            const output = Math.max(0, Number(completionTokens) || 0);
            const costCny = (input / 1000) * price.input + (output / 1000) * price.output;
            totalCny += costCny;
            const entry = {
                kind: 'llm',
                model: String(model || 'unknown'),
                promptTokens: input,
                completionTokens: output,
                costCny: Math.round(costCny * 1e6) / 1e6,
                step: step || null
            };
            entries.push(entry);
            return entry;
        },
        recordTool({ plugin, costCny = 0, step }) {
            const cost = Math.max(0, Number(costCny) || 0);
            totalCny += cost;
            const entry = {
                kind: 'tool',
                plugin: String(plugin || 'unknown'),
                costCny: Math.round(cost * 1e6) / 1e6,
                step: step || null
            };
            entries.push(entry);
            return entry;
        },
        check() {
            const costSoFarCny = Math.round(totalCny * 1e6) / 1e6;
            if (totalCny >= budgetCny) {
                return { level: 'exceeded', costSoFarCny, budgetCny };
            }
            if (totalCny >= budgetCny * warnRatio) {
                return { level: 'warning', costSoFarCny, budgetCny };
            }
            return { level: 'ok', costSoFarCny, budgetCny };
        },
        getBreakdown
    };
}

module.exports = {
    BUDGET_WARN_RATIO,
    isPeakBeijingTime,
    DEFAULT_MODEL_PRICES,
    createCostMeter
};
