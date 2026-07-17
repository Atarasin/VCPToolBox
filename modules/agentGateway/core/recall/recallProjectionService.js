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

function estimateTokenCount(text) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText) {
        return 0;
    }
    const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
    const nonCjkCount = normalizedText.length - cjkCount;
    return Math.max(1, cjkCount + Math.ceil(nonCjkCount / 4));
}

function truncateTextByTokens(text, maxTokens) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText || maxTokens <= 0) {
        return '';
    }
    let candidate = normalizedText;
    while (candidate && estimateTokenCount(candidate) > maxTokens) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    return candidate;
}

function projectBudgetedContextBlocks(items, options) {
    const opts = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    const tokenBudget = typeof opts.tokenBudget === 'number' && Number.isFinite(opts.tokenBudget) && opts.tokenBudget > 0
        ? Math.floor(opts.tokenBudget)
        : undefined;
    const maxTokenRatio = typeof opts.maxTokenRatio === 'number' && Number.isFinite(opts.maxTokenRatio)
        ? Math.max(0.1, Math.min(1.0, opts.maxTokenRatio))
        : undefined;
    const minScore = typeof opts.minScore === 'number' && Number.isFinite(opts.minScore)
        ? Math.max(0, Math.min(1, opts.minScore))
        : undefined;
    const maxBlocks = typeof opts.maxBlocks === 'number' && Number.isFinite(opts.maxBlocks) && opts.maxBlocks > 0
        ? Math.floor(opts.maxBlocks)
        : undefined;

    const maxInjectedTokens = tokenBudget !== undefined && maxTokenRatio !== undefined
        ? Math.max(1, Math.floor(tokenBudget * maxTokenRatio))
        : undefined;

    const scoredItems = Array.isArray(items) ? items : [];
    const eligibleItems = minScore !== undefined
        ? scoredItems.filter((item) => typeof item?.score === 'number' && Number.isFinite(item.score) && item.score >= minScore)
        : scoredItems;
    const filteredByMinScore = Math.max(0, scoredItems.length - eligibleItems.length);

    let consumedTokens = 0;
    const selectedItems = [];
    let truncatedCount = 0;

    for (const item of eligibleItems) {
        if (maxBlocks !== undefined && selectedItems.length >= maxBlocks) {
            break;
        }
        const itemTokens = estimateTokenCount(item?.text);
        if (maxInjectedTokens !== undefined && consumedTokens > 0 && consumedTokens + itemTokens > maxInjectedTokens) {
            continue;
        }
        if (maxInjectedTokens !== undefined && itemTokens > maxInjectedTokens) {
            const remainingTokens = Math.max(1, maxInjectedTokens - consumedTokens);
            const truncatedText = truncateTextByTokens(item?.text, remainingTokens);
            if (!truncatedText) {
                continue;
            }
            selectedItems.push({
                ...item,
                text: truncatedText,
                __truncated: true
            });
            consumedTokens += estimateTokenCount(truncatedText);
            truncatedCount += 1;
            break;
        }
        selectedItems.push(item);
        consumedTokens += itemTokens;
    }

    const blocks = projectContextBlocks(selectedItems);
    for (let i = 0; i < blocks.length; i += 1) {
        if (selectedItems[i].__truncated) {
            blocks[i].metadata.truncated = true;
        }
    }

    const appliedPolicy = {
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(maxTokenRatio !== undefined ? { maxTokenRatio } : {}),
        ...(maxInjectedTokens !== undefined ? { maxInjectedTokens } : {}),
        ...(maxBlocks !== undefined ? { maxBlocks } : {}),
        ...(minScore !== undefined ? { minScore } : {}),
        filteredByMinScore,
        truncatedCount
    };

    return { blocks, consumedTokens, appliedPolicy };
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
