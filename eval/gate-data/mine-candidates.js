'use strict';

const fs = require('fs');
const path = require('path');

const { loadDataset, sha256, stableValue, targetKey } = require('../lib/gateDataset');
const { loadScoreBundle } = require('../lib/gateCalibration');

function parseArgs(argv) {
    const flags = {};
    for (let index = 0; index < argv.length; index++) {
        const token = argv[index];
        if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
        const name = token.slice(2);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
        flags[name] = value;
    }
    return flags;
}

function artifactHash(value) {
    return sha256(JSON.stringify(stableValue(value)));
}

function percentileRanks(rows) {
    const sorted = [...rows].sort((left, right) => (right.score - left.score) || left.caseId.localeCompare(right.caseId));
    const denominator = Math.max(1, sorted.length - 1);
    return new Map(sorted.map((row, index) => [row.caseId, 1 - index / denominator]));
}

function minedOutputCaseId(caseId) {
    return String(caseId).replace(/_neg_(?:easy|neardomain|hard)_/u, '_neg_');
}

function mine({ datasetPath, scorePaths, output }) {
    const dataset = loadDataset(datasetPath);
    if (!dataset.verification.ok) throw new Error('dataset verification failed');
    const absolute = path.resolve(output);
    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(absolute, 'utf8')); } catch (_) {}
    const priorInputId = new Map((prior?.cases || []).map(item => [item.outputCaseId || item.caseId, item.caseId]));
    const scoreCaseId = caseId => priorInputId.get(caseId) || caseId;
    const bundles = scorePaths.map(loadScoreBundle);
    const byProfile = new Map();
    const scoreDatasetHashes = new Set(bundles.map(bundle => bundle.manifest.dataset?.hash));
    if (scoreDatasetHashes.size !== 1) throw new Error('score bundles do not share one dataset hash');
    const scoreDatasetHash = [...scoreDatasetHashes][0];
    const acceptedDatasetHashes = new Set([
        dataset.verification.datasetHash,
        dataset.manifest.miningEvidence?.inputDatasetHash
    ].filter(Boolean));
    for (const bundle of bundles) {
        if (!acceptedDatasetHashes.has(bundle.manifest.dataset?.hash)) {
            throw new Error(`${bundle.path}: score bundle belongs to another dataset`);
        }
        const profile = bundle.manifest.profile;
        if (!profile) throw new Error(`${bundle.path}: profile is missing`);
        const splits = byProfile.get(profile) || new Map();
        if (splits.has(bundle.manifest.split)) throw new Error(`duplicate ${profile}/${bundle.manifest.split} bundle`);
        splits.set(bundle.manifest.split, bundle);
        byProfile.set(profile, splits);
    }
    if (byProfile.size < 2) throw new Error('mining requires scores from at least two profiles');
    for (const [profile, splits] of byProfile) {
        if (!splits.has('calibration') || !splits.has('holdout')) {
            throw new Error(`${profile}: calibration and holdout bundles are both required`);
        }
    }

    const negativeRows = dataset.rows.filter(row => row.label === 'negative');
    const scoresByProfile = new Map();
    const scoreEvidence = [];
    for (const [profile, splits] of [...byProfile].sort(([left], [right]) => left.localeCompare(right))) {
        const rows = [...splits.values()].flatMap(bundle => bundle.rows);
        const scores = new Map(rows.map(row => [row.caseId, row.score]));
        if (scores.size !== dataset.rows.length || dataset.rows.some(row => !Number.isFinite(scores.get(scoreCaseId(row.id))))) {
            throw new Error(`${profile}: score coverage is incomplete`);
        }
        scoresByProfile.set(profile, scores);
        scoreEvidence.push({
            profile,
            embedding: splits.get('calibration').manifest.embedding,
            calibrationRowsHash: splits.get('calibration').manifest.rowsHash,
            holdoutRowsHash: splits.get('holdout').manifest.rowsHash
        });
    }

    const cases = [];
    const groups = new Map();
    for (const row of negativeRows) {
        const key = targetKey(row);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    }
    for (const [target, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
        if (rows.length !== 200) throw new Error(`${target}: expected 200 negative candidates, got ${rows.length}`);
        const ranks = new Map();
        for (const [profile, scores] of scoresByProfile) {
            const ranked = percentileRanks(rows.map(row => ({ caseId: row.id, score: scores.get(scoreCaseId(row.id)) })));
            ranks.set(profile, ranked);
        }
        const rankedCases = rows.map(row => {
            const profileScores = Object.fromEntries([...scoresByProfile].map(([profile, scores]) => [profile, scores.get(scoreCaseId(row.id))]));
            const profilePercentiles = Object.fromEntries([...ranks].map(([profile, values]) => [profile, values.get(row.id)]));
            const aggregatePercentile = Object.values(profilePercentiles)
                .reduce((sum, value) => sum + value, 0) / Object.keys(profilePercentiles).length;
            const inputCaseId = scoreCaseId(row.id);
            return {
                caseId: inputCaseId,
                outputCaseId: minedOutputCaseId(inputCaseId),
                target,
                profileScores,
                profilePercentiles,
                aggregatePercentile
            };
        }).sort((left, right) => (right.aggregatePercentile - left.aggregatePercentile)
            || left.caseId.localeCompare(right.caseId));
        rankedCases.forEach((item, index) => {
            item.assignedDifficulty = index < 66 ? 'hard' : (index < 133 ? 'near-domain' : 'easy');
            item.source = item.assignedDifficulty === 'hard' ? 'mined' : 'cross-library';
            cases.push(item);
        });
    }

    const evidence = {
        schemaVersion: 1,
        datasetId: dataset.manifest.datasetId,
        inputDatasetHash: scoreDatasetHash,
        algorithm: {
            name: 'mean-within-target-profile-percentile',
            hardPerTarget: 66,
            nearDomainPerTarget: 67,
            easyPerTarget: 67,
            tieBreak: 'caseId-ascending'
        },
        scoreEvidence,
        cases: cases.sort((left, right) => left.caseId.localeCompare(right.caseId))
    };
    evidence.evidenceId = artifactHash(evidence);
    evidence.generatedAt = prior?.evidenceId === evidence.evidenceId && prior.generatedAt
        ? prior.generatedAt
        : new Date().toISOString();
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(evidence, null, 2)}\n`);
    return { output: absolute, evidenceId: evidence.evidenceId, cases: cases.length, hard: cases.filter(item => item.assignedDifficulty === 'hard').length };
}

if (require.main === module) {
    try {
        const flags = parseArgs(process.argv.slice(2));
        const result = mine({
            datasetPath: flags.dataset,
            scorePaths: String(flags.scores || '').split(',').map(value => value.trim()).filter(Boolean),
            output: flags.out
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { mine, percentileRanks, artifactHash, minedOutputCaseId };
