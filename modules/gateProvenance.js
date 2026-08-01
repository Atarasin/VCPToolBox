'use strict';

const { sha256, stableValue, endpointFingerprint } = require('./embeddingProvenance');

const SCORING_FORMULA_VERSION = 'gate-score-v1';

function stripThresholds(value) {
    if (Array.isArray(value)) return value.map(stripThresholds);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'threshold')
        .map(([key, child]) => [key, stripThresholds(child)]));
}

function mergeThresholdOverride(baseConfig, overrideArtifact, targetType) {
    const effective = JSON.parse(JSON.stringify(baseConfig || {}));
    const thresholds = overrideArtifact?.thresholds?.[targetType] || {};
    const rejected = [];
    for (const [target, threshold] of Object.entries(thresholds)) {
        if (!Object.prototype.hasOwnProperty.call(effective, target)) {
            rejected.push({ target, reason: 'unknown-target' });
            continue;
        }
        if (!Number.isFinite(threshold)) {
            rejected.push({ target, reason: 'invalid-threshold' });
            continue;
        }
        effective[target] = { ...effective[target], threshold };
    }
    return { effective, rejected };
}

function gateIdentity(config, env = process.env) {
    const definition = stableValue(stripThresholds(config || {}));
    const vectorSourceHash = sha256(JSON.stringify(definition));
    const gateDefinitionHash = sha256(JSON.stringify(stableValue({ vectorSourceHash, scoringFormulaVersion: SCORING_FORMULA_VERSION })));
    const embedding = {
        model: env.WhitelistEmbeddingModel || '',
        dimension: Number(env.VECTORDB_DIMENSION || env.EMBEDDING_DIMENSIONS || 0),
        endpointFingerprint: endpointFingerprint({ apiUrl: env.API_URL || '', model: env.WhitelistEmbeddingModel || '' })
    };
    return { vectorSourceHash, gateDefinitionHash, scoringFormulaVersion: SCORING_FORMULA_VERSION, embedding };
}

function effectiveGateConfigHash(identity, effectiveConfig, overrideArtifact = null) {
    const thresholds = Object.fromEntries(Object.entries(effectiveConfig || {})
        .filter(([, value]) => Number.isFinite(value?.threshold))
        .map(([target, value]) => [target, value.threshold]));
    return sha256(JSON.stringify(stableValue({
        gateDefinitionHash: identity.gateDefinitionHash,
        thresholds,
        embedding: identity.embedding,
        scoringFormulaVersion: identity.scoringFormulaVersion,
        calibrationId: overrideArtifact?.calibrationId || null,
        artifactHash: overrideArtifact?.artifactHash
            || (overrideArtifact ? sha256(JSON.stringify(stableValue(overrideArtifact))) : null)
    })));
}

function cacheMatches(cache, identity) {
    return Boolean(cache
        && cache.schemaVersion === 2
        && cache.vectorSourceHash === identity.vectorSourceHash
        && cache.gateDefinitionHash === identity.gateDefinitionHash
        && cache.scoringFormulaVersion === identity.scoringFormulaVersion
        && cache.embedding?.model === identity.embedding.model
        && Number(cache.embedding?.dimension) === identity.embedding.dimension
        && cache.embedding?.endpointFingerprint === identity.embedding.endpointFingerprint
        && cache.vectors && typeof cache.vectors === 'object');
}

module.exports = {
    SCORING_FORMULA_VERSION,
    stripThresholds,
    mergeThresholdOverride,
    gateIdentity,
    effectiveGateConfigHash,
    cacheMatches
};
