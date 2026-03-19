/**
 * 时间工具模块：提供本地时区的 ISO8601 时间字符串与紧凑时间戳生成。
 * @module utils/time
 */

/**
 * 将 Date 对象转换为本地时区的 ISO8601 时间字符串。
 * 算法步骤：
 * 1. 获取当前时区偏移量（分钟）
 * 2. 将偏移量转换为 +/-HH:MM 格式
 * 3. 将 UTC 时间转换为本地时间后拼接时区偏移
 *
 * @param {Date} [now=new Date()] 待转换的日期对象，默认为当前时间
 * @returns {string} 本地时区的 ISO8601 字符串，精度到毫秒（.SSS）
 *
 * @example
 * // 在东八区运行
 * toLocalIsoString(new Date('2024-01-01T04:00:00Z'))
 * // 返回 '2024-01-01T12:00:00.000+08:00'
 *
 * @example
 * // 在 UTC 运行
 * toLocalIsoString(new Date('2024-01-01T00:00:00Z'))
 * // 返回 '2024-01-01T00:00:00.000+00:00'
 */
function toLocalIsoString(now = new Date()) {
  const tzMinutes = -now.getTimezoneOffset();
  const sign = tzMinutes >= 0 ? '+' : '-';
  const absMinutes = Math.abs(tzMinutes);
  const offsetHours = String(Math.floor(absMinutes / 60)).padStart(2, '0');
  const offsetMinutes = String(absMinutes % 60).padStart(2, '0');
  const localDate = new Date(now.getTime() + tzMinutes * 60 * 1000);
  return `${localDate.toISOString().slice(0, 23)}${sign}${offsetHours}:${offsetMinutes}`;
}

/**
 * 生成紧凑型本地时间戳（精确到秒）。
 * 格式：YYYYMMDDHHmmss（14位数字）
 * 主要用途：生成文件名、排序标识等需要紧凑格式的场景
 *
 * @param {Date} [now=new Date()] 待转换的日期对象，默认为当前时间
 * @returns {string} 14位紧凑时间戳字符串
 *
 * @example
 * // 在东八区运行，2024年1月1日中午12点
 * toLocalCompactTimestamp(new Date('2024-01-01T04:00:00Z'))
 * // 返回 '20240101120000'
 *
 * @example
 * // 常用于生成唯一文件名
 * const ts = toLocalCompactTimestamp(new Date());
 * // 例如：'20240101153045'
 * const filename = `checkpoint_${projectId}_${ts}.json`;
 */
function toLocalCompactTimestamp(now = new Date()) {
  return toLocalIsoString(now).replace(/[^\d]/g, '').slice(0, 14);
}

module.exports = {
  toLocalIsoString,
  toLocalCompactTimestamp
};
