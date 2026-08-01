'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const gate = require('../../modules/gateProvenance');
const pluginConfig = require('../lib/pluginConfig');
const TDBPlaceholderProcessor = require('../../Plugin/RAGDiaryPlugin/TDBPlaceholderProcessor');
const SemanticGroupManager = require('../../Plugin/RAGDiaryPlugin/SemanticGroupManager');

const ENV = {
    WhitelistEmbeddingModel: 'model-a',
    VECTORDB_DIMENSION: '3',
    API_URL: 'https://embedding.example.test'
};

test('threshold-only override changes existing targets and rejects semantic mutation', () => {
    const base = { EvalA: { tags: ['a'], description: 'A', threshold: 0.6 } };
    const result = gate.mergeThresholdOverride(base, {
        thresholds: { diary: { EvalA: 0.42, Unknown: 0.1, Bad: 'zero' } }
    }, 'diary');
    assert.equal(result.effective.EvalA.threshold, 0.42);
    assert.deepEqual(result.effective.EvalA.tags, ['a']);
    assert.equal(result.effective.Unknown, undefined);
    assert.deepEqual(result.rejected.map(item => item.target), ['Unknown', 'Bad']);
});

test('VT-004: cache schema v2 is threshold-independent and embedding-bound', () => {
    const baseA = { EvalA: { tags: ['a'], threshold: 0.3 } };
    const baseB = { EvalA: { tags: ['a'], threshold: 0.8 } };
    const identityA = gate.gateIdentity(baseA, ENV);
    const identityB = gate.gateIdentity(baseB, ENV);
    assert.equal(identityA.vectorSourceHash, identityB.vectorSourceHash);
    const cache = {
        schemaVersion: 2,
        ...identityA,
        vectors: { EvalA: [1, 2, 3] }
    };
    assert.equal(gate.cacheMatches(cache, identityB), true);
    assert.equal(gate.cacheMatches({ sourceHash: identityA.vectorSourceHash, vectors: cache.vectors }, identityA), false);
    const otherModel = gate.gateIdentity(baseA, { ...ENV, WhitelistEmbeddingModel: 'model-b' });
    assert.equal(gate.cacheMatches(cache, otherModel), false);
    const lowThresholdHash = gate.effectiveGateConfigHash(identityA, baseA, { calibrationId: 'c1' });
    const highThresholdHash = gate.effectiveGateConfigHash(identityB, baseB, { calibrationId: 'c1' });
    assert.notEqual(lowThresholdHash, highThresholdHash);
    assert.notEqual(
        gate.effectiveGateConfigHash(identityA, baseA, { calibrationId: 'c1', artifactHash: 'sha256:a' }),
        gate.effectiveGateConfigHash(identityA, baseA, { calibrationId: 'c1', artifactHash: 'sha256:b' })
    );
});

test('plugin config installs definitions without overwriting model-specific thresholds', t => {
    const files = [
        pluginConfig.RAG_TAGS,
        pluginConfig.TDB_TAGS,
        pluginConfig.SEMANTIC_GROUPS,
        pluginConfig.SEMANTIC_GROUPS_EDIT
    ];
    const tracked = files.flatMap(file => [file, `${file}.eval-backup`]);
    const snapshots = new Map(tracked.map(file => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]));
    t.after(() => {
        for (const [file, content] of snapshots) {
            if (content === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content);
        }
    });
    fs.mkdirSync(path.dirname(pluginConfig.RAG_TAGS), { recursive: true });
    fs.writeFileSync(pluginConfig.RAG_TAGS, JSON.stringify({
        '评测运维技术库': { tags: ['old'], threshold: 0.123 }
    }));
    pluginConfig.install();
    const rag = JSON.parse(fs.readFileSync(pluginConfig.RAG_TAGS, 'utf-8'));
    assert.equal(rag['评测运维技术库'].threshold, 0.123);
    assert.equal(Object.hasOwn(rag['评测幻想设定库'], 'threshold'), false);
    const cold = JSON.parse(fs.readFileSync(pluginConfig.TDB_TAGS, 'utf-8'));
    assert.equal(Object.hasOwn(cold['VCP知识'], 'threshold'), false);
});

test('cold gate consumes the cold threshold namespace', async t => {
    const pluginPath = pluginConfig.TDB_TAGS;
    const previousFile = fs.existsSync(pluginPath) ? fs.readFileSync(pluginPath) : null;
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-override-'));
    const overridePath = path.join(overrideDir, 'gate.json');
    const previousEnv = process.env.RAG_GATE_CONFIG_PATH;
    t.after(() => {
        if (previousFile === null) fs.rmSync(pluginPath, { force: true }); else fs.writeFileSync(pluginPath, previousFile);
        fs.rmSync(overrideDir, { recursive: true, force: true });
        if (previousEnv === undefined) delete process.env.RAG_GATE_CONFIG_PATH; else process.env.RAG_GATE_CONFIG_PATH = previousEnv;
    });
    fs.writeFileSync(pluginPath, JSON.stringify({ VCP知识: { tags: ['VCP'], threshold: 0.9 } }));
    fs.writeFileSync(overridePath, JSON.stringify({ thresholds: { cold: { VCP知识: 0.41 } } }));
    process.env.RAG_GATE_CONFIG_PATH = overridePath;
    const processor = new TDBPlaceholderProcessor({});
    await processor.loadConfig();
    assert.equal(processor.libraryConfig.VCP知识.threshold, 0.41);
});

test('semantic vector directory follows the per-run environment path', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-semantic-cache-'));
    const previous = process.env.SEMANTIC_VECTOR_CACHE_DIR;
    process.env.SEMANTIC_VECTOR_CACHE_DIR = dir;
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (previous === undefined) delete process.env.SEMANTIC_VECTOR_CACHE_DIR; else process.env.SEMANTIC_VECTOR_CACHE_DIR = previous;
    });
    const manager = new SemanticGroupManager({});
    assert.equal(manager.vectorsDirPath, dir);
    await manager.initializePromise;
});
