const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createGatewayRequestContextBuilder,
    extractPresentedCredential,
    resolveTargetCandidates
} = require('../../../modules/agentGateway/policy/gatewayRequestContext');
const { AGW_ERROR_CODES } = require('../../../modules/agentGateway/contracts/errorCodes');
const { MCP_ERROR_CODES } = require('../../../modules/agentGateway/protocols/mcp/constants');
const { mapGatewayFailureToMcpErrorCode } = require('../../../modules/agentGateway/protocols/mcp/errorMapping');

function fakeResolver(records) {
    return {
        async authenticate(token) {
            if (token === 'config-broken') {
                return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE' };
            }
            const record = records[token];
            if (!record) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'unknown token' };
            }
            return {
                ok: true,
                record,
                credentialId: record.credentialId,
                credentialSubject: record.credentialId,
                credentialRevision: `rev-${record.credentialId}`,
                snapshotRevision: 'snap-1'
            };
        }
    };
}

const RECORDS = {
    'token-bound': {
        credentialId: 'cred-bound', boundAgentId: 'MCPMidas',
        scopes: ['gateway:read', 'gateway:execute'], status: 'active'
    },
    'token-readonly-bound': {
        credentialId: 'cred-ro', boundAgentId: 'MCPMidas',
        scopes: ['gateway:read'], status: 'active'
    },
    'token-exec-bound': {
        credentialId: 'cred-exec', boundAgentId: 'MCPMidas',
        scopes: ['gateway:execute'], status: 'active'
    },
    'token-unbound': {
        credentialId: 'cred-unbound', boundAgentId: null,
        allowedAgents: ['Nexus'], scopes: ['gateway:read'], status: 'active'
    },
    'token-admin': {
        credentialId: 'cred-admin', boundAgentId: null,
        scopes: ['admin'], status: 'active'
    }
};

function makeBuilder(overrides = {}) {
    return createGatewayRequestContextBuilder({
        credentialResolver: fakeResolver(RECORDS),
        ...overrides
    });
}

function headersFor(token) {
    return { 'x-agent-gateway-key': token };
}

test('bound credential: omitted / same / different target agent', async () => {
    const builder = makeBuilder();

    const omitted = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'), targetCandidates: {}, requiresAgent: true
    });
    assert.equal(omitted.ok, true);
    assert.equal(omitted.effectiveAgentId, 'MCPMidas');
    assert.equal(omitted.boundAgentId, 'MCPMidas');

    const same = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'), targetCandidates: { body: 'MCPMidas' }
    });
    assert.equal(same.ok, true);
    assert.equal(same.effectiveAgentId, 'MCPMidas');
    assert.equal(same.targetAgentId, 'MCPMidas');

    const different = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'), targetCandidates: { body: 'Nexus' }
    });
    assert.equal(different.ok, false);
    assert.equal(different.code, AGW_ERROR_CODES.FORBIDDEN);
    assert.equal(different.httpStatus, 403);
});

test('unbound credential: missing target 400, out-of-scope 403, in-scope resolves', async () => {
    const builder = makeBuilder();

    const missing = await builder.buildGatewayRequestContext({
        headers: headersFor('token-unbound'), targetCandidates: {}, requiresAgent: true
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, AGW_ERROR_CODES.INVALID_REQUEST);

    const outside = await builder.buildGatewayRequestContext({
        headers: headersFor('token-unbound'), targetCandidates: { path: 'MCPMidas' }
    });
    assert.equal(outside.ok, false);
    assert.equal(outside.code, AGW_ERROR_CODES.FORBIDDEN);

    const inside = await builder.buildGatewayRequestContext({
        headers: headersFor('token-unbound'), targetCandidates: { path: 'Nexus' }
    });
    assert.equal(inside.ok, true);
    assert.equal(inside.effectiveAgentId, 'Nexus');

    const nonAgentOperation = await builder.buildGatewayRequestContext({
        headers: headersFor('token-unbound'), targetCandidates: {}, requiresAgent: false
    });
    assert.equal(nonAgentOperation.ok, true);
    assert.equal(nonAgentOperation.effectiveAgentId, null);
});

test('admin credential (unbound-only) reaches any agent; unknown token rejected', async () => {
    const builder = makeBuilder();
    const anyAgent = await builder.buildGatewayRequestContext({
        headers: headersFor('token-admin'), targetCandidates: { path: 'AnyAgent' }
    });
    assert.equal(anyAgent.ok, true);
    assert.equal(anyAgent.effectiveAgentId, 'AnyAgent');
    assert.equal(anyAgent.isAdmin, true);

    const unknown = await builder.buildGatewayRequestContext({
        headers: headersFor('token-nope'), targetCandidates: { path: 'X' }
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.code, AGW_ERROR_CODES.UNAUTHORIZED);
    assert.equal(unknown.httpStatus, 401);
});

test('path/query/body/URI target conflict -> AGW_INVALID_REQUEST, agreement resolves', async () => {
    const conflict = resolveTargetCandidates({ path: 'A', body: 'B' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict.sources.length, 2);

    assert.deepEqual(
        resolveTargetCandidates({ path: 'A', query: ' A ', body: 'A', uri: undefined }),
        { ok: true, target: 'A', sources: ['path', 'query', 'body'] }
    );

    const builder = makeBuilder();
    const result = await builder.buildGatewayRequestContext({
        headers: headersFor('token-admin'),
        targetCandidates: { path: 'AgentA', body: 'AgentB' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGW_ERROR_CODES.INVALID_REQUEST);
    assert.equal(result.httpStatus, 400);
});

test('dual channel presentation: mismatch 401, agreement or single channel ok', async () => {
    assert.equal(extractPresentedCredential({
        authorization: 'Bearer token-a', 'x-agent-gateway-key': 'token-b'
    }).conflict, true);
    assert.deepEqual(extractPresentedCredential({
        authorization: 'Bearer tok', 'x-agent-gateway-key': 'tok'
    }), { conflict: false, token: 'tok', source: 'both' });
    assert.equal(extractPresentedCredential({ authorization: 'Bearer only' }).source, 'authorization-bearer');

    const failures = [];
    const builder = makeBuilder({
        auditLogger: { logGatewayOperation: (event, payload) => failures.push({ event, payload }) }
    });
    const result = await builder.buildGatewayRequestContext({
        headers: { authorization: 'Bearer token-bound', 'x-agent-gateway-key': 'token-admin' },
        targetCandidates: {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGW_ERROR_CODES.UNAUTHORIZED);
    // 审计签名 (event, payload)：event 为字符串，最终产出 gateway.auth.failure
    assert.equal(failures[0].event, 'auth.failure');
    assert.equal(failures[0].payload.category, 'dual-channel-mismatch');
});

test('client body identity fields are discarded, not merged into the context', async () => {
    const builder = makeBuilder();
    const result = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'),
        targetCandidates: {},
        requestContext: {
            requestId: 'req-1',
            credentialId: 'spoofed',
            effectiveAgentId: 'spoofed-agent',
            credentialSubject: 'spoofed-subject'
        },
        authContext: { boundAgentId: 'spoofed-bound' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.requestContext.requestId, 'req-1');
    assert.equal(result.requestContext.credentialId, 'cred-bound');
    assert.equal(result.requestContext.effectiveAgentId, 'MCPMidas');
    assert.equal(result.requestContext.agentId, 'MCPMidas');
    assert.equal(result.authContext.boundAgentId, 'MCPMidas');
    assert.equal(result.authContext.credentialSubject, 'cred-bound');
});

test('authorizeTarget: two-layer authorization with serial intersection semantics', async () => {
    const builder = makeBuilder();
    const readOnly = await builder.buildGatewayRequestContext({
        headers: headersFor('token-readonly-bound'), targetCandidates: {}
    });
    const execOnly = await builder.buildGatewayRequestContext({
        headers: headersFor('token-exec-bound'), targetCandidates: {}
    });
    const admin = await builder.buildGatewayRequestContext({
        headers: headersFor('token-admin'), targetCandidates: { path: 'X' }
    });

    // gateway:read 与 gateway:execute 互不蕴含
    assert.equal(builder.authorizeTarget(readOnly, { credentialAction: 'read' }).ok, true);
    assert.equal(builder.authorizeTarget(readOnly, { credentialAction: 'execute' }).code, AGW_ERROR_CODES.FORBIDDEN);
    assert.equal(builder.authorizeTarget(execOnly, { credentialAction: 'execute' }).ok, true);
    assert.equal(builder.authorizeTarget(execOnly, { credentialAction: 'read' }).code, AGW_ERROR_CODES.FORBIDDEN);
    // admin 蕴含两者
    assert.equal(builder.authorizeTarget(admin, { credentialAction: 'read' }).ok, true);
    assert.equal(builder.authorizeTarget(admin, { credentialAction: 'execute' }).ok, true);
    // authenticated 只要求有效 credential
    assert.equal(builder.authorizeTarget(execOnly, { credentialAction: 'authenticated' }).ok, true);

    // agent 策略层拒绝 → 整体拒绝（串联交集）
    const policyDenied = builder.authorizeTarget(readOnly, {
        credentialAction: 'read',
        agentPolicyCheck: () => ({ ok: false, reason: 'diary not allowed' })
    });
    assert.equal(policyDenied.ok, false);
    assert.equal(policyDenied.code, AGW_ERROR_CODES.FORBIDDEN);

    // 未知 action 是实现错误
    assert.equal(builder.authorizeTarget(readOnly, { credentialAction: 'write' }).code, AGW_ERROR_CODES.INTERNAL_ERROR);
});

test('auth failure rate limit: failures counted per IP, 429 with Retry-After, success unaffected', async () => {
    let clock = 1_000_000;
    const metricsEvents = [];
    const builder = makeBuilder({
        authFailureLimit: 3,
        authFailureWindowMs: 60_000,
        now: () => clock,
        metrics: { recordAuthFailure: (event) => metricsEvents.push(event) }
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await builder.buildGatewayRequestContext({
            headers: headersFor('bad-token'), clientIp: '10.0.0.1', targetCandidates: {}
        });
        assert.equal(result.code, AGW_ERROR_CODES.UNAUTHORIZED);
    }
    const limited = await builder.buildGatewayRequestContext({
        headers: headersFor('bad-token'), clientIp: '10.0.0.1', targetCandidates: {}
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.code, AGW_ERROR_CODES.RATE_LIMITED);
    assert.equal(limited.httpStatus, 429);
    assert.ok(limited.retryAfterMs > 0);
    assert.equal(metricsEvents.length, 3);

    // 其他 IP 与正常流量不受影响
    const otherIp = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'), clientIp: '10.0.0.2', targetCandidates: {}
    });
    assert.equal(otherIp.ok, true);

    // 窗口滑出后恢复
    clock += 61_000;
    const recovered = await builder.buildGatewayRequestContext({
        headers: headersFor('token-bound'), clientIp: '10.0.0.1', targetCandidates: {}
    });
    assert.equal(recovered.ok, true);
});

test('security snapshot unavailable propagates AGW_CONFIG_UNAVAILABLE with 503, not 401', async () => {
    const builder = makeBuilder();
    const result = await builder.buildGatewayRequestContext({
        headers: headersFor('config-broken'), targetCandidates: {}
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, AGW_ERROR_CODES.CONFIG_UNAVAILABLE);
    assert.equal(result.httpStatus, 503);
});

test('AGW_UNAUTHORIZED maps to MCP_UNAUTHORIZED (§3.7)', () => {
    assert.equal(MCP_ERROR_CODES.UNAUTHORIZED, 'MCP_UNAUTHORIZED');
    assert.equal(
        mapGatewayFailureToMcpErrorCode(AGW_ERROR_CODES.UNAUTHORIZED),
        MCP_ERROR_CODES.UNAUTHORIZED
    );
});

test('builtin credential hook takes precedence and follows the same resolution tree', async () => {
    const builder = makeBuilder({
        resolveBuiltinCredential: async ({ token }) => {
            if (token !== 'legacy-key-token') {
                return { matched: false };
            }
            return {
                matched: true,
                result: {
                    ok: true,
                    record: { credentialId: 'legacy-gateway-key', boundAgentId: null, scopes: ['admin'], status: 'active' },
                    credentialId: 'legacy-gateway-key',
                    credentialSubject: 'legacy-gateway-key',
                    credentialRevision: 'rev-legacy'
                }
            };
        }
    });
    const result = await builder.buildGatewayRequestContext({
        headers: headersFor('legacy-key-token'), targetCandidates: { path: 'AnyAgent' }
    });
    assert.equal(result.ok, true);
    assert.equal(result.credentialId, 'legacy-gateway-key');
    assert.equal(result.effectiveAgentId, 'AnyAgent');
});
