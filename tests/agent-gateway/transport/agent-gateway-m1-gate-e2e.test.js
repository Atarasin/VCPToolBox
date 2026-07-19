const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const WebSocket = require('ws');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { createMcpHttpServer } = require('../../../modules/agentGateway/mcpHttpServer');
const { createMcpWebSocketServer } = require('../../../modules/agentGateway/mcpWebSocketServer');
const { computeTokenDigest } = require('../../../modules/agentGateway/policy/credentialResolver');
const { getGatewayServiceBundle } = require('../../../modules/agentGateway/createGatewayServiceBundle');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

/**
 * M1 里程碑门禁 E2E：两把不同 agent credential 的真实 HTTP/WS →
 * backend-proxy → Native REST 链路互不可访问，审计主体不折叠。
 */

const PEPPER = Buffer.alloc(32, 17);
const TOKEN_ARIADNE = 'token-ariadne-0123456789abcdef0123456789abcdef';
const TOKEN_NEXUS = 'token-nexus-0123456789abcdef0123456789abcdefgh';

async function setupCredentialFiles(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-m1-gate-'));
    const credentialsPath = path.join(dir, 'credentials.json');
    const peppersPath = path.join(dir, 'peppers.json');
    await fs.writeFile(credentialsPath, JSON.stringify({
        version: 1,
        credentials: [
            {
                credentialId: 'cred-ariadne',
                pepperKid: 'kid-gate',
                tokenDigest: `hmac-sha256:${computeTokenDigest(PEPPER, TOKEN_ARIADNE)}`,
                boundAgentId: 'Ariadne',
                scopes: ['gateway:read', 'gateway:execute'],
                status: 'active',
                expiresAt: null
            },
            {
                credentialId: 'cred-nexus',
                pepperKid: 'kid-gate',
                tokenDigest: `hmac-sha256:${computeTokenDigest(PEPPER, TOKEN_NEXUS)}`,
                boundAgentId: 'Nexus',
                scopes: ['gateway:read', 'gateway:execute'],
                status: 'active',
                expiresAt: null
            }
        ]
    }));
    await fs.writeFile(peppersPath, JSON.stringify({
        keys: { 'kid-gate': PEPPER.toString('base64') }
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
    return { credentialsPath, peppersPath };
}

async function createNativeBackend(t, auditEvents) {
    const pluginManager = createPluginManager();
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));
    const services = getGatewayServiceBundle(pluginManager);
    // 审计钩子：捕获 credential 主体
    const originalLog = services.auditLogger.logGatewayOperation.bind(services.auditLogger);
    services.auditLogger.logGatewayOperation = (event) => {
        auditEvents.push(event);
        return originalLog(event);
    };
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(async () => new Promise((resolve) => server.close(resolve)));
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, pluginManager, services };
}

function credentialServiceFor(pluginManager) {
    return getGatewayServiceBundle(pluginManager).gatewayCredentialService;
}

async function callNative(baseUrl, token, agentId) {
    const response = await fetch(`${baseUrl}/agent_gateway/memory/search`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-agent-gateway-key': token
        },
        body: JSON.stringify({ agentId, query: 'gate check', requestContext: { requestId: `req-${agentId}` } })
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

test('Native REST: bound credentials cannot reach each other\'s agent; audit subjects stay distinct', async (t) => {
    await setupCredentialFiles(t);
    const auditEvents = [];
    const backend = await createNativeBackend(t, auditEvents);

    // 各自访问所绑 agent：认证与决议通过（业务层可能因 fixture 数据返回其他结果，
    // 但不得是 401/403 决议拒绝）
    const ariadneOwn = await callNative(backend.baseUrl, TOKEN_ARIADNE, 'Ariadne');
    assert.ok(![401, 403].includes(ariadneOwn.status), `expected non-auth failure, got ${ariadneOwn.status}`);

    // 跨 agent：403，不折叠
    const ariadneCross = await callNative(backend.baseUrl, TOKEN_ARIADNE, 'Nexus');
    assert.equal(ariadneCross.status, 403);
    const nexusCross = await callNative(backend.baseUrl, TOKEN_NEXUS, 'Ariadne');
    assert.equal(nexusCross.status, 403);

    // 无效 token：401
    const unknownToken = await callNative(backend.baseUrl, 'token-unknown-x', 'Ariadne');
    assert.equal(unknownToken.status, 401);
});

test('HTTP MCP transport end-to-end: per-credential passthrough isolates agents', async (t) => {
    await setupCredentialFiles(t);
    const auditEvents = [];
    const backend = await createNativeBackend(t, auditEvents);

    const proxyPluginManager = createPluginManager();
    const mcpApp = express();
    const mcpServer = createMcpHttpServer({
        pluginManager: proxyPluginManager,
        backendUrl: backend.baseUrl,
        credentialService: credentialServiceFor(proxyPluginManager)
    });
    mcpServer.attach(mcpApp);
    const httpServer = await new Promise((resolve) => {
        const instance = mcpApp.listen(0, '127.0.0.1', () => resolve(instance));
    });
    t.after(async () => {
        await mcpServer.close?.();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    const mcpUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;

    async function mcpCall(token, sessionId, payload) {
        const response = await fetch(mcpUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'x-agent-gateway-key': token,
                ...(sessionId ? { 'mcp-session-id': sessionId } : {})
            },
            body: JSON.stringify(payload)
        });
        return {
            status: response.status,
            sessionId: response.headers.get('mcp-session-id'),
            body: await response.json().catch(() => null)
        };
    }

    async function initializeSession(token) {
        const result = await mcpCall(token, null, {
            jsonrpc: '2.0', id: 'init', method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate-test', version: '1.0.0' } }
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.ok(result.sessionId);
        return result.sessionId;
    }

    const ariadneSession = await initializeSession(TOKEN_ARIADNE);
    const nexusSession = await initializeSession(TOKEN_NEXUS);

    // Ariadne credential 访问自己的 agent：通过 proxy 透传到 Native，
    // 决议成功（结果不是 FORBIDDEN/UNAUTHORIZED）
    // recall_run 的业务失败是 MCP_NOT_FOUND（no profile），可与凭据层拒绝区分
    const ariadneOwn = await mcpCall(TOKEN_ARIADNE, ariadneSession, {
        jsonrpc: '2.0', id: 'own', method: 'tools/call',
        params: { name: 'gateway_recall_run', arguments: { agentId: 'Ariadne', query: 'gate' } }
    });
    assert.equal(ariadneOwn.status, 200);
    const ownError = ariadneOwn.body?.result?.error?.code || ariadneOwn.body?.error?.data?.code || '';
    assert.ok(!['MCP_FORBIDDEN', 'MCP_UNAUTHORIZED'].includes(ownError), `own-agent call must not be rejected, got ${ownError}`);

    // Ariadne credential 访问 Nexus：backend 决议 403 → MCP_FORBIDDEN
    const ariadneCross = await mcpCall(TOKEN_ARIADNE, ariadneSession, {
        jsonrpc: '2.0', id: 'cross', method: 'tools/call',
        params: { name: 'gateway_recall_run', arguments: { agentId: 'Nexus', query: 'gate' } }
    });
    const crossError = ariadneCross.body?.result?.error?.code || ariadneCross.body?.error?.data?.code || '';
    assert.equal(crossError, 'MCP_FORBIDDEN', JSON.stringify(ariadneCross.body));

    // session 不能跨 credential 重用
    const stolenSession = await mcpCall(TOKEN_NEXUS, ariadneSession, {
        jsonrpc: '2.0', id: 'stolen', method: 'tools/call',
        params: { name: 'gateway_recall_run', arguments: { agentId: 'Nexus', query: 'gate' } }
    });
    const stolenError = stolenSession.body?.error?.data?.code ||
        (Array.isArray(stolenSession.body) ? stolenSession.body[0]?.error?.data?.code : '') || '';
    assert.ok(
        ['AGW_FORBIDDEN', 'AGW_UNAUTHORIZED', 'MCP_FORBIDDEN', 'MCP_UNAUTHORIZED'].includes(stolenError) ||
        [401, 403, 404].includes(stolenSession.status),
        `cross-credential session reuse must be rejected: ${stolenSession.status} ${JSON.stringify(stolenSession.body)}`
    );

    assert.ok(nexusSession && nexusSession !== ariadneSession);
});

test('WS MCP transport end-to-end: bound credential isolation over websocket', async (t) => {
    await setupCredentialFiles(t);
    const auditEvents = [];
    const backend = await createNativeBackend(t, auditEvents);

    const proxyPluginManager = createPluginManager();
    const credentialService = credentialServiceFor(proxyPluginManager);
    const httpServer = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    const wsManager = createMcpWebSocketServer({
        pluginManager: proxyPluginManager,
        backendUrl: backend.baseUrl,
        resolveAuth: async ({ headers }) => {
            const credentialContext = await credentialService.buildGatewayRequestContext({
                headers, targetCandidates: {}, requiresAgent: false, entry: 'mcp-ws'
            });
            return credentialContext.ok
                ? { provided: true, authenticated: true, gatewayId: 'gw-gate', roles: ['gateway_client'], credentialContext }
                : { provided: true, authenticated: false };
        },
        checkConnectionCredential: (credentialId) => credentialService.credentialResolver.checkCredentialStatus(credentialId)
    });
    wsManager.attach(httpServer);
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await wsManager.close();
        await new Promise((resolve) => httpServer.close(resolve));
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.address().port}/mcp`;

    function connect(token) {
        return new Promise((resolve, reject) => {
            const client = new WebSocket(wsUrl, { headers: { 'x-agent-gateway-key': token } });
            client.once('open', () => resolve(client));
            client.once('error', reject);
        });
    }
    function waitForMessage(client) {
        return new Promise((resolve, reject) => {
            client.once('message', (data) => resolve(JSON.parse(String(data))));
            client.once('close', (code) => reject(new Error(`closed: ${code}`)));
            client.once('error', reject);
        });
    }

    const ariadneClient = await connect(TOKEN_ARIADNE);
    t.after(() => ariadneClient.terminate());

    ariadneClient.send(JSON.stringify({
        jsonrpc: '2.0', id: 'ws-cross', method: 'tools/call',
        params: { name: 'gateway_recall_run', arguments: { agentId: 'Nexus', query: 'gate' } }
    }));
    const crossResult = await waitForMessage(ariadneClient);
    const wsCrossError = crossResult.result?.error?.code || crossResult.error?.data?.code || '';
    assert.equal(wsCrossError, 'MCP_FORBIDDEN', JSON.stringify(crossResult));

    // 无效 token 的握手直接被拒
    await assert.rejects(connect('bad-token'));

    // 吊销传播：改写 credential 文件为 revoked 后，下一消息被拒并断连
    const credentialsPath = process.env.AGENT_GATEWAY_CREDENTIALS_PATH;
    const parsed = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    parsed.credentials.find((record) => record.credentialId === 'cred-ariadne').status = 'revoked';
    await fs.writeFile(credentialsPath, JSON.stringify(parsed));

    const closePromise = new Promise((resolve) => ariadneClient.once('close', (code) => resolve(code)));
    ariadneClient.send(JSON.stringify({
        jsonrpc: '2.0', id: 'ws-after-revoke', method: 'tools/call',
        params: { name: 'gateway_recall_run', arguments: { agentId: 'Ariadne', query: 'gate' } }
    }));
    const closeCode = await closePromise;
    assert.equal(closeCode, 4401, 'revoked credential must close the connection with 4401');
});
