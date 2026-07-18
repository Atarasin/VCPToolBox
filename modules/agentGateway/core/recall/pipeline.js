const { resolveProfileStage } = require('./stages/resolveProfile');
const { precomputeVectorStage } = require('./stages/precomputeVector');
const { executeRulesStage } = require('./stages/executeRules');
const { mergeResultsStage } = require('./stages/mergeResults');
const { applyBudgetStage } = require('./stages/applyBudget');
const { applyAiMemoStage } = require('./stages/applyAiMemo');

function buildProfileMeta(resolved) {
    const meta = {
        profileName: resolved.profileName,
        ruleCount: resolved.rules.length,
        modifierKeys: [...new Set(resolved.rules.flatMap((rule) => Object.keys(rule.modifiers || {})))]
    };
    for (const key of [
        'truncateTo', 'merge', 'aggregate', 'projection', 'tokenBudget',
        'maxTokenRatio', 'minScore', 'aiMemo'
    ]) {
        if (resolved[key] !== undefined) meta[key] = resolved[key];
    }
    return meta;
}

function createRecallPipeline(dependencies) {
    return async function executeRecall(input) {
        const startedAt = Date.now();
        const resolved = resolveProfileStage({ ...input, startedAt }, dependencies);
        if (resolved.failure) return resolved.failure;
        const state = {
            input,
            startedAt,
            ...resolved,
            pipelineStages: [resolved.stage],
            ruleDiagnostics: [],
            ruleItems: [],
            attachments: [],
            items: [],
            policyResolver: input.agentPolicyResolver || dependencies.defaultAgentPolicyResolver
        };
        await precomputeVectorStage(state, dependencies);
        await executeRulesStage(state, dependencies);
        mergeResultsStage(state);
        applyBudgetStage(state);
        await applyAiMemoStage(state, dependencies);
        return dependencies.buildRecallResult({
            success: true,
            agentId: state.agentId,
            profileName: state.resolved.profileName,
            items: state.items,
            diagnostics: {
                totalDurationMs: Date.now() - startedAt,
                rules: state.ruleDiagnostics,
                pipelineStages: state.pipelineStages,
                profileMeta: buildProfileMeta(state.resolved),
                attachments: state.attachments.length ? state.attachments : undefined,
                vectorPrecomputed: Array.isArray(state.queryVector) && state.queryVector.length > 0,
                vectorPrecomputeError: state.vectorFetchError?.message || null,
                summary: state.aiMemoSummary || undefined
            }
        });
    };
}

module.exports = {
    applyAiMemoStage,
    applyBudgetStage,
    createRecallPipeline,
    executeRulesStage,
    mergeResultsStage,
    precomputeVectorStage,
    resolveProfileStage
};
