const { createRevocationWatcher } = require('./revocationWatcher');

/**
 * Native SSE 吊销传播（§3.6 / M1.S6.T6）。
 *
 * 连接建立时的认证不能覆盖整个响应生命周期：
 * - 每次向流写出事件前重校验 credential 状态（复用 content-hash resolver）；
 * - 空闲流每 30s 周期重校验一次；
 * - 吊销/过期/revision 不再兼容 → 写出终止事件后 end；
 *   security snapshot 不可用 → 同样终止。
 * 时效承诺与 WS 一致：吊销后空闲流 ≤60s 内终止。
 */
function createGuardedSseWriter({
    res,
    checkStatus,
    writeEvent,
    intervalMs = 30_000
} = {}) {
    if (!res || typeof checkStatus !== 'function' || typeof writeEvent !== 'function') {
        throw new TypeError('createGuardedSseWriter requires res, checkStatus() and writeEvent()');
    }

    let terminated = false;

    function terminate(reason) {
        if (terminated) {
            return;
        }
        terminated = true;
        watcher.stop();
        try {
            writeEvent(res, 'gateway.stream.terminated', { reason });
        } catch (_error) { /* stream may already be gone */ }
        try {
            res.end();
        } catch (_error) { /* already ended */ }
    }

    const watcher = createRevocationWatcher({
        checkStatus,
        intervalMs,
        onRevoked: () => terminate('credential-revoked'),
        onUnavailable: () => terminate('security-configuration-unavailable')
    });
    watcher.start();
    res.on?.('close', () => {
        terminated = true;
        watcher.stop();
    });

    return Object.freeze({
        /**
         * 写出前校验；校验失败终止流并返回 false。
         */
        async write(eventName, payload) {
            if (terminated) {
                return false;
            }
            const status = await checkStatus();
            if (!status?.ok) {
                terminate(status?.code === 'AGW_CONFIG_UNAVAILABLE'
                    ? 'security-configuration-unavailable'
                    : 'credential-revoked');
                return false;
            }
            writeEvent(res, eventName, payload);
            return true;
        },
        end() {
            terminated = true;
            watcher.stop();
            try {
                res.end();
            } catch (_error) { /* already ended */ }
        },
        get terminated() {
            return terminated;
        }
    });
}

module.exports = { createGuardedSseWriter };
