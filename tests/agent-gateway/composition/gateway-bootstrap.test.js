const assert = require('node:assert/strict');
const test = require('node:test');

const { bootstrapGateway } = require('../../../modules/agentGateway/composition/bootstrapGateway');
const canonicalBundle = require('../../../modules/agentGateway/composition/createGatewayServiceBundle');
const legacyBundle = require('../../../modules/agentGateway/createGatewayServiceBundle');
const { bindVcpPorts } = require('../../../modules/agentGateway/composition/vcpPortBindings');

function createReadyHost() {
    return {
        plugins: new Map(),
        messagePreprocessors: new Map(),
        agentManager: { agentMap: new Map() },
        vectorDBManager: { listDiaryNames: () => [] },
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

test('optional host capabilities expose typed unavailable ports', () => {
    const pluginManager = createReadyHost();
    delete pluginManager.processToolCall;
    const ports = bindVcpPorts(pluginManager, { knowledgeBaseManager: null, ragPlugin: null });
    assert.equal(ports.diaryStore.available, false);
    assert.throws(() => ports.diaryStore.assertAvailable(), /diaryStore is unavailable/);
});
