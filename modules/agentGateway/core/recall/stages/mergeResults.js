const {
    aggregateDeduplicateItems,
    applyTruncate,
    createRecallBlock,
    interleaveItems,
    itemKey,
    sortItemsByScore
} = require('../recallItem');

function mergeResultsStage(state) {
    const startedAt = Date.now();
    const strategy = state.resolved.merge;
    const aggregate = state.resolved.aggregate;
    const flat = state.ruleItems.flat();
    let items;
    const detail = {
        strategy: strategy || 'default',
        aggregate: aggregate || 'max',
        inputRuleCount: state.ruleItems.length,
        inputItemCount: flat.length,
        outputItemCount: 0
    };
    if (strategy === 'interleave') {
        const deduped = aggregateDeduplicateItems(flat, aggregate);
        const byKey = new Map(deduped.map((item) => [itemKey(item), item]));
        const seen = new Set();
        const byRule = state.ruleItems.map((group) => group.flatMap((item) => {
            const key = itemKey(item);
            if (seen.has(key) || !byKey.has(key)) return [];
            seen.add(key);
            return [byKey.get(key)];
        }));
        items = interleaveItems(byRule.map(sortItemsByScore));
        detail.interleavedRuleCount = byRule.filter((group) => group.length).length;
    } else {
        items = sortItemsByScore(aggregateDeduplicateItems(flat, aggregate));
        detail.deduplicatedCount = items.length;
    }
    items = applyTruncate(items, state.resolved.truncateTo).map(createRecallBlock);
    detail.outputItemCount = items.length;
    state.items = items;
    state.pipelineStages.push({
        name: 'mergeResults',
        durationMs: Date.now() - startedAt,
        status: 'ok',
        detail
    });
}

module.exports = { mergeResultsStage };
