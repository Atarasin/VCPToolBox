'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
    createDownloadNonceStore,
    createFileDownloadNonceBackend,
    createInMemoryDownloadNonceBackend
} = require('../../../modules/agentGateway/policy/downloadNonceStore');
const { createAdminGatewaySessionStore } = require('../../../modules/agentGateway/policy/adminGatewaySessionStore');
const { createBuiltinCredentialResolver } = require('../../../modules/agentGateway/policy/builtinCredentials');
const { computeCredentialRecordRevision } = require('../../../modules/agentGateway/policy/credentialResolver');
const { createSkillDownloadSigningService, loadSigningKeys } = require('../../../modules/agentGateway/services/skillDownloadSigningService');

// 生成测试用签名密钥（base64 编码的 32 字节随机值）
const TEST_KEY_JSON = JSON.stringify([
    { kid: 'k1', secret: Buffer.alloc(32, 0xab).toString('base64') },
    { kid: 'k0', secret: Buffer.alloc(32, 0xcd).toString('base64') }
]);
const TEST_KEY_SINGLE = Buffer.alloc(32, 0xef).toString('base64');
const SUBJECT_KEY = crypto.randomBytes(32).toString('base64');

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

/**
 * 真实 admin session store + builtinCredentials 语义的 authContext：
 * credentialId 常量、trustedSessionId 为 opaque id、revision 取
 * `admin-session:<record revision>`、credentialRecord.expiresAt ISO。
 */
async function makeAdminSessionOwner() {
    const sessionStore = createAdminGatewaySessionStore({ subjectKey: SUBJECT_KEY });
    const session = await sessionStore.createSession();
    assert.equal(session.ok, true);
    const authContext = {
        credentialId: 'admin-session',
        credentialSubject: session.credentialSubject,
        credentialRevision: `admin-session:${session.revision}`,
        trustedSessionId: session.opaqueSessionId,
        credentialRecord: { expiresAt: new Date(session.expiresAt).toISOString() },
        effectiveAgentId: 'Ariadne'
    };
    return { sessionStore, session, authContext };
}

/**
 * 文件 credential owner：record + resolver canonical revision + 与真实
 * checkCredentialStatus 相同的返回形状（含 rotation compatibility）。
 */
function makeCredentialOwner(overrides = {}) {
    const record = {
        credentialId: 'cred-001',
        tokenDigest: 'hmac-sha256:' + 'a'.repeat(64),
        boundAgentId: 'Ariadne',
        allowedAgents: null,
        scopes: ['gateway:read'],
        status: 'active',
        expiresAt: null,
        ...overrides
    };
    const state = { record, ok: true };
    const credentialResolver = {
        checkCredentialStatus: async (credentialId) => {
            if (!state.ok || credentialId !== state.record.credentialId) {
                return { ok: false, code: 'AGW_UNAUTHORIZED' };
            }
            return {
                ok: true,
                record: state.record,
                credentialRevision: computeCredentialRecordRevision(state.record),
                rotationCompatibleRevision: state.record.status === 'rotating'
                    ? computeCredentialRecordRevision(state.record, 'active')
                    : null
            };
        }
    };
    const authContext = {
        credentialId: record.credentialId,
        credentialSubject: record.credentialId,
        credentialRevision: computeCredentialRecordRevision(record),
        effectiveAgentId: 'Ariadne'
    };
    return { state, credentialResolver, authContext };
}

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

    // fail-fast：缺 kid / 熵不足的 entry 使整组配置无效（表现为 mint 503）
    assert.equal(loadSigningKeys(JSON.stringify([
        { secret: Buffer.alloc(32, 1).toString('base64') }
    ])), null);
    assert.equal(loadSigningKeys(JSON.stringify([
        { kid: 'k1', secret: Buffer.alloc(32, 1).toString('base64') },
        { kid: 'k0', secret: Buffer.alloc(8, 1).toString('base64') }
    ])), null);
});

test('mint returns 503 when nonce store is not production', () => {
    const svc = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: createDownloadNonceStore() // in-memory, production: false
    });
    const { authContext } = makeCredentialOwner();
    const result = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'skill:Ariadne:claude:rev1' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
});

test('mint returns 503 when signing service not configured', () => {
    const svc = createSkillDownloadSigningService({ signingSecretEnv: null, downloadNonceStore: null });
    const { authContext } = makeCredentialOwner();
    const result = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 503);
});

test('credential owner: mint token redeems once against real revision, then nonce is consumed', async () => {
    const { credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'skill:Ariadne:claude:rev1' });
    assert.equal(mint.ok, true);

    const redeem1 = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(redeem1.ok, true);
    assert.equal(redeem1.payload.ownerKind, 'credential');
    assert.equal(redeem1.payload.ownerId, 'cred-001');

    // 缓存重放/二次兑换：nonce 已消费
    const redeem2 = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(redeem2.ok, false);
    assert.equal(redeem2.httpStatus, 403);
});

test('credential owner revocation and revision drift invalidate the token', async () => {
    const { state, credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(mint.ok, true);

    // 吊销 → 401
    state.ok = false;
    const revoked = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.httpStatus, 401);

    // 恢复但换 token digest（revision 漂移）→ 401
    state.ok = true;
    state.record = { ...state.record, tokenDigest: 'hmac-sha256:' + 'b'.repeat(64) };
    const drifted = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.httpStatus, 401);
});

test('credential owner: active -> rotating transition stays redeemable (same token digest)', async () => {
    const { state, credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    state.record = { ...state.record, status: 'rotating' };
    const redeem = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(redeem.ok, true);
});

test('admin-session owner: payload carries digest (not opaque id), redeems via real store, revocation propagates', async () => {
    const { sessionStore, session, authContext } = await makeAdminSessionOwner();
    const svc = makeService({ adminGatewaySessionStore: sessionStore });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(mint.ok, true);

    // 载荷不得含 opaque session id（§6）；ownerId 是其 sha256 digest
    const payload = svc._verifySignedToken({ keys: loadSigningKeys(TEST_KEY_JSON), token: mint.token });
    assert.ok(!JSON.stringify(payload).includes(session.opaqueSessionId));
    assert.equal(payload.ownerId, crypto.createHash('sha256').update(session.opaqueSessionId, 'utf8').digest('hex'));
    assert.equal(payload.ownerKind, 'admin-session');

    const redeem1 = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(redeem1.ok, true);

    // 吊销 session 后新 mint 的 token 立即失效
    const mint2 = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    await sessionStore.revokeSession(session.opaqueSessionId);
    const revoked = await svc.redeemDownloadToken({ token: mint2.token, agentId: 'Ariadne' });
    assert.equal(revoked.ok, false);
    assert.equal(revoked.httpStatus, 401);
});

test('admin-session owner: token TTL is capped by session remaining TTL', async () => {
    const { sessionStore, authContext } = await makeAdminSessionOwner();
    const svc = makeService({ adminGatewaySessionStore: sessionStore });
    const sessionExpiresAt = Date.parse(authContext.credentialRecord.expiresAt);
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x', ttlMs: 24 * 3600_000 });
    assert.equal(mint.ok, true);
    assert.ok(mint.expiresAt <= sessionExpiresAt);

    // session 已过期 → mint 拒绝
    const expiredContext = { ...authContext, credentialRecord: { expiresAt: new Date(Date.now() - 1000).toISOString() } };
    const rejected = svc.mintDownloadToken({ authContext: expiredContext, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.httpStatus, 401);
});

test('legacy owner: redeem revalidates via builtin status; key rotation/disable invalidates', async () => {
    const gatewayKey = 'legacy-key-0123456789';
    const builtin = createBuiltinCredentialResolver({
        gatewayKey,
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: false, legacyScopeNamesDisabled: false }
    });
    const legacyStatus = builtin.checkLegacyCredentialStatus();
    assert.equal(legacyStatus.ok, true);
    const authContext = {
        credentialId: 'legacy-gateway-key',
        credentialSubject: 'legacy-gateway-key',
        credentialRevision: legacyStatus.credentialRevision,
        effectiveAgentId: 'Ariadne'
    };
    const svc = makeService({ checkLegacyCredentialStatus: builtin.checkLegacyCredentialStatus });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    assert.equal(mint.ok, true);
    const redeem = await svc.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(redeem.ok, true);
    assert.equal(redeem.payload.ownerKind, 'legacy');

    // key 轮换：重建 resolver → revision 变化 → 401
    const rotated = createBuiltinCredentialResolver({
        gatewayKey: 'legacy-key-rotated-xyz',
        switches: { legacyKeyDisabled: false, adminFallbackDisabled: false, legacyScopeNamesDisabled: false }
    });
    const svcRotated = makeService({ checkLegacyCredentialStatus: rotated.checkLegacyCredentialStatus });
    const mintAgain = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    const afterRotate = await svcRotated.redeemDownloadToken({ token: mintAgain.token, agentId: 'Ariadne' });
    assert.equal(afterRotate.ok, false);
    assert.equal(afterRotate.httpStatus, 401);

    // 开关关闭 → 401
    const disabled = createBuiltinCredentialResolver({
        gatewayKey,
        switches: { legacyKeyDisabled: true, adminFallbackDisabled: false, legacyScopeNamesDisabled: false }
    });
    const svcDisabled = makeService({ checkLegacyCredentialStatus: disabled.checkLegacyCredentialStatus });
    const mint3 = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    const afterDisable = await svcDisabled.redeemDownloadToken({ token: mint3.token, agentId: 'Ariadne' });
    assert.equal(afterDisable.ok, false);
    assert.equal(afterDisable.httpStatus, 401);
});

test('redeem order: ensureArtifact failure does not consume the nonce', async () => {
    const { credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });

    // artifact 校验失败（如 guidance 瞬时不可用）→ 不消费 nonce
    const failed = await svc.redeemDownloadToken({
        token: mint.token,
        agentId: 'Ariadne',
        ensureArtifact: async () => ({ ok: false, httpStatus: 503, reason: 'transient guidance failure' })
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.httpStatus, 503);

    // 随后 artifact 恢复 → 同一 token 仍可成功兑换一次
    const succeeded = await svc.redeemDownloadToken({
        token: mint.token,
        agentId: 'Ariadne',
        ensureArtifact: async () => ({ ok: true, artifact: { artifactId: 'x' } })
    });
    assert.equal(succeeded.ok, true);
    assert.equal(succeeded.artifact.artifactId, 'x');

    // 成功消费后不可重放
    const replayed = await svc.redeemDownloadToken({
        token: mint.token,
        agentId: 'Ariadne',
        ensureArtifact: async () => ({ ok: true, artifact: { artifactId: 'x' } })
    });
    assert.equal(replayed.ok, false);
    assert.equal(replayed.httpStatus, 403);
});

test('redeem rejects tampered and length-mismatched signatures without throwing', async () => {
    const { credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });

    const tampered = mint.token.slice(0, -4) + 'XXXX';
    const result = await svc.redeemDownloadToken({ token: tampered, agentId: 'Ariadne' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);

    // 长度不符的伪造签名：恒时比较不抛 RangeError，仍 401
    const [kid, body] = mint.token.split('.');
    const short = `${kid}.${body}.abc`;
    const shortResult = await svc.redeemDownloadToken({ token: short, agentId: 'Ariadne' });
    assert.equal(shortResult.ok, false);
    assert.equal(shortResult.httpStatus, 401);
});

test('redeem rejects expired token', async () => {
    const past = Date.now() - 3_600_000;
    const { credentialResolver, authContext } = makeCredentialOwner();
    const svcPast = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        credentialResolver,
        now: () => past
    });
    const mint = svcPast.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x', ttlMs: 1 });
    const svcNow = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        credentialResolver
    });
    const result = await svcNow.redeemDownloadToken({ token: mint.token, agentId: 'Ariadne' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 401);
});

test('redeem rejects agent mismatch', async () => {
    const { credentialResolver, authContext } = makeCredentialOwner();
    const svc = makeService({ credentialResolver });
    const mint = svc.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });
    const result = await svc.redeemDownloadToken({ token: mint.token, agentId: 'OtherAgent' });
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 403);
});

test('kid rotation: previous key still verifies', async () => {
    const { credentialResolver, authContext } = makeCredentialOwner();
    // k0 is the previous key; build a token signed with k0 and verify with [k1, k0]
    const k0Only = JSON.stringify([{ kid: 'k0', secret: Buffer.alloc(32, 0xcd).toString('base64') }]);
    const svcOld = createSkillDownloadSigningService({
        signingSecretEnv: k0Only,
        downloadNonceStore: makeProductionNonceStore(),
        credentialResolver
    });
    const mint = svcOld.mintDownloadToken({ authContext, agentId: 'Ariadne', artifactId: 'x' });

    const svcNew = createSkillDownloadSigningService({
        signingSecretEnv: TEST_KEY_JSON,
        downloadNonceStore: makeProductionNonceStore(),
        credentialResolver
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

test('file nonce backend: atomic across instances, consumption survives restart', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-nonce-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const expiresAt = Date.now() + 60_000;

    // 两个 backend 实例共享同一目录（模拟多 worker）——只有一个消费成功
    const workerA = createDownloadNonceStore({ backend: createFileDownloadNonceBackend({ dir }) });
    const workerB = createDownloadNonceStore({ backend: createFileDownloadNonceBackend({ dir }) });
    assert.equal(workerA.production, true);
    const results = await Promise.all([
        workerA.consumeOnce('shared-nonce', expiresAt),
        workerB.consumeOnce('shared-nonce', expiresAt)
    ]);
    assert.equal(results.filter(Boolean).length, 1);

    // 重启（新实例、同目录）后已消费状态保持
    const afterRestart = createDownloadNonceStore({ backend: createFileDownloadNonceBackend({ dir }) });
    assert.equal(await afterRestart.consumeOnce('shared-nonce', expiresAt), false);

    // 过期 nonce 拒绝
    assert.equal(await afterRestart.consumeOnce('expired-nonce', Date.now() - 120_000), false);
});
