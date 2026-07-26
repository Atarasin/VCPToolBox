function normalizeDiaryNames(diaries) {
    return Array.isArray(diaries)
        ? diaries
            .filter((diary) => typeof diary === 'string')
            .map((diary) => diary.trim())
            .filter(Boolean)
        : [];
}

function formatDiaryNamesForMessage(diaries) {
    const normalizedDiaries = normalizeDiaryNames(diaries);
    return normalizedDiaries.length > 0
        ? normalizedDiaries.join(', ')
        : '(none)';
}

function buildDiaryForbiddenMessage({ forbiddenDiaries, allowedDiaries }) {
    const normalizedForbiddenDiaries = normalizeDiaryNames(forbiddenDiaries);
    const requestedLabel = normalizedForbiddenDiaries.length > 1 ? 'Requested diaries' : 'Requested diary';
    return [
        'Requested diary target is not allowed for this agent.',
        `${requestedLabel}: ${formatDiaryNamesForMessage(normalizedForbiddenDiaries)}.`,
        `Allowed diaries: ${formatDiaryNamesForMessage(allowedDiaries)}.`
    ].join(' ');
}

function buildDiaryDefaultsMissingMessage({ allowedDiaries }) {
    return [
        'No default diary targets are configured for this agent.',
        `Allowed diaries: ${formatDiaryNamesForMessage(allowedDiaries)}.`
    ].join(' ');
}

function buildDiaryAccessDetails({ agentId, allowedDiaries, defaultDiaries, forbiddenDiaries }) {
    const details = {
        agentId: typeof agentId === 'string' ? agentId.trim() : '',
        allowedDiaries: normalizeDiaryNames(allowedDiaries),
        defaultDiaries: normalizeDiaryNames(defaultDiaries)
    };

    const normalizedForbiddenDiaries = normalizeDiaryNames(forbiddenDiaries);
    if (normalizedForbiddenDiaries.length > 0) {
        details.diary = normalizedForbiddenDiaries[0];
        details.diaries = normalizedForbiddenDiaries;
    }

    return details;
}

module.exports = {
    buildDiaryAccessDetails,
    buildDiaryDefaultsMissingMessage,
    buildDiaryForbiddenMessage,
    formatDiaryNamesForMessage
};
