const support = require('../runtimeSupport');

function resolveProfileStage(input, dependencies) {
    const startedAt = Date.now();
    const agentId = support.normalizeString(input.agentId);
    const query = support.normalizeString(input.query);
    if (!agentId || !query) {
        return { failure: dependencies.buildRecallResult({
            success: false,
            agentId: agentId || undefined,
            code: support.AGW_ERROR_CODES.RECALL_INVALID_QUERY,
            error: `${!agentId ? 'agentId' : 'query'} is required`,
            status: 400
        }) };
    }
    const resolved = input.inlineRule && typeof input.inlineRule === 'object'
        ? { resolved: true, rules: [input.inlineRule], profileName: '_inline_' }
        : dependencies.profileResolver.resolveForAgent(agentId, input.profileName);
    if (!resolved.resolved) {
        const failure = dependencies.mapResolvedRecallFailure(resolved, agentId, input.profileName);
        return { failure: dependencies.buildRecallResult({
            success: false,
            agentId,
            profileName: resolved.profileName || input.profileName || null,
            ...failure,
            diagnostics: { totalDurationMs: Date.now() - input.startedAt, rules: [] }
        }) };
    }
    return {
        agentId,
        query,
        resolved,
        stage: {
            name: 'resolveProfile',
            durationMs: Date.now() - startedAt,
            status: 'ok',
            detail: { profileName: resolved.profileName, ruleCount: resolved.rules.length }
        }
    };
}

module.exports = { resolveProfileStage };
