'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TARGET_TYPES = new Set(['diary', 'cold']);
const LABELS = new Set(['positive', 'negative', 'ambiguous']);
const DIFFICULTIES = new Set(['easy', 'near-domain', 'hard']);
const SOURCES = new Set(['corpus-derived', 'cross-library', 'mined', 'production-sanitized']);
const SPLITS = new Set(['calibration', 'holdout']);

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function sha256(value) {
    return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function readJsonl(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, index) => {
        try { return JSON.parse(line); } catch (error) {
            error.message = `${filePath}:${index + 1}: ${error.message}`;
            throw error;
        }
    });
}

function canonicalRows(rows) {
    return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .map(stableValue);
}

function hashRows(rows) {
    return sha256(canonicalRows(rows).map(row => JSON.stringify(row)).join('\n'));
}

function targetKey(row) {
    return `${row.targetType}:${row.library}`;
}

function verifyRows(rows, manifest = {}, options = {}) {
    const findings = [];
    const ids = new Set();
    const intentSplits = new Map();
    const sourceRefSplits = new Map();
    const targetStats = {};
    const targets = new Set((manifest.targets || []).map(item => `${item.targetType}:${item.library}`));
    const add = (code, message, detail = {}) => findings.push({ level: 'error', code, message, ...detail });
    const warn = (code, message, detail = {}) => findings.push({ level: 'warn', code, message, ...detail });

    for (const [index, row] of rows.entries()) {
        const at = { index: index + 1, id: row?.id || null };
        if (!row || typeof row !== 'object' || Array.isArray(row)) { add('invalid-row', 'row must be an object', at); continue; }
        if (!row.id || typeof row.id !== 'string') add('invalid-id', 'id must be a non-empty string', at);
        else if (ids.has(row.id)) add('duplicate-id', `duplicate id: ${row.id}`, at);
        else ids.add(row.id);
        if (!TARGET_TYPES.has(row.targetType)) add('invalid-target-type', `invalid targetType: ${row.targetType}`, at);
        if (!row.library || typeof row.library !== 'string') add('invalid-library', 'library must be non-empty', at);
        if (targets.size && !targets.has(targetKey(row))) add('unknown-target', `target is absent from manifest: ${targetKey(row)}`, at);
        if (!row.query || typeof row.query !== 'string' || !row.query.trim()) add('invalid-query', 'query must be non-empty', at);
        if (typeof row.query === 'string' && row.query !== row.query.trim()) add('query-whitespace', 'query must be trimmed', at);
        if (!LABELS.has(row.label)) add('invalid-label', `invalid label: ${row.label}`, at);
        if (!DIFFICULTIES.has(row.difficulty)) add('invalid-difficulty', `invalid difficulty: ${row.difficulty}`, at);
        if (!SOURCES.has(row.source)) add('invalid-source', `invalid source: ${row.source}`, at);
        if (!Array.isArray(row.sourceRefs) || !row.sourceRefs.length || row.sourceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) {
            add('invalid-source-refs', 'sourceRefs must contain traceable non-empty strings', at);
        }
        if (!row.intentGroup || typeof row.intentGroup !== 'string') add('invalid-intent-group', 'intentGroup must be non-empty', at);
        if (!SPLITS.has(row.split)) add('invalid-split', `invalid split: ${row.split}`, at);

        if (row.intentGroup && SPLITS.has(row.split)) {
            const prior = intentSplits.get(row.intentGroup);
            if (prior && prior !== row.split) add('intent-split-leakage', `intentGroup ${row.intentGroup} occurs in ${prior} and ${row.split}`, at);
            else intentSplits.set(row.intentGroup, row.split);
        }
        if (Array.isArray(row.sourceRefs) && SPLITS.has(row.split)) {
            for (const sourceRef of row.sourceRefs) {
                if (typeof sourceRef !== 'string' || !sourceRef.trim()) continue;
                const prior = sourceRefSplits.get(sourceRef);
                if (prior && prior !== row.split) {
                    add('source-ref-split-leakage', `sourceRef ${sourceRef} occurs in ${prior} and ${row.split}`, at);
                } else {
                    sourceRefSplits.set(sourceRef, row.split);
                }
            }
        }

        const annotation = row.annotation || {};
        const verified = annotation.status === 'verified';
        const reviewCount = Number(annotation.reviewCount || 0);
        if (verified && (!Number.isInteger(reviewCount) || reviewCount < 1)) add('invalid-review-count', 'verified annotation requires reviewCount >= 1', at);
        if ((row.difficulty === 'hard' && row.label === 'negative') || row.label === 'ambiguous') {
            if (verified && reviewCount < 2) add('double-review-required', 'hard negatives and ambiguous rows require two verified reviews', at);
            else if (!verified) warn('double-review-pending', 'hard negative or ambiguous row still awaits two verified reviews', at);
        }

        const key = targetKey(row);
        const stats = targetStats[key] ||= {
            targetType: row.targetType, library: row.library, total: 0,
            positive: 0, negative: 0, ambiguous: 0, verified: 0,
            splits: { calibration: 0, holdout: 0 },
            negativeDifficulty: { easy: 0, 'near-domain': 0, hard: 0 }
        };
        stats.total++;
        if (LABELS.has(row.label)) stats[row.label]++;
        if (verified) stats.verified++;
        if (SPLITS.has(row.split)) stats.splits[row.split]++;
        if (row.label === 'negative' && DIFFICULTIES.has(row.difficulty)) stats.negativeDifficulty[row.difficulty]++;
    }

    const decisionTargets = [];
    const developmentTargets = [];
    for (const [key, stats] of Object.entries(targetStats)) {
        const allVerified = stats.verified === stats.total;
        const decisionCounts = stats.positive >= 100 && stats.negative >= 200;
        const negativeBalanced = Object.values(stats.negativeDifficulty).every(count => count >= Math.floor(stats.negative * 0.25));
        if (allVerified && decisionCounts && negativeBalanced) decisionTargets.push(key);
        if (allVerified && stats.positive >= 40 && stats.negative >= 60) developmentTargets.push(key);
    }
    const declared = [...targets];
    const qualityLevel = declared.length && declared.every(key => decisionTargets.includes(key))
        ? 'decision'
        : (declared.length && declared.every(key => developmentTargets.includes(key)) ? 'development' : 'candidate');
    if (options.requireDecision && qualityLevel !== 'decision') {
        add('dataset-insufficient', `decision dataset required; actual qualityLevel=${qualityLevel}`);
    }

    const splitRows = split => rows.filter(row => row.split === split);
    return {
        ok: findings.every(finding => finding.level !== 'error'),
        findings,
        datasetHash: hashRows(rows),
        calibrationSplitHash: hashRows(splitRows('calibration')),
        holdoutSplitHash: hashRows(splitRows('holdout')),
        qualityLevel,
        counts: { total: rows.length, targets: targetStats },
        annotation: {
            verified: rows.filter(row => row.annotation?.status === 'verified').length,
            pending: rows.filter(row => row.annotation?.status !== 'verified').length
        }
    };
}

function loadDataset(datasetPath, options = {}) {
    const absolute = path.resolve(datasetPath);
    const rows = readJsonl(absolute);
    const manifestPath = options.manifestPath
        ? path.resolve(options.manifestPath)
        : absolute.replace(/\.jsonl$/i, '.manifest.json');
    const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) : {};
    const verification = verifyRows(rows, manifest, options);
    const expected = manifest.hashes || {};
    if (expected.dataset && expected.dataset !== verification.datasetHash) {
        verification.findings.push({ level: 'error', code: 'dataset-hash-mismatch', message: 'manifest dataset hash differs' });
    }
    if (expected.calibration && expected.calibration !== verification.calibrationSplitHash) {
        verification.findings.push({ level: 'error', code: 'calibration-hash-mismatch', message: 'manifest calibration hash differs' });
    }
    if (expected.holdout && expected.holdout !== verification.holdoutSplitHash) {
        verification.findings.push({ level: 'error', code: 'holdout-hash-mismatch', message: 'manifest holdout hash differs' });
    }
    verification.ok = verification.findings.every(finding => finding.level !== 'error');
    return { path: absolute, manifestPath, manifest, rows, verification };
}

module.exports = { readJsonl, hashRows, verifyRows, loadDataset, stableValue, sha256, targetKey };
