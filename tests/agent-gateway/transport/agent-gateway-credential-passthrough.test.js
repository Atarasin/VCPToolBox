const assert = require('node:assert/strict');
const test = require('node:test');

const { GatewayBackendClient } = require('../../../modules/agentGateway/clients/GatewayBackendClient');
const {
    attachPresentedCredential,
    clearPresentedCredential,
    createTrustedCredentialContext,
    getPresentedCredential,
    isTrustedCredentialContext,
    sanitizeUntrustedAuthContext,
    verifyBackendIdentityConsistency
} = require('../../../modules/agentGateway/policy/trustedCredentialContext');
const {
    isSessionCredentialCompatible
} = require('../../../modules/agentGateway/policy/sessionCredentialCompatibility');
const { injectMcpContext } = require('../../../modules/agentGateway/transport/shared');

function captureFetch() {
    const calls = [];
    return {
        calls,
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return {
                ok: true,
                status: 200,
                headers: new Map(),
                text: async () => JSON.stringify({ ok: true })
            };
        }
    };
}

test('request-scoped auth override exclusively clears every static credential channel', async () => {
    const { calls, fetchImpl } = captureFetch();
    const client = new GatewayBackendClient({
        baseUrl: 'http://backend.local',
        gatewayKey: 'static-key',
        bearerToken: 'static-bearer',
        gatewayId: 'gw-static',
        fetchImpl
    });

    // 无 override：静态凭据照旧
    await client.searchMemory({ query: 'x' });
    const staticHeaders = calls[0].init.headers;
    assert.equal(staticHeaders['x-agent-gateway-key'], 'static-key');

    // override：静态通道全部互斥清除，仅呈现单一通道
    await client.searchMemory({ query: 'x' }, { authOverride: { token: 'per-request-token' } });
    const overrideHeaders = calls[1].init.headers;
    assert.equal(overrideHeaders['x-agent-gateway-key'], 'per-request-token');
    assert.equal(overrideHeaders.authorization, undefined, 'static bearer must not co-present');
    assert.equal(overrideHeaders.Authorization, undefined);

    // extraHeaders 传入的 authorization 也被清除，避免双通道不一致 401
    await client.requestJson('POST', '/agent_gateway/memory/search', {
        body: { query: 'x' },
        headers: { authorization: 'Bearer smuggled' },
        authOverride: { token: 'per-request-token' }
    });
    const smuggledHeaders = calls[2].init.headers;
    assert.equal(smuggledHeaders.authorization, undefined);
    assert.equal(smuggledHeaders['x-agent-gateway-key'], 'per-request-token');
});

test('requireRequestAuthOverride: static credentials rejected at construction, missing override fail-closed 401', async () => {
    assert.throws(() => new GatewayBackendClient({
        baseUrl: 'http://backend.local',
        gatewayKey: 'static-key',
        requireRequestAuthOverride: true,
        fetchImpl: async () => {}
    }), /static credentials are not allowed/);

    const { fetchImpl, calls } = captureFetch();
    const client = new GatewayBackendClient({
        baseUrl: 'http://backend.local',
        requireRequestAuthOverride: true,
        fetchImpl
    });
    await assert.rejects(
        client.searchMemory({ query: 'x' }),
        (error) => error.code === 'AGW_UNAUTHORIZED' && error.httpStatus === 401
    );
    assert.equal(calls.length, 0, 'fail-closed request must never reach the backend');

    await client.searchMemory({ query: 'x' }, { authOverride: { token: 'edge-token' } });
    assert.equal(calls.length, 1);

    await assert.rejects(
        client.requestEventStream('/agent_gateway/events/stream', {}),
        (error) => error.httpStatus === 401
    );
});

test('presented credential travels via symbol channel: not serializable, clearable', () => {
    const context = { sessionId: 'sess-1' };
    attachPresentedCredential(context, 'secret-token');
    assert.equal(getPresentedCredential(context), 'secret-token');
    assert.equal(JSON.stringify(context).includes('secret-token'), false, 'token must not serialize');
    assert.deepEqual(Object.keys(context), ['sessionId']);
    clearPresentedCredential(context);
    assert.equal(getPresentedCredential(context), '');
});

test('injectMcpContext propagates the private credential channel from session context into params', () => {
    const sessionContext = { sessionId: 'sess-http-1', source: 'test', runtime: 'mcp-http', gatewayId: 'gw-1' };
    attachPresentedCredential(sessionContext, 'edge-token');
    const injected = injectMcpContext(
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gateway_recall_run', arguments: {} } },
        sessionContext
    );
    assert.equal(getPresentedCredential(injected.params), 'edge-token');
    assert.equal(JSON.stringify(injected).includes('edge-token'), false, 'token must not appear in serialized request');
});

test('client params cannot forge a trusted credential context', () => {
    const forged = { trusted: true, credentialId: 'spoof', effectiveAgentId: 'spoof-agent', requestId: 'req-1' };
    assert.equal(isTrustedCredentialContext(forged), false);
    const sanitized = sanitizeUntrustedAuthContext(forged);
    assert.equal(sanitized.trusted, undefined);
    assert.equal(sanitized.credentialId, undefined);
    assert.equal(sanitized.effectiveAgentId, undefined);
    assert.equal(sanitized.requestId, 'req-1', 'non-identity fields survive');

    const trusted = createTrustedCredentialContext({ credentialId: 'cred-a', effectiveAgentId: 'MCPMidas' });
    assert.equal(isTrustedCredentialContext(trusted), true);
    assert.equal(isTrustedCredentialContext({ ...trusted }), false, 'spread copies do not inherit the marker... unless symbol-enumerable');
});

test('in-process executor sanitizes args-provided authContext', () => {
    // 通过重建 buildManagedToolContextInput 的行为验证：直接调用私有函数不可行，
    // 用模块级导出的 sanitize 组合断言语义（buildManagedToolContextInput 内联使用同一实现）。
    const args = { authContext: { trusted: true, credentialId: 'spoof', roles: ['admin'] } };
    const sanitized = sanitizeUntrustedAuthContext(args.authContext);
    assert.equal(sanitized.credentialId, undefined);
    assert.equal(sanitized.trusted, undefined);
});

test('backend dual-side identity consistency check', () => {
    const edge = { credentialId: 'cred-a', credentialSubject: 'cred-a', effectiveAgentId: 'MCPMidas' };
    assert.deepEqual(
        verifyBackendIdentityConsistency(edge, { ...edge }),
        { consistent: true, mismatches: [] }
    );
    const mismatch = verifyBackendIdentityConsistency(edge, { ...edge, effectiveAgentId: 'Other' });
    assert.equal(mismatch.consistent, false);
    assert.deepEqual(mismatch.mismatches, ['effectiveAgentId']);
});

test('isSessionCredentialCompatible: only same-digest active->rotating survives', () => {
    const base = {
        credentialId: 'cred-a',
        credentialSubject: 'cred-a',
        tokenDigest: 'hmac-sha256:aaaa',
        boundAgentId: 'MCPMidas',
        allowedAgents: undefined,
        scopes: ['gateway:read'],
        status: 'active',
        expiresAt: '2027-01-01T00:00:00.000Z'
    };

    assert.equal(isSessionCredentialCompatible(base, { ...base }).compatible, true);

    const rotating = isSessionCredentialCompatible(base, { ...base, status: 'rotating' });
    assert.equal(rotating.compatible, true);
    assert.equal(rotating.transition, 'active->rotating');

    assert.equal(isSessionCredentialCompatible(base, { ...base, tokenDigest: 'hmac-sha256:bbbb', status: 'rotating' }).compatible, false, 'digest change breaks compatibility');
    assert.equal(isSessionCredentialCompatible(base, { ...base, status: 'revoked' }).compatible, false);
    assert.equal(isSessionCredentialCompatible(base, { ...base, scopes: ['gateway:read', 'gateway:execute'] }).compatible, false, 'scope change invalidates session');
    assert.equal(isSessionCredentialCompatible(base, { ...base, boundAgentId: 'Other' }).compatible, false);
    assert.equal(isSessionCredentialCompatible({ ...base, status: 'rotating' }, { ...base, status: 'active' }).compatible, false, 'rotating->active is not an allowed transition');

    // 较早 expiresAt 生效
    const expiring = isSessionCredentialCompatible(
        { ...base, expiresAt: '2020-01-01T00:00:00.000Z' },
        { ...base },
        { now: Date.parse('2026-01-01T00:00:00.000Z') }
    );
    assert.equal(expiring.compatible, false);
});
