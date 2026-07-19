/**
 * 吊销传播的周期重校验（§3.6 / M1.S6.T5-T6）。
 *
 * loader 只在读取时发现变化，凡依赖"吊销后主动动作"的场景（空闲 WS 连接、
 * 空闲 SSE 流）必须叠加主动触发源：每 30s 对已注册 credentialId 做一次状态
 * 重校验（定时读取同时充当惰性重载触发源）。时效承诺：吊销写入后空闲连接
 * ≤60s 内断开（一个校验周期 + 重载判定余量）。
 */

const DEFAULT_REVALIDATION_INTERVAL_MS = 30_000;

function createRevocationWatcher({
    checkStatus,
    intervalMs = DEFAULT_REVALIDATION_INTERVAL_MS,
    onRevoked,
    onUnavailable,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval
} = {}) {
    if (typeof checkStatus !== 'function') {
        throw new TypeError('createRevocationWatcher requires checkStatus()');
    }
    let timer = null;
    let running = false;

    async function revalidate() {
        if (running) {
            return;
        }
        running = true;
        try {
            const status = await checkStatus();
            if (status?.ok) {
                return;
            }
            if (status?.code === 'AGW_CONFIG_UNAVAILABLE') {
                onUnavailable?.(status);
            } else {
                onRevoked?.(status);
            }
        } catch (error) {
            onUnavailable?.({ ok: false, code: 'AGW_CONFIG_UNAVAILABLE', reason: error.message });
        } finally {
            running = false;
        }
    }

    function start() {
        if (timer) {
            return;
        }
        timer = setIntervalImpl(() => { void revalidate(); }, intervalMs);
        if (typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    function stop() {
        if (timer) {
            clearIntervalImpl(timer);
            timer = null;
        }
    }

    return Object.freeze({ start, stop, revalidate });
}

module.exports = { DEFAULT_REVALIDATION_INTERVAL_MS, createRevocationWatcher };
