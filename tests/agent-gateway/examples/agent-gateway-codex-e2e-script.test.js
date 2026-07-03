const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    composeCodexConfig,
    createCodexConfigToml,
    createCodexPrompt,
    createRenderPluginManager,
    createTempAgentDir,
    detectCodexAuthFailure,
    evaluateRun,
    parseArgs,
    readRenderTextFromToolCall,
    removeDirectoryIfNeeded,
    resolveCodexAuthHint,
    runDirectGatewayProbe,
    startMcpHttpGateway,
    startNativeBackend,
    stripInheritedMcpSections,
    writeAgentFile
} = require('../../../scripts/run-agent-gateway-codex-e2e');

test('createCodexConfigToml generates an isolated streamable HTTP Codex config', () => {
    const config = createCodexConfigToml({
        serverName: 'vcp-agent-gateway-e2e',
        mcpUrl: 'http://127.0.0.1:9010/mcp',
        gatewayKey: 'gw-secret',
        gatewayId: 'gw-codex'
    });

    assert.match(config, /\[mcp_servers\.vcp-agent-gateway-e2e\]/);
    assert.match(config, /url = "http:\/\/127\.0\.0\.1:9010\/mcp"/);
    assert.match(config, /"x-agent-gateway-key" = "gw-secret"/);
    assert.match(config, /"x-agent-gateway-id" = "gw-codex"/);
    assert.match(config, /enabled_tools = \["gateway_agent_bootstrap"\]/);
});

test('composeCodexConfig preserves existing provider config and appends MCP config', () => {
    const combined = composeCodexConfig(
        'provider = "freemodel"\nmodel = "gpt-5.5"',
        '[mcp_servers.vcp-agent-gateway-e2e]\nurl = "http://127.0.0.1:9010/mcp"'
    );

    assert.match(combined, /provider = "freemodel"/);
    assert.match(combined, /model = "gpt-5.5"/);
    assert.match(combined, /\[mcp_servers\.vcp-agent-gateway-e2e\]/);
    assert.match(combined, /http:\/\/127\.0\.0\.1:9010\/mcp/);
});

test('stripInheritedMcpSections removes inherited MCP server blocks but keeps provider config', () => {
    const stripped = stripInheritedMcpSections([
        'provider = "freemodel"',
        'model = "gpt-5.5"',
        '',
        '[mcp_servers.legacy]',
        'url = "http://127.0.0.1:7000/mcp"',
        '',
        '[mcp_servers.other]',
        'command = "node"',
        '',
        '[profiles.fast]',
        'model = "gpt-5-mini"'
    ].join('\n'));

    assert.match(stripped, /provider = "freemodel"/);
    assert.match(stripped, /model = "gpt-5.5"/);
    assert.doesNotMatch(stripped, /\[mcp_servers\.legacy\]/);
    assert.doesNotMatch(stripped, /\[mcp_servers\.other\]/);
    assert.match(stripped, /\[profiles\.fast\]/);
});

test('createCodexPrompt forces a deterministic bootstrap tool call contract', () => {
    const prompt = createCodexPrompt({
        agentId: 'Ariadne',
        userName: 'CodexE2E'
    });

    assert.match(prompt, /gateway_agent_bootstrap/);
    assert.match(prompt, /"agentId":"Ariadne"/);
    assert.match(prompt, /"VarUserName":"CodexE2E"/);
    assert.match(prompt, /BOOTSTRAP_OK::/);
    assert.match(prompt, /BOOTSTRAP_FAIL::/);
});

test('evaluateRun accepts successful Codex MCP E2E evidence', () => {
    const result = evaluateRun({
        mcpGetResult: {
            code: 0,
            stdout: 'transport: streamable_http\nurl: http://127.0.0.1:9010/mcp\n',
            stderr: ''
        },
        directProbe: {
            ok: true,
            issues: [],
            renderedPrompt: 'You are Ariadne. Hello CodexE2E.'
        },
        execResult: {
            stdout: 'BOOTSTRAP_OK::You are Ariadne. Hello CodexE2E.',
            stderr: ''
        },
        lastMessage: 'BOOTSTRAP_OK::You are Ariadne. Hello CodexE2E.',
        renderHits: 1,
        userName: 'CodexE2E'
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.issues, []);
});

test('evaluateRun reports missing render evidence and malformed final messages', () => {
    const result = evaluateRun({
        mcpGetResult: {
            code: 0,
            stdout: 'url = "http://127.0.0.1:9010/mcp"\n',
            stderr: ''
        },
        directProbe: {
            ok: false,
            issues: ['tools/call returned 500'],
            renderedPrompt: ''
        },
        execResult: {
            stdout: '',
            stderr: ''
        },
        lastMessage: 'BOOTSTRAP_FAIL::tool unavailable',
        renderHits: 0,
        userName: 'CodexE2E'
    });

    assert.equal(result.ok, false);
    assert.equal(result.issues.includes('Direct MCP probe: tools/call returned 500'), true);
    assert.equal(result.issues.includes('Codex did not trigger the backend render route'), true);
    assert.equal(result.issues.includes('Neither Codex exec nor the direct probe produced the expected rendered prompt payload'), true);
});

test('evaluateRun downgrades non-interactive Codex MCP cancellation to a warning when the direct probe passes', () => {
    const result = evaluateRun({
        mcpGetResult: {
            code: 0,
            stdout: 'transport: streamable_http\nurl: http://127.0.0.1:9010/mcp\n',
            stderr: ''
        },
        directProbe: {
            ok: true,
            issues: [],
            renderedPrompt: 'You are Ariadne. Hello CodexE2E.'
        },
        execResult: {
            stdout: 'BOOTSTRAP_FAIL::user cancelled MCP tool call',
            stderr: 'mcp: vcp-agent-gateway-e2e/gateway_agent_bootstrap (failed)\nuser cancelled MCP tool call'
        },
        lastMessage: 'BOOTSTRAP_FAIL::user cancelled MCP tool call',
        renderHits: 1,
        userName: 'CodexE2E'
    });

    assert.equal(result.ok, true);
    assert.equal(result.issues.length, 0);
    assert.equal(
        result.warnings.includes('Codex exec cancelled the MCP tool call in non-interactive mode; direct MCP probe evidence is used for pass/fail.'),
        true
    );
});

test('detectCodexAuthFailure recognizes unauthenticated Codex exec output', () => {
    const detected = detectCodexAuthFailure({
        stdout: '',
        stderr: 'ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses'
    });

    assert.equal(detected, true);
});

test('resolveCodexAuthHint points API key users to OPENAI_API_KEY first', () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test';

    try {
        const hint = resolveCodexAuthHint();
        assert.match(hint, /OPENAI_API_KEY/);
        assert.doesNotMatch(hint, /^Detected Codex authentication failure\. If you use API key auth, export/);
    } finally {
        if (typeof originalApiKey === 'string') {
            process.env.OPENAI_API_KEY = originalApiKey;
        } else {
            delete process.env.OPENAI_API_KEY;
        }
    }
});

test('parseArgs supports explicit Codex E2E overrides', () => {
    const args = parseArgs([
        '--agent-id', 'Nexus',
        '--user-name', 'Nova',
        '--server-name', 'vcp-gateway-e2e-smoke',
        '--codex-bin', '/usr/local/bin/codex',
        '--model', 'gpt-5-codex',
        '--keep-temp'
    ]);

    assert.equal(args.agentId, 'Nexus');
    assert.equal(args.userName, 'Nova');
    assert.equal(args.serverName, 'vcp-gateway-e2e-smoke');
    assert.equal(args.codexBin, '/usr/local/bin/codex');
    assert.equal(args.model, 'gpt-5-codex');
    assert.equal(args.keepTemp, true);
});

test('parseArgs uses the dedicated E2E server name by default', () => {
    const args = parseArgs([]);
    assert.equal(args.serverName, 'vcp-agent-gateway-e2e');
});

test('readRenderTextFromToolCall prefers structuredContent and falls back to content text', () => {
    assert.equal(readRenderTextFromToolCall({
        body: {
            result: {
                structuredContent: {
                    result: {
                        renderedPrompt: 'Hello structured'
                    }
                }
            }
        }
    }), 'Hello structured');

    assert.equal(readRenderTextFromToolCall({
        body: {
            result: {
                content: [{ text: 'Hello content' }]
            }
        }
    }), 'Hello content');
});

test('runDirectGatewayProbe completes a real Streamable HTTP bootstrap call chain', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agw-codex-e2e-test-'));
    let agentDir = '';
    let nativeBackend = null;
    let mcpGateway = null;

    try {
        agentDir = await createTempAgentDir(tempRoot);
        await writeAgentFile(
            agentDir,
            'Ariadne.md',
            'You are Ariadne. Hello {{VarUserName}}.'
        );

        const pluginManager = createRenderPluginManager(agentDir, {
            agentId: 'Ariadne',
            gatewayKey: 'gw-codex-e2e-secret',
            gatewayId: 'gw-codex-e2e'
        });
        nativeBackend = await startNativeBackend(pluginManager);
        mcpGateway = await startMcpHttpGateway({
            pluginManager,
            backendUrl: nativeBackend.baseUrl,
            defaultAgentId: 'Ariadne',
            gatewayKey: 'gw-codex-e2e-secret',
            gatewayId: 'gw-codex-e2e'
        });

        const probe = await runDirectGatewayProbe({
            mcpUrl: mcpGateway.mcpUrl,
            gatewayKey: 'gw-codex-e2e-secret',
            gatewayId: 'gw-codex-e2e',
            agentId: 'Ariadne',
            userName: 'Nova'
        });

        assert.equal(probe.ok, true);
        assert.match(probe.renderedPrompt, /Hello Nova/);
        assert.equal(nativeBackend.metrics.renderHits, 1);
        assert.equal(mcpGateway.metrics.requests.some((entry) => entry.method === 'POST' && entry.status === 200), true);
        assert.equal(mcpGateway.metrics.requests.some((entry) => entry.sessionId === probe.sessionId), true);
    } finally {
        if (mcpGateway) {
            await mcpGateway.close();
        }
        if (nativeBackend) {
            await nativeBackend.close();
        }
        await removeDirectoryIfNeeded(tempRoot);
    }
});
