const fs = require('fs/promises');

/**
 * 文件锁工具：基于 lock 文件实现跨异步写入互斥。
 */

/**
 * 异步休眠。
 *
 * @param {number} ms 毫秒数
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取文件锁。
 * 关键逻辑：
 * - 通过 fs.open(lockPath, 'wx') 实现“仅当不存在时创建”；
 * - 竞争失败（EEXIST）时按固定间隔重试；
 * - 超时仍未获取则抛错，交由上层处理。
 *
 * @param {string} lockPath 锁文件路径
 * @param {object} [options={}] 互斥参数
 * @param {number} [options.timeoutMs=2000] 获取锁超时时间
 * @param {number} [options.retryIntervalMs=50] 重试间隔
 * @returns {Promise<{release: () => Promise<void>}>} 锁句柄
 */
async function acquireFileLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      return {
        async release() {
          try {
            await handle.close();
          } finally {
            await fs.rm(lockPath, { force: true });
          }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      await sleep(retryIntervalMs);
    }
  }

  throw new Error(`Failed to acquire lock within timeout: ${lockPath}`);
}

module.exports = {
  acquireFileLock
};
