'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const profile = require('../lib/profile');
const runstore = require('../lib/runstore');

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
        env: { API_URL: 'https://embedding.example.test/base/', API_Key: 'top-secret' }
    });
    const snapshot = profile.snapshotConfig(resolved);
    const serialized = JSON.stringify(snapshot);
    assert.doesNotMatch(serialized, /embedding\.example\.test/);
    assert.doesNotMatch(serialized, /top-secret/);
    assert.match(snapshot.embedding.endpointFingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.match(snapshot.embedding.apiKeyFingerprint, /^sha256:[a-f0-9]{12}$/);
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
