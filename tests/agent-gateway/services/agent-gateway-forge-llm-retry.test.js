const assert = require('node:assert/strict');
const test = require('node:test');

const {
    isTransientLlmError,
    resolveLlmRetryPolicy,
    backoffDelay
} = require('../../../modules/agentGateway/services/forge/llmRetry');
const {
    DEFAULT_FORGE_LLM_TIMEOUT_MS,
    resolveForgeLlmConfig,
    resolveForgeLlmTimeoutMs
} = require('../../../modules/agentGateway/services/forge/service');

// 2026-10-14 缺陷回归：distill 单次调用 60s 超时曾直接终止整个 job
// （04:00 定期进修批次整批报废）。加固 = 超时可配 + 瞬时失败退避重试。

test('isTransientLlmError：网络类瞬时错误为真；业务信号与 4xx 为假', () => {
    const timeout = new Error('timeout of 60000ms exceeded');
    timeout.code = 'ECONNABORTED';
    assert.equal(isTransientLlmError(timeout), true, 'axios 超时');

    const reset = new Error('socket hang up');
    reset.code = 'ECONNRESET';
    assert.equal(isTransientLlmError(reset), true, '连接重置');

    const refused = new Error('connect ECONNREFUSED');
    refused.code = 'ECONNREFUSED';
    assert.equal(isTransientLlmError(refused), true, '本地代理重启窗口');

    const upstream = new Error('Bad Gateway');
    upstream.response = { status: 502 };
    assert.equal(isTransientLlmError(upstream), true, '上游 5xx');

    const rateLimited = new Error('Too Many Requests');
    rateLimited.response = { status: 429 };
    assert.equal(isTransientLlmError(rateLimited), true, '限流 429');

    const badRequest = new Error('invalid request');
    badRequest.response = { status: 400 };
    assert.equal(isTransientLlmError(badRequest), false, '请求本身错误不重试');

    const budget = new Error('预算耗尽');
    budget.code = 'FORGE_BUDGET_EXCEEDED';
    assert.equal(isTransientLlmError(budget), false, 'FORGE_* 业务信号不重试');

    const cancelled = new Error('job 已被取消');
    cancelled.code = 'FORGE_JOB_CANCELLED';
    assert.equal(isTransientLlmError(cancelled), false, '取消不重试');

    assert.equal(isTransientLlmError(null), false);
    assert.equal(isTransientLlmError(new Error('timeout of 180000ms exceeded')), true, '消息兜底（无 code/response）');
    assert.equal(isTransientLlmError(new Error('some random failure')), false);
});

test('resolveLlmRetryPolicy / backoffDelay：默认 2 次、2s 起、指数退避封顶 30s，env 可配', () => {
    assert.deepEqual(resolveLlmRetryPolicy({}), { retries: 2, baseDelayMs: 2000 });
    assert.deepEqual(
        resolveLlmRetryPolicy({ FORGE_LLM_RETRIES: '4', FORGE_LLM_RETRY_BASE_MS: '500' }),
        { retries: 4, baseDelayMs: 500 }
    );
    assert.equal(resolveLlmRetryPolicy({ FORGE_LLM_RETRIES: 'abc' }).retries, 2, '非法值回落默认');
    assert.equal(resolveLlmRetryPolicy({ FORGE_LLM_RETRIES: '99' }).retries, 2, '超范围回落默认');

    assert.equal(backoffDelay(2000, 1), 2000);
    assert.equal(backoffDelay(2000, 2), 6000);
    assert.equal(backoffDelay(2000, 9), 30000, '封顶 30s');
});

test('resolveForgeLlmConfig：超时默认 180s、FORGE_LLM_TIMEOUT_MS 可配，且随配置一并下发', () => {
    const base = { FORGE_LLM_URL: 'http://localhost:3001/', FORGE_LLM_API: 'k', FORGE_LLM_MODEL: 'm' };
    assert.equal(DEFAULT_FORGE_LLM_TIMEOUT_MS, 180000);
    assert.equal(resolveForgeLlmTimeoutMs(base), 180000);
    assert.equal(resolveForgeLlmTimeoutMs({ ...base, FORGE_LLM_TIMEOUT_MS: '90000' }), 90000);
    assert.equal(resolveForgeLlmTimeoutMs({ ...base, FORGE_LLM_TIMEOUT_MS: 'abc' }), 180000, '非法值回落默认');
    assert.equal(resolveForgeLlmTimeoutMs({ ...base, FORGE_LLM_TIMEOUT_MS: '-1' }), 180000, '非正数回落默认');

    const config = resolveForgeLlmConfig(base);
    assert.equal(config.timeoutMs, 180000, 'llmConfig 携带 timeoutMs');
    assert.deepEqual(
        resolveForgeLlmConfig({ ...base, FORGE_LLM_TIMEOUT_MS: '120000' }).timeoutMs,
        120000
    );
    assert.equal(resolveForgeLlmConfig({}), null, '缺配置返回 null（不臆造超时字段）');
});
