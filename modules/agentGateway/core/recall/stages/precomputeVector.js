const support = require('../runtimeSupport');

async function precomputeVectorStage(state, dependencies) {
    const startedAt = Date.now();
    let vector = null;
    let error = null;
    if (!state.input.inlineRule) {
        try {
            vector = await dependencies.ragRetrieverPort.embedQuery(state.query);
        } catch (caught) {
            error = caught;
        }
    }
    state.queryVector = vector;
    state.vectorFetchError = error;
    state.pipelineStages.push({
        name: 'precomputeVector',
        durationMs: Date.now() - startedAt,
        status: error ? 'error' : 'ok',
        detail: {
            vectorPrecomputed: Array.isArray(vector) && vector.length > 0,
            skipped: Boolean(state.input.inlineRule)
        }
    });
}

module.exports = { precomputeVectorStage };
