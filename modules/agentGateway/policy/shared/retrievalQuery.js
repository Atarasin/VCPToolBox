/**
 * RAG 检索 query 的 canonical 解析。
 *
 * 渲染 agent 提示词时，日记本／冷知识库占位符按一条 query 检索后注入。
 * 该 query 的来源优先级只在这里定义一次：
 *
 *   1. `query`    —— 调用方显式给出的检索式（一级参数，最可靠）
 *   2. `messages` —— 最近一条 user 消息（宿主传对话上下文时的兼容路径）
 *   3. fallback   —— 两者都没有，退化成拿提示词自身文本去检索
 *
 * 第 3 种是**降级**：检索命中的是与用户问题无关的片段，而占位符照样被替换，
 * 表面看不出任何异常。渲染层据此产出 warning，调用方才有机会带上 query 重试。
 * 渲染闸门与元数据统计必须复用本模块，避免两处各判一次而漂移。
 */

const RETRIEVAL_QUERY_SOURCES = Object.freeze({
    QUERY: 'query',
    MESSAGES: 'messages',
    FALLBACK: 'fallback'
});

function extractMessageText(message) {
    if (typeof message?.content === 'string') {
        return message.content.trim();
    }
    if (!Array.isArray(message?.content)) {
        return '';
    }
    return message.content
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
        .trim();
}

function findLatestMessageText(messages, role) {
    const list = Array.isArray(messages) ? messages : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index]?.role === role) {
            const text = extractMessageText(list[index]);
            if (text) {
                return text;
            }
        }
    }
    return '';
}

/**
 * @returns {{ query: string, source: 'query'|'messages'|'fallback' }}
 *          `fallback` 时 query 为空串，由渲染层用提示词自身文本兜底。
 */
function resolveRetrievalQuery({ query, messages } = {}) {
    const explicitQuery = typeof query === 'string' ? query.trim() : '';
    if (explicitQuery) {
        return { query: explicitQuery, source: RETRIEVAL_QUERY_SOURCES.QUERY };
    }
    const latestUserText = findLatestMessageText(messages, 'user');
    if (latestUserText) {
        return { query: latestUserText, source: RETRIEVAL_QUERY_SOURCES.MESSAGES };
    }
    return { query: '', source: RETRIEVAL_QUERY_SOURCES.FALLBACK };
}

module.exports = {
    RETRIEVAL_QUERY_SOURCES,
    extractMessageText,
    findLatestMessageText,
    resolveRetrievalQuery
};
