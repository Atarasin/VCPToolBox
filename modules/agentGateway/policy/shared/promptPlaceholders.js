/**
 * 检索型提示词占位符的 canonical 判定。
 *
 * Gateway 侧曾各自散落一套只认「日记本」的正则（RAG 渲染闸门、
 * placeholder 统计），而 RAGDiaryPlugin 自己的闸门
 * （`Plugin/RAGDiaryPlugin/DirectDiaryTextProcessor.js`）同时认「知识库」。
 * 闸门是插件闸门的真子集，后果是：提示词里只有 `[[X知识库]]` 占位符的
 * agent，`processMessages` 一次都不会被调用，冷知识库整段拿不到——
 * 静默失效，渲染结果里只留下未替换的占位符。
 *
 * 本模块是两类判定的唯一实现，渲染闸门与依赖统计都必须复用：
 *   - retrieval：日记本 ∪ 知识库，决定「要不要走 RAG」
 *   - knowledge：仅冷知识库，决定「语料有没有真的注入」
 */

// 四种占位符语法。body 用否定字符类而不是 `.*?`，避免跨占位符吞并。
const PLACEHOLDER_FORMS = Object.freeze([
    { open: '\\[\\[', close: '\\]\\]', body: '[^\\[\\]]*' },
    { open: '<<', close: '>>', body: '[^<>]*' },
    { open: '《《', close: '》》', body: '[^《》]*' },
    { open: '\\{\\{', close: '\\}\\}', body: '[^{}]*' }
]);

const DIARY_MARKER = '日记本';
const KNOWLEDGE_MARKER = '知识库';

function buildPatternSource(markerSource) {
    return PLACEHOLDER_FORMS
        .map(({ open, close, body }) => `${open}${body}${markerSource}${body}${close}`)
        .join('|');
}

const RETRIEVAL_PATTERN_SOURCE = buildPatternSource(`(?:${DIARY_MARKER}|${KNOWLEDGE_MARKER})`);
const KNOWLEDGE_PATTERN_SOURCE = buildPatternSource(KNOWLEDGE_MARKER);

/**
 * `[[vcp知识库日记本]]` 的完整日记本名是「vcp知识库」，指向 dailynote/，
 * 不是 knowledge/ 下的冷知识库——与 TDBPlaceholderProcessor
 * `isDiaryPlaceholderAmbiguity()` 同一条规则。
 */
const KNOWLEDGE_DIARY_AMBIGUITY = new RegExp(`${KNOWLEDGE_MARKER}${DIARY_MARKER}(?=$|:|\\]|>|》|\\})`);

// 每次调用现建 RegExp：带 g 标志的实例有 lastIndex 状态，不可跨调用共享。
function collectMatches(text, patternSource) {
    if (typeof text !== 'string' || text.length === 0) {
        return [];
    }
    return text.match(new RegExp(patternSource, 'g')) || [];
}

/**
 * 日记本 ∪ 冷知识库占位符（RAG 渲染闸门的判定面）。
 */
function collectRetrievalPlaceholders(text) {
    return collectMatches(text, RETRIEVAL_PATTERN_SOURCE);
}

/**
 * 仅冷知识库占位符，已排除 `[[X知识库日记本]]` 这类日记本歧义写法。
 */
function collectKnowledgePlaceholders(text) {
    return collectMatches(text, KNOWLEDGE_PATTERN_SOURCE)
        .filter((match) => !KNOWLEDGE_DIARY_AMBIGUITY.test(match));
}

function hasRetrievalPlaceholder(text) {
    return collectRetrievalPlaceholders(text).length > 0;
}

module.exports = {
    KNOWLEDGE_PATTERN_SOURCE,
    RETRIEVAL_PATTERN_SOURCE,
    collectKnowledgePlaceholders,
    collectRetrievalPlaceholders,
    hasRetrievalPlaceholder
};
