const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..');
const START_SCRIPT = path.join(REPO_ROOT, 'scripts', 'start-agent-gateway-mcp-server.js');
const FIXTURE_RUNTIME = path.join(REPO_ROOT, 'test', 'helpers', 'mcp-transport-fixture-runtime.js');

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
            VCP_MCP_TRANSPORT_FACTORY: FIXTURE_RUNTIME,
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
    const { child, stdout, stderr } = spawnFixtureServer();

    try {
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 1,
            method: 'prompts/list'
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {
                agentId: 'Ariadne',
                requestContext: {
                    requestId: 'req-stdio-tools-list'
                }
            }
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 3,
            method: 'resources/list',
            params: {
                agentId: 'Ariadne',
                requestContext: {
                    requestId: 'req-stdio-resources-list'
                }
            }
        });
        sendMessage(child, {
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
                name: 'SciCalculator',
                arguments: {
                    expression: '1+1'
                },
                agentId: 'Ariadne',
                sessionId: 'sess-stdio-tool-call',
                requestContext: {
                    requestId: 'req-stdio-tool-call'
                }
            }
        });

        const prompts = await stdout.waitFor((message) => message.id === 1);
        const tools = await stdout.waitFor((message) => message.id === 2);
        const resources = await stdout.waitFor((message) => message.id === 3);
        const toolCall = await stdout.waitFor((message) => message.id === 4);

        assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['gateway_agent_render']);
        assert.equal(tools.result.tools.some((tool) => tool.name === 'gateway_agent_render'), true);
        assert.equal(resources.result.resources.some((resource) => resource.uri === 'vcp://agent-gateway/agents/Ariadne/profile'), true);
        assert.equal(toolCall.result.isError, false);
        assert.equal(toolCall.result.structuredContent.result.receivedArgs.expression, '1+1');
        assert.deepEqual(stdout.invalidLines, []);
        assert.equal(stderr.value.includes('[FixtureTransport]'), false);
    } finally {
        await stopChild(child);
    }
});

test('stdio MCP transport returns parse errors and keeps boot logs off stdout', async () => {
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_FIXTURE_LOG_STDOUT: '1'
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
        assert.equal(tools.result.tools.some((tool) => tool.name === 'SciCalculator'), true);
        assert.deepEqual(stdout.invalidLines, []);
        assert.equal(stderr.value.includes('[FixtureTransport] boot log'), true);
    } finally {
        await stopChild(child);
    }
});

test('stdio MCP transport exits non-zero on fatal bootstrap failure without polluting stdout', async () => {
    const { child, stdout, stderr } = spawnFixtureServer({
        VCP_MCP_FIXTURE_FAIL_BOOTSTRAP: '1'
    });

    child.stdin.end();

    const exitCode = await new Promise((resolve) => {
        child.once('exit', (code) => resolve(code));
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(stdout.lines, []);
    assert.deepEqual(stdout.invalidLines, []);
    assert.equal(stderr.value.includes('Fixture bootstrap failed intentionally.'), true);
});
