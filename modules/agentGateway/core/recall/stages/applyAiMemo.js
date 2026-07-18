const support = require('../runtimeSupport');
const modifiers = require('../modifiers');

async function applyAiMemoStage(state, dependencies) {
    const config = !state.input.inlineRule ? state.resolved.aiMemo : undefined;
    state.aiMemoSummary = null;
    if (!config) return;
    const preset = typeof config === 'object' && !Array.isArray(config)
        ? support.normalizeString(config.preset)
        : '';
    const result = await modifiers.applyAIMemo(state.items, {
        ...(dependencies.aiMemoConfigLoader() || {}),
        preset: preset || undefined
    }, dependencies.deps.llmCompletionPort);
    state.pipelineStages.push({
        name: 'aiMemo',
        durationMs: result.modifierDetail.durationMs,
        status: result.summary ? 'ok' : (result.modifierDetail.error ? 'error' : 'skipped'),
        detail: {
            inputCount: result.modifierDetail.inputCount,
            skipped: result.modifierDetail.skipped,
            summaryLength: result.modifierDetail.summaryLength,
            error: result.modifierDetail.error || undefined
        }
    });
    state.aiMemoSummary = result.summary;
}

module.exports = { applyAiMemoStage };
