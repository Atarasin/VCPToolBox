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
    assert.equal(operations.length, 15);
    for (const operation of operations) {
        assert.equal(typeof IN_PROCESS_OPERATION_HANDLERS[operation.executor], 'function');
        assert.equal(typeof operation.backendExecutor, 'string');
        assert.notEqual(operation.backendExecutor, '');
    }
});

// 双面接线完整性护栏（2026-10-11 注册表收敛）：此前只断言 backendExecutor 是
// 非空字符串——knowledge.search 整条 REST/proxy 链缺失（proxy 面 -32000）时
// 该测试依然绿。现在逐面断言真实 handler 存在，并把注册表路径与治理白名单/
// restOperations 对齐（历史事故：forge.confirm 路径后缀不一致、白名单漏配）。
test('every backend executor has a real proxy handler and an aligned REST chain', () => {
    const { createProxyToolHandlers } = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
    const { TOOL_REST_REGISTRY, registryPathFor } = require('../../../modules/agentGateway/contracts/operations/toolRestRegistry');
    const { PUBLISHED_NATIVE_GATEWAY_PATHS } = require('../../../modules/agentGateway/contracts/protocolGovernance');
    const { REST_OPERATIONS } = require('../../../modules/agentGateway/contracts/operations');
    const { GatewayBackendClient } = require('../../../modules/agentGateway/clients/GatewayBackendClient');

    const proxyHandlers = createProxyToolHandlers({});
    const restPaths = new Set(REST_OPERATIONS.map((operation) => operation.path));

    for (const operation of Object.values(GATEWAY_OPERATIONS)) {
        const executor = operation.backendExecutor;
        if (executor === 'removedRender') {
            continue; // 显式下线占位，非执行面
        }
        assert.equal(typeof proxyHandlers[executor], 'function', `proxy 面缺 handler：${executor}`);
        const entry = TOOL_REST_REGISTRY[executor];
        assert.ok(entry, `注册表缺条目：${executor}`);
        const path = registryPathFor(entry);
        assert.ok(PUBLISHED_NATIVE_GATEWAY_PATHS.includes(path), `治理白名单缺路径：${path}（${executor}）`);
        assert.ok(restPaths.has(path), `restOperations 缺操作：${path}（${executor}）`);
        assert.equal(typeof GatewayBackendClient.prototype[entry.clientMethod], 'function',
            `GatewayBackendClient 缺方法：${entry.clientMethod}（${executor}）`);
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
