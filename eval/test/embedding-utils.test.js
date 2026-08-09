'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    _createRequestScheduler,
    _parseRetryAfterMs,
    _sendBatch
} = require('../../EmbeddingUtils');

function response(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[String(name).toLowerCase()] || null },
        text: async () => JSON.stringify(body)
    };
}

test('Retry-After supports seconds and HTTP dates', () => {
    assert.equal(_parseRetryAfterMs('2'), 2000);
    assert.equal(_parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:58 GMT')), 2000);
    assert.equal(_parseRetryAfterMs('invalid'), null);
});

test('429 retries the same embedding model and honors Retry-After', async () => {
    const calls = [];
    const waits = [];
    const vectors = await _sendBatch(['query'], {
        apiUrl: 'https://embedding.example.test',
        apiKey: 'test-key',
        model: 'model-a',
        fetchImpl: async (_url, options) => {
            calls.push(JSON.parse(options.body).model);
            if (calls.length === 1) return response(429, { error: { type: 'rate_limit' } }, { 'retry-after': '2' });
            return response(200, { data: [{ index: 0, embedding: [1, 0] }] });
        },
        sleep: async ms => waits.push(ms),
        random: () => 0,
        rateLimitRetries: 2,
        rateLimitBaseMs: 100,
        rateLimitMaxMs: 5000,
        requestTimeoutMs: 1000
    }, 1, false, 2);

    assert.deepEqual(calls, ['model-a', 'model-a']);
    assert.deepEqual(waits, [2000]);
    assert.deepEqual(vectors, [[1, 0]]);
});

test('429 exhaustion throws a stable rate-limit error', async () => {
    let calls = 0;
    await assert.rejects(
        _sendBatch(['query'], {
            apiUrl: 'https://embedding.example.test',
            apiKey: 'test-key',
            model: 'model-a',
            fetchImpl: async () => {
                calls++;
                return response(429, { error: { type: 'rate_limit' } });
            },
            sleep: async () => {},
            random: () => 0,
            rateLimitRetries: 2,
            rateLimitBaseMs: 1,
            rateLimitMaxMs: 1,
            requestTimeoutMs: 1000
        }, 1, false, 2),
        error => error.code === 'EMBEDDING_RATE_LIMITED'
    );
    assert.equal(calls, 3);
});

test('a stalled embedding request fails with a stable timeout error', async () => {
    // AbortSignal.timeout 的内部 timer 会 unref；真实 socket 会保持事件循环，测试替身也需要模拟这一点。
    const socketHandle = setTimeout(() => {}, 1000);
    try {
        await assert.rejects(
            _sendBatch(['query'], {
                apiUrl: 'https://embedding.example.test',
                apiKey: 'test-key',
                model: 'model-a',
                fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
                }),
                requestTimeoutMs: 5
            }, 1, false, 2),
            error => error.code === 'EMBEDDING_REQUEST_TIMEOUT'
        );
    } finally {
        clearTimeout(socketHandle);
    }
});

test('global request scheduler bounds concurrent work', async () => {
    const schedule = _createRequestScheduler(1, 0);
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 4 }, () => schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
    }));
    await Promise.all(tasks);
    assert.equal(peak, 1);
});
