/**
 * 重试策略模块：提供退避时间计算、失败判定与下次重试时间生成。
 * @module execution/retryPolicy
 */

const { toLocalIsoString } = require('../utils/time');

/**
 * 计算退避等待秒数。
 * 算法：基础时间 * 尝试次数（至少为1），实现线性递增退避。
 *
 * @param {number} attempt 当前尝试次数（从1开始计数）
 * @param {number} baseSeconds 基础退避秒数，默认为30秒
 * @returns {number} 需要等待的秒数
 *
 * @example
 * resolveBackoffSeconds(1, 30)  // 返回 30
 * resolveBackoffSeconds(2, 30) // 返回 60
 * resolveBackoffSeconds(3, 30) // 返回 90
 */
function resolveBackoffSeconds(attempt, baseSeconds) {
  const normalizedAttempt = Math.max(1, Number(attempt || 1));
  const base = Math.max(1, Number(baseSeconds || 30));
  return base * normalizedAttempt;
}

/**
 * 判断是否应该将任务标记为最终失败。
 * 条件：当前尝试次数 >= 最大重试次数（最大重试次数至少为1）
 *
 * @param {number} attempt 当前尝试次数
 * @param {number} maxRetries 最大允许重试次数，默认为3
 * @returns {boolean} true表示应结束重试流程
 *
 * @example
 * shouldFinalizeFailure(3, 3)  // 返回 true，已达最大次数
 * shouldFinalizeFailure(2, 3) // 返回 false，仍可重试
 */
function shouldFinalizeFailure(attempt, maxRetries) {
  return Number(attempt || 0) >= Math.max(1, Number(maxRetries || 3));
}

/**
 * 构建下一次重试的时间戳（本地ISO格式）。
 * 计算方式：当前时间 + 退避秒数转换为毫秒
 *
 * @param {Date} now 当前时间对象
 * @param {number} attempt 当前尝试次数
 * @param {number} baseSeconds 基础退避秒数
 * @returns {string} 本地时区的ISO8601时间字符串
 *
 * @example
 * const now = new Date('2024-01-01T12:00:00Z');
 * buildNextRetryAt(now, 1, 30) // 返回 '2024-01-01T12:00:30.000+08:00'（假设东八区）
 */
function buildNextRetryAt(now, attempt, baseSeconds) {
  const offset = resolveBackoffSeconds(attempt, baseSeconds);
  return toLocalIsoString(new Date(now.getTime() + offset * 1000));
}

module.exports = {
  resolveBackoffSeconds,
  shouldFinalizeFailure,
  buildNextRetryAt
};
