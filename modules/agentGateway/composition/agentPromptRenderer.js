const messageProcessor = require('../../messageProcessor');

const { hasRetrievalPlaceholder } = require('../policy/shared/promptPlaceholders');
const { findLatestMessageText, resolveRetrievalQuery } = require('../policy/shared/retrievalQuery');

const DEFAULT_RENDER_VARIABLE_PASSES = 3;
const DEFAULT_RENDER_QUERY_LENGTH = 1200;

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function applyRenderVariables(text, variables) {
    let rendered = String(text || '');
    for (const [key, value] of Object.entries(variables || {})) {
        rendered = rendered.replaceAll(`{{${key}}}`, value == null ? '' : String(value));
    }
    return rendered;
}

function createRenderContext(pluginManager, overrides = {}) {
    return {
        pluginManager,
        cachedEmojiLists: overrides.cachedEmojiLists || new Map(),
        detectors: overrides.detectors || [],
        superDetectors: overrides.superDetectors || [],
        DEBUG_MODE: Boolean(overrides.DEBUG_MODE),
        messages: Array.isArray(overrides.messages) ? overrides.messages : [],
        // 一级检索式：优先于 messages，供只想给一句话的调用方使用。
        query: typeof overrides.query === 'string' ? overrides.query : '',
        expandedAgentName: null,
        expandedToolboxes: new Set()
    };
}

function unwrapMultilineBracePayloads(text) {
    return String(text || '').replace(/\{\{([\s\S]*?\n[\s\S]*?)\}\}/g, '$1');
}

async function renderVariablePasses(text, model, renderContext) {
    let current = String(text || '');
    for (let pass = 0; pass < DEFAULT_RENDER_VARIABLE_PASSES; pass += 1) {
        const next = unwrapMultilineBracePayloads(
            await messageProcessor.replaceAgentVariables(current, model, 'system', renderContext)
        );
        if (next === current) return next;
        current = next;
    }
    return unwrapMultilineBracePayloads(current);
}

function buildFallbackQuery(text, agentId) {
    const normalized = String(text || '').replace(/\{\{[^{}]+\}\}|\[\[[^\]]+\]\]|<<[^>]+>>|《《[^》]+》》/g, ' ')
        .replace(/\s+/g, ' ').trim();
    return normalized.slice(0, DEFAULT_RENDER_QUERY_LENGTH) ||
        `Render the canonical prompt for agent ${normalizeString(agentId) || 'unknown-agent'}.`;
}

function buildRagMessages(renderedText, renderContext, agentId) {
    const messages = renderContext.messages || [];
    const resolved = resolveRetrievalQuery({ query: renderContext.query, messages });
    const result = [{ role: 'system', content: renderedText }, {
        role: 'user',
        content: resolved.query || buildFallbackQuery(renderedText, agentId)
    }];
    const assistant = findLatestMessageText(messages, 'assistant');
    if (assistant) result.push({ role: 'assistant', content: assistant });
    return result;
}

// 闸门必须与 RAGDiaryPlugin 自己的闸门同宽：只认「日记本」会把冷知识库
// （`[[X知识库]]`）整段挡在 processMessages 之外，且静默无痕。
function needsRagRender(text) {
    return hasRetrievalPlaceholder(text)
        || /(\[\[VCP元思考.*\]\]|\[\[AIMemo=True\]\])/.test(text);
}

function createHostPromptRenderer(pluginManager, ragRetrieverPort, customRenderer) {
    return async function renderPrompt({ agentId, rawPrompt, model, renderVariables, renderOptions = {} }) {
        const renderContext = createRenderContext(pluginManager, renderOptions);
        if (typeof customRenderer === 'function') {
            return customRenderer({
                agentId,
                rawPrompt,
                model,
                renderVariables,
                renderContext
            });
        }
        const withVariables = applyRenderVariables(rawPrompt, renderVariables);
        const rendered = await renderVariablePasses(withVariables, model, renderContext);
        if (!needsRagRender(rendered) || !ragRetrieverPort?.capabilities?.().processMessages) return rendered;
        const processed = await ragRetrieverPort.processMessages(buildRagMessages(rendered, renderContext, agentId), {});
        return typeof processed?.[0]?.content === 'string' ? processed[0].content : rendered;
    };
}

module.exports = { createHostPromptRenderer, needsRagRender };
