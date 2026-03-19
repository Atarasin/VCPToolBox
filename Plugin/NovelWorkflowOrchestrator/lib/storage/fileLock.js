/**
 * 文件锁工具模块：基于 lock 文件实现跨异步写入的互斥访问。
 * 核心原理：利用 fs.open 的 'wx' 模式（仅当文件不存在时创建）实现竞争检测。
 * 使用场景：防止多个异步任务同时写入同一文件导致数据损坏。
 * @module storage/fileLock
 */

const fs = require('fs/promises');

/**
 * 异步休眠函数。
 * 实现方式：返回一个指定毫秒后 resolve 的 Promise。
 * 常用于锁竞争时的等待重试。
 *
 * @param {number} ms 休眠毫秒数
 * @returns {Promise<void>} 休眠完成后 resolve
 *
 * @example
 * await sleep(50); // 休眠50毫秒
 */
async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 获取文件锁。
 * 关键算法：
 * 1. 使用 fs.open(lockPath, 'wx') 尝试创建锁文件
 * 2. 若抛出 EEXIST 错误，说明锁已被其他进程持有，进入重试循环
 * 3. 设置超时机制，超过 timeoutMs 未获取锁则抛错
 * 4. 返回的 release() 函数用于主动释放锁（关闭文件描述符并删除锁文件）
 *
 * @param {string} lockPath 锁文件绝对路径
 * @param {object} [options={}] 锁获取选项
 * @param {number} [options.timeoutMs=2000] 获取锁超时时间，默认2秒
 * @param {number} [options.retryIntervalMs=50] 重试间隔，默认50毫秒
 * @returns {Promise<{release: () => Promise<void>}>} 锁句柄，包含 release 方法用于释放锁
 * @throws {Error} 获取锁超时后抛出错误
 *
 * @example
 * const lock = await acquireFileLock('/tmp/myfile.lock', { timeoutMs: 5000 });
 * try {
 *   // 执行需要互斥的操作
 *   await fs.writeFile('/tmp/myfile.json', data);
 * } finally {
 *   // 确保释放锁
 *   await lock.release();
 * }
 *
 * @example
 * // 锁竞争失败示意
 * // 进程A获取锁成功，创建了 /path/to/file.lock
 * // 进程B尝试获取锁，fs.open 抛出 EEXIST，进入50ms重试
 * // 进程A执行完毕后调用 lock.release() 删除锁文件
 * // 进程B在重试时成功创建锁文件，获取锁
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
