function estimateTokenCount(text) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText) return 0;
    const cjkCount = (normalizedText.match(/[\u3400-\u9fff]/g) || []).length;
    return Math.max(1, cjkCount + Math.ceil((normalizedText.length - cjkCount) / 4));
}

function truncateTextByTokens(text, maxTokens) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText || maxTokens <= 0) return '';
    let candidate = normalizedText;
    while (candidate && estimateTokenCount(candidate) > maxTokens) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    return candidate;
}

module.exports = { estimateTokenCount, truncateTextByTokens };
