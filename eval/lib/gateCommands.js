'use strict';

const fs = require('fs');
const path = require('path');

const profileLib = require('./profile');
const runstore = require('./runstore');
const corpusBuild = require('./corpusBuild');
const preflight = require('./preflight');
const pluginConfig = require('./pluginConfig');
const gateDataset = require('./gateDataset');
const gateCalibration = require('./gateCalibration');

const { EVAL_ROOT } = profileLib;

function requireFlag(flags, name) {
    const value = flags[name];
    if (!value || value === true) throw gateCalibration.codedError('GATE_CLI_ARGUMENT_REQUIRED', `--${name} is required`);
    return String(value);
}

function writeArtifact(filePath, artifact) {
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `${JSON.stringify(artifact, null, 2)}\n`);
    return absolute;
}

function verify(flags) {
    const loaded = gateDataset.loadDataset(requireFlag(flags, 'dataset'), {
        manifestPath: flags.manifest && flags.manifest !== true ? String(flags.manifest) : undefined,
        requireDecision: Boolean(flags['require-decision'])
    });
    return {
        ok: loaded.verification.ok,
        dataset: loaded.path,
        manifest: loaded.manifestPath,
        ...loaded.verification
    };
}

async function collect(flags) {
    const dataset = gateDataset.loadDataset(requireFlag(flags, 'dataset'), {
        manifestPath: flags.manifest && flags.manifest !== true ? String(flags.manifest) : undefined
    });
    if (!dataset.verification.ok) {
        throw gateCalibration.codedError('GATE_DATASET_INVALID', 'dataset verification failed');
    }
    const requestedSplit = flags.split && flags.split !== true ? String(flags.split) : null;
    if (requestedSplit && !['calibration', 'holdout'].includes(requestedSplit)) {
        throw gateCalibration.codedError('GATE_SCORE_SPLIT_INVALID', '--split must be calibration or holdout');
    }
    const collectDataset = requestedSplit
        ? { ...dataset, rows: dataset.rows.filter(row => row.split === requestedSplit) }
        : dataset;
    if (collectDataset.rows.length === 0) {
        throw gateCalibration.codedError('GATE_SCORE_SPLIT_EMPTY', `dataset has no rows for split ${requestedSplit}`);
    }
    const resolved = profileLib.loadProfile(flags.profile || 'default');
    const installed = pluginConfig.status();
    if (!installed.ok) throw gateCalibration.codedError('GATE_PLUGIN_CONFIG_MISSING', 'gate target definitions are not installed');
    const embeddingCheck = await preflight.checkEmbedding(resolved);
    if (!embeddingCheck.ok) throw gateCalibration.codedError('GATE_EMBEDDING_UNAVAILABLE', embeddingCheck.detail);
    const corpusManifest = corpusBuild.loadManifest(resolved.corpusRoot);
    if (!corpusManifest) throw gateCalibration.codedError('GATE_CORPUS_MISSING', 'generated corpus manifest is missing');

    const lock = runstore.acquireRunLock({ profile: resolved.name, label: 'gate-collect' });
    let runtime = null;
    let handle = null;
    const logs = [];
    const restore = require('./probes').installLogCapture(line => logs.push(line));
    try {
        handle = runstore.createRun({
            resolved,
            corpusHash: corpusManifest.corpusHash,
            suiteHash: dataset.verification.datasetHash,
            suites: ['gate-collect'],
            label: `gate-collect:${dataset.manifest.datasetId}`,
            includesTier4: false
        });
        resolved.storePath = handle.storePath;
        resolved.modelCache = {
            ragVectorCachePath: handle.paths.ragVectorCache,
            semanticVectorDir: handle.paths.semanticVectorDir
        };
        resolved.gate.configPath = handle.paths.gateConfig;
        profileLib.applyEnv(resolved);
        runstore.writeJson(handle.paths.resolvedConfig, profileLib.snapshotConfig(resolved));
        runstore.writeJson(handle.paths.ragParams, resolved.ragParams);
        runstore.writeJson(handle.paths.corpusManifest, corpusManifest);
        runstore.writeJson(handle.paths.gateDatasetManifest, dataset.manifest);
        runstore.writeJson(handle.paths.gateConfig, {
            schemaVersion: 1,
            calibrationId: null,
            artifactHash: null,
            gateDefinitionHash: resolved.gate.definitionHash,
            scoringFormulaVersion: resolved.gate.scoringFormulaVersion,
            embedding: {
                model: resolved.embedding.model,
                dimension: resolved.embedding.dimension,
                endpointFingerprint: resolved.embedding.endpointFingerprint
            },
            effectiveConfigHash: resolved.gate.effectiveConfigHash,
            allowedTargets: resolved.gate.allowedTargets,
            thresholds: {}
        });
        runtime = await require('./runtime').boot({ resolved, withLightMemo: false, withColdKB: false });
        const rows = await gateCalibration.collectRows(
            collectDataset,
            resolved.name,
            {
                model: resolved.embedding.model,
                dimension: resolved.embedding.dimension,
                endpointFingerprint: resolved.embedding.endpointFingerprint
            },
            request => runtime.ragPlugin.scoreGate(request),
            {
                concurrency: flags.concurrency,
                retryAttempts: flags['retry-attempts'],
                retryBaseMs: flags['retry-base-ms']
            }
        );
        const outputDir = path.resolve(flags.out || path.join(EVAL_ROOT, 'gate-scores'));
        const files = gateCalibration.writeScoreBundles({
            rows, dataset, profileName: resolved.name,
            embedding: {
                model: resolved.embedding.model,
                dimension: resolved.embedding.dimension,
                endpointFingerprint: resolved.embedding.endpointFingerprint
            },
            gateDefinitionHash: resolved.gate.definitionHash,
            outputDir,
            splits: requestedSplit ? [requestedSplit] : undefined
        });
        runstore.finalizeRun(handle, {
            status: 'completed',
            counts: { total: rows.length, scored: rows.length, skipped: 0, errored: 0 }
        });
        return {
            ok: true,
            command: 'collect',
            profile: resolved.name,
            datasetId: dataset.manifest.datasetId,
            datasetHash: dataset.verification.datasetHash,
            qualityLevel: dataset.verification.qualityLevel,
            runId: handle.runId,
            files
        };
    } catch (error) {
        if (handle) runstore.finalizeRun(handle, { status: 'failed', error: { code: error.code || null, message: error.message } });
        throw error;
    } finally {
        try { await runtime?.shutdown?.(); } catch (_) {}
        restore();
        if (handle) {
            try { fs.writeFileSync(handle.paths.log, logs.join('\n')); } catch (_) {}
        }
        lock.release();
    }
}

function calibrate(flags) {
    const bundle = gateCalibration.loadScoreBundle(requireFlag(flags, 'scores'));
    const artifact = gateCalibration.calibrate(bundle, {
        targetFpr: flags['target-fpr'],
        bootstrapIterations: flags.bootstrap,
        seed: flags.seed === undefined ? undefined : Number(flags.seed),
        allowDevelopment: Boolean(flags['allow-development'])
    });
    const output = writeArtifact(flags.out || path.join(EVAL_ROOT, 'gate-calibration', `${bundle.manifest.profile}.draft.json`), artifact);
    return { ok: true, command: 'calibrate', output, artifact };
}

function validate(flags) {
    const calibrationPath = path.resolve(requireFlag(flags, 'calibration'));
    const draft = JSON.parse(fs.readFileSync(calibrationPath, 'utf-8'));
    const bundle = gateCalibration.loadScoreBundle(requireFlag(flags, 'scores'));
    const artifact = gateCalibration.validate(draft, bundle, {
        allowDevelopment: Boolean(flags['allow-development'])
    });
    const defaultName = `${bundle.manifest.profile}.json`;
    const requestedOutput = path.resolve(flags.out || path.join(EVAL_ROOT, 'gate-calibration', defaultName));
    if (requestedOutput === calibrationPath) {
        throw gateCalibration.codedError('GATE_CALIBRATION_OVERWRITE_FORBIDDEN', 'validate output must not overwrite the draft');
    }
    const output = writeArtifact(requestedOutput, artifact);
    return { ok: true, command: 'validate', output, artifact };
}

function review(flags, positional = []) {
    const action = positional[0];
    const gateReview = require('./gateReview');
    if (action === 'export') {
        return gateReview.exportReview({
            datasetPath: requireFlag(flags, 'dataset'),
            manifestPath: flags.manifest && flags.manifest !== true ? String(flags.manifest) : undefined,
            output: requireFlag(flags, 'out'),
            reviewerId: flags.reviewer && flags.reviewer !== true ? String(flags.reviewer) : null,
            scope: flags.scope && flags.scope !== true ? String(flags.scope) : 'all',
            batchCount: flags['batch-count'] ?? 1,
            batchIndex: flags['batch-index'] ?? 0,
            reviewPaths: flags.reviews && flags.reviews !== true
                ? String(flags.reviews).split(',').map(value => value.trim()).filter(Boolean)
                : []
        });
    }
    if (action === 'merge') {
        const reviewPaths = String(requireFlag(flags, 'reviews')).split(',').map(value => value.trim()).filter(Boolean);
        return gateReview.mergeReviews({
            datasetPath: requireFlag(flags, 'dataset'),
            manifestPath: flags.manifest && flags.manifest !== true ? String(flags.manifest) : undefined,
            reviewPaths,
            output: requireFlag(flags, 'out')
        });
    }
    throw gateCalibration.codedError('GATE_REVIEW_ACTION_INVALID', 'gate review requires export or merge');
}

module.exports = { verify, collect, calibrate, validate, review };
