'use strict';

const fs = require('fs');
const path = require('path');
const { hashRows, sha256, stableValue } = require('./gateDataset');
const { SCORING_FORMULA_VERSION } = require('../../modules/gateScoring');

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function confusion(rows, threshold) {
    let tp = 0; let fp = 0; let tn = 0; let fn = 0;
    for (const row of rows) {
        if (!['positive', 'negative'].includes(row.label)) continue;
        const positive = row.label === 'positive';
        const passed = row.score >= threshold;
        if (positive && passed) tp++;
        else if (positive) fn++;
        else if (passed) fp++;
        else tn++;
    }
    const positives = tp + fn;
    const negatives = tn + fp;
    const tpr = positives ? tp / positives : null;
    const fpr = negatives ? fp / negatives : null;
    const tnr = negatives ? tn / negatives : null;
    return {
        threshold, tp, fp, tn, fn, positives, negatives,
        tpr, fpr, fnr: tpr === null ? null : 1 - tpr,
        accuracy: positives + negatives ? (tp + tn) / (positives + negatives) : null,
        balancedAccuracy: tpr === null || tnr === null ? null : (tpr + tnr) / 2
    };
}

function discrimination(rows) {
    const positives = rows.filter(row => row.label === 'positive').map(row => row.score).filter(Number.isFinite);
    const negatives = rows.filter(row => row.label === 'negative').map(row => row.score).filter(Number.isFinite);
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = (values, average) => values.length > 1
        ? values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
        : 0;
    if (!positives.length || !negatives.length) return { separation: null, standardizedSeparation: null };
    const positiveMean = mean(positives);
    const negativeMean = mean(negatives);
    const separation = positiveMean - negativeMean;
    const pooledVariance = ((positives.length - 1) * variance(positives, positiveMean)
        + (negatives.length - 1) * variance(negatives, negativeMean))
        / Math.max(1, positives.length + negatives.length - 2);
    const pooledStdDev = Math.sqrt(pooledVariance);
    return {
        positiveMean,
        negativeMean,
        separation,
        standardizedSeparation: pooledStdDev > 0 ? separation / pooledStdDev : (separation === 0 ? 0 : null)
    };
}

function selectThreshold(rows, targetFpr = 0.05) {
    const scored = rows.filter(row => ['positive', 'negative'].includes(row.label) && Number.isFinite(row.score));
    if (!scored.some(row => row.label === 'positive') || !scored.some(row => row.label === 'negative')) {
        throw codedError('GATE_SCORE_CLASS_MISSING', 'threshold fitting requires positive and negative scores');
    }
    const unique = [...new Set(scored.map(row => row.score))];
    const max = Math.max(...unique);
    const epsilon = Math.max(Number.EPSILON, Math.abs(max) * Number.EPSILON);
    const candidates = [max + epsilon, ...unique].map(threshold => confusion(scored, threshold));
    const feasible = candidates.filter(item => item.fpr !== null && item.fpr <= targetFpr + Number.EPSILON);
    feasible.sort((left, right) =>
        (right.tpr - left.tpr)
        || (right.balancedAccuracy - left.balancedAccuracy)
        || (right.threshold - left.threshold));
    return feasible[0];
}

function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

function seedFrom(value) {
    return Number.parseInt(sha256(String(value)).slice(7, 15), 16) >>> 0;
}

function quantile(values, q) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function bootstrap(rows, protocol) {
    const iterations = Math.max(1, Number(protocol.bootstrapIterations) || 1000);
    const random = mulberry32(Number(protocol.seed) >>> 0);
    const byLabel = {
        positive: rows.filter(row => row.label === 'positive'),
        negative: rows.filter(row => row.label === 'negative')
    };
    const values = { threshold: [], tpr: [], fpr: [], balancedAccuracy: [] };
    for (let iteration = 0; iteration < iterations; iteration++) {
        const sample = [];
        for (const label of ['positive', 'negative']) {
            const source = byLabel[label];
            for (let index = 0; index < source.length; index++) {
                sample.push(source[Math.floor(random() * source.length)]);
            }
        }
        const fitted = selectThreshold(sample, protocol.targetFpr);
        for (const key of Object.keys(values)) values[key].push(fitted[key]);
    }
    return Object.fromEntries(Object.entries(values).map(([key, samples]) => [key, {
        lower: quantile(samples, 0.025),
        upper: quantile(samples, 0.975)
    }]));
}

function groupRows(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!['positive', 'negative'].includes(row.label)) continue;
        const key = `${row.targetType}:${row.library}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    return groups;
}

function loadScoreBundle(scorePath) {
    const absolute = path.resolve(scorePath);
    const rows = fs.readFileSync(absolute, 'utf-8').split(/\r?\n/)
        .map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
    const manifestPath = absolute.replace(/\.jsonl$/i, '.manifest.json');
    if (!fs.existsSync(manifestPath)) throw codedError('GATE_SCORE_MANIFEST_MISSING', `score manifest missing: ${manifestPath}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (manifest.rowsHash !== hashRows(rows)) throw codedError('GATE_SCORE_HASH_MISMATCH', 'score rows hash differs from manifest');
    return { path: absolute, manifestPath, rows, manifest };
}

function assertScoreSplit(bundle, expected) {
    if (bundle.manifest.split !== expected || bundle.rows.some(row => row.split !== expected)) {
        throw codedError('GATE_SCORE_SPLIT_MISMATCH', `expected ${expected} score bundle`);
    }
}

function assertReviewedRows(bundle) {
    const allVerified = bundle.rows.every(row => row.annotation?.status === 'verified'
        && Number(row.annotation?.reviewCount || 0) >= ((row.label === 'ambiguous' || (row.label === 'negative' && row.difficulty === 'hard')) ? 2 : 1));
    if (!allVerified) throw codedError('GATE_DATASET_UNVERIFIED', 'score rows include annotations without required human review');
    if (bundle.manifest.caseCount !== undefined && Number(bundle.manifest.caseCount) !== bundle.rows.length) {
        throw codedError('GATE_SCORE_COUNT_MISMATCH', 'score row count differs from manifest');
    }
}

async function collectRows(dataset, profileName, embedding, scorer, options = {}) {
    const output = new Array(dataset.rows.length);
    let nextIndex = 0;
    const concurrency = Math.max(1, Math.min(32, Number(options.concurrency) || 4));
    const retryAttempts = Math.max(0, Math.min(8, Number(options.retryAttempts) || 0));
    const requestedRetryBaseMs = Number(options.retryBaseMs);
    const retryBaseMs = Number.isFinite(requestedRetryBaseMs)
        ? Math.max(0, Math.min(300000, requestedRetryBaseMs))
        : 15000;
    const scoreWithRetry = async request => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await scorer(request);
            } catch (error) {
                if (error?.code !== 'GATE_QUERY_EMBEDDING_UNAVAILABLE' || attempt >= retryAttempts) throw error;
                const delayMs = retryBaseMs * (2 ** attempt);
                console.warn(
                    `[GateCollect] query embedding unavailable; retrying in ${delayMs}ms ` +
                    `(attempt ${attempt + 1}/${retryAttempts})`
                );
                if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
    };
    const worker = async () => {
        for (;;) {
            const index = nextIndex++;
            if (index >= dataset.rows.length) return;
            const row = dataset.rows[index];
            const result = await scoreWithRetry({
                targetType: row.targetType,
                library: row.library,
                query: row.query
            });
            if (!Number.isFinite(result.score)) throw codedError('GATE_SCORE_INVALID', `non-finite score for ${row.id}`);
            output[index] = {
                datasetId: dataset.manifest.datasetId,
                datasetHash: dataset.verification.datasetHash,
                caseId: row.id,
                targetType: row.targetType,
                library: row.library,
                label: row.label,
                difficulty: row.difficulty,
                intentGroup: row.intentGroup,
                split: row.split,
                annotation: row.annotation,
                score: result.score,
                scoreComponents: result.scoreComponents,
                profile: profileName,
                embedding,
                scoringFormulaVersion: result.scoringFormulaVersion || SCORING_FORMULA_VERSION
            };
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, dataset.rows.length) }, worker));
    return output;
}

function scoreManifest({ dataset, profileName, embedding, gateDefinitionHash, split, rows }) {
    return {
        schemaVersion: 1,
        dataset: {
            id: dataset.manifest.datasetId,
            hash: dataset.verification.datasetHash,
            calibrationSplitHash: dataset.verification.calibrationSplitHash,
            holdoutSplitHash: dataset.verification.holdoutSplitHash,
            qualityLevel: dataset.verification.qualityLevel,
            counts: dataset.verification.counts
        },
        annotation: dataset.verification.annotation,
        profile: profileName,
        embedding,
        gateDefinitionHash,
        scoringFormulaVersion: SCORING_FORMULA_VERSION,
        split,
        caseCount: rows.length,
        rowsHash: hashRows(rows)
    };
}

function writeScoreBundles({ rows, dataset, profileName, embedding, gateDefinitionHash, outputDir }) {
    fs.mkdirSync(outputDir, { recursive: true });
    const written = {};
    for (const split of ['calibration', 'holdout']) {
        const selected = rows.filter(row => row.split === split).sort((a, b) => a.caseId.localeCompare(b.caseId));
        const base = path.join(outputDir, `${profileName}-gate-v1-${split}`);
        const manifest = scoreManifest({ dataset, profileName, embedding, gateDefinitionHash, split, rows: selected });
        fs.writeFileSync(`${base}.jsonl`, `${selected.map(row => JSON.stringify(row)).join('\n')}\n`);
        fs.writeFileSync(`${base}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
        written[split] = { scores: `${base}.jsonl`, manifest: `${base}.manifest.json`, count: selected.length, rowsHash: manifest.rowsHash };
    }
    return written;
}

function calibrate(bundle, options = {}) {
    assertScoreSplit(bundle, 'calibration');
    const qualityLevel = bundle.manifest.dataset?.qualityLevel || 'candidate';
    assertReviewedRows(bundle);
    if (qualityLevel === 'candidate') throw codedError('GATE_DATASET_UNVERIFIED', 'pending annotations cannot be calibrated');
    if (qualityLevel !== 'decision' && !options.allowDevelopment) {
        throw codedError('GATE_DATASET_INSUFFICIENT', 'development dataset requires --allow-development');
    }
    const targetFpr = Number(options.targetFpr ?? 0.05);
    if (!(targetFpr >= 0 && targetFpr <= 1)) throw codedError('GATE_TARGET_FPR_INVALID', 'targetFpr must be between 0 and 1');
    const splitHash = bundle.manifest.dataset.calibrationSplitHash;
    const protocol = {
        name: 'gate-v1',
        targetFpr,
        algorithm: 'max-tpr-under-fpr',
        scoringFormulaVersion: bundle.manifest.scoringFormulaVersion,
        bootstrapIterations: Math.max(1, Number(options.bootstrapIterations) || 1000),
        seed: Number.isInteger(options.seed) ? options.seed : seedFrom(`${bundle.manifest.profile}:${splitHash}:${targetFpr}`)
    };
    const thresholds = { diary: {}, cold: {} };
    const calibrationMetrics = {};
    for (const [key, rows] of groupRows(bundle.rows)) {
        const [targetType, ...libraryParts] = key.split(':');
        const library = libraryParts.join(':');
        const selected = selectThreshold(rows, targetFpr);
        thresholds[targetType][library] = selected.threshold;
        calibrationMetrics[key] = {
            ...selected,
            discrimination: discrimination(rows),
            confidenceInterval95: bootstrap(rows, protocol)
        };
    }
    const artifact = {
        schemaVersion: 1,
        status: 'draft',
        calibrationId: `${bundle.manifest.profile}-gate-v1-fpr${String(targetFpr).replace('.', '')}`,
        qualityLevel,
        protocol,
        embedding: bundle.manifest.embedding,
        dataset: bundle.manifest.dataset,
        gateDefinitionHash: bundle.manifest.gateDefinitionHash,
        thresholds,
        calibrationMetrics,
        holdoutMetrics: null,
        createdAt: new Date().toISOString()
    };
    artifact.artifactHash = artifactHash(artifact);
    return artifact;
}

function validate(draft, bundle, options = {}) {
    assertScoreSplit(bundle, 'holdout');
    assertReviewedRows(bundle);
    if (draft.status !== 'draft') throw codedError('GATE_CALIBRATION_NOT_DRAFT', 'validate requires a draft artifact');
    if (draft.dataset?.hash !== bundle.manifest.dataset?.hash
        || draft.dataset?.holdoutSplitHash !== bundle.manifest.dataset?.holdoutSplitHash) {
        throw codedError('GATE_DATASET_MISMATCH', 'holdout bundle does not match draft dataset');
    }
    if (draft.embedding?.model !== bundle.manifest.embedding?.model
        || Number(draft.embedding?.dimension) !== Number(bundle.manifest.embedding?.dimension)
        || draft.embedding?.endpointFingerprint !== bundle.manifest.embedding?.endpointFingerprint) {
        throw codedError('GATE_EMBEDDING_MISMATCH', 'holdout embedding does not match draft');
    }
    if (draft.gateDefinitionHash !== bundle.manifest.gateDefinitionHash
        || draft.protocol?.scoringFormulaVersion !== bundle.manifest.scoringFormulaVersion) {
        throw codedError('GATE_PROVENANCE_MISMATCH', 'holdout gate definition or scoring formula differs');
    }
    if (draft.qualityLevel !== 'decision' && !options.allowDevelopment) {
        throw codedError('GATE_DATASET_INSUFFICIENT', 'development artifact requires --allow-development');
    }
    const holdoutMetrics = {};
    for (const [key, rows] of groupRows(bundle.rows)) {
        const [targetType, ...libraryParts] = key.split(':');
        const library = libraryParts.join(':');
        const threshold = draft.thresholds?.[targetType]?.[library];
        if (!Number.isFinite(threshold)) throw codedError('GATE_THRESHOLD_MISSING', `draft threshold missing for ${key}`);
        holdoutMetrics[key] = confusion(rows, threshold);
    }
    const artifact = {
        ...draft,
        status: 'validated',
        holdoutMetrics,
        validatedAt: new Date().toISOString()
    };
    artifact.artifactHash = artifactHash(artifact);
    return artifact;
}

function artifactHash(artifact) {
    const canonical = { ...artifact };
    delete canonical.artifactHash;
    delete canonical.createdAt;
    delete canonical.validatedAt;
    return sha256(JSON.stringify(stableValue(canonical)));
}

module.exports = {
    confusion,
    discrimination,
    selectThreshold,
    bootstrap,
    collectRows,
    writeScoreBundles,
    loadScoreBundle,
    calibrate,
    validate,
    artifactHash,
    seedFrom,
    codedError
};
