const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

const REQUIRED_METHODS = Object.freeze(['embedQuery', 'listDiaries', 'searchDiary']);
const OPTIONAL_METHODS = Object.freeze([
    'enhanceSemanticGroups',
    'applyTagBoost',
    'parseTimeRanges',
    'getTimeRangeFilePaths',
    'getChunksByFilePaths',
    'cosineSimilarity',
    'deduplicateResults',
    'rerank',
    'getFileMetadata',
    'getDiaryContent',
    'getConceptVectors',
    'processMessages'
]);

function createRagRetrieverPort(bindings = {}) {
    if (bindings.enabled === false) return createUnavailablePort('ragRetriever', bindings.reason);
    const missing = REQUIRED_METHODS.filter((name) => typeof bindings[name] !== 'function');
    if (missing.length > 0) {
        if (bindings.optional === true) return createUnavailablePort('ragRetriever', `missing:${missing.join(',')}`);
        throw new Error(`[RagRetrieverPort] missing required bindings: ${missing.join(', ')}`);
    }
    const capabilities = Object.freeze(Object.fromEntries(
        OPTIONAL_METHODS.map((name) => [name, typeof bindings[name] === 'function'])
    ));
    const implementation = Object.fromEntries([
        ...REQUIRED_METHODS,
        ...OPTIONAL_METHODS
    ].map((name) => [name, typeof bindings[name] === 'function' ? bindings[name] : null]));
    return freezeAvailablePort('ragRetriever', {
        ...implementation,
        capabilities: () => capabilities
    });
}

module.exports = { createRagRetrieverPort, OPTIONAL_METHODS, REQUIRED_METHODS };
