const assert = require('node:assert/strict');
const test = require('node:test');

const { GatewayBackendClient } = require('../../../modules/agentGateway/GatewayBackendClient');

function createJsonResponse(payload = {}) {
    return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async text() {
            return JSON.stringify(payload);
        }
    };
}

test('GatewayBackendClient applies its default timeout to hanging fetches', async () => {
    const client = new GatewayBackendClient({
        baseUrl: 'http://127.0.0.1:3000',
        timeoutMs: 10,
        fetchImpl: async (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        })
    });

    await assert.rejects(
        client.requestJson('GET', '/agent_gateway/health'),
        (error) => error?.name === 'TimeoutError'
    );
});

test('GatewayBackendClient composes external abort signals with timeout handling', async () => {
    const controller = new AbortController();
    const client = new GatewayBackendClient({
        baseUrl: 'http://127.0.0.1:3000',
        timeoutMs: 1000,
        fetchImpl: async (url, options) => new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        })
    });
    const expectedError = new Error('caller aborted');
    const request = client.requestJson('GET', '/agent_gateway/health', { signal: controller.signal });
    controller.abort(expectedError);

    await assert.rejects(request, (error) => error === expectedError);
});

test('GatewayBackendClient removes external abort listeners after normal completion', async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (...args) => {
        added += 1;
        return originalAdd(...args);
    };
    controller.signal.removeEventListener = (...args) => {
        removed += 1;
        return originalRemove(...args);
    };

    const client = new GatewayBackendClient({
        baseUrl: 'http://127.0.0.1:3000',
        timeoutMs: 1000,
        fetchImpl: async () => createJsonResponse({ success: true })
    });
    const result = await client.requestJson('GET', '/agent_gateway/health', { signal: controller.signal });

    assert.equal(result.ok, true);
    assert.equal(added, 1);
    assert.equal(removed, 1);
});

test('GatewayBackendClient applies timeout handling to event streams', async () => {
    const client = new GatewayBackendClient({
        baseUrl: 'http://127.0.0.1:3000',
        timeoutMs: 1000,
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: new Headers(),
            async text() {
                return 'event: runtime\ndata: {"jobId":"job-1"}\n\n';
            }
        })
    });

    const result = await client.requestEventStream('/agent_gateway/events/stream');
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].eventType, 'runtime');
    assert.equal(result.events[0].jobId, 'job-1');
});

test('GatewayBackendClient reads VCP_MCP_BACKEND_TIMEOUT_MS when no timeout is injected', () => {
    const previousTimeout = process.env.VCP_MCP_BACKEND_TIMEOUT_MS;
    try {
        process.env.VCP_MCP_BACKEND_TIMEOUT_MS = '4321';
        const client = new GatewayBackendClient({
            baseUrl: 'http://127.0.0.1:3000',
            fetchImpl: async () => createJsonResponse()
        });
        assert.equal(client.timeoutMs, 4321);
    } finally {
        if (typeof previousTimeout === 'string') {
            process.env.VCP_MCP_BACKEND_TIMEOUT_MS = previousTimeout;
        } else {
            delete process.env.VCP_MCP_BACKEND_TIMEOUT_MS;
        }
    }
});

test('GatewayBackendClient forwards an explicit trace header unchanged', async () => {
    let capturedHeaders;
    const client = new GatewayBackendClient({
        baseUrl: 'http://127.0.0.1:3000',
        fetchImpl: async (_url, options) => {
            capturedHeaders = options.headers;
            return createJsonResponse({ success: true });
        }
    });
    await client.searchMemory({}, { headers: { 'x-agent-gateway-trace-id': 'trace-cross-boundary' } });
    assert.equal(capturedHeaders['x-agent-gateway-trace-id'], 'trace-cross-boundary');
});
