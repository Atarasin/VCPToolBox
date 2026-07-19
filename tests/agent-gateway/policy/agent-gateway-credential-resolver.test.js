const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_PRESENTED_TOKEN_LENGTH,
    computeTokenDigest,
    createCredentialResolver
} = require('../../../modules/agentGateway/policy/credentialResolver');

const QUIET_LOGGER = { info() {}, warn() {}, error() {} };
const CLI_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'agent-gateway-credential-cli.js');

const PEPPER_A = Buffer.alloc(32, 5);
const PEPPER_B = Buffer.alloc(32, 9);
const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz012345';

function record({ credentialId = 'cred-a', kid = 'kid-a', token = TOKEN, pepper = PEPPER_A, ...rest } = {}) {
    return {
        credentialId,
        pepperKid: kid,
        tokenDigest: `hmac-sha256:${computeTokenDigest(pepper, token)}`,
        boundAgentId: 'MCPMidas',
        scopes: ['gateway:read'],
        status: 'active',
        expiresAt: '2027-01-01T00:00:00.000Z',
        ...rest
    };
}

async function makeFixture({ credentials = [record()], keyring } = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-resolver-'));
    const paths = {
        dir,
        credentials: path.join(dir, 'credentials.json'),
        keyring: path.join(dir, 'peppers.json')
    };
    if (credentials !== null) {
        await fs.writeFile(paths.credentials, JSON.stringify({ version: 1, credentials }));
    }
    await fs.writeFile(paths.keyring, JSON.stringify({
        keys: keyring || { 'kid-a': PEPPER_A.toString('base64'), 'kid-b': PEPPER_B.toString('base64') }
    }));
    return paths;
}

function makeResolver(paths, overrides = {}) {
    return createCredentialResolver({
        credentialsPath: paths.credentials,
        pepperKeyringPath: paths.keyring,
        logger: QUIET_LOGGER,
        ...overrides
    });
}

test('valid token authenticates against exactly one record with stable identity fields', async () => {
    const resolver = makeResolver(await makeFixture());
    const result = await resolver.authenticate(TOKEN);
    assert.equal(result.ok, true);
    assert.equal(result.credentialId, 'cred-a');
    assert.equal(result.credentialSubject, 'cred-a');
    assert.match(result.credentialRevision, /^sha256:/);
    assert.equal(result.record.boundAgentId, 'MCPMidas');

    const again = await resolver.authenticate(TOKEN);
    assert.equal(again.credentialRevision, result.credentialRevision, 'revision must be stable for unchanged record');
});

test('invalid, oversized and empty tokens are rejected', async () => {
    const resolver = makeResolver(await makeFixture());
    assert.equal((await resolver.authenticate('wrong-token')).ok, false);
    assert.equal((await resolver.authenticate('')).ok, false);
    const oversized = 'x'.repeat(MAX_PRESENTED_TOKEN_LENGTH + 1);
    const result = await resolver.authenticate(oversized);
    assert.equal(result.ok, false);
    assert.match(result.reason, /length limit/);
});

test('expired and revoked records are rejected; rotating still authenticates until expiry', async () => {
    const paths = await makeFixture({
        credentials: [
            record({ credentialId: 'cred-expired', token: 'token-expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
            record({ credentialId: 'cred-revoked', token: 'token-revoked', status: 'revoked' }),
            record({ credentialId: 'cred-rotating', token: 'token-rotating', status: 'rotating' }),
            record({ credentialId: 'cred-marked-expired', token: 'token-marked', status: 'expired' })
        ]
    });
    const resolver = makeResolver(paths);
    assert.match((await resolver.authenticate('token-expired')).reason, /expired/);
    assert.match((await resolver.authenticate('token-revoked')).reason, /revoked/);
    assert.equal((await resolver.authenticate('token-rotating')).ok, true);
    assert.match((await resolver.authenticate('token-marked')).reason, /expired/);
});

test('rotation: old and new tokens coexist, revocation propagates on next authorization read', async () => {
    const paths = await makeFixture({
        credentials: [
            record({ credentialId: 'cred-old', token: 'token-old', status: 'rotating' }),
            record({ credentialId: 'cred-new', token: 'token-new' })
        ]
    });
    const resolver = makeResolver(paths);
    assert.equal((await resolver.authenticate('token-old')).ok, true);
    assert.equal((await resolver.authenticate('token-new')).ok, true);

    await fs.writeFile(paths.credentials, JSON.stringify({
        version: 1,
        credentials: [
            record({ credentialId: 'cred-old', token: 'token-old', status: 'revoked' }),
            record({ credentialId: 'cred-new', token: 'token-new' })
        ]
    }));
    assert.equal((await resolver.authenticate('token-old')).ok, false, 'first read after revocation must see it');
    assert.equal((await resolver.authenticate('token-new')).ok, true);
});

test('same mtime/size content replacement invalidates the old token immediately', async () => {
    const paths = await makeFixture({ credentials: [record({ token: 'token-aaaa' })] });
    const resolver = makeResolver(paths);
    assert.equal((await resolver.authenticate('token-aaaa')).ok, true);

    // 同长度替换 credentialId 与 digest（同 id 换 digest 会被 tombstone 拦截，属另一用例）
    const before = await fs.readFile(paths.credentials, 'utf8');
    const after = before
        .replace(computeTokenDigest(PEPPER_A, 'token-aaaa'), computeTokenDigest(PEPPER_A, 'token-bbbb'))
        .replace('"cred-a"', '"cred-b"');
    assert.equal(after.length, before.length);
    const stat = await fs.stat(paths.credentials);
    await fs.writeFile(paths.credentials, after);
    await fs.utimes(paths.credentials, stat.atime, stat.mtime);

    assert.equal((await resolver.authenticate('token-aaaa')).ok, false, 'content hash must detect same-mtime/size replacement');
    assert.equal((await resolver.authenticate('token-bbbb')).ok, true);
});

test('corrupted credential file or keyring after being valid → all tokens fail closed', async () => {
    const paths = await makeFixture();
    const resolver = makeResolver(paths);
    assert.equal((await resolver.authenticate(TOKEN)).ok, true);

    await fs.writeFile(paths.credentials, '{ corrupted');
    const corrupted = await resolver.authenticate(TOKEN);
    assert.equal(corrupted.ok, false);
    assert.equal(corrupted.code, 'AGW_CONFIG_UNAVAILABLE');

    await fs.writeFile(paths.credentials, JSON.stringify({ version: 1, credentials: [record()] }));
    assert.equal((await resolver.authenticate(TOKEN)).ok, true, 'recovers after fix');

    await fs.writeFile(paths.keyring, 'not json');
    const badKeyring = await resolver.authenticate(TOKEN);
    assert.equal(badKeyring.ok, false);
    assert.equal(badKeyring.code, 'AGW_CONFIG_UNAVAILABLE');
});

test('phase A: unset credentials path -> valid empty snapshot with migration warning; bad explicit path fail-closed', async () => {
    const paths = await makeFixture();
    const warnings = [];
    const resolverA = createCredentialResolver({
        credentialsPath: '',
        pepperKeyringPath: paths.keyring,
        logger: { ...QUIET_LOGGER, warn: (message) => warnings.push(message) }
    });
    const snapshot = await resolverA.getSnapshot();
    assert.equal(snapshot.available, true);
    assert.equal(snapshot.records.length, 0);
    assert.equal(snapshot.migrationWarning, 'no credential file configured');
    assert.equal(warnings.length, 1);
    const auth = await resolverA.authenticate(TOKEN);
    assert.equal(auth.ok, false);
    assert.equal(auth.code, 'AGW_UNAUTHORIZED');

    const resolverB = makeResolver({ ...paths, credentials: path.join(paths.dir, 'missing.json') });
    const badPath = await resolverB.authenticate(TOKEN);
    assert.equal(badPath.ok, false);
    assert.equal(badPath.code, 'AGW_CONFIG_UNAVAILABLE');

    const resolverC = createCredentialResolver({
        credentialsPath: '',
        pepperKeyringPath: paths.keyring,
        legacyCredentialEnabled: false,
        logger: QUIET_LOGGER
    });
    assert.equal((await resolverC.getSnapshot()).available, false, 'phase B requires a credential file');
});

test('missing keyring / unknown kid fail closed; pepper rotation with new kid works', async () => {
    const missingKidPaths = await makeFixture({
        credentials: [record({ kid: 'kid-unknown' })]
    });
    const resolverA = makeResolver(missingKidPaths);
    const unknownKid = await resolverA.authenticate(TOKEN);
    assert.equal(unknownKid.ok, false);
    assert.equal(unknownKid.code, 'AGW_CONFIG_UNAVAILABLE');

    // pepper 轮换：新 kid + 新 token + 新 record，旧 kid 只为 rotating 记录保留
    const rotationPaths = await makeFixture({
        credentials: [
            record({ credentialId: 'cred-old', token: 'token-old', kid: 'kid-a', status: 'rotating' }),
            record({ credentialId: 'cred-new', token: 'token-new', kid: 'kid-b', pepper: PEPPER_B })
        ]
    });
    const resolverB = makeResolver(rotationPaths);
    assert.equal((await resolverB.authenticate('token-old')).ok, true);
    assert.equal((await resolverB.authenticate('token-new')).ok, true);
});

test('token matching multiple records across kids is rejected fail-closed with audit marker', async () => {
    // 同一 token 在 kid-a 与 kid-b 下都有记录（跨 kid 冲突只能认证时发现）
    const paths = await makeFixture({
        credentials: [
            record({ credentialId: 'cred-a', kid: 'kid-a', token: TOKEN, pepper: PEPPER_A }),
            record({ credentialId: 'cred-b', kid: 'kid-b', token: TOKEN, pepper: PEPPER_B })
        ]
    });
    const errors = [];
    const resolver = makeResolver(paths, {
        logger: { ...QUIET_LOGGER, error: (message) => errors.push(message) }
    });
    const result = await resolver.authenticate(TOKEN);
    assert.equal(result.ok, false);
    assert.equal(result.audit, 'token-collision');
    assert.equal(errors.length, 1);
});

test('credentialId reuse with different digest is tombstoned within the process', async () => {
    const paths = await makeFixture({ credentials: [record({ token: 'token-one' })] });
    const resolver = makeResolver(paths);
    assert.equal((await resolver.authenticate('token-one')).ok, true);

    // 同 credentialId 换 digest —— 进程内 tombstone 尽早拒绝整个 snapshot
    await fs.writeFile(paths.credentials, JSON.stringify({
        version: 1,
        credentials: [record({ token: 'token-two' })]
    }));
    const result = await resolver.authenticate('token-two');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'AGW_CONFIG_UNAVAILABLE');
    assert.ok(JSON.stringify(result.reasons).includes('tombstoned'));
});

test('checkCredentialStatus reflects revocation and disappearance', async () => {
    const paths = await makeFixture();
    const resolver = makeResolver(paths);
    assert.equal((await resolver.checkCredentialStatus('cred-a')).ok, true);
    assert.equal((await resolver.checkCredentialStatus('cred-missing')).ok, false);

    await fs.writeFile(paths.credentials, JSON.stringify({
        version: 1,
        credentials: [record({ status: 'revoked' })]
    }));
    const revoked = await resolver.checkCredentialStatus('cred-a');
    assert.equal(revoked.ok, false);
    assert.match(revoked.reason, /revoked/);
});

test('concurrent authentications coalesce into shared in-flight reads', async () => {
    const paths = await makeFixture();
    const realReadFile = fs.readFile;
    let reads = 0;
    const resolver = createCredentialResolver({
        credentialsPath: paths.credentials,
        pepperKeyringPath: paths.keyring,
        logger: QUIET_LOGGER
    });
    const fsModule = require('node:fs/promises');
    const original = fsModule.readFile;
    fsModule.readFile = async (...args) => {
        reads += 1;
        return original.apply(fsModule, args);
    };
    try {
        const results = await Promise.all(
            Array.from({ length: 20 }, () => resolver.authenticate(TOKEN))
        );
        assert.ok(results.every((result) => result.ok));
        // 20 个并发合并为一次 in-flight 快照读取（2 个文件）
        assert.ok(reads <= 4, `expected coalesced reads, saw ${reads}`);
    } finally {
        fsModule.readFile = original;
    }
});

test('hot path benchmark: p99 additional latency < 5ms', async () => {
    const paths = await makeFixture();
    const resolver = makeResolver(paths);
    await resolver.authenticate(TOKEN);

    const samples = [];
    for (let iteration = 0; iteration < 300; iteration += 1) {
        const start = process.hrtime.bigint();
        const result = await resolver.authenticate(TOKEN);
        const end = process.hrtime.bigint();
        assert.equal(result.ok, true);
        samples.push(Number(end - start) / 1e6);
    }
    samples.sort((left, right) => left - right);
    const p99 = samples[Math.floor(samples.length * 0.99)];
    assert.ok(p99 < 5, `credential check p99 ${p99.toFixed(3)}ms must stay under 5ms`);
});

test('resolver never uses readFileSync on the request path', async () => {
    const source = await fs.readFile(
        path.join(__dirname, '..', '..', '..', 'modules', 'agentGateway', 'policy', 'credentialResolver.js'),
        'utf8'
    );
    assert.ok(!source.includes('readFileSync'), 'request path must use async I/O only');
});

test('credential CLI creates, rotates and revokes records with CSPRNG tokens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-cli-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const peppersPath = path.join(dir, 'peppers.json');
    await fs.writeFile(peppersPath, JSON.stringify({ keys: { 'kid-cli': Buffer.alloc(32, 11).toString('base64') } }));

    const createOut = execFileSync('node', [
        CLI_PATH, 'create',
        '--credentials', credentialsPath,
        '--peppers', peppersPath,
        '--credential-id', 'cli-cred',
        '--bound-agent', 'MCPMidas'
    ], { env: { ...process.env, AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID: 'kid-cli' }, encoding: 'utf8' });
    const token = createOut.match(/token: (\S+)/)[1];
    assert.ok(Buffer.from(token, 'base64url').length >= 32, 'token must be >=256 bit');

    const resolver = createCredentialResolver({
        credentialsPath, pepperKeyringPath: peppersPath, logger: QUIET_LOGGER
    });
    const auth = await resolver.authenticate(token);
    assert.equal(auth.ok, true);
    assert.equal(auth.credentialId, 'cli-cred');

    // duplicate id rejected
    assert.throws(() => execFileSync('node', [
        CLI_PATH, 'create',
        '--credentials', credentialsPath, '--peppers', peppersPath,
        '--credential-id', 'cli-cred', '--kid', 'kid-cli'
    ], { encoding: 'utf8', stdio: 'pipe' }));

    const rotateOut = execFileSync('node', [
        CLI_PATH, 'rotate',
        '--credentials', credentialsPath, '--peppers', peppersPath,
        '--credential-id', 'cli-cred',
        '--new-credential-id', 'cli-cred-2',
        '--old-expires-at', '2027-06-01T00:00:00.000Z',
        '--kid', 'kid-cli'
    ], { encoding: 'utf8' });
    const newToken = rotateOut.match(/token: (\S+)/)[1];

    const fileAfterRotate = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    const oldRecord = fileAfterRotate.credentials.find((item) => item.credentialId === 'cli-cred');
    assert.equal(oldRecord.status, 'rotating');
    assert.equal(oldRecord.expiresAt, '2027-06-01T00:00:00.000Z');
    assert.equal((await resolver.authenticate(newToken)).ok, true);
    assert.equal((await resolver.authenticate(token)).ok, true, 'rotating old token still valid until expiry');

    execFileSync('node', [
        CLI_PATH, 'revoke',
        '--credentials', credentialsPath,
        '--credential-id', 'cli-cred'
    ], { encoding: 'utf8' });
    assert.equal((await resolver.authenticate(token)).ok, false, 'revocation visible on next read');
    assert.equal((await resolver.authenticate(newToken)).ok, true);

    // secret 不落盘：文件中只有 digest
    const fileText = await fs.readFile(credentialsPath, 'utf8');
    assert.ok(!fileText.includes(token) && !fileText.includes(newToken));
});
