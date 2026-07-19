const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildDiscoverySnapshot,
    computeVisibleAgents,
    encodeDiscoveryCursor,
    narrowSnapshotToAgent,
    readSnapshotPage
} = require('../../../modules/agentGateway/policy/discoverySnapshot');

const ALL_AGENTS = ['Ariadne', 'MCPMidas', 'Nexus'];
const CANONICAL_TOOLS = [{ name: 'gateway_recall_run' }, { name: 'gateway_memory_write' }];
const CANONICAL_PROMPTS = [{ name: 'gateway_agent_render' }];

function boundCredential(agentId = 'MCPMidas') {
    return { credentialId: 'cred-bound', boundAgentId: agentId, scopes: ['gateway:read'] };
}

function unboundCredential(allowedAgents = ['Nexus']) {
    return { credentialId: 'cred-unbound', boundAgentId: null, allowedAgents, scopes: ['gateway:read'] };
}

function adminCredential() {
    return { credentialId: 'cred-admin', boundAgentId: null, scopes: ['admin'] };
}

function makeSnapshot(credential, overrides = {}) {
    return buildDiscoverySnapshot({
        credential,
        credentialSubject: credential.credentialId,
        allAgentIds: ALL_AGENTS,
        canonicalTools: CANONICAL_TOOLS,
        canonicalPrompts: CANONICAL_PROMPTS,
        dynamicToolsForAgent: (agentId) => [{ name: `dyn_${agentId}` }],
        resourcesForAgent: (agentId) => [{ uri: `vcp://agent-gateway/agents/${agentId}/capabilities`, agentId }],
        ...overrides
    });
}

test('visible agent computation: bound / unbound / admin rules', () => {
    assert.deepEqual(computeVisibleAgents(boundCredential(), ALL_AGENTS), ['MCPMidas']);
    assert.deepEqual(computeVisibleAgents(boundCredential('Ghost'), ALL_AGENTS), [], 'bound to unknown agent sees nothing');
    assert.deepEqual(computeVisibleAgents(unboundCredential(['Nexus', 'Ghost']), ALL_AGENTS), ['Nexus']);
    assert.deepEqual(computeVisibleAgents(adminCredential(), ALL_AGENTS), ALL_AGENTS);
    assert.deepEqual(computeVisibleAgents(unboundCredential([]), ALL_AGENTS), []);
});

test('bound credential: canonical + per-agent dynamic tools, own resources only', () => {
    const snapshot = makeSnapshot(boundCredential());
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), ['dyn_MCPMidas', 'gateway_memory_write', 'gateway_recall_run']);
    assert.deepEqual(snapshot.resources.map((resource) => resource.agentId), ['MCPMidas']);
    assert.deepEqual(snapshot.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
    assert.ok(Object.isFrozen(snapshot));
});

test('unbound credential: canonical tools only, resources enumerate allowedAgents sorted', () => {
    const snapshot = makeSnapshot(unboundCredential(['Nexus', 'Ariadne']));
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), ['gateway_memory_write', 'gateway_recall_run'], 'no per-agent dynamic tools for unbound');
    assert.deepEqual(snapshot.resources.map((resource) => resource.agentId), ['Ariadne', 'Nexus'], 'stable agentId order');
});

test('admin credential follows the same rule over the full visible set', () => {
    const snapshot = makeSnapshot(adminCredential());
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), ['gateway_memory_write', 'gateway_recall_run'], 'admin is unbound: canonical only');
    assert.deepEqual(snapshot.resources.map((resource) => resource.agentId), ALL_AGENTS);
});

test('discovery revision is deterministic and credential-subject bound', () => {
    const snapshotA = makeSnapshot(boundCredential());
    const snapshotB = makeSnapshot(boundCredential());
    assert.equal(snapshotA.discoveryRevision, snapshotB.discoveryRevision);
    const snapshotC = makeSnapshot(unboundCredential());
    assert.notEqual(snapshotA.discoveryRevision, snapshotC.discoveryRevision);
});

test('cursor cannot cross discovery revision or credential subject', () => {
    const snapshot = makeSnapshot(adminCredential());
    const pageOne = readSnapshotPage(snapshot, 'resources', { pageSize: 2 });
    assert.equal(pageOne.ok, true);
    assert.equal(pageOne.items.length, 2);
    assert.ok(pageOne.nextCursor);

    const pageTwo = readSnapshotPage(snapshot, 'resources', { cursor: pageOne.nextCursor, pageSize: 2 });
    assert.equal(pageTwo.ok, true);
    assert.equal(pageTwo.items.length, 1);
    assert.equal(pageTwo.nextCursor, null);

    const otherSnapshot = makeSnapshot(boundCredential());
    const crossRevision = readSnapshotPage(otherSnapshot, 'resources', { cursor: pageOne.nextCursor });
    assert.equal(crossRevision.ok, false);
    assert.match(crossRevision.reason, /different discovery revision|different credential subject/);

    const forgedCursor = encodeDiscoveryCursor({
        revision: snapshot.discoveryRevision, subject: 'someone-else', offset: 0
    });
    const crossSubject = readSnapshotPage(snapshot, 'resources', { cursor: forgedCursor });
    assert.equal(crossSubject.ok, false);
    assert.match(crossSubject.reason, /credential subject/);

    assert.equal(readSnapshotPage(snapshot, 'resources', { cursor: '!!!' }).ok, false);
});

test('custom discovery agentId is only a narrowing extension; out-of-scope returns empty sets', () => {
    const snapshot = makeSnapshot(unboundCredential(['Nexus', 'Ariadne']));
    const narrowed = narrowSnapshotToAgent(snapshot, 'Nexus');
    assert.deepEqual(narrowed.visibleAgents, ['Nexus']);
    assert.deepEqual(narrowed.resources.map((resource) => resource.agentId), ['Nexus']);

    const outOfScope = narrowSnapshotToAgent(snapshot, 'MCPMidas');
    assert.deepEqual(outOfScope.visibleAgents, []);
    assert.deepEqual([...outOfScope.tools], []);
    assert.deepEqual([...outOfScope.resources], []);

    assert.equal(narrowSnapshotToAgent(snapshot, ''), snapshot, 'no narrowing without agentId');
});

test('frozen snapshot is immutable while policy changes only affect newly built snapshots', () => {
    const snapshot = makeSnapshot(boundCredential());
    assert.throws(() => { snapshot.tools.push({ name: 'later' }); }, TypeError);
    const laterSnapshot = makeSnapshot(boundCredential(), {
        dynamicToolsForAgent: () => [{ name: 'dyn_v2' }]
    });
    assert.notEqual(laterSnapshot.discoveryRevision, snapshot.discoveryRevision);
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), ['dyn_MCPMidas', 'gateway_memory_write', 'gateway_recall_run'], 'old snapshot stays stable');
});

test('serveFrozenList freezes per-session list results across config changes', async () => {
    const {
        DISCOVERY_SNAPSHOT_HOLDER,
        createDiscoverySnapshotHolder,
        serveFrozenList
    } = require('../../../modules/agentGateway/policy/discoverySnapshot');
    const { injectMcpContext } = require('../../../modules/agentGateway/transport/shared');

    const holder = createDiscoverySnapshotHolder();
    const input = { [DISCOVERY_SNAPSHOT_HOLDER]: holder };
    let version = 1;
    const compute = () => ({ tools: [{ name: `tool-v${version}` }] });

    const first = serveFrozenList(input, 'tools', compute);
    version = 2;
    const second = serveFrozenList(input, 'tools', compute);
    assert.deepEqual(second, first, 'same session must keep the frozen list');

    const freshHolder = createDiscoverySnapshotHolder();
    const fresh = serveFrozenList({ [DISCOVERY_SNAPSHOT_HOLDER]: freshHolder }, 'tools', compute);
    assert.equal(fresh.tools[0].name, 'tool-v2', 'new session sees the new configuration');

    // async compute 也冻结
    const asyncHolder = createDiscoverySnapshotHolder();
    const asyncInput = { [DISCOVERY_SNAPSHOT_HOLDER]: asyncHolder };
    const resolved = await serveFrozenList(asyncInput, 'resources', async () => ({ resources: ['r1'] }));
    const resolvedAgain = serveFrozenList(asyncInput, 'resources', async () => ({ resources: ['r2'] }));
    assert.deepEqual(resolvedAgain, resolved);

    // injectMcpContext 把 session context 的 holder 传递到 params
    const sessionContext = { sessionId: 'sess-1', source: 'test', runtime: 'mcp-http' };
    sessionContext[DISCOVERY_SNAPSHOT_HOLDER] = holder;
    const injected = injectMcpContext(
        { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
        sessionContext
    );
    assert.equal(injected.params[DISCOVERY_SNAPSHOT_HOLDER], holder);
    assert.equal(JSON.stringify(injected).includes('tool-v'), false, 'holder must not serialize');
});
