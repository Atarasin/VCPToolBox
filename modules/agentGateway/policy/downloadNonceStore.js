'use strict';

const crypto = require('crypto');

/**
 * Download nonce store（§6 / M4.S2）。
 *
 * 一次性语义由 consumeOnce() 保证：先完成签名/owner/expiry/artifact 校验，
 * 再在输出任何响应 body 前原子消费 nonce；消费后传输失败不恢复。
 * 多 worker 部署必须注入共享且可跨重启的 backend；
 * 没有生产级 store 时 mint endpoint 返回 503，不能降级为进程内 Map。
 * 仓库内置内存实现仅供单进程开发/测试（非生产）。
 */

const CLOCK_SKEW_MS = 30_000;

function createInMemoryDownloadNonceBackend() {
    const store = new Map();
    return {
        production: false,
        async consume(nonce, expiresAt) {
            const now = Date.now();
            // TTL 清理
            for (const [k, v] of store.entries()) {
                if (v.expiresAt + CLOCK_SKEW_MS < now) store.delete(k);
            }
            if (store.has(nonce)) return false; // already consumed
            if (expiresAt + CLOCK_SKEW_MS < now) return false; // expired
            store.set(nonce, { expiresAt });
            return true;
        }
    };
}

function createDownloadNonceStore({ backend = null } = {}) {
    const b = backend || createInMemoryDownloadNonceBackend();
    return {
        production: Boolean(b.production),
        /**
         * 原子消费 nonce。返回 true 表示首次消费成功；false 表示已用或过期。
         * 调用方必须在输出任何响应 body 前调用此方法。
         */
        async consumeOnce(nonce, expiresAt) {
            if (!nonce || typeof expiresAt !== 'number') return false;
            return b.consume(nonce, expiresAt);
        }
    };
}

module.exports = {
    CLOCK_SKEW_MS,
    createDownloadNonceStore,
    createInMemoryDownloadNonceBackend
};
