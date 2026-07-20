const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildCapabilityMatrix,
    createCapabilityPrompt,
    createCodexMcpConfigToml,
    createGuidanceConfig,
    parseArgs,
    parseCapabilityMarkers
} = require('../../../scripts/run-agent-gateway-m2-smoke');

test('parseArgs validates client list and rejects unknown clients', () => {
    assert.deepEqual(parseArgs([]).clients, ['claude', 'codex', 'kimi']);
    assert.deepEqual(parseArgs(['--clients', 'kimi,codex']).clients, ['kimi', 'codex']);
    assert.equal(parseArgs(['--skip-clients']).skipClients, true);
    assert.throws(() => parseArgs(['--clients', 'gemini']), /Unsupported client/);
    assert.throws(() => parseArgs(['--client-timeout-ms', '-5']), /positive integer/);
});

test('createGuidanceConfig publishes the probe agent with marker workflow', () => {
    const config = createGuidanceConfig('Ariadne');
    assert.ok(config.agents.Ariadne);
    assert.ok(config.shared.workflow.some((line) => line.includes('M2-SMOKE-MARKER')));
});

test('createCapabilityPrompt asks for the four marker lines', () => {
    const prompt = createCapabilityPrompt({
        serverName: 'vcp-agent-gateway-m2',
        agentId: 'Ariadne',
        userName: 'M2Smoke'
    });
    for (const marker of ['TOOLS::', 'BOOTSTRAP::', 'RESOURCE::', 'INSTRUCTIONS::']) {
        assert.ok(prompt.includes(marker), `prompt should mention ${marker}`);
    }
    assert.ok(prompt.includes('gateway_agent_bootstrap'));
    assert.ok(prompt.includes('vcp://agent-gateway/agents/Ariadne/guidance'));
});

test('parseCapabilityMarkers extracts marker lines from noisy client output', () => {
    const markers = parseCapabilityMarkers([
        'Some model preamble',
        'TOOLS::gateway_agent_bootstrap,gateway_recall_run',
        'BOOTSTRAP::sha256:abc',
        'RESOURCE_UNSUPPORTED',
        'INSTRUCTIONS::You are connected to the VCP',
        'trailing text'
    ].join('\n'));
    assert.equal(markers.tools, 'gateway_agent_bootstrap,gateway_recall_run');
    assert.equal(markers.bootstrapOk, true);
    assert.equal(markers.bootstrapRevision, 'sha256:abc');
    assert.equal(markers.resourceOk, false);
    assert.equal(markers.resourceUnsupported, true);
    assert.equal(markers.instructionsSeen, true);

    const failed = parseCapabilityMarkers('BOOTSTRAP_FAIL::tool rejected\nINSTRUCTIONS_UNSEEN');
    assert.equal(failed.bootstrapOk, false);
    assert.equal(failed.bootstrapFailReason, 'tool rejected');
    assert.equal(failed.instructionsSeen, false);
});

test('buildCapabilityMatrix cross-checks self-reported markers against observed RPC', () => {
    const revision = 'sha256:abc';
    const matrix = buildCapabilityMatrix([
        {
            client: 'claude',
            version: '2.1',
            markers: {
                instructionsSeen: true,
                instructionsExcerpt: 'You are connected',
                resourceOk: true,
                resourceRevision: revision,
                bootstrapOk: true,
                bootstrapRevision: revision
            },
            rpcMethods: new Set(['initialize', 'resources/read', 'tools/call']),
            toolCallNames: ['gateway_agent_bootstrap']
        },
        {
            client: 'kimi',
            version: '0.27',
            markers: {
                instructionsSeen: false,
                resourceUnsupported: true,
                bootstrapOk: false,
                bootstrapFailReason: 'plain text only'
            },
            rpcMethods: new Set(['initialize', 'tools/call']),
            toolCallNames: ['gateway_agent_bootstrap']
        }
    ], revision);
    assert.match(matrix, /claude .*resources\/read \+ revision 一致.*成功 \+ revision 一致/);
    assert.match(matrix, /kimi .*不支持.*调用发生/);
});

test('createCodexMcpConfigToml emits the streamable HTTP server block', () => {
    const toml = createCodexMcpConfigToml({
        serverName: 'vcp-agent-gateway-m2',
        mcpUrl: 'http://127.0.0.1:9010/mcp',
        token: 'tok"en',
        gatewayId: 'gw-m2'
    });
    assert.match(toml, /\[mcp_servers\.vcp-agent-gateway-m2\]/);
    assert.match(toml, /"x-agent-gateway-key" = "tok\\"en"/);
    assert.match(toml, /"x-agent-gateway-id" = "gw-m2"/);
});
