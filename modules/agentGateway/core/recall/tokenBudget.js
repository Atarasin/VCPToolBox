const { estimateTokenCount, truncateTextByTokens } = require('./recallProjectionService');

function applyBudgetPostProcessing(items, resolved) {
    const { tokenBudget, maxTokenRatio, minScore } = resolved || {};
    if (tokenBudget === undefined && maxTokenRatio === undefined && minScore === undefined) {
        return { items, skipped: true, consumedTokens: 0, inputItemCount: items.length, outputItemCount: items.length };
    }
    const limit = tokenBudget !== undefined && maxTokenRatio !== undefined
        ? Math.max(1, Math.floor(tokenBudget * maxTokenRatio)) : undefined;
    const eligible = minScore === undefined ? items : items.filter((item) => Number.isFinite(item?.score) && item.score >= minScore);
    const selected = [];
    let consumedTokens = 0;
    let truncatedCount = 0;
    for (const item of eligible) {
        const tokens = estimateTokenCount(item?.text);
        if (limit !== undefined && consumedTokens > 0 && consumedTokens + tokens > limit) continue;
        if (limit !== undefined && tokens > limit) {
            const text = truncateTextByTokens(item?.text, Math.max(1, limit - consumedTokens));
            if (text) {
                selected.push({ ...item, text });
                consumedTokens += estimateTokenCount(text);
                truncatedCount += 1;
            }
            break;
        }
        selected.push(item);
        consumedTokens += tokens;
    }
    return {
        items: selected, skipped: false, consumedTokens, truncatedCount,
        inputItemCount: items.length, outputItemCount: selected.length,
        minScoreApplied: minScore !== undefined,
        tokenBudgetApplied: tokenBudget !== undefined,
        maxTokenRatioApplied: maxTokenRatio !== undefined
    };
}

module.exports = { applyBudgetPostProcessing };
