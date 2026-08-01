'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const dataset = require('../lib/gateDataset');
const calibration = require('../lib/gateCalibration');
const { scoreGateVectors } = require('../../modules/gateScoring');

function scoreBundle(split, rows, qualityLevel = 'decision') {
    return {
        rows: rows.map((row, index) => ({
            caseId: `${split}-${index}`,
            targetType: 'diary',
            library: 'EvalDiary',
            split,
            difficulty: 'easy',
            annotation: { status: 'verified', reviewCount: 1 },
            ...row
        })),
        manifest: {
            split,
            profile: 'synthetic',
            embedding: { model: 'model-a', dimension: 3, endpointFingerprint: 'sha256:endpoint' },
            gateDefinitionHash: 'sha256:gate',
            scoringFormulaVersion: 'gate-score-v1',
            dataset: {
                id: 'gate-v1', hash: 'sha256:dataset',
                calibrationSplitHash: 'sha256:calibration',
                holdoutSplitHash: 'sha256:holdout', qualityLevel
            },
            caseCount: rows.length
        }
    };
}

test('VT-010: perfectly separable scores select an FPR=0 TPR=1 threshold', () => {
    const rows = [
        ...[0.9, 0.8, 0.7].map(score => ({ label: 'positive', score })),
        ...[0.3, 0.2, 0.1].map(score => ({ label: 'negative', score }))
    ];
    const selected = calibration.selectThreshold(rows, 0.05);
    assert.equal(selected.fpr, 0);
    assert.equal(selected.tpr, 1);
    assert.equal(selected.threshold, 0.7);
});

test('VT-011: tied scores report zero separation and deterministic confidence intervals', () => {
    const rows = [
        ...Array.from({ length: 70 }, () => ({ label: 'positive', score: 0.5 })),
        ...Array.from({ length: 140 }, () => ({ label: 'negative', score: 0.5 }))
    ];
    const bundle = scoreBundle('calibration', rows);
    const first = calibration.calibrate(bundle, { bootstrapIterations: 40, seed: 7 });
    const second = calibration.calibrate(bundle, { bootstrapIterations: 40, seed: 7 });
    const metric = first.calibrationMetrics['diary:EvalDiary'];
    assert.equal(metric.discrimination.separation, 0);
    assert.equal(metric.discrimination.standardizedSeparation, 0);
    assert.deepEqual(metric.confidenceInterval95, second.calibrationMetrics['diary:EvalDiary'].confidenceInterval95);
    assert.equal(first.artifactHash, second.artifactHash);
});

test('VT-012: verified data below decision counts is development quality', () => {
    const rows = [];
    for (let index = 0; index < 40; index++) rows.push({
        id: `p-${index}`, targetType: 'diary', library: 'EvalDiary', query: `positive ${index}`,
        label: 'positive', difficulty: 'easy', source: 'corpus-derived', sourceRefs: ['doc'],
        intentGroup: `p-${index}`, split: index < 28 ? 'calibration' : 'holdout',
        annotation: { status: 'verified', reviewCount: 1 }
    });
    for (let index = 0; index < 60; index++) rows.push({
        id: `n-${index}`, targetType: 'diary', library: 'EvalDiary', query: `negative ${index}`,
        label: 'negative', difficulty: index % 3 === 2 ? 'hard' : (index % 3 === 1 ? 'near-domain' : 'easy'),
        source: 'cross-library', sourceRefs: ['other-doc'], intentGroup: `n-${index}`,
        split: index < 42 ? 'calibration' : 'holdout',
        annotation: { status: 'verified', reviewCount: index % 3 === 2 ? 2 : 1 }
    });
    const result = dataset.verifyRows(rows, { targets: [{ targetType: 'diary', library: 'EvalDiary' }] });
    assert.equal(result.ok, true);
    assert.equal(result.qualityLevel, 'development');
});

test('VT-013: calibrate rejects holdout scores', () => {
    const bundle = scoreBundle('holdout', [
        { label: 'positive', score: 0.8 }, { label: 'negative', score: 0.2 }
    ]);
    assert.throws(() => calibration.calibrate(bundle), error => error.code === 'GATE_SCORE_SPLIT_MISMATCH');
});

test('VT-014: one intentGroup cannot cross calibration and holdout', () => {
    const base = {
        targetType: 'diary', library: 'EvalDiary', query: 'query', label: 'positive', difficulty: 'easy',
        source: 'corpus-derived', sourceRefs: ['doc'], intentGroup: 'same-intent',
        annotation: { status: 'verified', reviewCount: 1 }
    };
    const result = dataset.verifyRows([
        { ...base, id: 'a', split: 'calibration' },
        { ...base, id: 'b', split: 'holdout' }
    ], { targets: [{ targetType: 'diary', library: 'EvalDiary' }] });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(finding => finding.code === 'intent-split-leakage'));
});

test('production-shared gate formula reports both cosine components', () => {
    const scored = scoreGateVectors({
        queryVector: [1, 0], libraryNameVector: [0.6, 0.8], enhancedVector: [1, 0],
        cosineSimilarity: (left, right) => left[0] * right[0] + left[1] * right[1]
    });
    assert.equal(scored.score, 1);
    assert.deepEqual(scored.scoreComponents, {
        libraryNameCosine: 0.6, enhancedVectorCosine: 1, aggregation: 'max'
    });
});

test('validate keeps fitted thresholds fixed and creates a deterministic finalized hash', () => {
    const calibrationRows = [
        ...Array.from({ length: 70 }, (_, index) => ({ label: 'positive', score: 0.7 + index / 1000 })),
        ...Array.from({ length: 140 }, (_, index) => ({ label: 'negative', score: 0.1 + index / 1000 }))
    ];
    const holdoutRows = [
        ...Array.from({ length: 30 }, (_, index) => ({ label: 'positive', score: 0.72 + index / 1000 })),
        ...Array.from({ length: 60 }, (_, index) => ({ label: 'negative', score: 0.12 + index / 1000 }))
    ];
    const draft = calibration.calibrate(scoreBundle('calibration', calibrationRows), { bootstrapIterations: 20, seed: 9 });
    const first = calibration.validate(draft, scoreBundle('holdout', holdoutRows));
    const second = calibration.validate(draft, scoreBundle('holdout', holdoutRows));
    assert.equal(first.status, 'validated');
    assert.deepEqual(first.thresholds, draft.thresholds);
    assert.equal(first.artifactHash, second.artifactHash);
});

test('collectRows preserves dataset provenance and uses the shared scorer contract', async () => {
    const loaded = {
        manifest: { datasetId: 'gate-test' },
        verification: { datasetHash: 'sha256:dataset' },
        rows: [
            { id: 'a', targetType: 'diary', library: 'A', query: 'alpha', label: 'positive', difficulty: 'easy', intentGroup: 'a', split: 'calibration', annotation: { status: 'verified', reviewCount: 1 } },
            { id: 'b', targetType: 'cold', library: 'B', query: 'beta', label: 'negative', difficulty: 'easy', intentGroup: 'b', split: 'holdout', annotation: { status: 'verified', reviewCount: 1 } }
        ]
    };
    const rows = await calibration.collectRows(
        loaded,
        'profile-a',
        { model: 'model-a', dimension: 3, endpointFingerprint: 'sha256:endpoint' },
        async request => ({ score: request.query === 'alpha' ? 0.8 : 0.2, scoreComponents: { aggregation: 'max' }, scoringFormulaVersion: 'gate-score-v1' }),
        { concurrency: 2 }
    );
    assert.deepEqual(rows.map(row => [row.caseId, row.score, row.split]), [['a', 0.8, 'calibration'], ['b', 0.2, 'holdout']]);
    assert.equal(rows[0].datasetHash, 'sha256:dataset');
});

test('gate calibrate/validate --json emit one stable machine-readable document', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-cli-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const writeBundle = (split, positives, negatives) => {
        const rows = [
            ...Array.from({ length: positives }, (_, index) => ({
                caseId: `${split}-p-${index}`, targetType: 'diary', library: 'EvalDiary', label: 'positive',
                difficulty: 'easy', intentGroup: `${split}-p-${index}`, split,
                annotation: { status: 'verified', reviewCount: 1 }, score: 0.8 + index / 10000
            })),
            ...Array.from({ length: negatives }, (_, index) => ({
                caseId: `${split}-n-${index}`, targetType: 'diary', library: 'EvalDiary', label: 'negative',
                difficulty: index % 3 === 2 ? 'hard' : (index % 3 === 1 ? 'near-domain' : 'easy'),
                intentGroup: `${split}-n-${index}`, split,
                annotation: { status: 'verified', reviewCount: index % 3 === 2 ? 2 : 1 }, score: 0.1 + index / 10000
            }))
        ];
        const scorePath = path.join(dir, `${split}.jsonl`);
        fs.writeFileSync(scorePath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
        fs.writeFileSync(scorePath.replace('.jsonl', '.manifest.json'), JSON.stringify({
            schemaVersion: 1, split, profile: 'synthetic', caseCount: rows.length,
            embedding: { model: 'model-a', dimension: 3, endpointFingerprint: 'sha256:endpoint' },
            gateDefinitionHash: 'sha256:gate', scoringFormulaVersion: 'gate-score-v1', rowsHash: dataset.hashRows(rows),
            dataset: { id: 'gate-v1', hash: 'sha256:dataset', calibrationSplitHash: 'sha256:calibration', holdoutSplitHash: 'sha256:holdout', qualityLevel: 'decision' }
        }));
        return scorePath;
    };
    const calibrationScores = writeBundle('calibration', 70, 140);
    const holdoutScores = writeBundle('holdout', 30, 60);
    const draftPath = path.join(dir, 'draft.json');
    const finalPath = path.join(dir, 'final.json');
    const root = path.resolve(__dirname, '..', '..');
    const calibrated = spawnSync(process.execPath, [
        path.join(root, 'eval', 'vcp-eval.js'), 'gate', 'calibrate', '--scores', calibrationScores,
        '--bootstrap', '20', '--seed', '17', '--out', draftPath, '--json'
    ], { cwd: root, encoding: 'utf-8' });
    assert.equal(calibrated.status, 0, calibrated.stderr);
    const calibratedJson = JSON.parse(calibrated.stdout);
    assert.equal(calibratedJson.ok, true);
    assert.equal(calibratedJson.artifact.status, 'draft');
    const validated = spawnSync(process.execPath, [
        path.join(root, 'eval', 'vcp-eval.js'), 'gate', 'validate', '--calibration', draftPath,
        '--scores', holdoutScores, '--out', finalPath, '--json'
    ], { cwd: root, encoding: 'utf-8' });
    assert.equal(validated.status, 0, validated.stderr);
    const validatedJson = JSON.parse(validated.stdout);
    assert.equal(validatedJson.ok, true);
    assert.equal(validatedJson.artifact.status, 'validated');
    assert.ok(fs.existsSync(finalPath));
});
