const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    computeSnapshotRevision,
    createIntegrationSnapshotCoordinator
} = require('../../../modules/agentGateway/composition/integrationSnapshotCoordinator');
const { AGW_ERROR_CODES } = require('../../../modules/agentGateway/contracts/errorCodes');
const { MCP_ERROR_CODES } = require('../../../modules/agentGateway/protocols/mcp/constants');
const { mapGatewayFailureToMcpErrorCode } = require('../../../modules/agentGateway/protocols/mcp/errorMapping');

const QUIET_LOGGER = { info() {}, warn() {}, error() {} };

function guidanceJson() {
    return JSON.stringify({
        version: 1,
        shared: {
            workflow: ['先 recall 后作答'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥'] }
        },
        agents: { MCPMidas: { displayName: 'Midas' } }
    });
}

function credentialsJson() {
    return JSON.stringify({
        version: 1,
        credentials: [{
            credentialId: 'midas-prod',
            pepperKid: 'kid-a',
            tokenDigest: `hmac-sha256:${'a'.repeat(64)}`,
            boundAgentId: 'MCPMidas',
            scopes: ['gateway:read'],
            status: 'active',
            expiresAt: '2027-01-01T00:00:00.000Z'
        }]
    });
}

function keyringJson() {
    return JSON.stringify({ keys: { 'kid-a': Buffer.alloc(32, 3).toString('base64') } });
}

async function makeFixture({ guidance = guidanceJson(), credentials = credentialsJson(), keyring = keyringJson() } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-snapshot-'));
    const paths = {
        dir,
        guidance: path.join(dir, 'agent_guidance.json'),
        credentials: path.join(dir, 'credentials.json'),
        keyring: path.join(dir, 'peppers.json')
    };
    if (guidance !== null) await fs.writeFile(paths.guidance, guidance);
    if (credentials !== null) await fs.writeFile(paths.credentials, credentials);
    if (keyring !== null) await fs.writeFile(paths.keyring, keyring);
    return paths;
}

function makeCoordinator(paths, overrides = {}) {
    return createIntegrationSnapshotCoordinator({
        guidanceConfigPath: paths.guidance,
        credentialsPath: paths.credentials,
        pepperKeyringPath: paths.keyring,
        listAgents: () => [{ alias: 'MCPMidas', sourceFile: 'MCPMidas.txt' }],
        logger: QUIET_LOGGER,
        ...overrides
    });
}

test('publishes frozen { revision, contentHashes, agents } snapshots for both domains', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths);
    const { integration, security, health } = await coordinator.refreshAll();

    assert.equal(integration.available, true);
    assert.match(integration.snapshot.revision, /^sha256:/);
    assert.ok(Object.isFrozen(integration.snapshot));
    assert.ok(integration.snapshot.agents.MCPMidas);
    assert.equal(integration.snapshot.agents.MCPMidas.displayName, 'Midas');
    assert.match(integration.snapshot.contentHashes.guidance, /^sha256:/);

    assert.equal(security.available, true);
    assert.equal(security.snapshot.credentials.length, 1);
    assert.ok(security.snapshot.authPolicyCatalog.entries.length > 0);

    assert.deepEqual(health, {
        guidance: 'ok', credentialFile: 'ok', pepperKeyring: 'ok', authorizationPolicy: 'ok'
    });
});

test('initial guidance failure -> unavailable with AGW_CONFIG_UNAVAILABLE, recovery publishes and records event', async () => {
    const paths = await makeFixture({ guidance: '{ corrupted' });
    const coordinator = makeCoordinator(paths);
    await coordinator.refreshAll();

    let status = coordinator.getIntegrationStatus();
    assert.equal(status.available, false);
    assert.equal(status.code, 'AGW_CONFIG_UNAVAILABLE');
    assert.equal(coordinator.getHealthDomains().guidance, 'unavailable');

    await fs.writeFile(paths.guidance, guidanceJson());
    await coordinator.refreshIntegrationSnapshot();
    status = coordinator.getIntegrationStatus();
    assert.equal(status.available, true);
    assert.equal(coordinator.getHealthDomains().guidance, 'ok');

    const events = coordinator.getRecoveryEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].domain, 'guidance');
    assert.match(events[0].recoveredRevision, /^sha256:/);
});

test('guidance hot-reload failure keeps last-known-good and records failed content hash', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths);
    await coordinator.refreshAll();
    const goodRevision = coordinator.getIntegrationStatus().snapshot.revision;

    await fs.writeFile(paths.guidance, '{ broken json');
    await coordinator.refreshIntegrationSnapshot();
    const status = coordinator.getIntegrationStatus();
    assert.equal(status.available, true, 'last-known-good must be retained');
    assert.equal(status.snapshot.revision, goodRevision);
    assert.ok(status.failure);
    assert.equal(coordinator.getHealthDomains().guidance, 'degraded');
});

test('security domain fail-closed: hot-reload corruption clears the snapshot entirely', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths);
    await coordinator.refreshAll();
    assert.equal(coordinator.getSecurityStatus().available, true);

    await fs.writeFile(paths.credentials, '{ not json');
    await coordinator.refreshSecuritySnapshot();
    const status = coordinator.getSecurityStatus();
    assert.equal(status.available, false, 'no last-known-good for identity/authorization config');
    assert.equal(status.snapshot, null);
    assert.equal(status.code, 'AGW_CONFIG_UNAVAILABLE');
    assert.equal(coordinator.getHealthDomains().credentialFile, 'unavailable');
});

test('cross-reference errors reject the candidate: unknown pepperKid fail-closed, unknown guidance agent unavailable', async () => {
    const badKeyringPaths = await makeFixture({
        keyring: JSON.stringify({ keys: { 'kid-other': Buffer.alloc(32, 1).toString('base64') } })
    });
    const coordinatorA = makeCoordinator(badKeyringPaths);
    await coordinatorA.refreshAll();
    const securityStatus = coordinatorA.getSecurityStatus();
    assert.equal(securityStatus.available, false);
    assert.ok(JSON.stringify(securityStatus.failure).includes('unknown pepperKid'));

    const badGuidancePaths = await makeFixture({
        guidance: JSON.stringify({
            version: 1,
            shared: { workflow: ['w'], memoryWritePolicy: { write: ['a'], skip: ['b'] } },
            agents: { UnknownAgent: { displayName: 'Ghost' } }
        })
    });
    const coordinatorB = makeCoordinator(badGuidancePaths);
    await coordinatorB.refreshAll();
    assert.equal(coordinatorB.getIntegrationStatus().available, false);
});

test('default diary outside allowed diaries rejects the guidance candidate', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths, {
        getMemoryPolicy: () => ({ allowedDiaries: ['Midas'], defaultDiaries: ['Nexus'] })
    });
    await coordinator.refreshAll();
    const status = coordinator.getIntegrationStatus();
    assert.equal(status.available, false);
    assert.ok(JSON.stringify(status.failure).includes('default diary'));
});

test('same mtime/size content replacement is detected via content hash', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths);
    await coordinator.refreshAll();
    const beforeHash = coordinator.getSecurityStatus().snapshot.contentHashes.credentials;

    // 同长度替换：改 tokenDigest 的一个字符，再回拨 mtime 模拟同秒替换
    const replaced = credentialsJson().replace(`hmac-sha256:${'a'.repeat(64)}`, `hmac-sha256:${'b'.repeat(64)}`);
    assert.equal(replaced.length, credentialsJson().length);
    const stat = await fs.stat(paths.credentials);
    await fs.writeFile(paths.credentials, replaced);
    await fs.utimes(paths.credentials, stat.atime, stat.mtime);

    await coordinator.refreshSecuritySnapshot();
    const afterStatus = coordinator.getSecurityStatus();
    assert.equal(afterStatus.available, true);
    assert.notEqual(afterStatus.snapshot.contentHashes.credentials, beforeHash);
});

test('atomic rename update is picked up as a single consistent revision', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths);
    await coordinator.refreshAll();
    const before = coordinator.getIntegrationStatus().snapshot.revision;

    const updated = JSON.parse(guidanceJson());
    updated.agents.MCPMidas.displayName = 'Midas-2';
    const tmpPath = path.join(paths.dir, 'agent_guidance.json.tmp');
    const handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(JSON.stringify(updated));
    await handle.sync();
    await handle.close();
    await fs.rename(tmpPath, paths.guidance);

    await coordinator.refreshIntegrationSnapshot();
    const after = coordinator.getIntegrationStatus().snapshot;
    assert.notEqual(after.revision, before);
    assert.equal(after.agents.MCPMidas.displayName, 'Midas-2');
});

test('revision is deterministic over content hashes and changes when any hash changes', () => {
    const revisionA = computeSnapshotRevision({ guidance: 'sha256:x', credentials: 'sha256:y' });
    const revisionB = computeSnapshotRevision({ credentials: 'sha256:y', guidance: 'sha256:x' });
    const revisionC = computeSnapshotRevision({ guidance: 'sha256:x', credentials: 'sha256:z' });
    assert.equal(revisionA, revisionB);
    assert.notEqual(revisionA, revisionC);
});

test('phase A: missing credentials path publishes empty snapshot with migration warning; explicit bad path fail-closed', async () => {
    const paths = await makeFixture();
    const warnings = [];
    const coordinatorA = makeCoordinator({ ...paths, credentials: '' }, {
        logger: { ...QUIET_LOGGER, warn: (message) => warnings.push(message) }
    });
    await coordinatorA.refreshAll();
    const statusA = coordinatorA.getSecurityStatus();
    assert.equal(statusA.available, true);
    assert.deepEqual([...statusA.snapshot.credentials], []);
    assert.equal(statusA.snapshot.migrationWarning, 'no credential file configured');
    assert.equal(warnings.length, 1);

    const coordinatorB = makeCoordinator({ ...paths, credentials: path.join(paths.dir, 'missing.json') });
    await coordinatorB.refreshAll();
    assert.equal(coordinatorB.getSecurityStatus().available, false, 'configured but unreadable path must fail closed');

    const coordinatorC = makeCoordinator({ ...paths, credentials: '' }, { legacyCredentialEnabled: false });
    await coordinatorC.refreshAll();
    assert.equal(coordinatorC.getSecurityStatus().available, false, 'phase B requires a credential file');
});

test('invalid auth policy catalog blocks the security domain', async () => {
    const paths = await makeFixture();
    const coordinator = makeCoordinator(paths, {
        buildCatalog: () => ({ valid: false, errors: [{ entry: 'x', message: 'boom' }], catalog: null })
    });
    await coordinator.refreshAll();
    const status = coordinator.getSecurityStatus();
    assert.equal(status.available, false);
    assert.ok(status.failure.fields.authorizationPolicy);
    const health = coordinator.getHealthDomains();
    assert.equal(health.authorizationPolicy, 'unavailable');
    assert.equal(health.credentialFile, 'blocked');
});

test('AGW_CONFIG_UNAVAILABLE maps to MCP_SERVICE_UNAVAILABLE', () => {
    assert.equal(AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'AGW_CONFIG_UNAVAILABLE');
    assert.equal(MCP_ERROR_CODES.SERVICE_UNAVAILABLE, 'MCP_SERVICE_UNAVAILABLE');
    assert.equal(
        mapGatewayFailureToMcpErrorCode(AGW_ERROR_CODES.CONFIG_UNAVAILABLE),
        MCP_ERROR_CODES.SERVICE_UNAVAILABLE
    );
});
