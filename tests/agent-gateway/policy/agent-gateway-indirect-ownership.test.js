const assert = require('node:assert/strict');
const test = require('node:test');

const {
    SESSION_STATES,
    applyAdoption,
    authorizeIndirectAccess,
    captureOwnerSnapshot
} = require('../../../modules/agentGateway/policy/indirectObjectOwnership');
const { createRevocationWatcher } = require('../../../modules/agentGateway/policy/revocationWatcher');
const { createGuardedSseWriter } = require('../../../modules/agentGateway/policy/guardedSseWriter');
const { createJobRuntimeService } = require('../../../modules/agentGateway/services/jobRuntimeService');

function makeContext(overrides = {}) {
    return {
        ok: true,
        credentialId: 'cred-a',
        credentialSubject: 'cred-a',
        credentialRevision: 'rev-1',
        effectiveAgentId: 'MCPMidas',
        isAdmin: false,
        credential: {
            credentialId: 'cred-a',
            tokenDigest: 'hmac-sha256:aaaa',
            boundAgentId: 'MCPMidas',
            scopes: ['gateway:read', 'gateway:execute'],
            status: 'active',
            expiresAt: '2027-01-01T00:00:00.000Z'
        },
        ...overrides
    };
}

test('owner snapshot fixes subject/id/revision/agent/trustedSession at creation', () => {
    const owner = captureOwnerSnapshot({ ...makeContext(), trustedSessionId: 'sess-1' });
    assert.equal(owner.credentialSubject, 'cred-a');
    assert.equal(owner.credentialId, 'cred-a');
    assert.equal(owner.credentialRevision, 'rev-1');
    assert.equal(owner.effectiveAgentId, 'MCPMidas');
    assert.equal(owner.trustedSessionId, 'sess-1');
    assert.ok(Object.isFrozen(owner));
    assert.throws(() => captureOwnerSnapshot({ ok: false }), TypeError);
});

test('same credential accesses its object; different subject 403', () => {
    const owner = captureOwnerSnapshot(makeContext());
    assert.equal(authorizeIndirectAccess({ owner, requesterContext: makeContext() }).allowed, true);

    const stranger = makeContext({
        credentialId: 'cred-b', credentialSubject: 'cred-b',
        credential: { ...makeContext().credential, credentialId: 'cred-b' }
    });
    const denied = authorizeIndirectAccess({ owner, requesterContext: stranger });
    assert.equal(denied.allowed, false);
    assert.equal(denied.code, 'AGW_FORBIDDEN');
});

test('revision compatibility: only same-digest active->rotating inherits; new token rejected', () => {
    const owner = captureOwnerSnapshot(makeContext());

    const rotating = makeContext({
        credentialRevision: 'rev-2',
        credential: { ...makeContext().credential, status: 'rotating' }
    });
    assert.equal(authorizeIndirectAccess({ owner, requesterContext: rotating }).allowed, true);

    const newToken = makeContext({
        credentialRevision: 'rev-3',
        credential: { ...makeContext().credential, tokenDigest: 'hmac-sha256:bbbb', status: 'rotating' }
    });
    const denied = authorizeIndirectAccess({ owner, requesterContext: newToken });
    assert.equal(denied.allowed, false);
    assert.match(denied.reason, /revision incompatible/);
});

test('trusted session: alive mismatch 403; normal termination allows same-subject adoption; revoked destroys', () => {
    const owner = captureOwnerSnapshot({ ...makeContext(), trustedSessionId: 'sess-owner' });

    // 存活但不匹配
    const aliveMismatch = authorizeIndirectAccess({
        owner, requesterContext: makeContext(),
        requesterSessionId: 'sess-other', ownerSessionState: SESSION_STATES.ALIVE
    });
    assert.equal(aliveMismatch.allowed, false);
    assert.equal(aliveMismatch.code, 'AGW_FORBIDDEN');

    // 匹配放行
    assert.equal(authorizeIndirectAccess({
        owner, requesterContext: makeContext(),
        requesterSessionId: 'sess-owner', ownerSessionState: SESSION_STATES.ALIVE
    }).allowed, true);

    // 正常终止 → 同 subject + revision 兼容收养（原子替换 owner）
    const adoption = authorizeIndirectAccess({
        owner, requesterContext: makeContext(),
        requesterSessionId: 'sess-new', ownerSessionState: SESSION_STATES.TERMINATED_NORMALLY
    });
    assert.equal(adoption.allowed, true);
    assert.equal(adoption.adoption.previousTrustedSessionId, 'sess-owner');
    assert.equal(adoption.adoption.newTrustedSessionId, 'sess-new');
    const adopted = applyAdoption(owner, adoption.adoption);
    assert.equal(adopted.trustedSessionId, 'sess-new');

    // 异 subject 收养被拒
    const strangerAdoption = authorizeIndirectAccess({
        owner,
        requesterContext: makeContext({ credentialSubject: 'cred-b', credentialId: 'cred-b' }),
        requesterSessionId: 'sess-new', ownerSessionState: SESSION_STATES.TERMINATED_NORMALLY
    });
    assert.equal(strangerAdoption.allowed, false);

    // 吊销销毁的 session 不适用收养
    const revokedAdoption = authorizeIndirectAccess({
        owner, requesterContext: makeContext(),
        requesterSessionId: 'sess-new', ownerSessionState: SESSION_STATES.DESTROYED_REVOKED
    });
    assert.equal(revokedAdoption.allowed, false);
    assert.match(revokedAdoption.reason, /adoption not applicable/);
});

test('file admin credential crosses owners with audit; admin-session cannot adopt', () => {
    const owner = captureOwnerSnapshot({ ...makeContext(), trustedSessionId: 'sess-owner' });

    const fileAdmin = makeContext({
        credentialId: 'ops-admin', credentialSubject: 'ops-admin', isAdmin: true,
        credential: { credentialId: 'ops-admin', boundAgentId: null, scopes: ['admin'], status: 'active' }
    });
    const crossOwner = authorizeIndirectAccess({ owner, requesterContext: fileAdmin });
    assert.equal(crossOwner.allowed, true);
    assert.equal(crossOwner.crossOwnerAdmin, true);
    assert.equal(crossOwner.originalOwner.credentialSubject, 'cred-a');

    const adminSessionOwner = captureOwnerSnapshot({
        ...makeContext({
            credentialId: 'admin-session',
            credentialSubject: 'admin-session:owner-hmac',
            credential: { credentialId: 'admin-session', boundAgentId: null, scopes: ['admin'], status: 'active', builtin: 'admin-session' }
        }),
        trustedSessionId: 'admin-sess-1'
    });
    // 另一个 admin session（不同 subject）不能访问，也不能收养
    const otherAdminSession = makeContext({
        credentialId: 'admin-session',
        credentialSubject: 'admin-session:other-hmac',
        isAdmin: true,
        credential: { credentialId: 'admin-session', boundAgentId: null, scopes: ['admin'], status: 'active', builtin: 'admin-session' }
    });
    const denied = authorizeIndirectAccess({
        owner: adminSessionOwner,
        requesterContext: otherAdminSession,
        ownerSessionState: SESSION_STATES.TERMINATED_NORMALLY
    });
    assert.equal(denied.allowed, false);
});

test('job runtime fixes owner snapshot and enforces ownership on read', () => {
    const service = createJobRuntimeService();
    const ownerAuth = {
        requestId: 'req-1', sessionId: 'sess-1', agentId: 'MCPMidas',
        credentialSubject: 'cred-a', credentialId: 'cred-a', credentialRevision: 'rev-1',
        effectiveAgentId: 'MCPMidas',
        credentialRecord: {
            credentialId: 'cred-a', credentialSubject: 'cred-a',
            tokenDigest: 'hmac-sha256:aaaa', boundAgentId: 'MCPMidas',
            scopes: ['gateway:execute'], status: 'active', expiresAt: null
        }
    };
    const accepted = service.createAcceptedJob({ operation: 'tool.invoke', authContext: ownerAuth, metadata: {} });
    const jobId = accepted.jobId;
    assert.ok(jobId);

    // 同 credential 可读
    const sameCredential = service.pollJob(jobId, ownerAuth);
    assert.equal(sameCredential.success, true);
    assert.equal(sameCredential.data.job.authContext.owner.credentialSubject, 'cred-a');

    // 不同 credential subject 403（不折叠为同一主体）
    const strangerAuth = {
        ...ownerAuth,
        credentialSubject: 'cred-b', credentialId: 'cred-b', credentialRevision: 'rev-9',
        credentialRecord: { ...ownerAuth.credentialRecord, credentialId: 'cred-b', tokenDigest: 'hmac-sha256:bbbb' }
    };
    const denied = service.pollJob(jobId, strangerAuth);
    assert.equal(denied.success, false);
    assert.equal(denied.status, 403);

    // 新 token（revision 变化且 digest 不同）不能继承旧对象
    const newTokenAuth = {
        ...ownerAuth,
        credentialRevision: 'rev-2',
        credentialRecord: { ...ownerAuth.credentialRecord, tokenDigest: 'hmac-sha256:cccc', status: 'rotating' }
    };
    assert.equal(service.pollJob(jobId, newTokenAuth).success, false);

    // 同 digest active->rotating 继承成功
    const rotatingAuth = {
        ...ownerAuth,
        credentialRevision: 'rev-2',
        credentialRecord: { ...ownerAuth.credentialRecord, status: 'rotating', expiresAt: '2027-01-01T00:00:00.000Z' }
    };
    assert.equal(service.pollJob(jobId, rotatingAuth).success, true);

    // 无凭据身份不能访问有 owner 的对象
    const legacyAuth = { requestId: 'req-2', agentId: 'MCPMidas', sessionId: 'sess-1' };
    assert.equal(service.pollJob(jobId, legacyAuth).success, false);
});

test('job adoption after normal session termination replaces owner atomically with audit', () => {
    const service = createJobRuntimeService();
    const ownerAuth = {
        requestId: 'req-1', sessionId: 'sess-http-1', agentId: 'MCPMidas',
        credentialSubject: 'cred-a', credentialId: 'cred-a', credentialRevision: 'rev-1',
        trustedSessionId: 'sess-http-1',
        credentialRecord: {
            credentialId: 'cred-a', credentialSubject: 'cred-a',
            tokenDigest: 'hmac-sha256:aaaa', boundAgentId: 'MCPMidas',
            scopes: ['gateway:execute'], status: 'active', expiresAt: null
        }
    };
    const accepted = service.createAcceptedJob({ operation: 'tool.invoke', authContext: ownerAuth, metadata: {} });

    // owner session 存活时另一 session 403
    const otherSession = { ...ownerAuth, trustedSessionId: 'sess-http-2', ownerSessionState: 'alive' };
    assert.equal(service.pollJob(accepted.jobId, otherSession).success, false);

    // 正常终止后同 subject 收养成功
    const adopter = { ...ownerAuth, trustedSessionId: 'sess-http-2', ownerSessionState: 'terminated-normally' };
    const adopted = service.pollJob(accepted.jobId, adopter);
    assert.equal(adopted.success, true);
    assert.equal(adopted.data.job.authContext.owner.trustedSessionId, 'sess-http-2');
    assert.ok(adopted.data.job.authContext.adoptionAudit);

    // 吊销销毁不适用收养
    const revokedAdopter = { ...ownerAuth, trustedSessionId: 'sess-http-3', ownerSessionState: 'destroyed-revoked' };
    assert.equal(service.pollJob(accepted.jobId, revokedAdopter).success, false);
});

test('revocation watcher: periodic recheck fires revoked/unavailable within one interval', async () => {
    let status = { ok: true };
    const events = [];
    let tick = null;
    const watcher = createRevocationWatcher({
        checkStatus: async () => status,
        intervalMs: 30_000,
        onRevoked: (state) => events.push(['revoked', state.code]),
        onUnavailable: (state) => events.push(['unavailable', state.code]),
        setIntervalImpl: (fn) => { tick = fn; return { unref() {} }; },
        clearIntervalImpl: () => { tick = null; }
    });
    watcher.start();
    await watcher.revalidate();
    assert.deepEqual(events, []);

    status = { ok: false, code: 'AGW_UNAUTHORIZED' };
    await tick(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events[0], ['revoked', 'AGW_UNAUTHORIZED']);

    status = { ok: false, code: 'AGW_CONFIG_UNAVAILABLE' };
    await tick(); await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events[1], ['unavailable', 'AGW_CONFIG_UNAVAILABLE']);
    watcher.stop();
    assert.equal(tick, null);
});

test('guarded SSE writer terminates the stream on revocation before writing', async () => {
    const written = [];
    let ended = false;
    const res = {
        on() {},
        end() { ended = true; }
    };
    let status = { ok: true };
    const writer = createGuardedSseWriter({
        res,
        checkStatus: async () => status,
        writeEvent: (_res, eventName, payload) => written.push([eventName, payload])
    });

    assert.equal(await writer.write('job.completed', { jobId: 'j1' }), true);
    assert.deepEqual(written[0], ['job.completed', { jobId: 'j1' }]);

    status = { ok: false, code: 'AGW_UNAUTHORIZED' };
    assert.equal(await writer.write('job.completed', { jobId: 'j2' }), false);
    assert.equal(ended, true);
    assert.equal(writer.terminated, true);
    assert.equal(written.at(-1)[0], 'gateway.stream.terminated');
    assert.equal(written.at(-1)[1].reason, 'credential-revoked');
    // 终止后不再写出
    assert.equal(await writer.write('job.completed', { jobId: 'j3' }), false);
    assert.equal(written.filter(([name]) => name === 'job.completed').length, 1);
});
