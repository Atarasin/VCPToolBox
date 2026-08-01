'use strict';

const { sha256, stableValue, endpointFingerprint } = require('./embeddingProvenance');

const SCORING_FORMULA_VERSION = 'gate-score-v1';

function resolveThreshold(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function stripThresholds(value) {
    if (Array.isArray(value)) return value.map(stripThresholds);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => key !== 'threshold')
        .map(([key, child]) => [key, stripThresholds(child)]));
}

function mergeThresholdOverride(baseConfig, overrideArtifact, targetType, options = {}) {
    const effective = JSON.parse(JSON.stringify(baseConfig || {}));
    const thresholds = overrideArtifact?.thresholds?.[targetType] || {};
    const allowedTargets = options.allowedTargets
        ? new Set(options.allowedTargets)
        : null;
    const rejected = [];
    for (const [target, threshold] of Object.entries(thresholds)) {
        if (allowedTargets && !allowedTargets.has(target)) {
            rejected.push({ target, reason: 'target-outside-eval-namespace' });
            continue;
        }
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
    const embedding = embeddingIdentity(env);
    return { vectorSourceHash, gateDefinitionHash, scoringFormulaVersion: SCORING_FORMULA_VERSION, embedding };
}

function embeddingIdentity(env = process.env) {
    const model = env.WhitelistEmbeddingModel || '';
    return {
        model,
        dimension: Number(env.VECTORDB_DIMENSION || env.EMBEDDING_DIMENSIONS || 0),
        endpointFingerprint: endpointFingerprint({ apiUrl: env.API_URL || '', model })
    };
}

function thresholdNamespaces(configs) {
    return Object.fromEntries(['diary', 'cold'].map(targetType => [
        targetType,
        Object.fromEntries(Object.entries(configs?.[targetType] || {})
            .filter(([, value]) => Number.isFinite(value?.threshold))
            .map(([target, value]) => [target, value.threshold]))
    ]));
}

function combinedGateDefinition(configs) {
    const definition = stableValue({
        diary: stripThresholds(configs?.diary || {}),
        cold: stripThresholds(configs?.cold || {})
    });
    return { definition, hash: sha256(JSON.stringify(definition)) };
}

function effectiveGateConfigHash({
    gateDefinitionHash,
    thresholds,
    embedding,
    scoringFormulaVersion = SCORING_FORMULA_VERSION,
    calibrationId = null,
    artifactHash = null
}) {
    return sha256(JSON.stringify(stableValue({
        gateDefinitionHash,
        thresholds,
        embedding,
        scoringFormulaVersion,
        calibrationId,
        artifactHash
    })));
}

function resolveGateState(baseConfigs, overrideArtifact = null, options = {}) {
    const allowedTargets = options.allowedTargets || overrideArtifact?.allowedTargets || {};
    const diary = mergeThresholdOverride(baseConfigs?.diary, overrideArtifact, 'diary', {
        allowedTargets: allowedTargets.diary
    });
    const cold = mergeThresholdOverride(baseConfigs?.cold, overrideArtifact, 'cold', {
        allowedTargets: allowedTargets.cold
    });
    const effective = { diary: diary.effective, cold: cold.effective };
    const definition = combinedGateDefinition(baseConfigs);
    const embedding = options.embedding || embeddingIdentity(options.env);
    const thresholds = thresholdNamespaces(effective);
    const artifactHash = options.artifactHash ?? overrideArtifact?.artifactHash ?? null;
    return {
        effective,
        rejected: [
            ...diary.rejected.map(item => ({ targetType: 'diary', ...item })),
            ...cold.rejected.map(item => ({ targetType: 'cold', ...item }))
        ],
        gateDefinitionHash: definition.hash,
        definition: definition.definition,
        thresholds,
        embedding,
        scoringFormulaVersion: SCORING_FORMULA_VERSION,
        calibrationId: overrideArtifact?.calibrationId || null,
        artifactHash,
        effectiveConfigHash: effectiveGateConfigHash({
            gateDefinitionHash: definition.hash,
            thresholds,
            embedding,
            scoringFormulaVersion: SCORING_FORMULA_VERSION,
            calibrationId: overrideArtifact?.calibrationId || null,
            artifactHash
        })
    };
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
    resolveThreshold,
    stripThresholds,
    mergeThresholdOverride,
    gateIdentity,
    embeddingIdentity,
    thresholdNamespaces,
    combinedGateDefinition,
    effectiveGateConfigHash,
    resolveGateState,
    cacheMatches
};
