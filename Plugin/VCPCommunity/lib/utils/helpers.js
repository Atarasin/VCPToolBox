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
 * @returns {string} 本地时间格式的时间戳
 */
function getTimestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const year = now.getFullYear();
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const hours = pad(now.getHours());
    const minutes = pad(now.getMinutes());
    const seconds = pad(now.getSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

module.exports = {
    sanitizeFilename,
    getTimestamp,
};
