'use strict';

const SCORING_FORMULA_VERSION = 'gate-score-v1';

function finiteScore(value) {
    return Number.isFinite(value) ? value : null;
}

/**
 * Production-shared gate formula. Callers own vector acquisition; this function
 * is the single definition of how name/enhanced cosine components are combined.
 */
function scoreGateVectors({ queryVector, libraryNameVector, enhancedVector, cosineSimilarity }) {
    if (!queryVector || typeof cosineSimilarity !== 'function') {
        throw new TypeError('queryVector and cosineSimilarity are required');
    }
    const libraryNameCosine = libraryNameVector
        ? finiteScore(cosineSimilarity(queryVector, libraryNameVector))
        : null;
    const enhancedVectorCosine = enhancedVector
        ? finiteScore(cosineSimilarity(queryVector, enhancedVector))
        : null;
    const available = [libraryNameCosine, enhancedVectorCosine].filter(Number.isFinite);
    return {
        score: available.length ? Math.max(...available) : 0,
        scoreComponents: {
            libraryNameCosine,
            enhancedVectorCosine,
            aggregation: 'max'
        },
        scoringFormulaVersion: SCORING_FORMULA_VERSION
    };
}

module.exports = { SCORING_FORMULA_VERSION, scoreGateVectors };
