'use strict';

const fs = require('fs');
const path = require('path');

const { hashRows, loadDataset, sha256, verifyRows } = require('./gateDataset');

const ATTESTATION = 'I personally reviewed these gate labels against their source references.';
const LABELS = new Set(['positive', 'negative', 'ambiguous']);

function codedError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function writeJsonl(filePath, rows) {
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    return absolute;
}

function reviewerAlias(reviewerId) {
    return `reviewer-${sha256(String(reviewerId)).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

function exportReview({ datasetPath, manifestPath, output, reviewerId, scope = 'all', batchCount = 1, batchIndex = 0, reviewPaths = [] }) {
    const dataset = loadDataset(datasetPath, { manifestPath });
    if (!dataset.verification.ok) throw codedError('GATE_DATASET_INVALID', 'cannot review a structurally invalid dataset');
    const priorReviews = reviewPaths.map(readReview);
    for (const review of priorReviews) {
        if (review.meta.datasetHash !== dataset.verification.datasetHash) {
            throw codedError('GATE_REVIEW_DATASET_MISMATCH', `${review.path}: dataset hash differs`);
        }
    }
    const newlyAmbiguous = new Set(priorReviews.flatMap(review => [...review.decisions]
        .filter(([, decision]) => decision.label === 'ambiguous')
        .map(([caseId]) => caseId)));
    const count = Number(batchCount);
    const index = Number(batchIndex);
    if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 0 || index >= count) {
        throw codedError('GATE_REVIEW_BATCH_INVALID', 'batchCount/batchIndex must identify a valid zero-based shard');
    }
    if (!['all', 'double-review'].includes(scope)) throw codedError('GATE_REVIEW_SCOPE_INVALID', 'scope must be all or double-review');
    const selected = [...dataset.rows].sort((a, b) => a.id.localeCompare(b.id))
        .filter(row => scope === 'all' || newlyAmbiguous.has(row.id)
            || row.label === 'ambiguous' || (row.label === 'negative' && row.difficulty === 'hard'))
        .filter((row, rowIndex) => rowIndex % count === index);
    const rows = [{
        recordType: 'review-meta',
        schemaVersion: 1,
        datasetId: dataset.manifest.datasetId,
        datasetHash: dataset.verification.datasetHash,
        scope,
        batch: { index, count },
        reviewerId: reviewerId || null,
        reviewedAt: null,
        attestation: null,
        requiredAttestation: ATTESTATION,
        selectionEvidence: priorReviews.map(review => review.evidenceHash).sort()
    }, ...selected.map(row => ({
        recordType: 'gate-review',
        caseId: row.id,
        targetType: row.targetType,
        library: row.library,
        query: row.query,
        sourceRefs: row.sourceRefs,
        difficulty: row.difficulty,
        candidateLabel: row.label,
        label: null,
        notes: null
    }))];
    const reviewPath = writeJsonl(output, rows);
    return { ok: true, output: reviewPath, datasetHash: dataset.verification.datasetHash, scope, batch: { index, count }, cases: selected.length };
}

function readReview(filePath) {
    const absolute = path.resolve(filePath);
    const lines = fs.readFileSync(absolute, 'utf-8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const rows = lines.map((line, index) => {
        try { return JSON.parse(line); } catch (error) {
            throw codedError('GATE_REVIEW_JSON_INVALID', `${absolute}:${index + 1}: ${error.message}`);
        }
    });
    const meta = rows[0];
    if (meta?.recordType !== 'review-meta' || meta.schemaVersion !== 1) throw codedError('GATE_REVIEW_META_INVALID', `${absolute}: missing review-meta header`);
    if (!meta.reviewerId || typeof meta.reviewerId !== 'string') throw codedError('GATE_REVIEWER_ID_MISSING', `${absolute}: reviewerId is required`);
    if (meta.attestation !== ATTESTATION) throw codedError('GATE_REVIEW_ATTESTATION_MISSING', `${absolute}: exact human attestation is required`);
    if (!meta.reviewedAt || !Number.isFinite(Date.parse(meta.reviewedAt))) throw codedError('GATE_REVIEW_TIME_MISSING', `${absolute}: reviewedAt must be an ISO timestamp`);
    const decisions = new Map();
    for (const row of rows.slice(1)) {
        if (row.recordType !== 'gate-review' || !row.caseId) throw codedError('GATE_REVIEW_ROW_INVALID', `${absolute}: invalid review row`);
        if (!LABELS.has(row.label)) throw codedError('GATE_REVIEW_LABEL_MISSING', `${absolute}: ${row.caseId} needs a final label`);
        if (decisions.has(row.caseId)) throw codedError('GATE_REVIEW_DUPLICATE_CASE', `${absolute}: duplicate ${row.caseId}`);
        decisions.set(row.caseId, { label: row.label, notes: row.notes || null });
    }
    return { path: absolute, meta, decisions, evidenceHash: sha256(fs.readFileSync(absolute)) };
}

function mergeReviews({ datasetPath, manifestPath, reviewPaths, output }) {
    const dataset = loadDataset(datasetPath, { manifestPath });
    if (!dataset.verification.ok) throw codedError('GATE_DATASET_INVALID', 'cannot merge reviews into a structurally invalid dataset');
    const reviews = reviewPaths.map(readReview);
    const outputPath = path.resolve(output);
    if (outputPath === dataset.path) throw codedError('GATE_REVIEW_OVERWRITE_FORBIDDEN', 'review merge must not overwrite the source dataset');
    for (const review of reviews) {
        if (review.meta.datasetHash !== dataset.verification.datasetHash) throw codedError('GATE_REVIEW_DATASET_MISMATCH', `${review.path}: dataset hash differs`);
    }

    const caseIds = new Set(dataset.rows.map(row => row.id));
    for (const review of reviews) {
        for (const caseId of review.decisions.keys()) {
            if (!caseIds.has(caseId)) throw codedError('GATE_REVIEW_UNKNOWN_CASE', `${review.path}: unknown case ${caseId}`);
        }
    }

    const conflicts = [];
    const missing = [];
    const mergedRows = dataset.rows.map(row => {
        const decisions = reviews.flatMap(review => {
            const decision = review.decisions.get(row.id);
            return decision ? [{ reviewerId: review.meta.reviewerId, ...decision }] : [];
        });
        if (new Set(decisions.map(decision => decision.reviewerId)).size !== decisions.length) {
            throw codedError('GATE_REVIEW_DUPLICATE_REVIEWER', `reviewer submitted ${row.id} more than once`);
        }
        if (!decisions.length) {
            missing.push({ caseId: row.id, required: 1, actual: 0 });
            return row;
        }
        const labels = [...new Set(decisions.map(decision => decision.label))];
        if (labels.length !== 1) {
            conflicts.push({ caseId: row.id, decisions });
            return row;
        }
        const finalLabel = labels[0];
        const candidateNeedsDoubleReview = row.label === 'ambiguous' || (row.label === 'negative' && row.difficulty === 'hard');
        const required = candidateNeedsDoubleReview || finalLabel === 'ambiguous' ? 2 : 1;
        if (decisions.length < required) {
            missing.push({ caseId: row.id, required, actual: decisions.length });
            // Keep the source candidate immutable until its full review quorum is met.
            // Otherwise an incomplete merge could be used as the source of a later
            // merge and silently downgrade a hard-negative case to single review.
            return row;
        }
        return {
            ...row,
            label: finalLabel,
            annotation: {
                status: 'verified',
                reviewCount: decisions.length,
                reviewBatch: sha256(reviews.map(review => review.evidenceHash).sort().join('|')),
                notes: decisions.map(decision => decision.notes).filter(Boolean).join(' | ') || null
            }
        };
    });

    const baseManifest = {
        ...dataset.manifest,
        annotationVersion: `reviewed-${new Date().toISOString().slice(0, 10)}`,
        reviewEvidence: reviews.map(review => ({
            reviewerId: reviewerAlias(review.meta.reviewerId),
            reviewedAt: review.meta.reviewedAt,
            scope: review.meta.scope,
            batch: review.meta.batch,
            evidenceHash: review.evidenceHash
        }))
    };
    delete baseManifest.hashes;
    delete baseManifest.counts;
    delete baseManifest.annotation;
    const verification = verifyRows(mergedRows, baseManifest);
    baseManifest.qualityLevel = verification.qualityLevel;
    baseManifest.status = verification.qualityLevel === 'decision' ? 'reviewed' : 'review-incomplete';
    baseManifest.hashes = {
        dataset: verification.datasetHash,
        calibration: verification.calibrationSplitHash,
        holdout: verification.holdoutSplitHash
    };
    baseManifest.counts = verification.counts;
    baseManifest.annotation = verification.annotation;
    const datasetOutput = writeJsonl(outputPath, mergedRows);
    const manifestOutput = datasetOutput.replace(/\.jsonl$/i, '.manifest.json');
    fs.writeFileSync(manifestOutput, `${JSON.stringify(baseManifest, null, 2)}\n`);
    return {
        ok: verification.ok && conflicts.length === 0 && missing.length === 0,
        output: datasetOutput,
        manifest: manifestOutput,
        qualityLevel: verification.qualityLevel,
        verified: verification.annotation.verified,
        pending: verification.annotation.pending,
        conflicts,
        missing,
        evidence: baseManifest.reviewEvidence,
        datasetHash: hashRows(mergedRows)
    };
}

module.exports = { ATTESTATION, exportReview, readReview, mergeReviews, codedError, reviewerAlias };
