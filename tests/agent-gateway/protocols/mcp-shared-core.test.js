const assert = require('node:assert/strict');
const test = require('node:test');

const legacyDescriptors = require('../../../modules/agentGateway/adapters/mcpDescriptorRegistry');
const descriptors = require('../../../modules/agentGateway/protocols/mcp/descriptors');
const { createMcpHarness } = require('../../../modules/agentGateway/protocols/mcp/harness');
const legacyInProcess = require('../../../modules/agentGateway/adapters/mcpAdapter');
const canonicalInProcess = require('../../../modules/agentGateway/protocols/mcp/inProcessExecutor');
const legacyBackendProxy = require('../../../modules/agentGateway/adapters/mcpBackendProxyAdapter');
const canonicalBackendProxy = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
const { GATEWAY_OPERATIONS } = require('../../../modules/agentGateway/protocols/mcp/operations');
const { IN_PROCESS_OPERATION_HANDLERS } = require('../../../modules/agentGateway/protocols/mcp/inProcessOperations');

function createNoopAdapter() {
    return {
        async listPrompts() { return { prompts: [] }; },
        async getPrompt() { return {}; },
        async listTools() { return { tools: [] }; },
        async callTool() { return {}; },
        async listResources() { return { resources: [] }; },
        async readResource() { return {}; }
    };
}

test('legacy and canonical descriptor paths expose identical module identities', () => {
    assert.equal(legacyDescriptors, descriptors);
    assert.equal(
        legacyDescriptors.createGatewayManagedToolDescriptors,
        descriptors.createGatewayManagedToolDescriptors
    );
});

test('legacy adapter paths re-export canonical executor identities', () => {
    assert.equal(legacyInProcess, canonicalInProcess);
    assert.equal(legacyBackendProxy, canonicalBackendProxy);
    assert.equal(canonicalInProcess.createInProcessExecutor, canonicalInProcess.createMcpAdapter);
    assert.equal(canonicalBackendProxy.createBackendProxyExecutor, canonicalBackendProxy.createBackendProxyMcpAdapter);
});

test('descriptor set is unchanged when callers pass the removed diaryRagLoopOnly option', () => {
    assert.deepEqual(
        descriptors.createGatewayManagedToolDescriptors({ diaryRagLoopOnly: true }),
        descriptors.createGatewayManagedToolDescriptors()
    );
});

test('every gateway operation has explicit in-process and backend executor bindings', () => {
    const operations = Object.values(GATEWAY_OPERATIONS);
    assert.equal(operations.length, 8);
    for (const operation of operations) {
        assert.equal(typeof IN_PROCESS_OPERATION_HANDLERS[operation.executor], 'function');
        assert.equal(typeof operation.backendExecutor, 'string');
        assert.notEqual(operation.backendExecutor, '');
    }
});

test('shared MCP harness owns initialize and error sanitization semantics', async () => {
    const first = createMcpHarness({ adapter: createNoopAdapter() });
    const second = createMcpHarness({ adapter: createNoopAdapter() });
    const request = {
        jsonrpc: '2.0',
        id: 'initialize-shared',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' }
    };

    assert.deepEqual(await first.handleRequest(request), await second.handleRequest(request));
});
