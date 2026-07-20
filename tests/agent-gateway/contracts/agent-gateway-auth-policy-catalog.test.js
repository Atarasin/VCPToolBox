const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ACTION_SCOPES,
    CREDENTIAL_ACTIONS,
    SURFACE_ENTRIES,
    assertValidAuthPolicyCatalog,
    buildAuthPolicyCatalog
} = require('../../../modules/agentGateway/contracts/authPolicyCatalog');
const { MCP_OPERATIONS, REST_OPERATIONS } = require('../../../modules/agentGateway/contracts/operations');

test('shipped catalogs build a valid auth policy catalog', () => {
    const result = buildAuthPolicyCatalog();
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.ok(Object.isFrozen(result.catalog));
    assert.ok(result.catalog.entries.length >= MCP_OPERATIONS.length + REST_OPERATIONS.length);
});

test('every MCP operation declares exactly one credentialAction', () => {
    for (const operation of MCP_OPERATIONS) {
        assert.ok(
            CREDENTIAL_ACTIONS.includes(operation.execution.credentialAction),
            `${operation.toolName} must declare a known credentialAction`
        );
        assert.equal(operation.execution.authMechanism, undefined);
    }
});

test('read/execute assignments follow §3.5 canonical action semantics', () => {
    const byTool = Object.fromEntries(MCP_OPERATIONS.map(
        (operation) => [operation.toolName, operation.execution.credentialAction]
    ));
    assert.equal(byTool.gateway_recall_run, 'read');
    assert.equal(byTool.gateway_memory_search, 'read');
    assert.equal(byTool.gateway_context_assemble, 'read');
    assert.equal(byTool.gateway_agent_render, 'read');
    assert.equal(byTool.gateway_agent_bootstrap, 'read');
    assert.equal(byTool.gateway_job_get, 'read');
    assert.equal(byTool.gateway_memory_write, 'execute');
    assert.equal(byTool.gateway_job_cancel, 'execute');
});

test('REST operations carry credentialAction except fixed adminAuth exclusions', () => {
    const exclusions = REST_OPERATIONS.filter((operation) => operation.authExclusion === 'adminAuth');
    assert.deepEqual(
        exclusions.map((operation) => operation.path).sort(),
        ['/agent_gateway/health', '/agent_gateway/metrics']
    );
    for (const operation of REST_OPERATIONS) {
        if (operation.authExclusion === 'adminAuth') {
            assert.equal(operation.credentialAction, undefined);
        } else if (operation.authMechanism === 'adminAuthBridge' || operation.authMechanism === 'signedDownloadUrl') {
            assert.equal(operation.credentialAction, undefined);
        } else {
            assert.ok(CREDENTIAL_ACTIONS.includes(operation.credentialAction), operation.operationId);
        }
    }
});

test('surface registry covers initialize, discovery, resource read, skill download redeem, admin bridge', () => {
    const surfaces = SURFACE_ENTRIES.map((entry) => entry.surface);
    for (const required of [
        'mcp.initialize',
        'mcp.tools/list',
        'mcp.resources/list',
        'mcp.prompts/list',
        'mcp.resources/read'
    ]) {
        assert.ok(surfaces.includes(required), `missing surface ${required}`);
    }
    // integration/skill 在线 endpoint 必须在 REST operations 中以 credentialAction: read 登记
    const integrationOp = REST_OPERATIONS.find((op) => op.path === '/agent_gateway/agents/{agentId}/integration');
    assert.ok(integrationOp, 'integration endpoint must be in REST operations');
    assert.equal(integrationOp.credentialAction, 'read');
    const skillOp = REST_OPERATIONS.find((op) => op.path === '/agent_gateway/agents/{agentId}/integration/skill');
    assert.ok(skillOp, 'integration/skill endpoint must be in REST operations');
    assert.equal(skillOp.credentialAction, 'read');
    // admin session bridge 自 M1.S3 起由真实 REST binding 登记
    const bridge = REST_OPERATIONS.find((operation) => operation.path === '/agent_gateway/auth/admin-session');
    assert.equal(bridge.authMechanism, 'adminAuthBridge');
    assert.equal(bridge.credentialAction, undefined);
    // L3 签名下载 redeem（§6）：signedDownloadUrl surface 由 REST binding 登记，
    // 不呈现 credential——签名 URL 即 bearer capability。
    const redeem = REST_OPERATIONS.find((operation) => operation.path === '/agent_gateway/agents/{agentId}/integration/skill/download');
    assert.equal(redeem.authMechanism, 'signedDownloadUrl');
    assert.equal(redeem.credentialAction, undefined);
    const mint = REST_OPERATIONS.find((operation) => operation.path === '/agent_gateway/agents/{agentId}/integration/skill/download-url');
    assert.equal(mint.credentialAction, 'read');
});

test('catalog rejects a second signedDownloadUrl surface and misplaced usage', () => {
    const second = buildAuthPolicyCatalog({
        surfaceEntries: [
            ...SURFACE_ENTRIES,
            { surface: 'rest.other-download', kind: 'rest-download-redeem', authMechanism: 'signedDownloadUrl' }
        ]
    });
    assert.equal(second.valid, false);
    assert.ok(second.errors.some((error) => /reserved for the skill download redeem operation/.test(error.message)));

    const restOperations = structuredClone([...REST_OPERATIONS]);
    const guidance = restOperations.find((operation) => operation.operationId === 'getAgentGatewayAgentGuidance');
    delete guidance.credentialAction;
    guidance.authMechanism = 'signedDownloadUrl';
    const misplaced = buildAuthPolicyCatalog({ restOperations });
    assert.equal(misplaced.valid, false);
    assert.ok(misplaced.errors.some((error) => /reserved for the skill download redeem operation|only one signedDownloadUrl/.test(error.message)));
});

test('catalog rejects entries with both action and mechanism', () => {
    const result = buildAuthPolicyCatalog({
        surfaceEntries: [{
            surface: 'rest.auth/admin-session',
            kind: 'admin-session-bridge',
            credentialAction: 'read',
            authMechanism: 'adminAuthBridge'
        }]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /mutually exclusive/.test(error.message)));
});

test('catalog rejects entries with neither action nor mechanism', () => {
    const result = buildAuthPolicyCatalog({
        surfaceEntries: [{ surface: 'mcp.custom', kind: 'mcp-protocol' }]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /neither credentialAction nor authMechanism/.test(error.message)));
});

test('catalog rejects unknown credentialAction and unknown authMechanism', () => {
    const badAction = buildAuthPolicyCatalog({
        surfaceEntries: [{ surface: 'mcp.custom', kind: 'mcp-protocol', credentialAction: 'write' }]
    });
    assert.equal(badAction.valid, false);
    assert.ok(badAction.errors.some((error) => /unknown credentialAction "write"/.test(error.message)));

    const badMechanism = buildAuthPolicyCatalog({
        surfaceEntries: [{ surface: 'rest.custom', kind: 'admin-session-bridge', authMechanism: 'basicAuth' }]
    });
    assert.equal(badMechanism.valid, false);
    assert.ok(badMechanism.errors.some((error) => /unknown authMechanism "basicAuth"/.test(error.message)));
});

test('catalog rejects REST/MCP binding action mismatch for the same canonical operation', () => {
    const restOperations = structuredClone([...REST_OPERATIONS]);
    const memoryWrite = restOperations.find((operation) => operation.operationId === 'writeAgentGatewayMemory');
    memoryWrite.credentialAction = 'read';
    const result = buildAuthPolicyCatalog({ restOperations });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /binding credentialAction mismatch.*memory\.write/.test(error.message)));
});

test('catalog rejects a second adminAuthBridge surface', () => {
    const result = buildAuthPolicyCatalog({
        surfaceEntries: [
            ...SURFACE_ENTRIES,
            { surface: 'rest.auth/other-bridge', kind: 'admin-session-bridge', authMechanism: 'adminAuthBridge' }
        ]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => /only one adminAuthBridge surface/.test(error.message)));
});

test('assertValidAuthPolicyCatalog throws with entry detail on invalid catalog (strict startup)', () => {
    assert.throws(
        () => assertValidAuthPolicyCatalog({
            surfaceEntries: [{ surface: 'mcp.custom', kind: 'mcp-protocol' }]
        }),
        /invalid catalog: surface:mcp\.custom/
    );
    const catalog = assertValidAuthPolicyCatalog();
    assert.ok(catalog.entries.length > 0);
});

test('action scope mapping matches §3.5 table and scopes do not imply each other', () => {
    assert.deepEqual([...ACTION_SCOPES.read], ['gateway:read', 'admin']);
    assert.deepEqual([...ACTION_SCOPES.execute], ['gateway:execute', 'admin']);
    assert.deepEqual([...ACTION_SCOPES.authenticated], []);
    assert.ok(!ACTION_SCOPES.read.includes('gateway:execute'));
    assert.ok(!ACTION_SCOPES.execute.includes('gateway:read'));
});
