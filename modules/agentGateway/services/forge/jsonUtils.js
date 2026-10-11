'use strict';

/**
 * LLM 输出的宽松 JSON 提取：容忍代码围栏与前后杂文。
 *
 * 两级策略：
 * 1. 快路径：剥掉所有 ``` / ```json 围栏后取首 `{` 到末 `}` 的整体跨度（历史行为）；
 * 2. 平衡扫描：整体跨度解析失败时，字符串感知地逐个 `{` 起点找**首个可解析的
 *    完整对象**——覆盖「JSON 前后有带大括号的散文」「一次输出多个对象」
 *    「围栏内外夹注释」等污染形态（2026-10-11 出题/蒸馏抖动实测）。
 */

function stripCodeFences(text) {
    return text.replace(/```(?:json)?/gi, '');
}

// 从 start 起做字符串感知的括号平衡扫描；返回完整对象的文本切片，未闭合返回 null。
function scanBalancedObject(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
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
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
            if (depth < 0) {
                return null;
            }
        }
    }
    return null;
}

function extractJsonObject(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const cleaned = stripCodeFences(text);
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
            // 落入平衡扫描。
        }
    }
    for (let i = cleaned.indexOf('{'); i !== -1; i = cleaned.indexOf('{', i + 1)) {
        const candidate = scanBalancedObject(cleaned, i);
        if (candidate === null) {
            continue;
        }
        try {
            return JSON.parse(candidate);
        } catch {
            // 试下一个起点。
        }
    }
    return null;
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
