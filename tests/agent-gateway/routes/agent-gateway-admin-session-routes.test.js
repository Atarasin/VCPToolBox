const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

async function createServer({ outerAuthenticated = false, env = {} } = {}) {
    const savedEnv = {};
    for (const [key, value] of Object.entries(env)) {
        savedEnv[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (outerAuthenticated) {
            // 模拟 server.js adminAuth Basic 验证成功后的 outer 标记
            req.agentGatewayAuth = { outerAuthenticated: true };
        }
        next();
    });
    app.use('/agent_gateway', createAgentGatewayRoutes(createPluginManager()));

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    };
}

const BRIDGE_ENV = {
    AGENT_GATEWAY_ADMIN_SESSION_DEV_STORE: 'true',
    AGENT_GATEWAY_ADMIN_SUBJECT_KEY: Buffer.alloc(32, 7).toString('base64'),
    AGENT_GATEWAY_ADMIN_SAME_ORIGIN: 'true',
    AGENT_GATEWAY_ADMIN_ORIGINS: undefined,
    AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED: undefined
};

test('POST /auth/admin-session requires prior adminAuth (pre-credential bridge)', async () => {
    const server = await createServer({ outerAuthenticated: false, env: BRIDGE_ENV });
    try {
        const response = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(response.status, 401);
    } finally {
        await server.close();
    }
});

test('POST/DELETE /auth/admin-session full lifecycle with cookie and CSRF', async () => {
    const server = await createServer({ outerAuthenticated: true, env: BRIDGE_ENV });
    try {
        const created = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(created.status, 201);
        const setCookie = created.headers.get('set-cookie');
        assert.match(setCookie, /agw_admin_session=/);
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Strict/);
        assert.match(setCookie, /Path=\/agent_gateway/);
        const body = await created.json();
        assert.ok(body.data.csrfToken, 'CSRF token returned once in body');
        assert.equal(created.headers.get('cache-control'), 'private, no-store');

        const cookie = setCookie.split(';')[0];

        // DELETE without CSRF → 403
        const noCsrf = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, {
            method: 'DELETE', headers: { cookie }
        });
        assert.equal(noCsrf.status, 403);

        // DELETE with CSRF → revoked
        const revoked = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, {
            method: 'DELETE', headers: { cookie, 'x-agent-gateway-csrf': body.data.csrfToken }
        });
        assert.equal(revoked.status, 200);

        // 再次 DELETE：session 已不存在
        const again = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, {
            method: 'DELETE', headers: { cookie, 'x-agent-gateway-csrf': body.data.csrfToken }
        });
        assert.equal(again.status, 401);
    } finally {
        await server.close();
    }
});

test('POST /auth/admin-session returns 503 without origin policy or production store', async () => {
    const noOrigin = await createServer({
        outerAuthenticated: true,
        env: { ...BRIDGE_ENV, AGENT_GATEWAY_ADMIN_SAME_ORIGIN: undefined }
    });
    try {
        const response = await fetch(`${noOrigin.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(response.status, 503, 'missing origin config must 503, not accept any origin');
    } finally {
        await noOrigin.close();
    }

    const noStore = await createServer({
        outerAuthenticated: true,
        env: { ...BRIDGE_ENV, AGENT_GATEWAY_ADMIN_SESSION_DEV_STORE: undefined }
    });
    try {
        const response = await fetch(`${noStore.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(response.status, 503, 'no production session store must 503');
    } finally {
        await noStore.close();
    }

    const disabled = await createServer({
        outerAuthenticated: true,
        env: { ...BRIDGE_ENV, AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED: 'true' }
    });
    try {
        const response = await fetch(`${disabled.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(response.status, 503, 'admin fallback disabled must reject session creation');
    } finally {
        await disabled.close();
    }
});

test('cookie-authenticated business mutation requires CSRF token and Origin check', async () => {
    const server = await createServer({ outerAuthenticated: true, env: BRIDGE_ENV });
    try {
        const created = await fetch(`${server.baseUrl}/agent_gateway/auth/admin-session`, { method: 'POST' });
        assert.equal(created.status, 201);
        const cookie = created.headers.get('set-cookie').split(';')[0];
        const { data } = await created.json();

        const writeBody = JSON.stringify({
            agentId: 'MCPMidas',
            target: { diary: 'MidasDiary' },
            memory: { text: 'csrf check' }
        });

        // 无 CSRF token 的 cookie mutation → 拒绝（401/403）
        const noCsrf = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie },
            body: writeBody
        });
        assert.ok([401, 403].includes(noCsrf.status),
            `cookie mutation without CSRF must be rejected, got ${noCsrf.status}`);

        // 带 CSRF token → 通过认证层（业务层结果不限定，但不得是 401/403）
        const withCsrf = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie, 'x-agent-gateway-csrf': data.csrfToken },
            body: writeBody
        });
        assert.ok(![401, 403].includes(withCsrf.status),
            `cookie mutation with valid CSRF must pass auth, got ${withCsrf.status}`);

        // same-origin 模式下伪造跨域 Origin → 403
        const badOrigin = await fetch(`${server.baseUrl}/agent_gateway/memory/write`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json', cookie,
                'x-agent-gateway-csrf': data.csrfToken,
                origin: 'https://evil.example'
            },
            body: writeBody
        });
        assert.equal(badOrigin.status, 403, 'cross-origin cookie mutation must be rejected');

        // cookie GET（read 操作）不要求 CSRF
        const read = await fetch(`${server.baseUrl}/agent_gateway/capabilities`, {
            headers: { cookie }
        });
        assert.ok(![401, 403].includes(read.status),
            `cookie read must not require CSRF, got ${read.status}`);
    } finally {
        await server.close();
    }
});

test('unified injection point exposes a single canonical auth object', async () => {
    const server = await createServer({ env: BRIDGE_ENV });
    try {
        // health 路由继续可访问（无凭据时 dedicated auth 未 provided）
        const response = await fetch(`${server.baseUrl}/agent_gateway/health`);
        assert.equal(response.status, 200);
        // 无效 gateway key 仍然 401（保持既有行为）
        const bad = await fetch(`${server.baseUrl}/agent_gateway/health`, {
            headers: { 'x-agent-gateway-key': 'wrong-key' }
        });
        assert.equal(bad.status, 401);
    } finally {
        await server.close();
    }
});
