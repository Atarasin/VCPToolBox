'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const dataset = require('../lib/gateDataset');
const calibration = require('../lib/gateCalibration');
const review = require('../lib/gateReview');
const mining = require('../gate-data/mine-candidates');
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
        label: 'positive', difficulty: 'easy', source: 'corpus-derived', sourceRefs: [`doc-${index < 28 ? 'calibration' : 'holdout'}`],
        intentGroup: `p-${index}`, split: index < 28 ? 'calibration' : 'holdout',
        annotation: { status: 'verified', reviewCount: 1 }
    });
    for (let index = 0; index < 60; index++) rows.push({
        id: `n-${index}`, targetType: 'diary', library: 'EvalDiary', query: `negative ${index}`,
        label: 'negative', difficulty: index % 3 === 2 ? 'hard' : (index % 3 === 1 ? 'near-domain' : 'easy'),
        source: 'cross-library', sourceRefs: [`other-doc-${index < 42 ? 'calibration' : 'holdout'}`], intentGroup: `n-${index}`,
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

test('VT-014: questions derived from one source document cannot cross splits', () => {
    const base = {
        targetType: 'diary', library: 'EvalDiary', label: 'positive', difficulty: 'easy',
        source: 'corpus-derived', sourceRefs: ['shared-document'],
        annotation: { status: 'verified', reviewCount: 1 }
    };
    const result = dataset.verifyRows([
        { ...base, id: 'source-a', query: 'first paraphrase', intentGroup: 'intent-a', split: 'calibration' },
        { ...base, id: 'source-b', query: 'second intent', intentGroup: 'intent-b', split: 'holdout' }
    ], { targets: [{ targetType: 'diary', library: 'EvalDiary' }] });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some(finding => finding.code === 'source-ref-split-leakage'));
});

test('gate-v1 candidate uses grouped natural paraphrases and decision-level counts', () => {
    const candidatePath = path.resolve(__dirname, '../gate-data/gate-v1.jsonl');
    const candidate = dataset.loadDataset(candidatePath);
    assert.equal(candidate.verification.ok, true);
    assert.equal(candidate.verification.qualityLevel, 'candidate');
    assert.equal(candidate.rows.length, 1500);
    assert.equal(new Set(candidate.rows.map(row => row.intentGroup)).size, 50);
    assert.equal(candidate.rows.some(row => /第\s*\d+\s*个(?:表述|检查角度)/u.test(row.query)), false);
    assert.equal(candidate.rows.filter(row => row.source === 'mined').length, 330);
    assert.equal(candidate.rows.filter(row => row.label === 'negative' && row.difficulty === 'hard' && row.source !== 'mined').length, 0);
    assert.equal(candidate.rows.some(row => /_neg_(?:easy|neardomain|hard)_/u.test(row.id)), false);
    const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../gate-data/gate-v1.mining.json'), 'utf8'));
    const { evidenceId, generatedAt, ...hashable } = evidence;
    assert.ok(Number.isFinite(Date.parse(generatedAt)));
    assert.equal(evidenceId, mining.artifactHash(hashable));
    assert.equal(candidate.manifest.miningEvidence.evidenceId, evidenceId);
    for (const stats of Object.values(candidate.verification.counts.targets)) {
        assert.equal(stats.positive, 100);
        assert.equal(stats.negative, 200);
        assert.deepEqual(stats.splits, { calibration: 210, holdout: 90 });
    }
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

test('collectRows retries only transient query embedding failures', async () => {
    const loaded = {
        manifest: { datasetId: 'gate-test' },
        verification: { datasetHash: 'sha256:dataset' },
        rows: [
            { id: 'a', targetType: 'diary', library: 'A', query: 'alpha', label: 'positive', difficulty: 'easy', intentGroup: 'a', split: 'calibration', annotation: { status: 'verified', reviewCount: 1 } }
        ]
    };
    let calls = 0;
    const rows = await calibration.collectRows(
        loaded,
        'profile-a',
        { model: 'model-a', dimension: 3, endpointFingerprint: 'sha256:endpoint' },
        async () => {
            calls++;
            if (calls < 3) {
                const error = new Error('temporary embedding failure');
                error.code = 'GATE_QUERY_EMBEDDING_UNAVAILABLE';
                throw error;
            }
            return { score: 0.8, scoreComponents: {}, scoringFormulaVersion: 'gate-score-v1' };
        },
        { concurrency: 1, retryAttempts: 2, retryBaseMs: 0 }
    );
    assert.equal(calls, 3);
    assert.equal(rows[0].score, 0.8);

    calls = 0;
    await assert.rejects(
        calibration.collectRows(loaded, 'profile-a', {}, async () => {
            calls++;
            throw new Error('permanent failure');
        }, { retryAttempts: 8, retryBaseMs: 0 }),
        /permanent failure/
    );
    assert.equal(calls, 1);
});

test('score bundles can be written as isolated calibration/holdout runs', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-split-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const datasetInfo = {
        manifest: { datasetId: 'gate-v1' },
        verification: { datasetHash: 'sha256:dataset' }
    };
    const files = calibration.writeScoreBundles({
        rows: [{ caseId: 'calibration-1', split: 'calibration', score: 0.8 }],
        dataset: datasetInfo,
        profileName: 'synthetic',
        embedding: { model: 'model-a', dimension: 3, endpointFingerprint: 'sha256:endpoint' },
        gateDefinitionHash: 'sha256:gate',
        outputDir: dir,
        splits: ['calibration']
    });
    assert.deepEqual(Object.keys(files), ['calibration']);
    assert.equal(fs.existsSync(path.join(dir, 'synthetic-gate-v1-holdout.jsonl')), false);
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

test('review evidence requires two distinct humans for hard negatives', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-review-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const rows = [
        {
            id: 'easy-positive', targetType: 'diary', library: 'EvalDiary', query: 'relevant question',
            label: 'positive', difficulty: 'easy', source: 'corpus-derived', sourceRefs: ['doc-a'],
            intentGroup: 'intent-a', split: 'calibration', annotation: { status: 'pending', reviewCount: 0 }
        },
        {
            id: 'hard-negative', targetType: 'diary', library: 'EvalDiary', query: 'deceptive unrelated question',
            label: 'negative', difficulty: 'hard', source: 'cross-library', sourceRefs: ['doc-b'],
            intentGroup: 'intent-b', split: 'holdout', annotation: { status: 'pending', reviewCount: 0 }
        }
    ];
    const manifest = {
        schemaVersion: 1, datasetId: 'review-test', qualityLevel: 'candidate', status: 'awaiting-human-review',
        targets: [{ targetType: 'diary', library: 'EvalDiary' }]
    };
    const verified = dataset.verifyRows(rows, manifest);
    manifest.hashes = { dataset: verified.datasetHash, calibration: verified.calibrationSplitHash, holdout: verified.holdoutSplitHash };
    const datasetPath = path.join(dir, 'dataset.jsonl');
    fs.writeFileSync(datasetPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(datasetPath.replace('.jsonl', '.manifest.json'), JSON.stringify(manifest));

    const fill = (filePath, reviewerId) => {
        const records = fs.readFileSync(filePath, 'utf-8').trim().split('\n').map(JSON.parse);
        records[0].reviewerId = reviewerId;
        records[0].reviewedAt = '2026-08-01T00:00:00.000Z';
        records[0].attestation = review.ATTESTATION;
        for (const record of records.slice(1)) record.label = record.candidateLabel;
        fs.writeFileSync(filePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
    };
    const firstPath = path.join(dir, 'review-a.jsonl');
    const secondPath = path.join(dir, 'review-b.jsonl');
    review.exportReview({ datasetPath, output: firstPath, reviewerId: 'reviewer-a', scope: 'all' });
    review.exportReview({ datasetPath, output: secondPath, reviewerId: 'reviewer-b', scope: 'double-review' });
    fill(firstPath, 'reviewer-a');

    const incomplete = review.mergeReviews({
        datasetPath, reviewPaths: [firstPath], output: path.join(dir, 'incomplete.jsonl')
    });
    assert.equal(incomplete.ok, false);
    assert.equal(incomplete.verified, 1);
    assert.equal(incomplete.pending, 1);
    assert.deepEqual(incomplete.missing, [{ caseId: 'hard-negative', required: 2, actual: 1 }]);

    fill(secondPath, 'reviewer-b');
    const complete = review.mergeReviews({
        datasetPath, reviewPaths: [firstPath, secondPath], output: path.join(dir, 'reviewed.jsonl')
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.verified, 2);
    assert.equal(complete.pending, 0);
    const mergedRows = dataset.readJsonl(complete.output);
    assert.equal(mergedRows.find(row => row.id === 'hard-negative').annotation.reviewCount, 2);
    assert.equal(new Set(complete.evidence.map(item => item.reviewerId)).size, 2);
    assert.ok(complete.evidence.every(item => item.reviewerId.startsWith('reviewer-')));
    assert.ok(complete.evidence.every(item => !['reviewer-a', 'reviewer-b'].includes(item.reviewerId)));
});

test('review merge rejects missing attestation and conflicting labels', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-review-conflict-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const row = {
        id: 'hard-negative', targetType: 'diary', library: 'EvalDiary', query: 'question', label: 'negative',
        difficulty: 'hard', source: 'cross-library', sourceRefs: ['doc'], intentGroup: 'intent', split: 'calibration',
        annotation: { status: 'pending', reviewCount: 0 }
    };
    const manifest = { schemaVersion: 1, datasetId: 'review-test', targets: [{ targetType: 'diary', library: 'EvalDiary' }] };
    const verified = dataset.verifyRows([row], manifest);
    manifest.hashes = { dataset: verified.datasetHash, calibration: verified.calibrationSplitHash, holdout: verified.holdoutSplitHash };
    const datasetPath = path.join(dir, 'dataset.jsonl');
    fs.writeFileSync(datasetPath, `${JSON.stringify(row)}\n`);
    fs.writeFileSync(datasetPath.replace('.jsonl', '.manifest.json'), JSON.stringify(manifest));
    const make = (name, label, attest = true) => {
        const file = path.join(dir, `${name}.jsonl`);
        review.exportReview({ datasetPath, output: file, reviewerId: name, scope: 'all' });
        const records = fs.readFileSync(file, 'utf-8').trim().split('\n').map(JSON.parse);
        records[0].reviewedAt = '2026-08-01T00:00:00.000Z';
        records[0].attestation = attest ? review.ATTESTATION : null;
        records[1].label = label;
        fs.writeFileSync(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
        return file;
    };
    const invalid = make('invalid', 'negative', false);
    assert.throws(
        () => review.mergeReviews({ datasetPath, reviewPaths: [invalid], output: path.join(dir, 'invalid-out.jsonl') }),
        error => error.code === 'GATE_REVIEW_ATTESTATION_MISSING'
    );
    const a = make('a', 'negative');
    const b = make('b', 'positive');
    const conflict = review.mergeReviews({ datasetPath, reviewPaths: [a, b], output: path.join(dir, 'conflict.jsonl') });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicts.length, 1);
    assert.equal(conflict.pending, 1);

    const relabeled = make('relabeled', 'positive');
    const stillNeedsSecondReview = review.mergeReviews({
        datasetPath, reviewPaths: [relabeled], output: path.join(dir, 'relabeled.jsonl')
    });
    assert.deepEqual(stillNeedsSecondReview.missing, [{ caseId: 'hard-negative', required: 2, actual: 1 }]);
    assert.equal(dataset.readJsonl(stillNeedsSecondReview.output)[0].label, 'negative');

    const staged = review.exportReview({
        datasetPath: stillNeedsSecondReview.output,
        output: path.join(dir, 'staged.jsonl'),
        reviewerId: 'staged-reviewer',
        scope: 'double-review'
    });
    assert.equal(staged.cases, 1);
});

test('double-review export includes newly ambiguous first-review decisions without revealing labels', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-review-followup-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const row = {
        id: 'easy-negative', targetType: 'diary', library: 'EvalDiary', query: 'question', label: 'negative',
        difficulty: 'easy', source: 'cross-library', sourceRefs: ['doc'], intentGroup: 'intent', split: 'calibration',
        annotation: { status: 'pending', reviewCount: 0 }
    };
    const manifest = { schemaVersion: 1, datasetId: 'followup-test', targets: [{ targetType: 'diary', library: 'EvalDiary' }] };
    const verified = dataset.verifyRows([row], manifest);
    manifest.hashes = { dataset: verified.datasetHash, calibration: verified.calibrationSplitHash, holdout: verified.holdoutSplitHash };
    const datasetPath = path.join(dir, 'dataset.jsonl');
    fs.writeFileSync(datasetPath, `${JSON.stringify(row)}\n`);
    fs.writeFileSync(datasetPath.replace('.jsonl', '.manifest.json'), JSON.stringify(manifest));

    const firstPath = path.join(dir, 'first.jsonl');
    review.exportReview({ datasetPath, output: firstPath, reviewerId: 'first', scope: 'all' });
    const first = fs.readFileSync(firstPath, 'utf8').trim().split('\n').map(JSON.parse);
    first[0].reviewedAt = '2026-08-01T00:00:00.000Z';
    first[0].attestation = review.ATTESTATION;
    first[1].label = 'ambiguous';
    fs.writeFileSync(firstPath, `${first.map(record => JSON.stringify(record)).join('\n')}\n`);

    const secondPath = path.join(dir, 'second.jsonl');
    const exported = review.exportReview({
        datasetPath, output: secondPath, reviewerId: 'second', scope: 'double-review', reviewPaths: [firstPath]
    });
    assert.equal(exported.cases, 1);
    const second = fs.readFileSync(secondPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(second[1].caseId, 'easy-negative');
    assert.equal(second[1].candidateLabel, 'negative');
    assert.equal(Object.hasOwn(second[1], 'priorLabel'), false);
    assert.deepEqual(second[0].selectionEvidence, [review.readReview(firstPath).evidenceHash]);
});

test('gate-v1 review export embeds only allowlisted source context', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-review-context-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const output = path.join(dir, 'context.jsonl');
    review.exportReview({
        datasetPath: path.resolve(__dirname, '../gate-data/gate-v1.jsonl'),
        output, reviewerId: 'context-reviewer', scope: 'all', batchCount: 150, batchIndex: 0
    });
    const header = JSON.parse(fs.readFileSync(output, 'utf8').split('\n')[0]);
    const refs = Object.keys(header.sourceContexts);
    assert.equal(refs.length, 1);
    assert.ok(refs[0].startsWith('评测'));
    assert.ok(header.sourceContexts[refs[0]].length > 20);
    assert.equal(Object.hasOwn(header.sourceContexts, '/etc/passwd'), false);
});

test('review export keeps one target intentGroup atomic across deterministic shards', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-review-group-shard-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const datasetPath = path.resolve(__dirname, '../gate-data/gate-v1.jsonl');
    const observed = new Map();
    for (let batchIndex = 0; batchIndex < 4; batchIndex++) {
        const output = path.join(dir, `batch-${batchIndex}.jsonl`);
        review.exportReview({
            datasetPath, output, reviewerId: 'shard-reviewer', scope: 'all', batchCount: 4, batchIndex
        });
        for (const row of dataset.readJsonl(output).slice(1)) {
            const key = `${row.targetType}:${row.library}:${row.intentGroup}`;
            const prior = observed.get(key);
            assert.ok(prior === undefined || prior === batchIndex);
            observed.set(key, batchIndex);
        }
    }
    assert.equal(observed.size, 150);
});
