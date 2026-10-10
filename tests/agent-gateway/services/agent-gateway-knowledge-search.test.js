const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createKnowledgeStorePort } = require('../../../modules/agentGateway/ports/knowledgeStore');
const { createKnowledgeRuntimeService } = require('../../../modules/agentGateway/services/knowledgeRuntimeService');
const { resolveKnowledgeLibraryAccess } = require('../../../modules/agentGateway/policy/knowledgeScopeGuard');

function writeTempPolicy(payload) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-knowledge-'));
    const policyPath = path.join(dir, 'mcp_agent_knowledge_policy.json');
    fs.writeFileSync(policyPath, JSON.stringify(payload), 'utf8');
    return policyPath;
}

const POLICY = {
    restrictedLibraries: {
        '付鹏观点库': { allowedAgents: ['MCPFuPeng'] }
    }
};

function createTestService({ libraries = ['VCP百科全书', 'VCP知识', 'TDBdocs', '付鹏观点库'], hits = [], searchError = null } = {}) {
    const calls = { search: [], listLibraries: 0 };
    const port = createKnowledgeStorePort({
        search: async (queryText, options = {}) => {
            calls.search.push({ queryText, options });
            if (searchError) throw searchError;
            return hits;
        },
        listLibraries: async () => {
            calls.listLibraries += 1;
            return libraries;
        }
    });
    const auditEvents = [];
    const service = createKnowledgeRuntimeService({
        knowledgeStorePort: port,
        auditLogger: { log(event, payload) { auditEvents.push({ event, payload }); } },
        knowledgePolicyPath: writeTempPolicy(POLICY)
    });
    return { service, calls, auditEvents };
}

test('knowledge store port requires search and listLibraries and reports availability', () => {
    const port = createKnowledgeStorePort({
        search: async () => [],
        listLibraries: async () => []
    });
    assert.equal(port.available, true);

    const unavailable = createKnowledgeStorePort({ enabled: false, reason: 'tdb_knowledge_unavailable', optional: true });
    assert.equal(unavailable.available, false);
    assert.throws(() => createKnowledgeStorePort({ search: async () => [] }), /missing required bindings/);
});

test('knowledge search defaults to all agent-accessible libraries and excludes restricted ones', async () => {
    const { service, calls, auditEvents } = createTestService({
        hits: [{ library: 'VCP百科全书', id: 1, score: 0.87, text: 'hit-text', sourceFile: 'a.md', chunkIndex: 0 }]
    });
    const result = await service.search({
        body: { query: '什么是 VCP' },
        requestContext: { requestId: 'req-1', agentId: 'MCPMidas' }
    });

    assert.equal(result.success, true);
    assert.equal(calls.listLibraries, 1);
    assert.equal(calls.search.length, 1);
    // 默认 scope 排除受限库（付鹏观点库），未授权 agent 不见其存在
    assert.deepEqual(calls.search[0].options.libraries, ['VCP百科全书', 'VCP知识', 'TDBdocs']);
    assert.equal(calls.search[0].options.topK, 8);
    assert.equal(calls.search[0].options.expand, true);
    assert.deepEqual(result.data.items, [
        { library: 'VCP百科全书', id: 1, score: 0.87, text: 'hit-text', sourceFile: 'a.md', chunkIndex: 0 }
    ]);
    assert.equal(result.data.resultCount, 1);
    assert.ok(auditEvents.some((event) => event.event === 'knowledge.search.completed'));
});

test('non-FuPeng agent explicitly requesting 付鹏观点库 gets 403 Forbidden', async () => {
    const { service, auditEvents } = createTestService();
    await assert.rejects(
        service.search({
            body: { query: '付鹏对美元利率的观点', library: '付鹏观点库' },
            requestContext: { requestId: 'req-2', agentId: 'MCPMidas' }
        }),
        (error) => {
            assert.equal(error.status, 403);
            assert.equal(error.code, 'AGW_FORBIDDEN');
            assert.match(error.message, /付鹏观点库/);
            assert.deepEqual(error.details.forbiddenLibraries, ['付鹏观点库']);
            assert.ok(error.details.allowedLibraries.includes('VCP百科全书'));
            assert.ok(!error.details.allowedLibraries.includes('付鹏观点库'));
            return true;
        }
    );
    assert.ok(auditEvents.some((event) => event.event === 'knowledge.search.forbidden'));
});

test('MCPFuPeng can search the restricted library explicitly', async () => {
    const { service, calls } = createTestService();
    const result = await service.search({
        body: { query: '付鹏对美元利率的观点', libraries: ['付鹏观点库'], topK: 3 },
        requestContext: { requestId: 'req-3', agentId: 'MCPFuPeng' }
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls.search[0].options.libraries, ['付鹏观点库']);
    assert.equal(calls.search[0].options.topK, 3);
});

test('topK is clamped to the 50 hard cap and unknown libraries are rejected', async () => {
    const { service } = createTestService();
    const capped = await service.search({
        body: { query: 'q', topK: 999 },
        requestContext: { requestId: 'req-4', agentId: 'MCPMidas' }
    });
    assert.equal(capped.success, true);

    await assert.rejects(
        service.search({
            body: { query: 'q', library: '不存在的库' },
            requestContext: { requestId: 'req-5', agentId: 'MCPMidas' }
        }),
        (error) => {
            assert.equal(error.status, 403);
            assert.deepEqual(error.details.unknownLibraries, ['不存在的库']);
            return true;
        }
    );
});

test('unavailable knowledge store returns explicit 503 capability error', async () => {
    const unavailablePort = createKnowledgeStorePort({ enabled: false, reason: 'tdb_knowledge_unavailable', optional: true });
    const service = createKnowledgeRuntimeService({ knowledgeStorePort: unavailablePort });
    const result = await service.search({
        body: { query: 'q' },
        requestContext: { requestId: 'req-6', agentId: 'MCPMidas' }
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, 'AGW_CONFIG_UNAVAILABLE');
});

test('search failures map to a controlled runtime error with audit trail', async () => {
    const { service, auditEvents } = createTestService({ searchError: new Error('tdb exploded') });
    const result = await service.search({
        body: { query: 'q' },
        requestContext: { requestId: 'req-7', agentId: 'MCPMidas' }
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 500);
    assert.ok(auditEvents.some((event) => event.event === 'knowledge.search.failed'));
});

test('guard policy hot-reloads on file change', () => {
    const policyPath = writeTempPolicy({ restrictedLibraries: {} });
    const available = ['A库', 'B库'];
    // 无受限库：全部可访问
    assert.deepEqual(
        resolveKnowledgeLibraryAccess({ requestedLibraries: [], availableLibraries: available, agentId: 'X', policyPath }).targetLibraries,
        ['A库', 'B库']
    );
    // 热更新：把 A库 设为仅 AgentY 可用
    fs.writeFileSync(policyPath, JSON.stringify({ restrictedLibraries: { 'A库': { allowedAgents: ['AgentY'] } } }), 'utf8');
    const mtimeBump = policyPath + '.touch';
    fs.utimesSync(policyPath, new Date(Date.now() + 1200), new Date(Date.now() + 1200));
    assert.deepEqual(
        resolveKnowledgeLibraryAccess({ requestedLibraries: [], availableLibraries: available, agentId: 'X', policyPath }).targetLibraries,
        ['B库']
    );
    assert.deepEqual(
        resolveKnowledgeLibraryAccess({ requestedLibraries: [], availableLibraries: available, agentId: 'AgentY', policyPath }).targetLibraries,
        ['A库', 'B库']
    );
});

test('external MCP client can call gateway_knowledge_search end-to-end (MCP tools/call)', async () => {
    const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');
    const { createMcpAdapter } = require('../../../modules/agentGateway/adapters/mcpAdapter');

    const tdbKnowledgeManager = {
        async search(queryText, options = {}) {
            return [
                { library: options.libraries?.[0] || 'VCP百科全书', id: 7, score: 0.91, text: 'VCP 是一个 AI 中间层。', sourceFile: 'vcp.md', chunkIndex: 2 }
            ];
        },
        async listLibraries() {
            return ['VCP百科全书', 'VCP知识', 'TDBdocs', '付鹏观点库'];
        }
    };
    const pluginManager = { ...createPluginManager({}), tdbKnowledgeManager };
    const adapter = createMcpAdapter(pluginManager);

    // 工具目录可见
    const listing = await adapter.listTools({
        agentId: 'MCPMidas',
        requestContext: { requestId: 'req-knowledge-list' }
    });
    assert.ok(listing.tools.some((tool) => tool.name === 'gateway_knowledge_search'));

    // 非 FuPeng 调用：默认 scope 自动排除付鹏观点库并正常返回
    const generalSearch = await adapter.callTool({
        name: 'gateway_knowledge_search',
        arguments: { query: '什么是 VCP' },
        agentId: 'MCPMidas',
        sessionId: 'sess-knowledge-midas',
        requestContext: { requestId: 'req-knowledge-midas' }
    });
    assert.equal(generalSearch.isError, false);
    assert.ok(JSON.stringify(generalSearch.structuredContent).includes('VCP百科全书'));
    assert.ok(!JSON.stringify(generalSearch.structuredContent).includes('付鹏观点库'));

    // 非 FuPeng 显式请求付鹏观点库 → 403 MCP_FORBIDDEN
    const forbidden = await adapter.callTool({
        name: 'gateway_knowledge_search',
        arguments: { query: '付鹏观点', library: '付鹏观点库' },
        agentId: 'MCPMidas',
        sessionId: 'sess-knowledge-forbidden',
        requestContext: { requestId: 'req-knowledge-forbidden' }
    });
    assert.equal(forbidden.isError, true);
    assert.equal(forbidden.error.code, 'MCP_FORBIDDEN');
    assert.match(forbidden.error.message, /付鹏观点库/);

    // FuPeng 显式请求付鹏观点库 → 正常
    const fupeng = await adapter.callTool({
        name: 'gateway_knowledge_search',
        arguments: { query: '付鹏观点', library: '付鹏观点库' },
        agentId: 'MCPFuPeng',
        sessionId: 'sess-knowledge-fupeng',
        requestContext: { requestId: 'req-knowledge-fupeng' }
    });
    assert.equal(fupeng.isError, false);
});
