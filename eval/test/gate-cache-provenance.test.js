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
    const strict = gate.mergeThresholdOverride(
        { EvalA: { threshold: 0.6 }, ProductionA: { threshold: 0.7 } },
        { thresholds: { diary: { EvalA: 0, ProductionA: 0.1 } } },
        'diary',
        { allowedTargets: ['EvalA'] }
    );
    assert.equal(strict.effective.EvalA.threshold, 0);
    assert.equal(strict.effective.ProductionA.threshold, 0.7);
    assert.equal(strict.rejected[0].reason, 'target-outside-eval-namespace');
    assert.equal(gate.resolveThreshold(0, 0.6), 0);
    const missingNamespace = gate.resolveGateState(
        { diary: { EvalA: { threshold: 0.6 } }, cold: {} },
        { thresholds: { diary: { EvalA: 0.2 }, cold: {} } },
        { env: { ...ENV, EVAL_STRICT_PROVENANCE: 'true' } }
    );
    assert.equal(missingNamespace.effective.diary.EvalA.threshold, 0.6);
    assert.equal(missingNamespace.rejected[0].reason, 'eval-namespace-not-declared');
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
    const lowThresholdHash = gate.resolveGateState(
        { diary: baseA, cold: {} },
        { calibrationId: 'c1' },
        { env: ENV }
    ).effectiveConfigHash;
    const highThresholdHash = gate.resolveGateState(
        { diary: baseB, cold: {} },
        { calibrationId: 'c1' },
        { env: ENV }
    ).effectiveConfigHash;
    assert.notEqual(lowThresholdHash, highThresholdHash);
    assert.notEqual(
        gate.resolveGateState({ diary: baseA, cold: {} }, { calibrationId: 'c1' }, { env: ENV, artifactHash: 'sha256:a' }).effectiveConfigHash,
        gate.resolveGateState({ diary: baseA, cold: {} }, { calibrationId: 'c1' }, { env: ENV, artifactHash: 'sha256:b' }).effectiveConfigHash
    );
    const profileState = gate.resolveGateState(
        { diary: baseA, cold: {} },
        { calibrationId: 'c1', thresholds: { diary: { EvalA: 0.2 }, cold: {} } },
        { env: ENV, artifactHash: 'sha256:artifact', allowedTargets: { diary: ['EvalA'], cold: [] } }
    );
    const snapshot = {
        calibrationId: profileState.calibrationId,
        artifactHash: profileState.artifactHash,
        allowedTargets: { diary: ['EvalA'], cold: [] },
        thresholds: profileState.thresholdOverrides
    };
    const runtimeState = gate.resolveGateState(
        { diary: baseA, cold: {} },
        snapshot,
        { env: ENV }
    );
    assert.equal(runtimeState.effectiveConfigHash, profileState.effectiveConfigHash);
});

test('profile and runtime share one effective gate config hash', () => {
    const resolved = require('../lib/profile').loadProfile('default');
    const read = file => file && fs.existsSync(file)
        ? JSON.parse(fs.readFileSync(file, 'utf-8'))
        : {};
    const runtimeState = gate.resolveGateState({
        diary: read(resolved.gate.definitionPaths.diary),
        cold: read(resolved.gate.definitionPaths.cold)
    }, resolved.gateCalibration.artifact, {
        embedding: {
            model: resolved.embedding.model,
            dimension: resolved.embedding.dimension,
            endpointFingerprint: resolved.embedding.endpointFingerprint
        },
        artifactHash: resolved.gateCalibration.artifactHash
    });
    assert.equal(runtimeState.gateDefinitionHash, resolved.gate.definitionHash);
    assert.deepEqual(runtimeState.thresholds, resolved.gate.thresholds);
    assert.deepEqual(runtimeState.thresholdOverrides, resolved.gate.thresholdOverrides);
    assert.equal(runtimeState.effectiveConfigHash, resolved.gate.effectiveConfigHash);
});

test('plugin config installs definitions without overwriting model-specific thresholds', t => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-plugin-config-'));
    const paths = pluginConfig.resolvePaths({ projectRoot });
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    fs.mkdirSync(paths.PLUGIN_DIR, { recursive: true });
    fs.writeFileSync(paths.RAG_TAGS, JSON.stringify({
        '评测运维技术库': { tags: ['old'], threshold: 0.123 }
    }));
    pluginConfig.install({ projectRoot });
    const rag = JSON.parse(fs.readFileSync(paths.RAG_TAGS, 'utf-8'));
    assert.equal(rag['评测运维技术库'].threshold, 0.123);
    assert.equal(Object.hasOwn(rag['评测幻想设定库'], 'threshold'), false);
    const cold = JSON.parse(fs.readFileSync(paths.TDB_TAGS, 'utf-8'));
    assert.equal(Object.hasOwn(cold['VCP知识'], 'threshold'), false);
});

test('cold gate consumes the cold threshold namespace', async t => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-gate-override-'));
    const pluginPath = path.join(overrideDir, 'tdb_tags.json');
    const overridePath = path.join(overrideDir, 'gate.json');
    const previousEnv = process.env.RAG_GATE_CONFIG_PATH;
    t.after(() => {
        fs.rmSync(overrideDir, { recursive: true, force: true });
        if (previousEnv === undefined) delete process.env.RAG_GATE_CONFIG_PATH; else process.env.RAG_GATE_CONFIG_PATH = previousEnv;
    });
    fs.writeFileSync(pluginPath, JSON.stringify({ VCP知识: { tags: ['VCP'], threshold: 0.9 } }));
    fs.writeFileSync(overridePath, JSON.stringify({ thresholds: { cold: { VCP知识: 0.41 } } }));
    process.env.RAG_GATE_CONFIG_PATH = overridePath;
    const processor = new TDBPlaceholderProcessor({}, { configPath: pluginPath });
    await processor.loadConfig();
    assert.equal(processor.libraryConfig.VCP知识.threshold, 0.41);
});

test('cold threshold hot reload does not replay the threshold stored with cached vectors', async () => {
    const processor = new TDBPlaceholderProcessor({
        getSingleEmbeddingCached: async () => [1, 0, 0]
    });
    processor.libraryConfig = { VCP知识: { threshold: 0.9 } };
    assert.equal((await processor._getLibraryVectors('VCP知识')).threshold, 0.9);
    processor.libraryConfig = { VCP知识: { threshold: 0.41 } };
    assert.equal((await processor._getLibraryVectors('VCP知识')).threshold, 0.41);
});

test('semantic vector directory follows the per-run environment path', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-semantic-cache-'));
    const groupsPath = path.join(dir, 'groups.json');
    const editPath = path.join(dir, 'groups.edit.json');
    const groupData = {
        config: {},
        groups: { EvalGroup: { words: ['alpha'], auto_learned: [], weight: 1, vector_id: 'shared-id' } }
    };
    const originalGroups = JSON.stringify(groupData);
    fs.writeFileSync(groupsPath, originalGroups);
    fs.writeFileSync(editPath, originalGroups);
    const previous = {
        vectors: process.env.SEMANTIC_VECTOR_CACHE_DIR,
        groups: process.env.SEMANTIC_GROUPS_CONFIG_PATH,
        edit: process.env.SEMANTIC_GROUPS_EDIT_PATH,
        model: process.env.WhitelistEmbeddingModel,
        dimension: process.env.VECTORDB_DIMENSION,
        apiUrl: process.env.API_URL
    };
    process.env.SEMANTIC_VECTOR_CACHE_DIR = dir;
    process.env.SEMANTIC_GROUPS_CONFIG_PATH = groupsPath;
    process.env.SEMANTIC_GROUPS_EDIT_PATH = editPath;
    process.env.WhitelistEmbeddingModel = 'model-a';
    process.env.VECTORDB_DIMENSION = '3';
    process.env.API_URL = 'https://embedding.example.test';
    t.after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [key, value] of Object.entries({
            SEMANTIC_VECTOR_CACHE_DIR: previous.vectors,
            SEMANTIC_GROUPS_CONFIG_PATH: previous.groups,
            SEMANTIC_GROUPS_EDIT_PATH: previous.edit,
            WhitelistEmbeddingModel: previous.model,
            VECTORDB_DIMENSION: previous.dimension,
            API_URL: previous.apiUrl
        })) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });
    const manager = new SemanticGroupManager({ getSingleEmbeddingCached: async () => [1, 0, 0] });
    assert.equal(manager.vectorsDirPath, dir);
    assert.equal(manager.groupsFilePath, groupsPath);
    await manager.waitUntilReady();
    assert.equal(fs.readFileSync(groupsPath, 'utf-8'), originalGroups);
    const vectorPath = path.join(dir, `${manager._getWordsHash(['alpha'])}.json`);
    assert.equal(JSON.parse(fs.readFileSync(vectorPath, 'utf-8')).schemaVersion, 2);
});

test('RAGDiaryPlugin initialization waits for the actual semanticGroups manager', async () => {
    const pluginInstance = require('../../Plugin/RAGDiaryPlugin/RAGDiaryPlugin');
    let semanticReady = false;
    const fake = {
        vectorDBManager: null,
        pushVcpInfo: null,
        tdbProcessor: { loadConfig: async () => {} },
        loadConfig: async () => {},
        loadRagParams: async () => {},
        semanticGroups: { waitUntilReady: async () => { semanticReady = true; } },
        _startRagParamsWatcher: () => {},
        _startRagTagsWatcher: () => {},
        queryCacheEnabled: false,
        cacheManager: { startCleanup: () => {} }
    };
    await pluginInstance.constructor.prototype.initialize.call(fake, {}, {});
    assert.equal(semanticReady, true);
});
