'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');

const {
    initializeBackendProxyMcpRuntime,
    shutdownBackendProxyMcpRuntime,
    createStdioMcpServer
} = require('../../../modules/agentGateway/mcpStdioServer');
const { StdioTransport } = require('../../../modules/agentGateway/transport');

/**
 * §5.5 / L4：stdio 静态 credential 的绑定身份自省与注入。
 * 启动时经 GET /agent_gateway/credential/context 解析绑定身份（trusted），
 * 注入后续每条请求；自省失败/未绑定/HTTP-WS runtime 保持现状语义。
 */

function createMockStreams() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    return { stdin, stdout, stderr };
}

function createCredentialContextBackendClient({ boundAgentId = 'MCPFuPeng', scopes = ['gateway:read', 'gateway:execute'], calls = null } = {}) {
    return {
        async getCredentialContext() {
            if (calls) calls.push('getCredentialContext');
            return {
                ok: true,
                httpStatus: 200,
                payload: {
                    success: true,
                    data: {
                        credentialId: 'cred-stdio',
                        credentialSubject: 'cred-stdio',
                        boundAgentId,
                        scopes,
                        status: 'active',
                        expiresAt: null,
                        credentialRevision: 'rev-stdio'
                    }
                }
            };
        }
    };
}

async function waitForCondition(predicate, attempts = 100) {
    for (let i = 0; i < attempts; i += 1) {
        if (predicate()) return true;
        await new Promise((resolve) => setImmediate(resolve));
    }
    return false;
}

test('resolves static bound identity at startup via the credential context endpoint', async () => {
    await shutdownBackendProxyMcpRuntime();
    const context = await initializeBackendProxyMcpRuntime({
        backendClient: createCredentialContextBackendClient()
    });

    assert.deepEqual(context.staticCredentialIdentity, {
        boundAgentId: 'MCPFuPeng',
        credentialScopes: ['gateway:read', 'gateway:execute']
    });
    await shutdownBackendProxyMcpRuntime();
});

test('returns null identity for unbound credentials and introspection failures', async () => {
    await shutdownBackendProxyMcpRuntime();
    const unbound = await initializeBackendProxyMcpRuntime({
        backendClient: createCredentialContextBackendClient({ boundAgentId: null, scopes: ['admin'] })
    });
    assert.equal(unbound.staticCredentialIdentity, null);
    await shutdownBackendProxyMcpRuntime();

    const failing = await initializeBackendProxyMcpRuntime({
        backendClient: {
            async getCredentialContext() {
                throw new Error('backend unreachable');
            }
        }
    });
    assert.equal(failing.staticCredentialIdentity, null);
    await shutdownBackendProxyMcpRuntime();
});

test('skips introspection when request-scoped auth override is required (HTTP/WS runtime)', async () => {
    await shutdownBackendProxyMcpRuntime();
    const calls = [];
    const context = await initializeBackendProxyMcpRuntime({
        requireRequestAuthOverride: true,
        backendClient: createCredentialContextBackendClient({ calls })
    });

    assert.equal(calls.length, 0);
    assert.equal(context.staticCredentialIdentity, null);
    await shutdownBackendProxyMcpRuntime();
});

test('stdio injects the trusted static identity over forged client authContext fields', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const received = [];
    const harness = {
        async handleRequest(request) {
            received.push(request);
            return { jsonrpc: '2.0', id: request.id, result: {} };
        }
    };
    const server = await createStdioMcpServer({
        transport: new StdioTransport({ stdin, stdout, stderr }),
        stderr,
        harness,
        staticCredentialIdentity: { boundAgentId: 'MCPFuPeng', credentialScopes: ['gateway:read'] },
        shutdownOnClose: false
    });

    stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'gateway_recall_run',
            arguments: { query: 'stdio bound omitted' },
            authContext: { boundAgentId: 'ForgedAgent', credentialScopes: ['admin'], note: 'keep' }
        }
    })}\n`);

    assert.equal(await waitForCondition(() => received.length > 0), true);
    assert.deepEqual(received[0].params.authContext, {
        note: 'keep',
        boundAgentId: 'MCPFuPeng',
        credentialScopes: ['gateway:read']
    });

    await server.close();
});

test('lines arriving before the runtime is ready are queued, not dropped (stdio handler registration race)', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const received = [];
    const harness = {
        async handleRequest(request) {
            received.push(request);
            return { jsonrpc: '2.0', id: request.id, result: {} };
        }
    };
    const provider = {
        async get() {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { backendClient: {}, harness, staticCredentialIdentity: null };
        },
        async reset() {}
    };
    const serverPromise = createStdioMcpServer({
        transport: new StdioTransport({ stdin, stdout, stderr }),
        stderr,
        runtimeProvider: provider,
        shutdownOnClose: false
    });
    // provider.get 解决前写入：readline 从 transport 构造起就在发射 line 事件，
    // handler 注册前的行曾被静默丢弃（启动自省拉长该窗口后暴露）。
    stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}\n');
    const server = await serverPromise;

    assert.equal(await waitForCondition(() => received.length > 0), true);
    assert.equal(received[0].method, 'ping');

    await server.close();
});

test('without static identity, client authContext is only sanitized and requests without one stay untouched', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const received = [];
    const harness = {
        async handleRequest(request) {
            received.push(request);
            return { jsonrpc: '2.0', id: request.id, result: {} };
        }
    };
    const server = await createStdioMcpServer({
        transport: new StdioTransport({ stdin, stdout, stderr }),
        stderr,
        harness,
        staticCredentialIdentity: null,
        shutdownOnClose: false
    });

    stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
            name: 'gateway_recall_run',
            arguments: { query: 'x' },
            authContext: { boundAgentId: 'ForgedAgent', note: 'keep' }
        }
    })}\n`);
    stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
        params: {}
    })}\n`);

    assert.equal(await waitForCondition(() => received.length >= 2), true);
    assert.deepEqual(received[0].params.authContext, { note: 'keep' });
    assert.equal('authContext' in received[1].params, false);

    await server.close();
});
