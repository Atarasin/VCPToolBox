const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createAdminGatewaySessionStore,
    createInMemoryAdminSessionBackend
} = require('../../../modules/agentGateway/policy/adminGatewaySessionStore');
const {
    ADMIN_SESSION_CREDENTIAL_ID,
    LEGACY_CREDENTIAL_ID,
    createAuthMigrationMetrics,
    createBuiltinCredentialResolver,
    readMigrationSwitches
} = require('../../../modules/agentGateway/policy/builtinCredentials');
const {
    createGatewayRequestContextBuilder
} = require('../../../modules/agentGateway/policy/gatewayRequestContext');
const {
    checkOrigin,
    resolveOriginPolicy
} = require('../../../routes/agentGateway/authSessionRoutes');

const SUBJECT_KEY = Buffer.alloc(32, 42).toString('base64');

function makeStore(overrides = {}) {
    return createAdminGatewaySessionStore({
        backend: createInMemoryAdminSessionBackend(),
        subjectKey: SUBJECT_KEY,
        ...overrides
    });
}

const EMPTY_FILE_RESOLVER = {
    async authenticate() {
        return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'unknown token' };
    }
};

test('admin session lifecycle: create, verify, CSRF binding, revoke', async () => {
    const store = makeStore();
    const session = await store.createSession();
    assert.equal(session.ok, true);
    assert.ok(Buffer.from(session.opaqueSessionId, 'base64url').length >= 32, 'opaque id must be >=256 bit CSPRNG');
    assert.match(session.credentialSubject, /^admin-session:[0-9a-f]{64}$/);

    const verified = await store.verifySession(session.opaqueSessionId);
    assert.equal(verified.ok, true);
    assert.equal(verified.credentialSubject, session.credentialSubject);

    // CSRF：mutation 必须呈现 session-bound token
    const missingCsrf = await store.verifySession(session.opaqueSessionId, { requireCsrf: true });
    assert.equal(missingCsrf.ok, false);
    assert.equal(missingCsrf.code, 'AGW_FORBIDDEN');
    const wrongCsrf = await store.verifySession(session.opaqueSessionId, { requireCsrf: true, csrfToken: 'nope' });
    assert.equal(wrongCsrf.ok, false);
    const rightCsrf = await store.verifySession(session.opaqueSessionId, { requireCsrf: true, csrfToken: session.csrfToken });
    assert.equal(rightCsrf.ok, true);

    await store.revokeSession(session.opaqueSessionId);
    assert.equal((await store.verifySession(session.opaqueSessionId)).ok, false);
});

test('admin session TTL expiry and subject key requirements', async () => {
    let clock = 1_000_000;
    const store = makeStore({ sessionTtlMs: 10_000, now: () => clock });
    const session = await store.createSession();
    assert.equal((await store.verifySession(session.opaqueSessionId)).ok, true);
    clock += 10_001;
    const expired = await store.verifySession(session.opaqueSessionId);
    assert.equal(expired.ok, false);
    assert.match(expired.reason, /expired|not found/);

    // subject key 未配置或太短 → 503 语义
    const unconfigured = createAdminGatewaySessionStore({ subjectKey: '' });
    assert.equal((await unconfigured.createSession()).code, 'AGW_CONFIG_UNAVAILABLE');
    const shortKey = createAdminGatewaySessionStore({ subjectKey: 'too-short' });
    assert.equal((await shortKey.createSession()).code, 'AGW_CONFIG_UNAVAILABLE');
});

test('subject key rotation atomically revokes old sessions', async () => {
    const backend = createInMemoryAdminSessionBackend();
    const storeA = createAdminGatewaySessionStore({ backend, subjectKey: SUBJECT_KEY });
    const session = await storeA.createSession();
    assert.equal((await storeA.verifySession(session.opaqueSessionId)).ok, true);

    const rotatedKey = Buffer.alloc(32, 99).toString('base64');
    const storeB = createAdminGatewaySessionStore({ backend, subjectKey: rotatedKey });
    const afterRotation = await storeB.verifySession(session.opaqueSessionId);
    assert.equal(afterRotation.ok, false);
    assert.match(afterRotation.reason, /subject key rotated/);
});

test('legacy gateway key synthesizes builtin admin credential; disabled switch rejects it', async () => {
    const metrics = createAuthMigrationMetrics();
    const resolver = createBuiltinCredentialResolver({
        gatewayKey: 'legacy-secret-key',
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: false, legacyScopeNamesDisabled: false },
        authMigrationMetrics: metrics
    });

    const matched = await resolver.resolveBuiltinCredential({ token: 'legacy-secret-key' });
    assert.equal(matched.matched, true);
    assert.equal(matched.result.ok, true);
    assert.equal(matched.result.credentialId, LEGACY_CREDENTIAL_ID);
    assert.equal(matched.result.record.boundAgentId, null);
    assert.deepEqual(matched.result.record.scopes, ['admin'], 'phase A keeps full cross-agent power intentionally');

    const unmatched = await resolver.resolveBuiltinCredential({ token: 'other-token' });
    assert.equal(unmatched.matched, false);

    const disabledResolver = createBuiltinCredentialResolver({
        gatewayKey: 'legacy-secret-key',
        switches: { legacyKeyDisabled: true, adminFallbackDisabled: false, legacyScopeNamesDisabled: false },
        authMigrationMetrics: metrics
    });
    const rejected = await disabledResolver.resolveBuiltinCredential({ token: 'legacy-secret-key' });
    assert.equal(rejected.matched, true);
    assert.equal(rejected.result.ok, false);

    const snapshot = metrics.snapshot();
    assert.equal(snapshot[LEGACY_CREDENTIAL_ID].accepted, 1);
    assert.equal(snapshot[LEGACY_CREDENTIAL_ID]['rejected-disabled'], 1);
});

test('admin session maps to builtin credential on native surface only; /mcp always rejects', async () => {
    const store = makeStore();
    const session = await store.createSession();
    const resolver = createBuiltinCredentialResolver({
        gatewayKey: '',
        adminSessionStore: store,
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: false, legacyScopeNamesDisabled: false }
    });

    const native = await resolver.resolveBuiltinCredential({
        surface: 'native', adminSessionId: session.opaqueSessionId
    });
    assert.equal(native.matched, true);
    assert.equal(native.result.ok, true);
    assert.equal(native.result.credentialId, ADMIN_SESSION_CREDENTIAL_ID);
    assert.equal(native.result.credentialSubject, session.credentialSubject);
    assert.match(native.result.credentialRevision, /^admin-session:/);
    assert.equal(native.result.record.trustedSessionId, session.opaqueSessionId);

    const mcp = await resolver.resolveBuiltinCredential({
        surface: 'mcp', adminSessionId: session.opaqueSessionId
    });
    assert.equal(mcp.matched, true);
    assert.equal(mcp.result.ok, false, '/mcp transports must never accept admin sessions');

    // admin fallback 开关独立生效
    const disabled = createBuiltinCredentialResolver({
        gatewayKey: '',
        adminSessionStore: store,
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: true, legacyScopeNamesDisabled: false }
    });
    const rejected = await disabled.resolveBuiltinCredential({
        surface: 'native', adminSessionId: session.opaqueSessionId
    });
    assert.equal(rejected.result.ok, false);
});

test('builtin credentials flow through the unified resolution tree end to end', async () => {
    const store = makeStore();
    const session = await store.createSession();
    const builtinResolver = createBuiltinCredentialResolver({
        gatewayKey: 'legacy-secret-key',
        adminSessionStore: store,
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: false, legacyScopeNamesDisabled: false }
    });
    const builder = createGatewayRequestContextBuilder({
        credentialResolver: EMPTY_FILE_RESOLVER,
        resolveBuiltinCredential: ({ token, headers }) => builtinResolver.resolveBuiltinCredential({
            token,
            surface: headers['x-test-surface'] || 'native',
            adminSessionId: headers['x-test-session'] || ''
        })
    });

    const legacyContext = await builder.buildGatewayRequestContext({
        headers: { 'x-agent-gateway-key': 'legacy-secret-key' },
        targetCandidates: { path: 'AnyAgent' }
    });
    assert.equal(legacyContext.ok, true);
    assert.equal(legacyContext.credentialId, LEGACY_CREDENTIAL_ID);
    assert.equal(legacyContext.effectiveAgentId, 'AnyAgent');

    const adminSessionContext = await builder.buildGatewayRequestContext({
        headers: { 'x-test-session': session.opaqueSessionId },
        targetCandidates: { path: 'SomeAgent' }
    });
    assert.equal(adminSessionContext.ok, true);
    assert.equal(adminSessionContext.credentialId, ADMIN_SESSION_CREDENTIAL_ID);
});

test('legacy token collision with file credential is detected as config error', async () => {
    const { computeTokenDigest } = require('../../../modules/agentGateway/policy/credentialResolver');
    const pepper = Buffer.alloc(32, 3);
    const resolver = createBuiltinCredentialResolver({ gatewayKey: 'shared-secret' });
    const collision = resolver.detectLegacyTokenCollision({
        available: true,
        records: [{
            credentialId: 'file-cred',
            pepperKid: 'kid-a',
            tokenDigest: `hmac-sha256:${computeTokenDigest(pepper, 'shared-secret')}`
        }],
        pepperKeys: { 'kid-a': pepper }
    });
    assert.equal(collision.collision, true);
    assert.equal(collision.credentialId, 'file-cred');

    const noCollision = resolver.detectLegacyTokenCollision({
        available: true,
        records: [{
            credentialId: 'file-cred',
            pepperKid: 'kid-a',
            tokenDigest: `hmac-sha256:${computeTokenDigest(pepper, 'different-secret')}`
        }],
        pepperKeys: { 'kid-a': pepper }
    });
    assert.equal(noCollision.collision, false);
});

test('migration switches read independently from env', () => {
    const switches = readMigrationSwitches({
        AGENT_GATEWAY_LEGACY_KEY_DISABLED: 'true',
        AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED: 'false',
        AGENT_GATEWAY_LEGACY_SCOPE_NAMES_DISABLED: 'true'
    });
    assert.equal(switches.legacyKeyDisabled, true);
    assert.equal(switches.adminFallbackDisabled, false);
    assert.equal(switches.legacyScopeNamesDisabled, true);
});

test('origin policy: same-origin, allowlist and unconfigured modes', () => {
    const sameOrigin = resolveOriginPolicy({ AGENT_GATEWAY_ADMIN_SAME_ORIGIN: 'true' });
    assert.equal(sameOrigin.mode, 'same-origin');
    assert.equal(sameOrigin.sameSite, 'Strict');
    assert.equal(checkOrigin({ headers: { host: 'gw.local:6005' } }, sameOrigin).ok, true);
    assert.equal(checkOrigin({ headers: { origin: 'http://gw.local:6005', host: 'gw.local:6005' } }, sameOrigin).ok, true);
    assert.equal(checkOrigin({ headers: { origin: 'http://evil.local', host: 'gw.local:6005' } }, sameOrigin).ok, false);

    const allowlist = resolveOriginPolicy({ AGENT_GATEWAY_ADMIN_ORIGINS: 'http://admin.local:6006' });
    assert.equal(allowlist.mode, 'allowlist');
    assert.equal(allowlist.sameSite, 'Lax');
    const allowed = checkOrigin({ headers: { origin: 'http://admin.local:6006' } }, allowlist);
    assert.equal(allowed.ok, true);
    assert.equal(allowed.corsOrigin, 'http://admin.local:6006');
    assert.equal(checkOrigin({ headers: { origin: 'http://other.local' } }, allowlist).ok, false);
    assert.equal(checkOrigin({ headers: {} }, allowlist).ok, false, 'allowlist mode requires Origin');

    assert.equal(resolveOriginPolicy({}).mode, 'unconfigured');
    assert.equal(resolveOriginPolicy({ AGENT_GATEWAY_ADMIN_ORIGINS: '*' }).mode, 'unconfigured', 'wildcard not allowed');
});
