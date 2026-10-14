'use strict';

/**
 * forge LLM 调用的瞬时失败判定与退避策略（2026-10-14）。
 *
 * 背景：distill 等大调用单次生成可达 5k+ token，在 60s 硬超时下偶发撞线
 * （ECONNABORTED），此前一次超时直接终止整个 job——无人值守的定期进修
 * 04:00 批次整批报废（2026-10-14 两个 learn job 均此原因失败）。
 *
 * 策略：
 * - 只重试「瞬时」错误：超时 / 连接重置 / 连接拒绝 / 上游 5xx / 429 / 408；
 * - 绝不重试业务信号：code 以 FORGE_ 开头（预算耗尽、协作取消、端口不可用等）；
 * - 默认重试 2 次、指数退避 2s → 6s（FORGE_LLM_RETRIES /
 *   FORGE_LLM_RETRY_BASE_MS 可配，上限 30s）；
 * - 每次物理调用前由调用方（wrapLlm）重做取消检查；退避等待本身不可中断。
 */

const TRANSIENT_CODES = new Set([
    'ECONNABORTED', // axios 超时
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED', // 本地代理重启窗口内值得一次重试
    'EPIPE',
    'EAI_AGAIN', // 临时 DNS 失败
    'ERR_NETWORK'
]);

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const TRANSIENT_MESSAGE_PATTERN = /timeout of \d+ms exceeded|socket hang up|network error/i;

function isTransientLlmError(error) {
    if (!error) {
        return false;
    }
    const code = typeof error.code === 'string' ? error.code : '';
    if (code.startsWith('FORGE_')) {
        return false; // 业务信号（预算/取消/端口不可用）——重试无意义。
    }
    if (TRANSIENT_CODES.has(code)) {
        return true;
    }
    const status = Number(error.response?.status);
    if (Number.isFinite(status)) {
        return TRANSIENT_STATUS.has(status);
    }
    return TRANSIENT_MESSAGE_PATTERN.test(String(error.message || ''));
}

function readInt(raw, fallback, min, max) {
    const value = Number(raw);
    return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}

function resolveLlmRetryPolicy(env = process.env) {
    return {
        retries: readInt(env.FORGE_LLM_RETRIES, 2, 0, 5),
        baseDelayMs: readInt(env.FORGE_LLM_RETRY_BASE_MS, 2000, 0, 60000)
    };
}

// 第 n 次重试前等待：base × 3^(n-1)，上限 30s。
function backoffDelay(baseDelayMs, attemptIndex) {
    const delay = baseDelayMs * Math.pow(3, Math.max(0, attemptIndex - 1));
    return Math.min(delay, 30000);
}

function sleep(ms) {
    if (!Number.isFinite(ms) || ms <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    isTransientLlmError,
    resolveLlmRetryPolicy,
    backoffDelay,
    sleep
};
