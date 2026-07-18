const { applyBudgetPostProcessing } = require('../tokenBudget');

function applyBudgetStage(state) {
    const startedAt = Date.now();
    const result = applyBudgetPostProcessing(state.items, state.resolved);
    state.items = result.items;
    if (!result.skipped) {
        state.pipelineStages.push({
            name: 'budgetFilter',
            durationMs: Date.now() - startedAt,
            status: 'ok',
            detail: {
                inputItemCount: result.inputItemCount,
                outputItemCount: result.outputItemCount,
                minScoreApplied: result.minScoreApplied,
                tokenBudgetApplied: result.tokenBudgetApplied,
                maxTokenRatioApplied: result.maxTokenRatioApplied,
                tokensConsumed: result.consumedTokens
            }
        });
    }
}

module.exports = { applyBudgetStage };
