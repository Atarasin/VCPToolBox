/**
 * 辅助函数：安全文件名处理
 * 替换非法字符并截断长度，防止文件系统错误。
 * @param {string} name 原始名称
 * @returns {string} 安全的文件名
 */
function sanitizeFilename(name) {
    return name.replace(/[\\/:\*\?"<>\|]/g, '_').slice(0, 50);
}

/**
 * 辅助函数：获取当前时间戳
 * @returns {string} ISO 8601 格式的时间戳
 */
function getTimestamp() {
    return new Date().toISOString();
}

module.exports = {
    sanitizeFilename,
    getTimestamp,
};
