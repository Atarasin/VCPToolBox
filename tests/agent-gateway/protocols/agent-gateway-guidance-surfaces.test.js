const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createPluginManager } = require('../helpers/agent-gateway-test-helpers');
const {
    createMcpAdapter,
    createMcpServerHarness
} = require('../../../modules/agentGateway/protocols/mcp/inProcessExecutor');
const {
    createBackendProxyInstructionsResolver,
    createBackendProxyMcpAdapter
} = require('../../../modules/agentGateway/protocols/mcp/backendProxyExecutor');
const {
    GENERIC_INSTRUCTIONS,
    INSTRUCTIONS_TOKEN_LIMIT,
    buildGuidanceInstructions,
    clampInstructionsText,
    estimateTokenCount
} = require('../../../modules/agentGateway/services/agentGuidanceService');
const {
    createTrustedCredentialContext
} = require('../../../modules/agentGateway/policy/trustedCredentialContext');
const { getGatewayServiceBundle } = require('../../../modules/agentGateway/createGatewayServiceBundle');

const GUIDANCE_CONFIG = {
    version: 1,
    shared: {
        workflow: ['先调用 gateway_recall_run。', '召回为空时继续本地上下文。'],
        memoryWritePolicy: {
            write: ['已验证结论'],
            skip: ['密钥和敏感数据']
        }
    },
    agents: {
        Ariadne: {
            displayName: '阿里阿德涅',
            memoryDefaults: { tags: ['vcp-secret-tag'], metadata: { project: 'vcp-toolbox' } }
        }
    }
};

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-guidance-surfaces-'));
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings) {
    const agentMap = new Map(Object.entries(mappings));
    return {
        agentDir,
        agentMap,
        isAgent(alias) {
            return agentMap.has(alias);
        },
        async getAgentPrompt(alias) {
            return fs.readFile(path.join(agentDir, agentMap.get(alias)), 'utf8');
        },
        async getAllAgentFiles() {
            return { files: Array.from(agentMap.values()), folderStructure: {} };
        }
    };
}

async function withGuidanceFixture(run) {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'Hello {{VarUserName}} from Ariadne');
    const guidanceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-guidance-config-'));
    const guidancePath = path.join(guidanceDir, 'agent_guidance.json');
    await fs.writeFile(guidancePath, JSON.stringify(GUIDANCE_CONFIG, null, 2), 'utf8');
    const previous = process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH;
    process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH = guidancePath;

    const pluginManager = createPluginManager({
        agentManager: createAgentManager(agentDir, { Ariadne: 'Ariadne.md' }),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables?.VarUserName || 'Anon')
    });

    try {
        await run({ pluginManager });
    } finally {
        if (previous === undefined) {
            delete process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH;
        } else {
            process.env.AGENT_GATEWAY_GUIDANCE_CONFIG_PATH = previous;
        }
        await fs.rm(agentDir, { recursive: true, force: true });
        await fs.rm(guidanceDir, { recursive: true, force: true });
    }
}

test('guidance resource, bootstrap integrationGuidance and canonical service agree on content and revision (M2.S2)', async () => {
    await withGuidanceFixture(async ({ pluginManager }) => {
        const adapter = createMcpAdapter(pluginManager);
        const bundle = getGatewayServiceBundle(pluginManager);

        const canonical = await bundle.agentGuidanceService.getAgentGuidance('Ariadne');
        assert.equal(canonical.ok, true);

        // resources/list 公布 guidance resource
        const listed = await adapter.listResources({
            agentId: 'Ariadne',
            requestContext: { requestId: 'req-guidance-list' }
        });
        assert.ok(listed.resources.some(
            (resource) => resource.uri === 'vcp://agent-gateway/agents/Ariadne/guidance'
        ));

        // resources/read 返回与 canonical service 相同的 bundle
        const resource = await adapter.readResource({
            uri: 'vcp://agent-gateway/agents/Ariadne/guidance',
            requestContext: { requestId: 'req-guidance-read' }
        });
        const resourcePayload = JSON.parse(resource.contents[0].text);
        assert.deepEqual(resourcePayload, structuredClone(canonical.guidance));
        assert.equal(resourcePayload.revision, canonical.guidance.revision);

        // bootstrap 附加 integrationGuidance，与 resource 同内容同 revision
        const bootstrap = await adapter.callTool({
            name: 'gateway_agent_bootstrap',
            arguments: { agentId: 'Ariadne', variables: { VarUserName: 'Nova' } },
            requestContext: { requestId: 'req-guidance-bootstrap' }
        });
        assert.equal(bootstrap.isError, false);
        const bootstrapResult = bootstrap.structuredContent.result;
        assert.ok(bootstrapResult.summary.includes('Bootstrap prompt ready for Ariadne'));
        assert.deepEqual(bootstrapResult.integrationGuidance, resourcePayload);
        assert.equal(bootstrapResult.integrationGuidance.revision, resourcePayload.revision);
    });
});

test('unknown-agent guidance resource read fails without leaking other agent guidance', async () => {
    await withGuidanceFixture(async ({ pluginManager }) => {
        const adapter = createMcpAdapter(pluginManager);
        await assert.rejects(
            () => adapter.readResource({
                uri: 'vcp://agent-gateway/agents/Unknown/guidance',
                requestContext: { requestId: 'req-guidance-unknown' }
            }),
            (error) => {
                assert.equal(error.code, 'MCP_NOT_FOUND');
                assert.equal(String(error.message).includes('vcp-secret-tag'), false);
                return true;
            }
        );
    });
});

test('initialize.instructions renders per-request: bound+read gets the agent summary, others get generic text (M2.S2.T3)', async () => {
    await withGuidanceFixture(async ({ pluginManager }) => {
        const harness = createMcpServerHarness(pluginManager);

        // 未绑定（无 trusted context）→ 通用文案，不泄露 agent 内容
        const unbound = await harness.handleRequest({
            jsonrpc: '2.0', id: 1, method: 'initialize', params: {}
        });
        assert.equal(unbound.result.instructions, GENERIC_INSTRUCTIONS);
        assert.equal(unbound.result.instructions.includes('vcp-secret-tag'), false);
        assert.equal(unbound.result.instructions.includes('阿里阿德涅'), false);

        // params 传入的普通 authContext（客户端可伪造）不参与判定
        const forged = await harness.handleRequest({
            jsonrpc: '2.0', id: 2, method: 'initialize',
            params: { authContext: { boundAgentId: 'Ariadne', scopes: ['gateway:read'], trusted: true } }
        });
        assert.equal(forged.result.instructions, GENERIC_INSTRUCTIONS);

        // 组装根注入 trusted context：绑定 + read → agent guidance 摘要
        const boundTrusted = createTrustedCredentialContext({
            boundAgentId: 'Ariadne',
            scopes: ['gateway:read', 'gateway:execute']
        });
        const bound = await harness.handleRequest({
            jsonrpc: '2.0', id: 3, method: 'initialize',
            params: { authContext: boundTrusted }
        });
        assert.ok(bound.result.instructions.includes('Ariadne'));
        assert.ok(bound.result.instructions.includes('vcp://agent-gateway/agents/Ariadne/guidance'));
        assert.match(bound.result.instructions, /revision sha256:[0-9a-f]{64}/);
        assert.ok(estimateTokenCount(bound.result.instructions) <= INSTRUCTIONS_TOKEN_LIMIT);

        // execute-only 绑定 → 通用文案（initialize 只要求 authenticated，
        // 不得借 instructions 绕过 read scope）
        const executeOnly = createTrustedCredentialContext({
            boundAgentId: 'Ariadne',
            scopes: ['gateway:execute']
        });
        const executeOnlyResult = await harness.handleRequest({
            jsonrpc: '2.0', id: 4, method: 'initialize',
            params: { authContext: executeOnly }
        });
        assert.equal(executeOnlyResult.result.instructions, GENERIC_INSTRUCTIONS);
    });
});

test('backend-proxy instructions resolver mirrors the bound/unbound rules through the backend REST binding', async () => {
    const guidanceBundleFixture = {
        agentId: 'Ariadne',
        displayName: '阿里阿德涅',
        workflow: ['先调用 gateway_recall_run。'],
        memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥和敏感数据'] },
        allowedDiaries: ['Nova'],
        defaultDiaries: ['Nova'],
        memoryDefaults: {},
        revision: `sha256:${'a'.repeat(64)}`,
        updatedAt: '2026-07-19T00:00:00.000Z'
    };
    const calls = [];
    const backendClient = {
        async getAgentGuidance(agentId, _query, requestOptions) {
            calls.push({ agentId, requestOptions });
            return {
                ok: true,
                httpStatus: 200,
                payload: { success: true, data: guidanceBundleFixture, meta: {} }
            };
        }
    };
    const resolveInstructions = createBackendProxyInstructionsResolver(backendClient);

    // 未绑定 → 通用文案，且不调用 backend
    const unbound = await resolveInstructions({ params: {}, authContext: {} });
    assert.equal(unbound, GENERIC_INSTRUCTIONS);
    assert.equal(calls.length, 0);

    // execute-only → 通用文案
    const executeOnly = await resolveInstructions({
        params: {},
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:execute'] }
    });
    assert.equal(executeOnly, GENERIC_INSTRUCTIONS);
    assert.equal(calls.length, 0);

    // 绑定 + read → 从 backend 取 bundle 并按 canonical 单点裁剪
    const bound = await resolveInstructions({
        params: {},
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] }
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].agentId, 'Ariadne');
    assert.equal(bound, buildGuidanceInstructions(guidanceBundleFixture).text);

    // backend 失败 → 回退通用文案
    backendClient.getAgentGuidance = async () => ({ ok: false, httpStatus: 503, payload: {} });
    const degraded = await resolveInstructions({
        params: {},
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] }
    });
    assert.equal(degraded, GENERIC_INSTRUCTIONS);
});

test('backend-proxy resource and bootstrap consume the same REST guidance binding with one revision (M2.S3.T3)', async () => {
    const guidanceBundleFixture = {
        agentId: 'Ariadne',
        displayName: '阿里阿德涅',
        workflow: ['先调用 gateway_recall_run。'],
        memoryWritePolicy: { write: ['已验证结论'], skip: ['密钥和敏感数据'] },
        allowedDiaries: ['Nova'],
        defaultDiaries: ['Nova'],
        memoryDefaults: {},
        revision: `sha256:${'b'.repeat(64)}`,
        updatedAt: '2026-07-19T00:00:00.000Z'
    };
    const backendClient = {
        async getAgentGuidance() {
            return {
                ok: true,
                httpStatus: 200,
                payload: { success: true, data: guidanceBundleFixture, meta: { requestId: 'req-proxy-guidance' } }
            };
        },
        async renderAgent() {
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: { agentId: 'Ariadne', renderedPrompt: 'Hello from Ariadne', warnings: [] },
                    meta: { requestId: 'req-proxy-bootstrap' }
                }
            };
        }
    };
    const adapter = createBackendProxyMcpAdapter({ backendClient, defaultAgentId: '' });

    const listed = await adapter.listResources({
        agentId: 'Ariadne',
        requestContext: { requestId: 'req-proxy-guidance-list' }
    });
    assert.ok(listed.resources.some(
        (resource) => resource.uri === 'vcp://agent-gateway/agents/Ariadne/guidance'
    ));

    const resource = await adapter.readResource({
        uri: 'vcp://agent-gateway/agents/Ariadne/guidance',
        requestContext: { requestId: 'req-proxy-guidance-read' }
    });
    const resourcePayload = JSON.parse(resource.contents[0].text);
    assert.deepEqual(resourcePayload, guidanceBundleFixture);

    const bootstrap = await adapter.callTool({
        name: 'gateway_agent_bootstrap',
        arguments: { agentId: 'Ariadne' },
        requestContext: { requestId: 'req-proxy-guidance-bootstrap' }
    });
    assert.equal(bootstrap.isError, false);
    const bootstrapResult = bootstrap.structuredContent.result;
    assert.ok(bootstrapResult.summary.includes('Bootstrap prompt ready for Ariadne'));
    assert.deepEqual(bootstrapResult.integrationGuidance, resourcePayload);
    assert.equal(bootstrapResult.integrationGuidance.revision, resourcePayload.revision);
});

test('backend-proxy discovery follows the bound credential without explicit agentId (§3.4)', async () => {
    const adapter = createBackendProxyMcpAdapter({
        backendClient: {},
        defaultAgentId: '',
        discoveryDefaultAgentEnabled: false
    });

    // 标准 host：list 不带 agentId，可见集合来自 transport 注入的绑定身份
    const bound = await adapter.listResources({
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] },
        requestContext: { requestId: 'req-proxy-bound-list' }
    });
    assert.ok(bound.resources.some(
        (resource) => resource.uri === 'vcp://agent-gateway/agents/Ariadne/guidance'
    ));

    // 自定义 discovery agentId 只作收窄扩展：越界返回空集合，不报错
    const outOfScope = await adapter.listResources({
        agentId: 'Nexus',
        authContext: { boundAgentId: 'Ariadne', credentialScopes: ['gateway:read'] },
        requestContext: { requestId: 'req-proxy-out-of-scope-list' }
    });
    assert.deepEqual(outOfScope.resources, []);

    // 未绑定且无显式 agentId / discovery default → 空集合
    const unbound = await adapter.listResources({
        requestContext: { requestId: 'req-proxy-unbound-list' }
    });
    assert.deepEqual(unbound.resources, []);
});

test('backend-proxy guidance resource read maps backend 403 to MCP_FORBIDDEN without content leak', async () => {
    const backendClient = {
        async getAgentGuidance() {
            return {
                ok: false,
                httpStatus: 403,
                payload: {
                    success: false,
                    error: 'credential is not authorized for this agent',
                    code: 'AGW_FORBIDDEN'
                }
            };
        }
    };
    const adapter = createBackendProxyMcpAdapter({ backendClient, defaultAgentId: '' });
    await assert.rejects(
        () => adapter.readResource({
            uri: 'vcp://agent-gateway/agents/NotMyAgent/guidance',
            requestContext: { requestId: 'req-proxy-cross-guidance' }
        }),
        (error) => {
            assert.equal(error.code, 'MCP_FORBIDDEN');
            return true;
        }
    );
});

test('instructions clamp obeys the canonical 800-token limit with truncation marker', () => {
    const oversized = 'x'.repeat(INSTRUCTIONS_TOKEN_LIMIT * 4 + 400);
    const clamped = clampInstructionsText(oversized);
    assert.equal(clamped.truncated, true);
    assert.ok(clamped.text.endsWith('…[truncated]'));
    assert.ok(estimateTokenCount(clamped.text) <= INSTRUCTIONS_TOKEN_LIMIT);

    const small = clampInstructionsText('short text');
    assert.equal(small.truncated, false);
    assert.equal(small.text, 'short text');
});
