const { estimateTokenCount, truncateTextByTokens } = require('./tokenText');

function normalizeBudgetOptions(options = {}) {
    const tokenBudget = Number.isFinite(options.tokenBudget) && options.tokenBudget > 0
        ? Math.floor(options.tokenBudget) : undefined;
    const maxTokenRatio = Number.isFinite(options.maxTokenRatio)
        ? Math.max(0.1, Math.min(1, options.maxTokenRatio)) : undefined;
    const minScore = Number.isFinite(options.minScore)
        ? Math.max(0, Math.min(1, options.minScore)) : undefined;
    const maxItems = Number.isFinite(options.maxItems ?? options.maxBlocks) && (options.maxItems ?? options.maxBlocks) > 0
        ? Math.floor(options.maxItems ?? options.maxBlocks) : undefined;
    const tokenLimit = tokenBudget !== undefined && maxTokenRatio !== undefined
        ? Math.max(1, Math.floor(tokenBudget * maxTokenRatio)) : undefined;
    return { tokenBudget, maxTokenRatio, minScore, maxItems, tokenLimit };
}

function selectBudgetedItems(items, options = {}) {
    const policy = normalizeBudgetOptions(options);
    const input = Array.isArray(items) ? items : [];
    const eligible = policy.minScore === undefined
        ? input
        : input.filter((item) => Number.isFinite(item?.score) && item.score >= policy.minScore);
    const selected = [];
    let consumedTokens = 0;
    let truncatedCount = 0;

    for (const item of eligible) {
        if (policy.maxItems !== undefined && selected.length >= policy.maxItems) break;
        const tokens = estimateTokenCount(item?.text);
        if (policy.tokenLimit !== undefined && consumedTokens > 0 && consumedTokens + tokens > policy.tokenLimit) continue;
        if (policy.tokenLimit !== undefined && tokens > policy.tokenLimit) {
            const text = truncateTextByTokens(item?.text, Math.max(1, policy.tokenLimit - consumedTokens));
            if (text) {
                selected.push({ ...item, text, __truncated: true });
                consumedTokens += estimateTokenCount(text);
                truncatedCount += 1;
            }
            break;
        }
        selected.push(item);
        consumedTokens += tokens;
    }
    return {
        items: selected, consumedTokens, truncatedCount,
        inputItemCount: input.length, outputItemCount: selected.length,
        filteredByMinScore: input.length - eligible.length, policy
    };
}

function applyBudgetPostProcessing(items, resolved) {
    const { tokenBudget, maxTokenRatio, minScore } = resolved || {};
    if (tokenBudget === undefined && maxTokenRatio === undefined && minScore === undefined) {
        return { items, skipped: true, consumedTokens: 0, inputItemCount: items.length, outputItemCount: items.length };
    }
    const result = selectBudgetedItems(items, { tokenBudget, maxTokenRatio, minScore });
    return {
        ...result, skipped: false,
        minScoreApplied: minScore !== undefined,
        tokenBudgetApplied: tokenBudget !== undefined,
        maxTokenRatioApplied: maxTokenRatio !== undefined
    };
}

module.exports = { applyBudgetPostProcessing, normalizeBudgetOptions, selectBudgetedItems };
