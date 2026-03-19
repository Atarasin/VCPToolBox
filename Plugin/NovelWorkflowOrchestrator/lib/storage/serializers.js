/**
 * 序列化工具模块：提供稳定排序的美化 JSON 输出。
 * 核心用途：确保相同语义的数据对象序列化后字符串一致，便于：
 * 1. 文件内容对比和版本控制
 * 2. 生成稳定可复现的签名或哈希
 * 3. 测试中断言的一致性验证
 * @module storage/serializers
 */

/**
 * 将对象格式化为带缩进的美化 JSON 字符串，并在末尾追加换行符。
 * 底层使用 JSON.stringify(value, null, 2) 实现缩进。
 *
 * @param {any} value 待序列化的值（可以是任意 JSON 可序列化类型）
 * @returns {string} 美化后的 JSON 字符串，末尾包含一个换行符
 *
 * @example
 * toPrettyJson({ a: 1, b: 2 })
 * // 返回：
 * // "{\n  \"a\": 1,\n  \"b\": 2\n}\n"
 */
function toPrettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * 递归地对对象进行按键名排序。
 * 排序规则：
 * 1. 数组保持原顺序，仅对数组元素递归排序
 * 2. 普通对象按键名字典序排序后重新组装
 * 3. 递归应用到所有嵌套层级的对象
 *
 * @param {any} value 待排序的值
 * @returns {any} 排序后的值（结构与输入相同，但键顺序已排序）
 *
 * @example
 * stableSortObject({ b: 2, a: 1 })
 * // 返回 { a: 1, b: 2 }
 *
 * @example
 * // 嵌套对象排序示例
 * stableSortObject({ z: { c: 3, b: 2, a: 1 }, y: 2, x: 1 })
 * // 返回 { x: 1, y: 2, z: { a: 1, b: 2, c: 3 } }
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
 * 组合 toPrettyJson 和 stableSortObject，实现：
 * 1. 对象按键名递归排序
 * 2. 输出格式化缩进
 * 3. 末尾追加换行符
 *
 * @param {any} value 待序列化的值
 * @returns {string} 稳定排序后的美化 JSON 字符串
 *
 * @example
 * const obj = { z: 3, items: [{ b: 2, a: 1 }], a: 1 };
 * toStablePrettyJson(obj);
 * // 返回（键按字典序排列）：
 * // "{\n  \"a\": 1,\n  \"items\": [\n    {\n      \"a\": 1,\n      \"b\": 2\n    }\n  ],\n  \"z\": 3\n}\n"
 */
function toStablePrettyJson(value) {
  return toPrettyJson(stableSortObject(value));
}

module.exports = {
  toPrettyJson,
  stableSortObject,
  toStablePrettyJson
};
