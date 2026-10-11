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

/**
 * 从（疑似被 max_tokens 截断的）输出里按锚点字段抢救完整的数组元素对象。
 * 逐字符扫描并跳过字符串字面量内部的 {}/引号，只收集完整闭合且可 JSON.parse
 * 的元素——截断在半途的那个单元自然被丢弃。
 */
function extractCompleteArrayObjects(text, anchor) {
    if (typeof text !== 'string') {
        return [];
    }
    const anchorIndex = text.indexOf(anchor);
    if (anchorIndex === -1) {
        return [];
    }
    const arrayStart = text.indexOf('[', anchorIndex + anchor.length);
    if (arrayStart === -1) {
        return [];
    }
    const objects = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = arrayStart; i < text.length; i += 1) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            if (depth === 0) {
                start = i;
            }
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                try {
                    objects.push(JSON.parse(text.slice(start, i + 1)));
                } catch {
                    // 单个元素损坏跳过，不影响其余抢救。
                }
                start = -1;
            } else if (depth < 0) {
                break;
            }
        }
    }
    return objects;
}

/**
 * 整体 JSON.parse 失败后的兜底：按蒸馏输出契约抢救 knowledgeUnits /
 * droppedSources 的完整元素。一个完整单元都捞不到时返回 null（调用方
 * 走重试/拆半/失败留档路径）。
 */
function salvageTruncatedPayload(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const knowledgeUnits = extractCompleteArrayObjects(text, '"knowledgeUnits"');
    if (knowledgeUnits.length === 0) {
        return null;
    }
    return {
        knowledgeUnits,
        droppedSources: extractCompleteArrayObjects(text, '"droppedSources"'),
        salvaged: true
    };
}

module.exports = {
    extractJsonObject,
    extractCompleteArrayObjects,
    salvageTruncatedPayload
};
