const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const test = require('node:test');
const express = require('express');

const createAgentGatewayRoutes = require('../../../routes/agentGatewayRoutes');
const {
    getGatewayServiceBundle
} = require('../../../modules/agentGateway/createGatewayServiceBundle');
const {
    createPluginManager
} = require('../helpers/agent-gateway-test-helpers');

async function createTempAgentDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'agw-mcp-transport-'));
}

async function writeAgentFile(baseDir, relativePath, content) {
    const absolutePath = path.join(baseDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
}

function createAgentManager(agentDir, mappings = {
    Ariadne: 'Ariadne.md'
}) {
    const mapping = new Map(Object.entries(mappings));

    return {
        agentDir,
        agentMap: mapping,
        isAgent(alias) {
            return mapping.has(alias);
        },
        async getAgentPrompt(alias) {
            const relativePath = mapping.get(alias);
            return fs.readFile(path.join(agentDir, relativePath), 'utf8');
        },
        async getAllAgentFiles() {
            return {
                files: Array.from(mapping.values()),
                folderStructure: {}
            };
        }
    };
}

function createTransportPluginManager(agentDir, overrides = {}) {
    return createPluginManager({
        agentManager: createAgentManager(agentDir, overrides.agentMappings),
        agentRegistryRenderPrompt: async ({ rawPrompt, renderVariables }) =>
            rawPrompt.replaceAll('{{VarUserName}}', renderVariables.VarUserName || ''),
        ...overrides
    });
}

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'start-agent-gateway-mcp-server.js');

async function createNativeServer(pluginManager) {
    const app = express();
    app.use(express.json());
    app.use('/agent_gateway', createAgentGatewayRoutes(pluginManager));

    const server = await new Promise((resolve) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    return {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        async close() {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    };
}

function createStdoutCollector(stream) {
    let buffer = '';
    const lines = [];
    const invalidLines = [];
    const waiters = [];

    function flushWaiters() {
        while (waiters.length > 0) {
            const next = waiters[0];
            const match = lines.find(next.predicate);
            if (!match) {
                break;
            }
            waiters.shift();
            next.resolve(match);
        }
    }

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        buffer += chunk;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
            const rawLine = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (rawLine) {
                try {
                    lines.push(JSON.parse(rawLine));
                } catch (error) {
                    invalidLines.push(rawLine);
                }
            }
            newlineIndex = buffer.indexOf('\n');
        }
        flushWaiters();
    });

    return {
        lines,
        invalidLines,
        waitFor(predicate, timeoutMs = 2500) {
            const existing = lines.find(predicate);
            if (existing) {
                return Promise.resolve(existing);
            }
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error(`Timed out waiting for MCP response. Invalid lines: ${invalidLines.join(' | ')}`));
                }, timeoutMs);
                waiters.push({
                    predicate,
                    resolve(value) {
                        clearTimeout(timeout);
                        resolve(value);
                    }
                });
            });
        }
    };
}

function createStderrCollector(stream) {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
        output += chunk;
    });
    return {
        get value() {
            return output;
        }
    };
}

function spawnFixtureServer(extraEnv = {}) {
    const child = spawn(process.execPath, [START_SCRIPT], {
        cwd: REPO_ROOT,
        env: {
            ...process.env,
            ...extraEnv
        },
        stdio: ['pipe', 'pipe', 'pipe']
    });

    return {
        child,
        stdout: createStdoutCollector(child.stdout),
        stderr: createStderrCollector(child.stderr)
    };
}

async function stopChild(child) {
    if (child.exitCode !== null) {
        return;
    }
    child.stdin.end();
    await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(() => {
            if (child.exitCode === null) {
                child.kill('SIGTERM');
            }
        }, 1000);
    });
}

function sendMessage(child, payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
}

test('stdio MCP transport serves capability discovery and representative tool calls', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createTransportPluginManager(agentDir);
    const server = await createNativeServer(pluginManager);
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: {
                    name: 'trae',
                    version: '1.0.0'
                }
            }
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 2,
            method: 'ping'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'prompts/list'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/list'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 5,
            method: 'resources/list'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 6,
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Nova'
                    }
                }
            }
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: {
                name: 'gateway_agent_bootstrap',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Nova'
                    }
                },
                agentId: 'Ariadne',
                sessionId: 'sess-stdio-tool-call',
                requestContext: {
                    requestId: 'req-stdio-tool-call'
                }
            }
        });

        const initialize = await stdout.waitFor((message) => message.id === 1);
        const ping = await stdout.waitFor((message) => message.id === 2);
        const prompts = await stdout.waitFor((message) => message.id === 3);
        const tools = await stdout.waitFor((message) => message.id === 4);
        const resources = await stdout.waitFor((message) => message.id === 5);
        const promptGet = await stdout.waitFor((message) => message.id === 6);
        const toolCall = await stdout.waitFor((message) => message.id === 7);

        assert.equal(initialize.result.protocolVersion, '2025-06-18');
        assert.equal(initialize.result.serverInfo.name, 'vcp-agent-gateway');
        assert.doesNotMatch(initialize.result.instructions, /stdio/i);
        assert.deepEqual(ping.result, {});
        assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
        assert.equal(tools.result.meta.agentId, 'Ariadne');
        assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_agent_render'), false);
        assert.equal(tools.result.tools.some((tool) => tool.name === 'SciCalculator'), false);
        assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_recall_for_coding'), false);
        assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_agent_bootstrap'), true);
        assert.equal(resources.result.meta.agentId, 'Ariadne');
        assert.deepEqual(
            resources.result.resources.map((resource) => resource.uri),
            ['vcp://agent-gateway/memory-targets/Ariadne']
        );
        assert.equal(promptGet.result.name, 'gateway_agent_render');
        assert.equal(promptGet.result.messages[0].content[0].text.includes('Hello Nova'), true);
        assert.equal(promptGet.result.meta.agentId, 'Ariadne');
        assert.equal(promptGet.result.meta.hostHints.primarySurface, 'prompts/get');
        assert.equal(promptGet.result.meta.hostHints.fallbackToolSurfaceAvailable, true);
        assert.equal(toolCall.result.isError, false);
        assert.equal(toolCall.result.structuredContent.toolName, 'gateway_agent_bootstrap');
        assert.equal(toolCall.result.structuredContent.result.renderedPrompt.includes('Hello Nova'), true);
        assert.equal(toolCall.result.structuredContent.result.summary.includes('Bootstrap prompt ready for Ariadne'), true);
        assert.deepEqual(stdout.invalidLines, []);
        assert.equal(stderr.value.includes('[MCPTransport]'), false);
    } finally {
        await stopChild(child);
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('stdio MCP transport preserves explicit bootstrap agentId over default agent', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    await writeAgentFile(agentDir, 'Nexus.md', 'You are Nexus. Hello {{VarUserName}}.');

    const pluginManager = createTransportPluginManager(agentDir, {
        agentMappings: {
            Ariadne: 'Ariadne.md',
            Nexus: 'Nexus.md'
        }
    });
    const server = await createNativeServer(pluginManager);
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Nexus'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 11,
            method: 'initialize',
            params: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                clientInfo: {
                    name: 'trae',
                    version: '1.0.0'
                }
            }
        });
        await stdout.waitFor((message) => message.id === 11);

        sendMessage(child, {
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: {
                name: 'gateway_agent_bootstrap',
                arguments: {
                    agentId: 'Ariadne',
                    variables: {
                        VarUserName: 'Trae'
                    }
                }
            }
        });

        const bootstrap = await stdout.waitFor((message) => message.id === 12);
        assert.equal(bootstrap.result.structuredContent.result.agentId, 'Ariadne');
        assert.match(bootstrap.result.content[0].text, /You are Ariadne/);
        assert.doesNotMatch(bootstrap.result.content[0].text, /You are Nexus/);
        assert.equal(stderr.value, '');
    } finally {
        await stopChild(child);
        await server.close();
    }
});

test('stdio MCP transport rejects gateway_agent_render as a tool and points clients to prompts/get', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createTransportPluginManager(agentDir);
    const server = await createNativeServer(pluginManager);
    const { child, stdout } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne'
                }
            }
        });

        const failure = await stdout.waitFor((message) => message.id === 11);
        assert.equal(failure.error.code, -32000);
        assert.equal(failure.error.data.code, 'MCP_NOT_FOUND');
        assert.equal(failure.error.data.primarySurface, 'prompts/get');
    } finally {
        await stopChild(child);
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('stdio MCP transport sanitizes representative backend runtime failures with stable MCP metadata', async () => {
    const { child, stdout } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: 'http://127.0.0.1:9',
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 12,
            method: 'prompts/get',
            params: {
                name: 'gateway_agent_render',
                arguments: {
                    agentId: 'Ariadne'
                }
            }
        });

        const failure = await stdout.waitFor((message) => message.id === 12);
        const payload = JSON.stringify(failure);

        assert.equal(failure.error.code, -32000);
        assert.equal(failure.error.message, 'Gateway backend request failed');
        assert.equal(failure.error.data.code, 'MCP_RUNTIME_ERROR');
        assert.equal(failure.error.data.stack, undefined);
        assert.equal(failure.error.data.details, undefined);
        assert.doesNotMatch(payload, /127\.0\.0\.1:9|localhost:9|ECONNREFUSED|https?:\/\/127\.0\.0\.1:9/i);
    } finally {
        await stopChild(child);
    }
});

test('stdio MCP transport returns parse errors and keeps boot logs off stdout', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createTransportPluginManager(agentDir);
    const server = await createNativeServer(pluginManager);
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne'
    });

    try {
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"\n');
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {
                agentId: 'Ariadne',
                requestContext: {
                    requestId: 'req-stdio-tools-list-after-parse-error'
                }
            }
        });

        const parseError = await stdout.waitFor((message) => message.error && message.error.code === -32700);
        const tools = await stdout.waitFor((message) => message.id === 2);

        assert.equal(parseError.id, null);
        assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_memory_search'), true);
        assert.deepEqual(stdout.invalidLines, []);
        assert.equal(stderr.value.includes('boot log'), false);
    } finally {
        await stopChild(child);
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('stdio MCP transport maps removed coding tools to not-found failures without polluting stdout', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createTransportPluginManager(agentDir);
    const server = await createNativeServer(pluginManager);
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 9,
            method: 'tools/call',
            params: {
                name: 'gateway_memory_commit_for_coding',
                arguments: {
                    task: {
                        description: '提交 writeback'
                    }
                },
                agentId: 'Ariadne',
                sessionId: 'sess-stdio-writeback-forbidden',
                requestContext: {
                    requestId: 'req-stdio-writeback-forbidden'
                }
            }
        });

        const failure = await stdout.waitFor((message) => message.id === 9);
        assert.equal(failure.error.code, -32000);
        assert.equal(failure.error.data.code, 'MCP_NOT_FOUND');
        assert.deepEqual(stdout.invalidLines, []);
        assert.equal(stderr.value.includes('[MCPTransport]'), false);
    } finally {
        await stopChild(child);
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('stdio MCP transport preserves deferred bootstrap continuation and job-event resource shaping', async () => {
    const agentDir = await createTempAgentDir();
    await writeAgentFile(agentDir, 'Ariadne.md', 'You are Ariadne. Hello {{VarUserName}}.');
    const pluginManager = createTransportPluginManager(agentDir);
    const bundle = getGatewayServiceBundle(pluginManager);
    bundle.agentRegistryService.renderAgent = async (agentId, options = {}) => ({
        success: true,
        requestId: options?.context?.requestId || 'req-stdio-deferred-bootstrap',
        status: 'waiting_approval',
        data: {
            runtime: {
                deferred: true,
                status: 'waiting_approval'
            },
            job: bundle.jobRuntimeService.createWaitingApprovalJob({
                operation: 'agents.render',
                authContext: {
                    requestId: 'req-stdio-deferred-bootstrap',
                    agentId,
                    sessionId: 'sess-stdio-deferred-bootstrap',
                    runtime: 'native',
                    source: 'agent-gateway-bootstrap',
                    gatewayId: 'gw-transport-test'
                },
                target: {
                    type: 'tool',
                    id: 'gateway_agent_bootstrap'
                },
                metadata: {
                    agentId
                }
            })
        }
    });
    const server = await createNativeServer(pluginManager);
    const { child, stdout } = spawnFixtureServer({
        VCP_MCP_BACKEND_URL: server.baseUrl,
        VCP_MCP_DEFAULT_AGENT_ID: 'Ariadne',
        VCP_MCP_BACKEND_GATEWAY_ID: 'gw-transport-test'
    });

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'gateway_agent_bootstrap',
                arguments: {
                    agentId: 'Ariadne'
                },
                agentId: 'Ariadne',
                sessionId: 'sess-stdio-deferred-bootstrap',
                requestContext: {
                    requestId: 'req-stdio-deferred-bootstrap'
                }
            }
        });

        const deferred = await stdout.waitFor((message) => message.id === 1);
        const jobId = deferred.result.structuredContent.job.jobId;
        const eventUri = deferred.result.structuredContent.runtime.eventResourceUri;

        sendMessage(child, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
                name: 'gateway_job_get',
                arguments: {
                    jobId
                },
                agentId: 'Ariadne',
                sessionId: 'sess-stdio-deferred-bootstrap',
                requestContext: {
                    requestId: 'req-stdio-job-get'
                }
            }
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'resources/read',
            params: {
                uri: eventUri,
                agentId: 'Ariadne',
                    sessionId: 'sess-stdio-deferred-bootstrap',
                requestContext: {
                    requestId: 'req-stdio-job-events'
                }
            }
        });

        const jobGet = await stdout.waitFor((message) => message.id === 2);
        const jobEvents = await stdout.waitFor((message) => message.id === 3);
        const eventPayload = JSON.parse(jobEvents.result.contents[0].text);

        assert.equal(deferred.result.deferred, true);
        assert.equal(deferred.result.status, 'waiting_approval');
        assert.equal(eventUri.includes(encodeURIComponent(jobId)), true);
        assert.equal(jobGet.result.isError, false);
        assert.equal(jobGet.result.structuredContent.result.job.jobId, jobId);
        assert.equal(jobEvents.result.contents[0].uri, eventUri);
        assert.equal(eventPayload.jobId, jobId);
        assert.equal(
            eventPayload.events.some((event) => event.eventType === 'job.waiting_approval'),
            true
        );
    } finally {
        await stopChild(child);
        await server.close();
        await fs.rm(agentDir, { recursive: true, force: true });
    }
});

test('stdio MCP transport exits non-zero when backend configuration is missing', async () => {
    const { child, stdout, stderr } = spawnFixtureServer();

    child.stdin.end();

    const exitCode = await new Promise((resolve) => {
        child.once('exit', (code) => resolve(code));
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(stdout.lines, []);
    assert.deepEqual(stdout.invalidLines, []);
    assert.equal(stderr.value.includes('VCP_MCP_BACKEND_URL is required'), true);
});
