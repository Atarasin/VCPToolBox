const assert = require('node:assert/strict');
const test = require('node:test');

const { bootstrapGateway } = require('../../../modules/agentGateway/composition/bootstrapGateway');
const canonicalBundle = require('../../../modules/agentGateway/composition/createGatewayServiceBundle');
const legacyBundle = require('../../../modules/agentGateway/createGatewayServiceBundle');
const {
    createLazyGatewayCredentialService
} = require('../../../modules/agentGateway/composition/lazyGatewayCredentialService');
const { bindVcpPorts } = require('../../../modules/agentGateway/composition/vcpPortBindings');

function createReadyHost() {
    return {
        plugins: new Map(),
        messagePreprocessors: new Map(),
        agentManager: { agentMap: new Map() },
        vectorDBManager: { listDiaryNames: () => [], search: async () => [] },
        processToolCall: async () => ({}),
        getPlugin: () => null
    };
}

test('legacy service bundle path re-exports the composition root', () => {
    assert.equal(legacyBundle, canonicalBundle);
});

test('bootstrap fails before the VCP host is ready', () => {
    assert.throws(() => bootstrapGateway({
        app: { use() {} },
        pluginManager: { plugins: null },
        createRoutes: () => ({})
    }), /plugin host is not ready/);
});

test('bootstrap binds frozen ports and mounts routes after host readiness', () => {
    const pluginManager = createReadyHost();
    const mounts = [];
    const result = bootstrapGateway({
        app: { use(...args) { mounts.push(args); } },
        pluginManager,
        createRoutes: () => ({ kind: 'router' })
    });
    assert.equal(Object.isFrozen(result.ports), true);
    assert.equal(result.ports.ragRetriever.available, true);
    assert.equal(result.ports.toolInvoker.available, true);
    assert.deepEqual(mounts[0], ['/agent_gateway', { kind: 'router' }]);
    assert.equal(result.bundle.ports, result.ports);
});

test('lazy credential service does not freeze RAG ports before host readiness', () => {
    const pluginManager = createReadyHost();
    pluginManager.vectorDBManager = null;

    const credentialService = createLazyGatewayCredentialService(pluginManager);
    assert.equal(pluginManager.__agentGatewayServiceBundle, undefined);

    pluginManager.vectorDBManager = {
        listDiaryNames: () => ['Diary'],
        search: async () => []
    };

    assert.ok(credentialService.credentialResolver);
    assert.equal(pluginManager.__agentGatewayServiceBundle.ports.ragRetriever.available, true);
});

test('optional host capabilities expose typed unavailable ports', () => {
    const pluginManager = createReadyHost();
    delete pluginManager.processToolCall;
    const ports = bindVcpPorts(pluginManager, { knowledgeBaseManager: null, ragPlugin: null });
    assert.equal(ports.diaryStore.available, false);
    assert.throws(() => ports.diaryStore.assertAvailable(), /diaryStore is unavailable/);
});

test('partial enabled RAG host fails binding instead of exposing a lazy unavailable search wrapper', () => {
    const pluginManager = createReadyHost();
    pluginManager.messagePreprocessors.set('RAGDiaryPlugin', {
        getSingleEmbeddingCached: async () => [1, 0]
    });
    pluginManager.vectorDBManager = { listDiaryNames: () => ['Diary'] };

    assert.throws(
        () => bindVcpPorts(pluginManager),
        /missing required bindings: searchDiary/
    );
});
