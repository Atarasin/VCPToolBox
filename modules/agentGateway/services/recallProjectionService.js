/**
 * Recall Projection Service — 将 RecallResult 投影为外部消费格式。
 *
 * 工厂函数 createRecallProjectionService() 提供三种投影：
 *   - projectItems(recallResult)      → 扁平 items[]（含 content、score、sourceDiary 等）
 *   - projectRecallBlocks(recallResult) → recallBlocks[]（含 blockId、content、score、sourceDiary）
 *   - projectFullResult(recallResult, requestId) → 透传完整结果并附加 requestId / projectedAt
 */

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeString(item)).filter(Boolean);
    }
    return [];
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

    return {
        success: base.success !== false,
        agentId: base.agentId || null,
        profileName: base.profileName || null,
        requestId: normalizeString(requestId) || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        projectedAt: Date.now(),
        items: projectedItems,
        recallBlocks: projectedBlocks,
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
        projectContextBlocks
    };
}

module.exports = {
    createRecallProjectionService,
    projectItems,
    projectRecallBlocks,
    projectFullResult,
    projectFullTextSections,
    projectSearchItems,
    projectContextBlocks
};
