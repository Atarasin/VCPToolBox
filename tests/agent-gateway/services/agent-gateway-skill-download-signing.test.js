'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDownloadNonceStore, createInMemoryDownloadNonceBackend } = require('../../../modules/agentGateway/policy/downloadNonceStore');
const { createSkillDownloadSigningService, loadSigningKeys } = require('../../../modules/agentGateway/services/skillDownloadSigningService');

// 生成测试用签名密钥（base64 编码的 32 字节随机值）
const TEST_KEY_JSON = JSON.stringify([
    { kid: 'k1', secret: Buffer.alloc(32, 0xab).toString('base64') },
    { kid: 'k0', secret: Buffer.alloc(32, 0xcd).toString('base64') }
]);
const TEST_KEY_SINGLE = Buffer.alloc(32, 0xef).toString('base64');

function makeProductionNonceStore() {
    const backend = { ...createInMemoryDownloadNonceBackend(), production: true };
    return createDownloadNonceStore({ backend });
}

function makeService(overrides = {}) {
    return createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        credentialResolver: null,
        adminGatewaySessionStore: null,
        ...overrides
    });
}

const AUTH_CONTEXT = {
    credentialId: 'cred-001',
    credentialSubject: 'cred-001',
    credentialRevision: 'sha256:' + 'a'.repeat(64),
    effectiveAgentId: 'Ariadne'
};

test('loadSigningKeys parses JSON array and single base64', () => {
    const keys = loadSigningKeys(TEST_KEY_JSON);
    assert.equal(keys.length, 2);
    assert.equal(keys[0].kid, 'k1');
    assert.equal(keys[1].kid, 'k0');

    const single = loadSigningKeys(TEST_KEY_SINGLE);
    assert.equal(single.length, 1);
    assert.equal(single[0].kid, 'default');

    assert.equal(loadSigningKeys(null), null);
    assert.equal(loadSigningKeys(Buffer.alloc(8).toString('base64')), null); // too short
});

test('mint returns 503 when nonce store is not production', () => {
    const svc = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: createDownloadNonceStore(), // in-memory, production: false
    });
    const result = svc.mintDownloadToken({ authContext: AUTH_CONTEXT, agentId: 'Ariadne', artifactId: 'skill:Ariadne:claude:rev1' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
});

test('mint returns 503 when signing service not configured', () => {
    const svc = createSkillDownloadSigningService({ signingSecretEnv: null, downloadNonceStore: null });
    const result = svc.mintDownloadToken({ authContext: AUTH_CONTEXT, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
});

test('mint produces a verifiable token that redeem accepts once', async () => {
    const svc = makeService();
    const mintResult = svc.mintDownloadToken({ authContext: AUTH_CONTEXT, agentId: 'Ariadne', artifactId: 'skill:Ariadne:claude:rev1' });
    assert.equal(mintResult.ok, true);
    assert.ok(typeof mintResult.token === 'string');
    assert.ok(mintResult.expiresAt > Date.now());

    // redeem without owner revalidation (no credentialResolver) — owner check skipped for credential kind
    // We need a credentialResolver stub for the owner check
    const credentialResolver = {
        checkCredentialStatus: async (credentialId) => {
            if (credentialId !== 'cred-001') return { ok: false, code: 'AGW_UNAUTHORIZED' };
            return {
                ok: true,
                record: {
                    credentialId: 'cred-001',
                    tokenDigest: 'hmac-sha256:' + 'a'.repeat(64),
                    boundAgentId: 'Ariadne',
                    allowedAgents: null,
                    scopes: ['gateway:read'],
                    status: 'active',
                    expiresAt: Date.now() + 3600_000
                }
            };
        }
    };
    // The revision in AUTH_CONTEXT must match what credentialResolver returns.
    // Since we can't easily match the sha256 here, test with a service that skips owner check
    // by using admin-session kind.
    const adminSessionStore = {
        verifySession: async () => ({
            ok: true,
            credentialSubject: 'admin-session-subject',
            revision: 'rev1',
            expiresAt: Date.now() + 3600_000
        })
    };
    const adminAuthContext = {
        credentialId: 'admin-session',
        credentialSubject: 'admin-session-subject',
        credentialRevision: 'admin-session:rev1',
        effectiveAgentId: 'Ariadne',
        sessionExpiresAt: Date.now() + 3600_000
    };
    const svc2 = makeService({ adminGatewaySessionStore: adminSessionStore });
    const mint2 = svc2.mintDownloadToken({ authContext: adminAuthContext, agentId: 'Ariadne', artifactId: 'skill:Ariadne:claude:rev1' });
    assert.equal(mint2.ok, true);

    const redeem1 = await svc2.redeemDownloadToken({ token: mint2.token, agentId: 'Ariadne' });
    assert.equal(redeem1.ok, true);

    // second redeem must fail (nonce consumed)
    const redeem2 = await svc2.redeemDownloadToken({ token: mint2.token, agentId: 'Ariadne' });
    assert.equal(redeem2.ok, false);
    assert.equal(redeem2.httpStatus, 403);
});

test('redeem rejects tampered token', async () => {
    const svc = makeService();
    const mint = svc.mintDownloadToken({ authContext: { ...AUTH_CONTEXT, credentialId: 'admin-session', credentialSubject: 'sub', sessionExpiresAt: Date.now() + 3600_000 }, agentId: 'Ariadne', artifactId: 'x' });
    const tampered = mint.token.slice(0, -4) + 'XXXX';
    const result = await svc.redeemDownloadToken({ token: tampered, agentId: 'Ariadne' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
});

test('redeem rejects expired token', async () => {
    const past = Date.now() - 1000;
    const svc = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        now: () => past
    });
    const mint = svc.mintDownloadToken({ authContext: { credentialId: 'admin-session', credentialSubject: 'sub', credentialRevision: 'r', sessionExpiresAt: past + 60_000 }, agentId: 'Ariadne', artifactId: 'x', ttlMs: 1 });
    // now advance time past expiry
    const svc2 = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        now: () => Date.now() + 3_600_000
    });
    const result = await svc2.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
});

test('redeem rejects agent mismatch', async () => {
    const adminSessionStore = { verifySession: async () => ({ ok: true, credentialSubject: 'sub', revision: 'r', expiresAt: Date.now() + 3600_000 }) };
    const svc = makeService({ adminGatewaySessionStore: adminSessionStore });
    const mint = svc.mintDownloadToken({ authContext: { credentialId: 'admin-session', credentialSubject: 'sub', credentialRevision: 'r', sessionExpiresAt: Date.now() + 3600_000 }, agentId: 'Ariadne', artifactId: 'x' });
    const result = await svc.redeemDownloadToken({ token: mint.token, agentId: 'OtherAgent' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
});

test('kid rotation: previous key still verifies', async () => {
    // k0 is the previous key; build a token signed with k0 and verify with [k1, k0]
    const k0Only = JSON.stringify([{ kid: 'k0', secret: Buffer.alloc(32, 0xcd).toString('base64') }]);
    const adminSessionStore = { verifySession: async () => ({ ok: true, credentialSubject: 'sub', revision: 'r', expiresAt: Date.now() + 3600_000 }) };
    const svcOld = createSkillDownloadSigningService({
        signingSecretEnv: k0Only,
        downloadNonceStore: makeProductionNonceStore(),
        adminGatewaySessionStore: adminSessionStore
    });
    const mint = svcOld.mintDownloadToken({ authContext: { credentialId: 'admin-session', credentialSubject: 'sub', credentialRevision: 'r', sessionExpiresAt: Date.now() + 3600_000 }, agentId: 'Ariadne', artifactId: 'x' });

    // new service has both keys (k1 current, k0 previous)
    const svcNew = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        adminGatewaySessionStore: adminSessionStore
    });
    const result = await svcNew.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(result.ok, true);
});

test('nonce store consumeOnce is atomic: concurrent calls only one succeeds', async () => {
    const store = makeProductionNonceStore();
    const expiresAt = Date.now() + 60_000;
    const results = await Promise.all([
        store.consumeOnce('nonce-abc', expiresAt),
        store.consumeOnce('nonce-abc', expiresAt),
        store.consumeOnce('nonce-abc', expiresAt)
    ]);
    const trueCount = results.filter(Boolean).length;
    assert.equal(trueCount, 1);
});
