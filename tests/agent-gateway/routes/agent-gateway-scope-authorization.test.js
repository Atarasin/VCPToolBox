const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { computeTokenDigest } = require('../../../modules/agentGateway/policy/credentialResolver');
const { resolveRestCredentialAction } = require('../../../modules/agentGateway/policy/restCredentialActions');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

/**
 * §3.5 两层授权（M1.S2.T3）：credentialScopes 在真实 REST surface 上生效。
 * read-only credential 对 execute 类 operation（memory.write、tools.invoke、
 * jobs.cancel）必须 403；read 类 operation 决议通过。
 */

const PEPPER = Buffer.alloc(32, 23);
const TOKEN_READONLY = 'token-readonly-0123456789abcdef0123456789abcd';
const TOKEN_FULL = 'token-full-0123456789abcdef0123456789abcdefgh';

async function setupCredentialFiles(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-scope-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const peppersPath = path.join(dir, 'peppers.json');
    await fs.writeFile(credentialsPath, JSON.stringify({
        version: 1,
        credentials: [
            {
                credentialId: 'cred-readonly',
                pepperKid: 'kid-scope',
                tokenDigest: `hmac-sha256:${computeTokenDigest(PEPPER, TOKEN_READONLY)}`,
                boundAgentId: 'Ariadne',
                scopes: ['gateway:read'],
                status: 'active',
                expiresAt: null
            },
            {
                credentialId: 'cred-full',
                pepperKid: 'kid-scope',
                tokenDigest: `hmac-sha256:${computeTokenDigest(PEPPER, TOKEN_FULL)}`,
                boundAgentId: 'Ariadne',
                scopes: ['gateway:read', 'gateway:execute'],
                status: 'active',
                expiresAt: null
            }
        ]
    }));
    await fs.writeFile(peppersPath, JSON.stringify({
        keys: { 'kid-scope': PEPPER.toString('base64') }
    }));

    const savedEnv = {
        AGENT_GATEWAY_CREDENTIALS_PATH: process.env.AGENT_GATEWAY_CREDENTIALS_PATH,
        AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH: process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH
    };
    process.env.AGENT_GATEWAY_CREDENTIALS_PATH = credentialsPath;
    process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH = peppersPath;
    t.after(async () => {
        for (const [key, value] of Object.entries(savedEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(dir, { recursive: true, force: true });
    });
}

async function createServer(t) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(createPluginManager()));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(async () => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
}

function callWrite(baseUrl, token) {
    return fetch(`${baseUrl}/agent_gateway/memory/write`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-gateway-key': token },
        body: JSON.stringify({
            agentId: 'Ariadne',
            target: { diary: 'AriadneDiary' },
            memory: { text: 'scope check' }
        })
    });
}

test('read-only credential is rejected with 403 on execute operations', async (t) => {
    await setupCredentialFiles(t);
    const baseUrl = await createServer(t);

    const writeDenied = await callWrite(baseUrl, TOKEN_READONLY);
    assert.equal(writeDenied.status, 403);
    const body = await writeDenied.json();
    assert.equal(body.code, 'AGW_FORBIDDEN');
    assert.equal(body.details.credentialAction, 'execute');

    const cancelDenied = await fetch(`${baseUrl}/agent_gateway/jobs/job-x/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-gateway-key': TOKEN_READONLY },
        body: JSON.stringify({})
    });
    assert.equal(cancelDenied.status, 403);

    const invokeDenied = await fetch(`${baseUrl}/agent_gateway/tools/some_tool/invoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-gateway-key': TOKEN_READONLY },
        body: JSON.stringify({ agentId: 'Ariadne' })
    });
    assert.equal(invokeDenied.status, 403);
});

test('read-only credential passes scope check on read operations', async (t) => {
    await setupCredentialFiles(t);
    const baseUrl = await createServer(t);

    const search = await fetch(`${baseUrl}/agent_gateway/memory/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-gateway-key': TOKEN_READONLY },
        body: JSON.stringify({ agentId: 'Ariadne', query: 'scope check' })
    });
    assert.ok(![401, 403].includes(search.status),
        `read operation must not be rejected by scope check, got ${search.status}`);
});

test('execute-scoped credential passes scope check on execute operations', async (t) => {
    await setupCredentialFiles(t);
    const baseUrl = await createServer(t);

    const write = await callWrite(baseUrl, TOKEN_FULL);
    assert.ok(![401, 403].includes(write.status),
        `execute credential must pass authorization, got ${write.status}`);
});

test('resolveRestCredentialAction matches catalog paths', () => {
    assert.deepEqual(
        resolveRestCredentialAction('POST', '/memory/write').credentialAction, 'execute');
    assert.deepEqual(
        resolveRestCredentialAction('POST', '/jobs/abc-123/cancel').credentialAction, 'execute');
    assert.deepEqual(
        resolveRestCredentialAction('GET', '/jobs/abc-123').credentialAction, 'read');
    assert.deepEqual(
        resolveRestCredentialAction('POST', '/agents/Ariadne/render').credentialAction, 'read');
    // health/metrics 是 adminAuth 排除项，不参与 credential scope 检查
    assert.equal(resolveRestCredentialAction('GET', '/health').authExclusion, 'adminAuth');
    assert.equal(resolveRestCredentialAction('GET', '/metrics').authExclusion, 'adminAuth');
    // 未登记 path 不匹配（fail-open 到既有 authenticated 语义，由 catalog 校验兜底）
    assert.equal(resolveRestCredentialAction('GET', '/nonexistent').matched, false);
});
