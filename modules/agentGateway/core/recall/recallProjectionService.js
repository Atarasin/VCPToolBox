/**
 * Recall Projection Service — 将 RecallResult 投影为外部消费格式。
 *
 * 工厂函数 createRecallProjectionService() 提供三种投影：
 *   - projectItems(recallResult)      → 扁平 items[]（含 content、score、sourceDiary 等）
 *   - projectRecallBlocks(recallResult) → recallBlocks[]（含 blockId、content、score、sourceDiary）
 *   - projectFullResult(recallResult, requestId) → 生成对外完整 RecallResult
 */

const PROJECTION_ALIAS_MAP = Object.freeze({
    items: 'items',
    item: 'items',
    semantic: 'items',
    keyword: 'items',
    recall_blocks: 'recallBlocks',
    recall_block: 'recallBlocks',
    recallblock: 'recallBlocks',
    recallblocks: 'recallBlocks',
    block: 'recallBlocks',
    blocks: 'recallBlocks',
    context: 'recallBlocks',
    full_text_sections: 'fullTextSections',
    full_text_section: 'fullTextSections',
    fulltextsections: 'fullTextSections',
    fulltextsection: 'fullTextSections',
    full_text: 'fullTextSections',
    full: 'fullTextSections',
    attachments: 'attachments',
    attachment: 'attachments',
    hybrid: 'hybrid'
});

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeString(item)).filter(Boolean);
    }
    return [];
}

function normalizeProjectionName(value) {
    const normalized = normalizeString(value)
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
    return PROJECTION_ALIAS_MAP[normalized] || '';
}

function resolveActiveProjection(recallResult) {
    const explicitProjection = normalizeProjectionName(recallResult?.diagnostics?.profileMeta?.projection);
    if (explicitProjection) {
        return explicitProjection;
    }

    const ruleProjections = Array.isArray(recallResult?.diagnostics?.rules)
        ? [...new Set(
            recallResult.diagnostics.rules
                .map((rule) => normalizeProjectionName(rule?.projection))
                .filter(Boolean)
        )]
        : [];
    if (ruleProjections.length === 1) {
        return ruleProjections[0];
    }
    if (ruleProjections.length > 1) {
        return 'hybrid';
    }

    const ruleTypes = Array.isArray(recallResult?.diagnostics?.rules)
        ? recallResult.diagnostics.rules.map((rule) => normalizeString(rule?.type))
        : [];
    if (ruleTypes.some((type) => type === 'full_text' || type === 'gated_full_text')) {
        return 'fullTextSections';
    }
    return 'items';
}

function projectItems(recallResult) {
    if (!recallResult || !Array.isArray(recallResult.items)) {
        return [];
    }
    return recallResult.items.map((item) => ({
        content: normalizeString(item?.text),
        score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
        sourceDiary: normalizeString(item?.sourceDiary),
        sourceFile: normalizeString(item?.sourceFile),
        timestamp: item?.timestamp || null,
        tags: normalizeStringArray(item?.tags)
    }));
}

function projectRecallBlocks(recallResult) {
    if (!recallResult || !Array.isArray(recallResult.items)) {
        return [];
    }
    return recallResult.items.map((item, index) => ({
        blockId: `rb-${index}`,
        content: normalizeString(item?.text),
        score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
        sourceDiary: normalizeString(item?.sourceDiary)
    }));
}

function projectFullResult(recallResult, requestId) {
    const base = recallResult && typeof recallResult === 'object' ? recallResult : {};
    const projectedItems = projectItems(base);
    const projectedBlocks = projectRecallBlocks(base);
    const projectedFullTextSections = projectFullTextSections(base);
    const activeProjection = resolveActiveProjection(base);

    return {
        success: base.success !== false,
        agentId: base.agentId || null,
        profileName: base.profileName || null,
        requestId: normalizeString(requestId) || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        projectedAt: Date.now(),
        activeProjection,
        items: projectedItems,
        recallBlocks: projectedBlocks,
        fullTextSections: projectedFullTextSections,
        attachments: base.diagnostics?.attachments || [],
        diagnostics: base.diagnostics || { totalDurationMs: 0, rules: [] },
        error: base.error || null,
        code: base.code || null,
        status: base.status || (base.success !== false ? 200 : 500)
    };
}

function projectFullTextSections(recallResult) {
    if (!recallResult || !Array.isArray(recallResult.items)) {
        return [];
    }

    const grouped = new Map();
    for (const item of recallResult.items) {
        const diary = normalizeString(item?.sourceDiary) || 'unknown';
        if (!grouped.has(diary)) {
            grouped.set(diary, []);
        }
        grouped.get(diary).push({
            content: normalizeString(item?.text),
            score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
            sourceFile: normalizeString(item?.sourceFile),
            timestamp: item?.timestamp || null,
            tags: normalizeStringArray(item?.tags)
        });
    }

    const sections = [];
    let sectionIndex = 0;
    for (const [diary, entries] of grouped) {
        entries.sort((a, b) => b.score - a.score);
        const combinedScore = entries.reduce((sum, entry) => sum + entry.score, 0);
        sections.push({
            sectionId: `fts-${sectionIndex}`,
            diaryName: diary,
            entries,
            entryCount: entries.length,
            combinedScore
        });
        sectionIndex += 1;
    }

    sections.sort((a, b) => b.combinedScore - a.combinedScore);
    sections.forEach((section, index) => {
        section.sectionId = `fts-${index}`;
    });

    return sections;
}

const { estimateTokenCount, truncateTextByTokens } = require('./tokenText');
const { selectBudgetedItems } = require('./tokenBudget');

function projectBudgetedContextBlocks(items, options) {
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const selected = selectBudgetedItems(items, { ...opts, maxItems: opts.maxBlocks });
    const selectedItems = selected.items;

    const blocks = projectContextBlocks(selectedItems);
    for (let i = 0; i < blocks.length; i += 1) {
        if (selectedItems[i].__truncated) {
            blocks[i].metadata.truncated = true;
        }
    }

    const appliedPolicy = {
        ...(selected.policy.tokenBudget !== undefined ? { tokenBudget: selected.policy.tokenBudget } : {}),
        ...(selected.policy.maxTokenRatio !== undefined ? { maxTokenRatio: selected.policy.maxTokenRatio } : {}),
        ...(selected.policy.tokenLimit !== undefined ? { maxInjectedTokens: selected.policy.tokenLimit } : {}),
        ...(selected.policy.maxItems !== undefined ? { maxBlocks: selected.policy.maxItems } : {}),
        ...(selected.policy.minScore !== undefined ? { minScore: selected.policy.minScore } : {}),
        filteredByMinScore: selected.filteredByMinScore,
        truncatedCount: selected.truncatedCount
    };

    return { blocks, consumedTokens: selected.consumedTokens, appliedPolicy };
}

function projectSearchItems(items) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items.map((item) => ({
        text: normalizeString(item?.text),
        score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
        sourceDiary: normalizeString(item?.sourceDiary),
        sourceFile: normalizeString(item?.sourceFile),
        timestamp: item?.timestamp || null,
        tags: normalizeStringArray(item?.tags)
    }));
}

function projectContextBlocks(items) {
    if (!Array.isArray(items)) {
        return [];
    }
    return items.map((item) => {
        const text = normalizeString(item?.text);
        const sourceDiary = normalizeString(item?.sourceDiary);
        const sourceFile = normalizeString(item?.sourceFile);
        const tags = normalizeStringArray(item?.tags);
        const estimatedTokens = estimateTokenCount(text);
        return {
            text,
            metadata: {
                score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
                sourceDiary,
                sourceFile,
                timestamp: item?.timestamp || null,
                tags,
                estimatedTokens
            }
        };
    });
}

function createRecallProjectionService() {
    return {
        projectItems,
        projectRecallBlocks,
        projectFullResult,
        projectFullTextSections,
        projectSearchItems,
        projectContextBlocks,
        projectBudgetedContextBlocks,
        truncateTextByTokens
    };
}

module.exports = {
    createRecallProjectionService,
    projectItems,
    projectRecallBlocks,
    projectFullResult,
    projectFullTextSections,
    projectSearchItems,
    projectContextBlocks,
    projectBudgetedContextBlocks,
    truncateTextByTokens,
    estimateTokenCount,
    resolveActiveProjection
};
