'use strict';

/**
 * 冷知识索引规范化（设计 §3.2.1，M2.S2 T13）。
 *
 * rawContent → normalizeForIndex() → chunkText()：embedding、BM25 indexText、
 * text_preview 与 normalized chunk checksum 全部消费同一份规范化文本。
 * 原始文件 SHA-256 继续用于磁盘对账；_expandHits 仍从 rootPath 回读原始
 * 全文——Expand 契约不变。
 *
 * 两类已知 writer 格式（判定按文件名，K_ 前缀 / 数字_ 前缀）：
 * - K_ 知识卡：只移除首个 YAML frontmatter 中的顶层 sources 块，
 *   保留 title、oneLiner、type、subskill、tags 和正文；
 * - 编号长文档：只移除文档头部 blockquote 中的 `> 来源：` 与 `> 抓取时间：` 行。
 *
 * 不得误删：正文 URL、代码块内容、正文中的普通 sources: 字段、非首个 ---。
 * frontmatter 结构无法确定时显式抛错（摄取失败），不得静默回退为嵌入全部来源头。
 */

const crypto = require('node:crypto');

const NORMALIZER_NAME = 'forge-markdown-normalizer';
const NORMALIZER_VERSION = '1';
// 当前无配置旋钮；optionsHash 固定种子保证 provenance 稳定。
const NORMALIZER_OPTIONS = Object.freeze({ bom: 'strip', lineEndings: 'lf', formats: ['K_card', 'numbered'] });

function codedError(code, message, detail = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, detail);
    return error;
}

const K_CARD_PATTERN = /^K_[^/]+\.(md|markdown)$/i;
const NUMBERED_PATTERN = /^\d+[^/]*\.(md|markdown|txt)$/i;

/** 去除 BOM；统一行尾为 LF。仅作用于索引文本，不回写磁盘。 */
function preClean(raw) {
    return String(raw).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * 解析首个 frontmatter 的行界与顶层键。
 * 返回 { openAt, closeAt, topKeys } 或 null（无 frontmatter）。
 * 结构无法确定（起始 --- 无闭合 / 内容为空）→ 抛
 * TDB_NORMALIZE_FRONTMATTER_UNPARSEABLE（§3.2.1：显式摄取失败）。
 */
function locateFrontmatter(lines) {
    if (lines.length === 0 || lines[0].trimEnd() !== '---') return null;
    let closeAt = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trimEnd() === '---') {
            closeAt = i;
            break;
        }
    }
    if (closeAt === -1) {
        throw codedError('TDB_NORMALIZE_FRONTMATTER_UNPARSEABLE', 'frontmatter 以 --- 开始但没有闭合 ---', { lineCount: lines.length });
    }
    if (closeAt === 1) {
        throw codedError('TDB_NORMALIZE_FRONTMATTER_UNPARSEABLE', 'frontmatter 内容为空（--- 紧跟 ---）', {});
    }
    const topKeys = new Set();
    for (let i = 1; i < closeAt; i++) {
        const match = lines[i].match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
        if (match) topKeys.add(match[1]);
    }
    return { openAt: 0, closeAt, topKeys };
}

/**
 * 从 frontmatter 行段中摘除顶层 sources 块（含其后缩进续行/内联形式）。
 * 返回移除的行号列表；无 sources 键返回空数组。
 * 畸形（sources 键后缩进块越过闭合 --- / items 直通 EOF）由调用方行界保证。
 */
function locateTopLevelSourcesBlock(lines, openAt, closeAt) {
    const removed = [];
    for (let i = openAt + 1; i < closeAt; i++) {
        if (/^sources:\s*(.*)$/.test(lines[i])) {
            removed.push(i);
            let j = i + 1;
            while (j < closeAt) {
                const line = lines[j];
                if (line.trim() === '') {
                    removed.push(j); // 块内空行（随后若出现新顶层键则截断）
                    j += 1;
                    // 空行后若回到顶层键，则 sources 块到此为止——回退该空行。
                    if (j < closeAt && /^[A-Za-z_][A-Za-z0-9_-]*:/.test(lines[j])) {
                        removed.pop();
                        break;
                    }
                    continue;
                }
                if (/^[ \t]+/.test(line)) {
                    removed.push(j); // 缩进续行：列表项或嵌套键
                    j += 1;
                    continue;
                }
                break; // 顶层新键或闭合
            }
            break; // 只处理首个顶层 sources（§3.2.1：只移除首个 frontmatter 的顶层块）
        }
    }
    return removed;
}

/**
 * 摘除文档头部 blockquote 中的 writer 来源行（`> 来源：` / `> 抓取时间：`）。
 * 头部区域 = 自 bodyStart 起的标题行(#)/空行 + 其后首个连续 > 引用块
 * （writer 形制：# 标题 → 空行 → 引用块来源 → 正文）。正文中的引用、URL、
 * 代码块一律不动；一旦离开头部引用块即不再扫描。
 */
function locateLeadingSourceHeaderLines(lines, bodyStart) {
    const removed = [];
    let i = bodyStart;
    // 跳过头部标题与空行。
    while (i < lines.length && (lines[i].trim() === '' || /^#{1,6}\s/.test(lines[i]))) i++;
    // 其后必须是引用块，否则文档没有头部来源块。
    if (i >= lines.length || !/^>/.test(lines[i])) return removed;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '') continue; // 引用块内允许空行间隔
        if (!/^>/.test(line)) break; // 引用块（及头部）结束
        const content = line.replace(/^>\s?/, '');
        if (/^来源[：:]/.test(content) || /^抓取时间[：:]/.test(content)) {
            removed.push(i);
        }
    }
    return removed;
}

/**
 * 规范化入口。
 * @param {string} rawContent 原始全文
 * @param {{fileName?: string}} options 文件名（判定 writer 格式）
 * @returns {{text: string, removed: {frontmatterSourcesBlock: number, sourceHeaderLines: number}, kind: 'K_card'|'numbered'|'plain'}}
 */
function normalizeForIndex(rawContent, options = {}) {
    if (typeof rawContent !== 'string') {
        throw codedError('TDB_NORMALIZE_INPUT_INVALID', 'normalizeForIndex 需要 string 输入');
    }
    const fileName = String(options.fileName || '');
    const text = preClean(rawContent);
    const lines = text.split('\n');
    const isCard = K_CARD_PATTERN.test(fileName);
    const isNumbered = NUMBERED_PATTERN.test(fileName);

    let removed = { frontmatterSourcesBlock: 0, sourceHeaderLines: 0 };
    let drop = new Set();

    const fm = isCard ? locateFrontmatter(lines) : null; // 畸形头在 locate 内显式抛错
    if (fm) {
        const sourcesLines = locateTopLevelSourcesBlock(lines, fm.openAt, fm.closeAt);
        sourcesLines.forEach((index) => drop.add(index));
        removed.frontmatterSourcesBlock = sourcesLines.length;
    }

    const bodyStart = fm ? fm.closeAt + 1 : 0;
    if (isNumbered || !fm) {
        const headerLines = locateLeadingSourceHeaderLines(lines, bodyStart);
        headerLines.forEach((index) => drop.add(index));
        removed.sourceHeaderLines = headerLines.length;
    }

    const normalized = lines.filter((_, index) => !drop.has(index)).join('\n');
    return {
        text: normalized,
        removed,
        kind: isCard ? 'K_card' : isNumbered ? 'numbered' : 'plain'
    };
}

/** provenance 身份（§3.1.3 schemaVersion 2）：实现哈希 + 有效配置哈希。 */
function normalizerIdentity() {
    const implementationHash = `sha256:${crypto.createHash('sha256').update(require('node:fs').readFileSync(__filename)).digest('hex')}`;
    const optionsHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(NORMALIZER_OPTIONS)).digest('hex')}`;
    return {
        name: NORMALIZER_NAME,
        version: NORMALIZER_VERSION,
        implementationHash,
        optionsHash
    };
}

module.exports = {
    normalizeForIndex,
    normalizerIdentity,
    NORMALIZER_NAME,
    NORMALIZER_VERSION,
    NORMALIZER_OPTIONS,
    K_CARD_PATTERN,
    NUMBERED_PATTERN,
    locateFrontmatter,
    locateTopLevelSourcesBlock,
    locateLeadingSourceHeaderLines
};
