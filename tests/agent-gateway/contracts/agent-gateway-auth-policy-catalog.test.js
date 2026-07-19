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
        } else {
            assert.ok(CREDENTIAL_ACTIONS.includes(operation.credentialAction), operation.operationId);
        }
    }
});

test('surface registry covers initialize, discovery, resource read, skill download, admin bridge', () => {
    const surfaces = SURFACE_ENTRIES.map((entry) => entry.surface);
    for (const required of [
        'mcp.initialize',
        'mcp.tools/list',
        'mcp.resources/list',
        'mcp.prompts/list',
        'mcp.resources/read',
        'rest.integration/skill',
        'rest.auth/admin-session'
    ]) {
        assert.ok(surfaces.includes(required), `missing surface ${required}`);
    }
    const bridge = SURFACE_ENTRIES.find((entry) => entry.surface === 'rest.auth/admin-session');
    assert.equal(bridge.authMechanism, 'adminAuthBridge');
    assert.equal(bridge.credentialAction, undefined);
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
