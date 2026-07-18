function normalize(value) { return typeof value === 'string' ? value.trim() : ''; }
function itemKey(item) {
    return [normalize(item?.sourceDiary), normalize(item?.sourceFile || item?.source_file), normalize(item?.text)].join('::');
}
function deduplicateItems(items) {
    const seen = new Map();
    for (const item of items) {
        const existing = seen.get(itemKey(item));
        if (!existing || (item?.score || 0) > (existing?.score || 0)) seen.set(itemKey(item), item);
    }
    return Array.from(seen.values());
}
function aggregateDeduplicateItems(items, strategy = 'max') {
    const seen = new Map();
    for (const item of items) {
        const key = itemKey(item);
        const score = Number.isFinite(item?.score) ? item.score : 0;
        const entry = seen.get(key);
        if (entry) entry.scores.push(score); else seen.set(key, { item, scores: [score] });
    }
    return Array.from(seen.values(), ({ item, scores }) => {
        const score = strategy === 'sum' ? scores.reduce((a, b) => a + b, 0)
            : strategy === 'mean' ? scores.reduce((a, b) => a + b, 0) / scores.length
                : Math.max(...scores);
        return { ...item, score };
    });
}
function sortItemsByScore(items) { return [...items].sort((a, b) => (b?.score || 0) - (a?.score || 0)); }
function applyTruncate(items, limit) { return Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items; }
function createRecallBlock(item) {
    return {
        text: normalize(item?.text),
        score: Number.isFinite(item?.score) ? item.score : 0,
        sourceDiary: normalize(item?.sourceDiary),
        sourceFile: normalize(item?.sourceFile || item?.source_file),
        timestamp: item?.timestamp || null,
        tags: Array.isArray(item?.tags || item?.matchedTags) ? (item.tags || item.matchedTags).map(normalize).filter(Boolean) : []
    };
}
function interleaveItems(arrays) {
    const groups = Array.isArray(arrays) ? arrays.filter(Array.isArray) : [];
    const result = [];
    const max = groups.length ? Math.max(...groups.map((group) => group.length)) : 0;
    for (let index = 0; index < max; index += 1) {
        for (const group of groups) if (index < group.length) result.push(group[index]);
    }
    return result;
}
module.exports = { aggregateDeduplicateItems, applyTruncate, createRecallBlock, deduplicateItems, interleaveItems, itemKey, sortItemsByScore };
