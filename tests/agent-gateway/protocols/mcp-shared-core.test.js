const assert = require('node:assert/strict');
const test = require('node:test');

const legacyDescriptors = require('../../../modules/agentGateway/adapters/mcpDescriptorRegistry');
const descriptors = require('../../../modules/agentGateway/protocols/mcp/descriptors');
const { createMcpHarness } = require('../../../modules/agentGateway/protocols/mcp/harness');

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

test('descriptor set is unchanged when callers pass the removed diaryRagLoopOnly option', () => {
    assert.deepEqual(
        descriptors.createGatewayManagedToolDescriptors({ diaryRagLoopOnly: true }),
        descriptors.createGatewayManagedToolDescriptors()
    );
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
