'use strict';

/**
 * LLM 输出的宽松 JSON 提取：容忍代码围栏与前后杂文，取首个平衡的 JSON 对象。
 */

function extractJsonObject(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
        return null;
    }
    try {
        return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
        return null;
    }
}

module.exports = {
    extractJsonObject
};
