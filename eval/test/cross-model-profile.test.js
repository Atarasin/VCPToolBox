'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const profile = require('../lib/profile');
const runstore = require('../lib/runstore');
const preflight = require('../lib/preflight');

test('VT-001: aligned cold embedding is derived from the effective profile', () => {
    const resolved = profile.loadProfile('gemini3072');
    assert.equal(resolved.embedding.model, 'jy-gemini-embedding-001');
    assert.equal(resolved.embedding.dimension, 3072);
    assert.deepEqual(
        { model: resolved.coldKnowledge.model, dimension: resolved.coldKnowledge.dimension },
        { model: 'jy-gemini-embedding-001', dimension: 3072 }
    );
    assert.equal(resolved.env.TDB_KNOWLEDGE_MODEL, 'jy-gemini-embedding-001');
    assert.equal(resolved.env.TDB_KNOWLEDGE_DIMENSION, '3072');
});

test('VT-002: an explicit aligned cold embedding conflict has a stable code', () => {
    assert.throws(
        () => profile.loadProfile('gemini3072', {
            env: { TDB_KNOWLEDGE_MODEL: 'Qwen/Qwen3-Embedding-8B' }
        }),
        error => error.code === 'PROFILE_COLD_EMBEDDING_CONFLICT'
    );
});

test('snapshot stores endpoint and credential fingerprints, never raw values', () => {
    const resolved = profile.loadProfile('gemini3072', {
        env: {
            API_URL: 'https://embedding.example.test/base/',
            API_Key: 'top-secret',
            RerankUrl: 'https://rerank.example.test/v1?token=abc',
            RerankApi: 'rerank-secret',
            RerankModel: 'rerank-v1'
        }
    });
    const snapshot = profile.snapshotConfig(resolved);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /embedding\.example\.test/);
    assert.doesNotMatch(serialized, /top-secret/);
    assert.doesNotMatch(serialized, /rerank\.example\.test/);
    assert.doesNotMatch(serialized, /rerank-secret/);
    assert.match(snapshot.embedding.endpointFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(snapshot.embedding.apiKeyFingerprint, /^sha256:[a-f0-9]{12}$/);
});

test('VT-003: calibration embedding mismatch is reported as stale', t => {
    const artifactDir = path.join(profile.EVAL_ROOT, 'gate-calibration');
    const artifactPath = path.join(artifactDir, 'test-stale.json');
    const tempProfilePath = path.join(profile.PROFILES_DIR, 'test-stale.json');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({
        status: 'validated',
        embedding: { model: 'other-model', dimension: 3072, endpointFingerprint: 'sha256:other' }
    }));
    fs.writeFileSync(tempProfilePath, JSON.stringify({
        ragParamsPath: 'rag_params.json',
        embedding: { model: 'jy-gemini-embedding-001', dimension: 3072 },
        coldKnowledge: { mode: 'aligned', storePolicy: 'per-run' },
        gateCalibrationPath: 'gate-calibration/test-stale.json'
    }));
    t.after(() => {
        fs.rmSync(artifactPath, { force: true });
        fs.rmSync(tempProfilePath, { force: true });
    });

    const resolved = profile.loadProfile('test-stale');
    assert.equal(resolved.gateCalibration.status, 'stale');
    assert.equal(resolved.gateCalibration.reasonCode, 'gate-calibration-stale');
    assert.equal(preflight.checkGateCalibration(resolved).reasonCode, 'gate-calibration-stale');
});

test('cold corpus fingerprint is content-based and available to the real preflight chain', () => {
    const resolved = profile.loadProfile('gemini3072');
    const first = preflight.coldCorpusFingerprint(resolved);
    const second = preflight.coldCorpusFingerprint(resolved);
    assert.match(first, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first, second);
});

test('default profile resolves without relying on a local config.env', () => {
    const resolved = profile.loadProfile('default');
    assert.equal(resolved.embedding.model, 'Qwen/Qwen3-Embedding-8B');
    assert.equal(resolved.embedding.dimension, 4096);
});

test('runstore creates isolated model assets and records cross-model provenance', t => {
    const resolved = profile.loadProfile('gemini3072');
    const handle = runstore.createRun({
        resolved,
        corpusHash: 'corpus-test',
        suiteHash: `suite-${process.pid}-${Date.now()}`,
        suites: ['test'],
        includesTier4: true,
        coldCorpusFingerprint: 'sha256:cold-test'
    });
    t.after(() => fs.rmSync(handle.dir, { recursive: true, force: true }));

    assert.equal(handle.manifest.schemaVersion, 2);
    assert.equal(handle.manifest.provenance.coldKnowledge.model, resolved.embedding.model);
    assert.equal(handle.manifest.provenance.axes.retrieval.corpusHash, 'corpus-test');
    assert.ok(fs.statSync(handle.coldStorePath).isDirectory());
    assert.ok(fs.statSync(handle.modelCachePath).isDirectory());
    assert.ok(fs.statSync(handle.paths.semanticVectorDir).isDirectory());
    assert.equal(path.dirname(handle.paths.ragVectorCache), handle.modelCachePath);
});
