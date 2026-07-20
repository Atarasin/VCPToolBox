'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

/**
 * Download nonce store（§6 / M4.S2）。
 *
 * 一次性语义由 consumeOnce() 保证：先完成签名/owner/expiry/artifact 校验，
 * 再在输出任何响应 body 前原子消费 nonce；消费后传输失败不恢复。
 * 多 worker 部署必须使用共享且可跨重启的 backend；
 * 没有生产级 store 时 mint endpoint 返回 503，不能降级为进程内 Map。
 *
 * 仓库提供两个 backend：
 * - in-memory：仅供单进程开发/测试（`production: false`）。
 * - file：`AGENT_GATEWAY_DOWNLOAD_NONCE_DIR` 指定目录，用 O_CREAT|O_EXCL
 *   独占建档实现跨进程原子消费，文件本身即跨重启持久记录（`production:
 *   true`，适用于单机多 worker；跨主机部署经 pluginManager 注入外部
 *   backend，如共享 KV store）。
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

/**
 * 文件 backend：每个 nonce 一个 `<expiresAtMs>-<sha256(nonce)>.nonce` 文件，
 * `wx`（O_CREAT|O_EXCL）建档在 POSIX 上跨进程原子——首个建档成功者获得
 * 唯一一次消费权；文件存在即已消费，重启后仍然有效。清理按文件名内嵌的
 * expiresAt 延后 CLOCK_SKEW_MS 执行，最多每分钟扫描一次。
 */
function createFileDownloadNonceBackend({ dir, now = () => Date.now() } = {}) {
    const normalizedDir = typeof dir === 'string' ? dir.trim() : '';
    if (!normalizedDir) {
        throw new Error('createFileDownloadNonceBackend requires a dir');
    }
    fs.mkdirSync(normalizedDir, { recursive: true });
    let lastCleanupAt = 0;

    function nonceFileName(nonce, expiresAt) {
        const digest = crypto.createHash('sha256').update(String(nonce), 'utf8').digest('hex');
        return `${Math.trunc(expiresAt)}-${digest}.nonce`;
    }

    async function cleanupExpired(timestamp) {
        if (timestamp - lastCleanupAt < 60_000) return;
        lastCleanupAt = timestamp;
        let entries;
        try {
            entries = await fsPromises.readdir(normalizedDir);
        } catch (_) { return; }
        for (const entry of entries) {
            const match = /^(\d+)-[0-9a-f]{64}\.nonce$/.exec(entry);
            if (!match) continue;
            if (Number(match[1]) + CLOCK_SKEW_MS < timestamp) {
                await fsPromises.unlink(path.join(normalizedDir, entry)).catch(() => {});
            }
        }
    }

    return {
        production: true,
        async consume(nonce, expiresAt) {
            const timestamp = now();
            await cleanupExpired(timestamp);
            if (expiresAt + CLOCK_SKEW_MS < timestamp) return false; // expired
            const filePath = path.join(normalizedDir, nonceFileName(nonce, expiresAt));
            try {
                const handle = await fsPromises.open(filePath, 'wx');
                await handle.close();
                return true;
            } catch (error) {
                if (error && error.code === 'EEXIST') return false; // already consumed
                throw error;
            }
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
    createFileDownloadNonceBackend,
    createInMemoryDownloadNonceBackend
};
