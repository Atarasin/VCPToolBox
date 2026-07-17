const assert = require('node:assert/strict');
const test = require('node:test');

const {
    checkSlidingWindowRateLimit,
    createRuntimeProvider,
    createSlidingWindowRateLimit,
    dispatchJsonRpc,
    injectMcpContext,
    parseJsonRpcPayload
} = require('../../../modules/agentGateway/transport/shared');
const legacyClient = require('../../../modules/agentGateway/GatewayBackendClient');
const canonicalClient = require('../../../modules/agentGateway/clients/GatewayBackendClient');

test('legacy backend client path re-exports the canonical client', () => {
    assert.equal(legacyClient, canonicalClient);
});

test('shared JSON-RPC codec preserves transport-specific batch policies', () => {
    assert.equal(parseJsonRpcPayload('[{"id":1}]', { batchPolicy: 'reject' }).error.error.code, -32600);
    assert.equal(parseJsonRpcPayload('[{"id":1}]', { batchPolicy: 'allow', maxBatchSize: 20 }).batch, true);
    assert.equal(
        parseJsonRpcPayload('[{"id":1},{"id":2}]', { batchPolicy: 'allow', maxBatchSize: 1 }).error.error.data.reason,
        'batch_limit_exceeded'
    );
});

test('shared JSON-RPC dispatch omits notification responses', async () => {
    const result = await dispatchJsonRpc({
        requests: [
            { jsonrpc: '2.0', id: 'one', method: 'ping' },
            { jsonrpc: '2.0', method: 'notifications/initialized' }
        ],
        batch: true,
        harness: {
            async handleRequest(request) {
                return { jsonrpc: '2.0', id: request.id, result: {} };
            }
        }
    });
    assert.deepEqual(result.map((entry) => entry.id), ['one']);
});

test('runtime provider shares one initialized context until explicit process reset', async () => {
    let initializeCount = 0;
    const provider = createRuntimeProvider(async () => ({ id: ++initializeCount }));
    const first = await provider.get();
    const second = await provider.get();
    assert.equal(first, second);
    await provider.reset();
    assert.notEqual(await provider.get(), first);
});

test('shared context injector overwrites client session and auth identity', () => {
    const request = injectMcpContext({
        id: 'context',
        params: {
            sessionId: 'forged',
            authContext: { gatewayId: 'forged' },
            requestContext: { requestId: 'req-context' }
        }
    }, {
        sessionId: 'canonical-session',
        gatewayId: 'canonical-gateway',
        source: 'test',
        runtime: 'mcp-test',
        roles: ['gateway']
    });
    assert.equal(request.params.sessionId, 'canonical-session');
    assert.equal(request.params.authContext.gatewayId, 'canonical-gateway');
    assert.equal(request.params.requestContext.requestId, 'req-context');
});

test('sliding window limiter returns retry metadata and recovers', () => {
    const limiter = createSlidingWindowRateLimit({ limit: 1, windowMs: 100 });
    assert.equal(checkSlidingWindowRateLimit(limiter, 1000).allowed, true);
    const rejected = checkSlidingWindowRateLimit(limiter, 1050);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfterMs, 50);
    assert.equal(checkSlidingWindowRateLimit(limiter, 1101).allowed, true);
});
