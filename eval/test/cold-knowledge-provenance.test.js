'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tdbModule = require('../../TDBKnowledge');
const TDBPlaceholderProcessor = require('../../Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor');
const probes = require('../lib/probes');
const runtime = require('../lib/runtime');
const runner = require('../lib/runner');
const { deriveRunStatus } = require('../lib/cli');
const { _getEmbeddingModelCandidates } = require('../../EmbeddingUtils');

const { TDBKnowledgeManager } = tdbModule;

function temporaryManager(t, overrides = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-cold-root-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-cold-store-'));
    fs.mkdirSync(path.join(root, 'VCP知识'), { recursive: true });
    fs.writeFileSync(path.join(root, 'VCP知识', 'sample.txt'), 'stable cold corpus');
    t.after(() => {
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(store, { recursive: true, force: true });
    });
    const manager = new TDBKnowledgeManager({
        enabled: true,
        rootPath: root,
        storePath: store,
        model: 'model-a',
        dimension: 3,
        apiUrl: 'https://embedding.example.test',
        strictVectorMetadata: true,
        ...overrides
    });
    return { manager, root, store };
}

test('VT-007: empty store gets an embedding manifest and becomes compatible on reopen', async t => {
    const { manager, root, store } = temporaryManager(t);
    await manager._prepareStoreIdentity();
    assert.equal(manager.initializationState, 'empty');
    const manifest = JSON.parse(fs.readFileSync(path.join(store, 'embedding-manifest.json'), 'utf-8'));
    assert.equal(manifest.embedding.model, 'model-a');
    assert.equal(manifest.embedding.dimension, 3);
    assert.match(manifest.source.corpusFingerprint, /^sha256:[a-f0-9]{64}$/);

    const reopened = new TDBKnowledgeManager({
        enabled: true, rootPath: root, storePath: store, model: 'model-a', dimension: 3,
        apiUrl: 'https://embedding.example.test', strictVectorMetadata: true
    });
    await reopened._prepareStoreIdentity();
    assert.equal(reopened.initializationState, 'compatible');
});

test('VT-008: a populated store without a manifest is legacy_unknown and fail-closed', async t => {
    const { manager, store } = temporaryManager(t);
    fs.writeFileSync(path.join(store, 'legacy.tdb'), 'legacy');
    await assert.rejects(
        manager._prepareStoreIdentity(),
        error => error.code === 'TDB_STORE_REBUILD_REQUIRED' && error.storeState === 'legacy_unknown'
    );
    assert.equal(manager.initializationState, 'legacy_unknown');
});

test('store identity mismatch requires rebuild without deleting the existing store', async t => {
    const { manager, root, store } = temporaryManager(t);
    await manager._prepareStoreIdentity();
    const sentinel = path.join(store, 'keep.tdb');
    fs.writeFileSync(sentinel, 'do not delete');
    const mismatched = new TDBKnowledgeManager({
        enabled: true, rootPath: root, storePath: store, model: 'model-b', dimension: 3,
        apiUrl: 'https://embedding.example.test', strictVectorMetadata: true
    });
    await assert.rejects(mismatched._prepareStoreIdentity(), { code: 'TDB_STORE_REBUILD_REQUIRED' });
    assert.equal(mismatched.initializationState, 'rebuild_required');
    assert.equal(fs.readFileSync(sentinel, 'utf-8'), 'do not delete');
});

test('VT-005/006: vector dimension and model identity mismatches use stable codes', t => {
    const { manager } = temporaryManager(t);
    manager.storeManifest = {
        embedding: {
            model: manager.config.model,
            dimension: manager.config.dimension,
            endpointFingerprint: manager.config.endpointFingerprint
        }
    };
    assert.throws(
        () => manager._validateQueryVector([1, 2], {
            model: manager.config.model, dimension: 2, endpointFingerprint: manager.config.endpointFingerprint
        }),
        { code: 'TDB_QUERY_VECTOR_DIMENSION_MISMATCH' }
    );
    assert.throws(
        () => manager._validateQueryVector([1, 2, 3], {
            model: 'model-b', dimension: 3, endpointFingerprint: manager.config.endpointFingerprint
        }),
        { code: 'TDB_QUERY_VECTOR_MODEL_MISMATCH' }
    );
    assert.throws(
        () => manager._validateQueryVector([1, Number.NaN, 3], null),
        { code: 'TDB_QUERY_VECTOR_INVALID' }
    );
});

test('searchWithVector enforces the contract at the public entrypoint before native search', async t => {
    const { manager } = temporaryManager(t);
    manager.initialized = true;
    manager.storeManifest = {
        embedding: {
            model: manager.config.model,
            dimension: manager.config.dimension,
            endpointFingerprint: manager.config.endpointFingerprint
        }
    };
    manager.getIngestStatus = () => ({ ready: true, pending: 0, retry: 0, processing: 0, failed: 0 });
    await assert.rejects(
        manager.searchWithVector([1, 2], 'query', {
            vectorMeta: { model: manager.config.model, dimension: 2, endpointFingerprint: manager.config.endpointFingerprint }
        }),
        { code: 'TDB_QUERY_VECTOR_DIMENSION_MISMATCH' }
    );
    await assert.rejects(
        manager.searchWithVector([1, 2, 3], 'query', {
            vectorMeta: { model: manager.config.model, dimension: 3, endpointFingerprint: 'sha256:other-endpoint' }
        }),
        { code: 'TDB_QUERY_VECTOR_MODEL_MISMATCH' }
    );
});

test('placeholder broadcasts structured retrieval errors and probes mark integrity dirty', async () => {
    const events = [];
    const host = {
        pushVcpInfo: event => events.push(event),
        rerankConfig: {},
        _rerankDocuments: async (_query, hits) => hits
    };
    const processor = new TDBPlaceholderProcessor(host);
    processor.setTdbKnowledgeManager({
        initialized: true,
        searchWithVector: async () => {
            const error = new Error('wrong vector space');
            error.code = 'TDB_QUERY_VECTOR_MODEL_MISMATCH';
            throw error;
        }
    });
    const result = await processor.processDirect('VCP知识', '', [1, 2, 3], 'query', 5);
    assert.match(result, /冷知识库检索失败/);
    assert.equal(events[0].reasonCode, 'TDB_QUERY_VECTOR_MODEL_MISMATCH');
    const collector = { events, log: '' };
    const observation = probes.summarize({ collector, injectedContent: result });
    assert.equal(observation.integrity.clean, false);
    assert.equal(observation.integrity.errors[0].reasonCode, 'TDB_QUERY_VECTOR_MODEL_MISMATCH');
});

test('VT-009: cold ingestion timeout has a stable skip reason', async () => {
    const result = await runtime.warmupColdKB({
        tdb: { getIngestStatus: () => ({ pending: 1, retry: 0, processing: 0, failed: 0 }) },
        timeoutMs: 5,
        pollMs: 1
    });
    assert.equal(result.ready, false);
    assert.equal(result.reasonCode, 'cold-ingest-not-ready');
});

test('runner propagates stable capability skip reasons', async () => {
    const result = await runner.runSuite({
        cases: [{ id: 'cold', tier: 4, mode: 'placeholder', family: 'cold', requires: ['coldKB'] }],
        runtime: null,
        resolved: {},
        corpusManifest: { files: [] },
        capabilities: { coldKB: false },
        capabilityReasons: { coldKB: 'cold-ingest-not-ready' },
        artifactReady: false
    });
    assert.equal(result.perCase[0].status, 'skipped');
    assert.equal(result.perCase[0].skipReason, 'cold-ingest-not-ready');
});

test('zero scored cases produce not_evaluable instead of a green run', () => {
    assert.equal(deriveRunStatus({ scored: 0, skipped: 4, errored: 0 }), 'not_evaluable');
    assert.equal(deriveRunStatus({ scored: 2, skipped: 1, errored: 0 }), 'completed_with_skips');
});

test('strict provenance disables transparent embedding model fallback', t => {
    const previous = {
        strict: process.env.EVAL_STRICT_PROVENANCE,
        primary: process.env.WhitelistEmbeddingModel,
        backups: process.env.EmbeddingModelBackups
    };
    t.after(() => {
        for (const [key, value] of Object.entries({
            EVAL_STRICT_PROVENANCE: previous.strict,
            WhitelistEmbeddingModel: previous.primary,
            EmbeddingModelBackups: previous.backups
        })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    process.env.EVAL_STRICT_PROVENANCE = 'true';
    process.env.WhitelistEmbeddingModel = 'model-a';
    process.env.EmbeddingModelBackups = 'model-b,model-c';
    assert.deepEqual(_getEmbeddingModelCandidates(), ['model-a']);
});
