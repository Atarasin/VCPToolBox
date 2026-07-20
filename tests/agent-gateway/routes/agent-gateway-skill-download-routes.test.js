'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');

/**
 * L3 签名下载 endpoint 的 route 级验收（§8「L3」行 / §6）：
 * - mint 需 credential（gateway:read）且 mint 时校验 format；
 * - redeem 是 signedDownloadUrl surface：裸签名 URL（无 credential、无
 *   cookie）可达且成功；
 * - no-store 全套响应头（成功与错误）；HEAD/Range 拒绝且不消费 nonce；
 * - 缓存重放（同 URL 二次请求）403；
 * - artifact 绑定：guidance revision 变化后旧 token 410。
 */

const GATEWAY_KEY = 'route-test-gateway-key-0123456789';
const SIGNING_KEYS = JSON.stringify([
    { kid: 'k1', secret: Buffer.alloc(32, 0x11).toString('base64') }
]);

function createAgentManager(agentDir, mappings) {
    const agentMap = new Map(Object.entries(mappings));
    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            const sourceFile = agentMap.get(alias);
            return fs.readFile(path.join(agentDir, sourceFile), 'utf8');
        },
        async getAllAgentFiles() {
            return { files: Array.from(agentMap.values()), folderStructure: {} };
        }
    };
}

async function createDownloadTestServer() {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-skill-dl-'));
    const agentDir = path.join(workDir, 'agents');
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, 'Ariadne.md'), 'You are Ariadne.', 'utf8');
    const guidancePath = path.join(workDir, 'agent_guidance.json');
    await fs.writeFile(guidancePath, JSON.stringify({
        version: 1,
        shared: {
            workflow: ['先调用 gateway_recall_run。'],
            memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥和敏感数据'] }
        },
        agents: { Ariadne: { displayName: '阿里阿德涅' } }
    }, null, 2), 'utf8');
    const nonceDir = path.join(workDir, 'nonces');

    const env = {
        AGENT_GATEWAY_GUIDANCE_CONFIG_PATH: guidancePath,
        AGENT_GATEWAY_PUBLIC_BASE_URL: 'https://vcp.example.com',
        AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE: undefined,
        AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET: SIGNING_KEYS,
        AGENT_GATEWAY_DOWNLOAD_NONCE_DIR: nonceDir,
        AGENT_GATEWAY_KEY: GATEWAY_KEY,
        AGENT_GATEWAY_LEGACY_KEY_DISABLED: undefined
    };
    const savedEnv = {};
    for (const [key, value] of Object.entries(env)) {
        savedEnv[key] = process.env[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, { Ariadne: 'Ariadne.md' })
    });
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));
    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        guidancePath,
        nonceDir,
        async close() {
            await new Promise((resolve) => server.close(resolve));
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
            await fs.rm(workDir, { recursive: true, force: true });
        }
    };
}

function assertRedeemHeaders(response) {
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(response.headers.get('surrogate-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache');
    assert.equal(response.headers.get('expires'), '0');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('content-disposition'), 'attachment');
}

async function mintDownloadUrl(server, { format = 'claude' } = {}) {
    const response = await fetch(
        `${server.baseUrl}/agent_gateway/agents/Ariadne/integration/skill/download-url?format=${format}`,
        { headers: { 'x-agent-gateway-key': GATEWAY_KEY } }
    );
    return { response, payload: await response.json() };
}

function toLocalUrl(server, downloadUrl) {
    // mint 以 AGENT_GATEWAY_PUBLIC_BASE_URL 拼 URL；测试回指本地端口
    return downloadUrl.replace('https://vcp.example.com', server.baseUrl);
}

test('mint requires a credential and validates format; redeem works on the bare signed URL exactly once', async () => {
    const server = await createDownloadTestServer();
    try {
        // 无 credential 的 mint → 401
        const unauthenticated = await fetch(`${server.baseUrl}/agent_gateway/agents/Ariadne/integration/skill/download-url?format=claude`);
        assert.equal(unauthenticated.status, 401);

        // 非法 format 在 mint 即拒绝（不签发必然烧 nonce 的 token）
        const badFormat = await mintDownloadUrl(server, { format: 'evil' });
        assert.equal(badFormat.response.status, 400);

        const { response, payload } = await mintDownloadUrl(server);
        assert.equal(response.status, 200);
        // mint 是认证响应：no-store + Vary 身份通道（§6 / M2.S2.T4 约定）
        assert.equal(response.headers.get('cache-control'), 'private, no-store');
        const vary = String(response.headers.get('vary') || '').toLowerCase();
        for (const channel of ['authorization', 'x-agent-gateway-key', 'cookie']) {
            assert.ok(vary.includes(channel), `Vary must include ${channel}`);
        }
        assert.match(payload.data.artifactId, /^skill:Ariadne:claude:sha256:[0-9a-f]{64}$/);
        assert.ok(payload.data.downloadUrl.startsWith('https://vcp.example.com/agent_gateway/agents/Ariadne/integration/skill/download?token='));

        // redeem：裸签名 URL，无任何 credential / cookie
        const redeemUrl = toLocalUrl(server, payload.data.downloadUrl);
        const redeemed = await fetch(redeemUrl);
        assert.equal(redeemed.status, 200);
        assertRedeemHeaders(redeemed);
        const artifact = await redeemed.json();
        assert.equal(artifact.artifactId, payload.data.artifactId);
        assert.ok(artifact.files.some((file) => file.path === 'SKILL.md'));
        assert.ok(artifact.files.some((file) => file.path === 'manifest.json'));
        assert.equal(artifact.manifest.format, 'claude');

        // 缓存重放 / 二次兑换：nonce 已消费 → 403，错误响应同样 no-store
        const replayed = await fetch(redeemUrl);
        assert.equal(replayed.status, 403);
        assertRedeemHeaders(replayed);
    } finally {
        await server.close();
    }
});

test('redeem rejects HEAD and Range without consuming the nonce; tampered token 401', async () => {
    const server = await createDownloadTestServer();
    try {
        const { payload } = await mintDownloadUrl(server);
        const redeemUrl = toLocalUrl(server, payload.data.downloadUrl);

        const head = await fetch(redeemUrl, { method: 'HEAD' });
        assert.equal(head.status, 405);

        const ranged = await fetch(redeemUrl, { headers: { Range: 'bytes=0-10' } });
        assert.equal(ranged.status, 400);
        assertRedeemHeaders(ranged);

        const tampered = await fetch(`${redeemUrl.slice(0, -4)}XXXX`);
        assert.equal(tampered.status, 401);
        assertRedeemHeaders(tampered);

        // HEAD/Range/篡改都不得消费 nonce：完整 GET 仍成功
        const redeemed = await fetch(redeemUrl);
        assert.equal(redeemed.status, 200);
    } finally {
        await server.close();
    }
});

test('signed token is bound to the minted artifact: guidance revision drift redeems 410 without consuming nonce', async () => {
    const server = await createDownloadTestServer();
    try {
        const { payload } = await mintDownloadUrl(server);
        const redeemUrl = toLocalUrl(server, payload.data.downloadUrl);

        // guidance 内容变化 → 冻结 snapshot revision 变化 → 旧 token 指向的
        // artifact 不复存在
        const config = JSON.parse(await fs.readFile(server.guidancePath, 'utf8'));
        config.shared.workflow = ['先调用 gateway_recall_run。', '新增步骤。'];
        await fs.writeFile(server.guidancePath, JSON.stringify(config, null, 2), 'utf8');

        const gone = await fetch(redeemUrl);
        assert.equal(gone.status, 410);
        assertRedeemHeaders(gone);

        // 未消费 nonce：恢复原 guidance 后同一 token 仍可成功兑换
        config.shared.workflow = ['先调用 gateway_recall_run。'];
        await fs.writeFile(server.guidancePath, JSON.stringify(config, null, 2), 'utf8');
        const redeemed = await fetch(redeemUrl);
        assert.equal(redeemed.status, 200);
        const artifact = await redeemed.json();
        assert.equal(artifact.artifactId, payload.data.artifactId);
    } finally {
        await server.close();
    }
});

test('nonce consumption is shared and survives across server instances (file backend)', async () => {
    const server = await createDownloadTestServer();
    let redeemPath = '';
    let nonceDir = '';
    try {
        const { payload } = await mintDownloadUrl(server);
        const redeemUrl = toLocalUrl(server, payload.data.downloadUrl);
        redeemPath = new URL(redeemUrl).pathname + new URL(redeemUrl).search;
        nonceDir = server.nonceDir;
        const redeemed = await fetch(redeemUrl);
        assert.equal(redeemed.status, 200);
        // nonce 消费落盘（跨重启持久）
        assert.ok(fsSync.readdirSync(nonceDir).some((entry) => entry.endsWith('.nonce')));
    } finally {
        await server.close();
    }
});
