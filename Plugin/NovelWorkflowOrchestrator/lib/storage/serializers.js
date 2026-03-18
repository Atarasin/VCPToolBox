/**
 * 序列化工具：输出可读且稳定排序的 JSON 字符串。
 */

/**
 * 将对象格式化为缩进 JSON 并补充换行。
 *
 * @param {any} value 待序列化值
 * @returns {string} 美化后的 JSON 字符串
 */
function toPrettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 递归按键名排序对象，保证同一语义对象输出顺序稳定。
 *
 * @param {any} value 待排序值
 * @returns {any} 排序后的值
 */
function stableSortObject(value) {
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableSortObject(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * 输出稳定排序的美化 JSON。
 *
 * @param {any} value 待序列化值
 * @returns {string} 稳定序列化结果
 */
function toStablePrettyJson(value) {
  return toPrettyJson(stableSortObject(value));
}

module.exports = {
  toPrettyJson,
  toStablePrettyJson
};
