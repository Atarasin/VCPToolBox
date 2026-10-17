const assert = require('node:assert/strict');
const test = require('node:test');

const {
    completeJsonResilient,
    resolveThinkingMode,
    resetThinkingSupportCache
} = require('../../../modules/agentGateway/services/forge/jsonCompletion');

function ok(content, finishReason = 'stop') {
    return {
        data: {
            choices: [{ message: { content }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
            usage: { prompt_tokens: 100, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 0 } }
        }
    };
}

// 空正文：模型把整个输出预算耗在推理段（2026-10-16 事故形态）。
function blankBody(reasoningTokens = 8000, finishReason = 'length') {
    return {
        data: {
            choices: [{ message: { content: '', reasoning_content: '（推理段，未输出正文）' }, finish_reason: finishReason }],
            usage: { prompt_tokens: 1892, completion_tokens: Math.max(reasoningTokens, 1), completion_tokens_details: { reasoning_tokens: reasoningTokens } }
        }
    };
}

function rejection(status = 400) {
    const error = new Error(`Request failed with status code ${status}`);
    error.response = { status };
    return error;
}

const QUESTIONS = JSON.stringify({ questions: [{ id: 'q1', prompt: 'p' }] });
const validateQuestions = (candidate) => Array.isArray(candidate?.questions) && candidate.questions.length > 0;
const llmConfig = { url: 'http://t', model: 'm' };

test('阶梯：正文为空 → 抬预算重试（8k → 32k），不再同参重放', async () => {
    const calls = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            return calls.length === 1 ? blankBody() : ok(QUESTIONS);
        }
    };
    const result = await completeJsonResilient({
        llm, llmConfig, prompt: 'p', validate: validateQuestions,
        thinking: 'disabled'
    });
    assert.ok(result.payload, '抬预算后应成功');
    assert.equal(result.failureReason, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].max_tokens, 8000, '首次预算 8000');
    assert.equal(calls[1].max_tokens, 32000, '空正文触发抬预算');
    assert.deepEqual(calls[0].thinking, { type: 'disabled' }, '关思考随请求下发');
    assert.equal(result.attempts[0].blank, true);
    assert.equal(result.attempts[0].reasoningTokens, 8000, '尝试记录带推理 token 数');
});

test('阶梯：全部尝试正文为空 → failureReason=empty-content（与不可解析区分）', async () => {
    const calls = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            return blankBody(7000, calls.length === 1 ? 'length' : 'stop');
        }
    };
    const result = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions });
    assert.equal(result.payload, null);
    assert.equal(result.failureReason, 'empty-content');
    assert.equal(result.attempts.length, 3, '阶梯跑满三次尝试');
    assert.equal(calls.filter((call) => call.max_tokens === 32000).length, 2, '第 2/3 次抬预算');
});

test('阶梯：正文为空但推理段含结构化结果 → 从推理段抢救', async () => {
    const llm = {
        complete: async () => ({
            data: {
                choices: [{
                    message: { content: '', reasoning_content: `先想一下……\n\n${QUESTIONS}\n\n就这样。` },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 10, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3900 } }
            }
        })
    };
    const result = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions });
    assert.ok(result.payload, '推理段兜底应救回');
    assert.equal(result.salvagedFrom, 'reasoning');
    assert.equal(result.payload.salvaged, true, '抢救标记透传');
    assert.equal(result.attempts.length, 1);
});

test('阶梯：正文非空但不可解析 → 同预算重试（不误抬预算）', async () => {
    const calls = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            return calls.length === 1 ? ok('这不是 JSON') : ok(QUESTIONS);
        }
    };
    const result = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions, retryNote: '\n\n【重试要求】只输出 JSON。' });
    assert.ok(result.payload);
    assert.deepEqual(calls.map((call) => call.max_tokens), [8000, 8000], '抖动不抬预算');
    assert.ok(calls[1].messages[0].content.endsWith('【重试要求】只输出 JSON。'), '重试带强指令');
});

test('阶梯：供应商拒收 thinking 开关 → 去字段重试并记忆（后续调用不再携带）', async () => {
    resetThinkingSupportCache();
    const calls = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            if (payload.thinking) {
                throw rejection(400);
            }
            return ok(QUESTIONS);
        }
    };
    const first = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions, thinking: 'disabled' });
    assert.ok(first.payload);
    assert.equal(calls.length, 2, '拒收后去开关重试');
    assert.ok(calls[0].thinking, '首次带开关');
    assert.equal(calls[1].thinking, undefined, '重试不带开关');

    const second = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions, thinking: 'disabled' });
    assert.ok(second.payload);
    assert.equal(calls.length, 3, '记忆生效：不再为开关多付一次拒收');
    assert.equal(calls[2].thinking, undefined);
    resetThinkingSupportCache();
});

test('阶梯：供应商拒收抬升后的 max_tokens → 回落到安全上限', async () => {
    const calls = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            if (payload.max_tokens > 12000) {
                throw rejection(400);
            }
            return calls.length === 1 ? blankBody() : ok(QUESTIONS);
        }
    };
    const result = await completeJsonResilient({ llm, llmConfig, prompt: 'p', validate: validateQuestions });
    assert.ok(result.payload);
    assert.deepEqual(calls.map((call) => call.max_tokens), [8000, 32000, 12000]);
});

test('阶梯：onAttempt 返回 stop 立即中止（调用方接管，如拆半重蒸）', async () => {
    const calls = [];
    const seen = [];
    const llm = {
        complete: async (config, payload) => {
            calls.push(payload);
            return ok('{"knowledgeUnits":', 'length');
        }
    };
    const result = await completeJsonResilient({
        llm, llmConfig, prompt: 'p',
        validate: (candidate) => Array.isArray(candidate?.knowledgeUnits),
        onAttempt: (attempt) => {
            seen.push(attempt.finishReason);
            return attempt.finishReason === 'length' ? 'stop' : undefined;
        }
    });
    assert.equal(result.payload, null);
    assert.equal(result.halted, true);
    assert.equal(calls.length, 1, '中止后不再重试');
    assert.deepEqual(seen, ['length']);
});

test('resolveThinkingMode：缺省按调用方给的值，env 可改', () => {
    assert.equal(resolveThinkingMode('FORGE_X', 'disabled', {}), 'disabled');
    assert.equal(resolveThinkingMode('FORGE_X', 'enabled', {}), 'enabled');
    assert.equal(resolveThinkingMode('FORGE_X', 'enabled', { FORGE_X: 'disabled' }), 'disabled');
    assert.equal(resolveThinkingMode('FORGE_X', 'disabled', { FORGE_X: 'ENABLED' }), 'enabled');
    assert.equal(resolveThinkingMode('FORGE_X', 'disabled', { FORGE_X: 'off' }), 'disabled');
});
