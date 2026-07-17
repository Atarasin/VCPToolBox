const assert = require('node:assert/strict');
const test = require('node:test');

const {
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime
} = require('../../../modules/agentGateway/mcpStdioServer');

test('clearing the shared runtime cache does not invalidate an acquired harness', async () => {
    await shutdownBackendProxyMcpRuntime();
    const firstContext = await initializeBackendProxyMcpRuntime({
        defaultAgentId: 'Ariadne',
        backendClient: {}
    });
    const acquiredHarness = firstContext.harness;

    await shutdownBackendProxyMcpRuntime();
    const response = await acquiredHarness.handleRequest({
        jsonrpc: '2.0',
        id: 'old-harness-ping',
        method: 'ping'
    });

    assert.deepEqual(response, {
        jsonrpc: '2.0',
        id: 'old-harness-ping',
        result: {}
    });

    const secondContext = await initializeBackendProxyMcpRuntime({
        defaultAgentId: 'Ariadne',
        backendClient: {}
    });
    assert.notEqual(secondContext, firstContext);
    assert.notEqual(secondContext.harness, acquiredHarness);
    await shutdownBackendProxyMcpRuntime();
});
