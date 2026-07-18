const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const { collectRagItems } = require('./ragRetriever');
const {
    aggregateDeduplicateItems,
    applyTruncate,
    createRecallBlock,
    deduplicateItems,
    interleaveItems,
    itemKey,
    sortItemsByScore
} = require('./recallItem');
const { applyBudgetPostProcessing } = require('./tokenBudget');
const support = require('./runtimeSupport');
const modifiers = require('./modifiers');
const { createRecallPipeline } = require('./pipeline');
const { defaultFullTextRetriever } = require('./fullTextRetriever');
const fullText = require('./fullTextRetriever');
const {
    FULL_TEXT_RULE_TYPES,
    GATED_RULE_TYPES,
    buildRagOptionsFromModifiers,
    evaluateGate,
    normalizeString,
    parseModifierValue,
    resolveRoleValveMessages,
    resolveRuleKMultiplier,
    resolveRuleProjection,
    resolveRuleTargetMode,
    resolveRuleType
} = support;
const {
    applyAIMemo,
    applyS02Modifiers,
    defaultAiMemoConfigLoader,
    parseRoleValveConfig,
    evaluateRoleValveExpression
} = modifiers;

function buildRecallResult({ success, agentId, profileName, items, diagnostics, error, code, status }) {
    return {
        success: success !== false,
        agentId: agentId || null,
        profileName: profileName || null,
        items: Array.isArray(items) ? items : [],
        diagnostics: diagnostics || { totalDurationMs: 0, rules: [], pipelineStages: [], profileMeta: null },
        error: error || null,
        code: code || null,
        status: status || (success !== false ? 200 : 500)
    };
}

function mapResolvedRecallFailure(resolved, normalizedAgentId, requestedProfileName) {
    const rawCode = normalizeString(resolved?.code);
    if (rawCode === 'RECALL_FORBIDDEN' || rawCode === AGW_ERROR_CODES.RECALL_FORBIDDEN) {
        const forbiddenProfileName = resolved?.profileName || requestedProfileName || null;
        return {
            code: AGW_ERROR_CODES.RECALL_FORBIDDEN,
            error: forbiddenProfileName
                ? `Recall profile "${forbiddenProfileName}" is not allowed for agent "${normalizedAgentId}"`
                : `Recall access denied for agent "${normalizedAgentId}"`,
            status: 403
        };
    }
    if (rawCode === 'RECALL_INVALID_PROFILE' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_PROFILE) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_PROFILE,
            error: resolved?.details?.message || `Invalid recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_RULE' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_RULE) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_RULE,
            error: resolved?.details?.message || `Invalid rule in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_MODIFIER' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_MODIFIER) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_MODIFIER,
            error: resolved?.details?.message || `Invalid modifier in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    if (rawCode === 'RECALL_INVALID_DIARY' || rawCode === AGW_ERROR_CODES.RECALL_INVALID_DIARY) {
        return {
            code: AGW_ERROR_CODES.RECALL_INVALID_DIARY,
            error: resolved?.details?.message || `Invalid diary access in recall profile for agent "${normalizedAgentId}"`,
            status: 400,
            details: resolved?.details || {}
        };
    }
    return {
        code: AGW_ERROR_CODES.RECALL_NO_PROFILE,
        error: `No recall profile resolved for agent "${normalizedAgentId}"`,
        status: 404
    };
}

/**
 * Recall Runtime Service — 编译并执行预置召回配置。
 *
 * 工厂函数接收依赖注入：
 *   - ragRetrieverPort       RAG 检索窄端口
 *   - recallProfileResolver   配置文件解析器（resolveForAgent）
 *   - embeddingUtilsLoader    Embedding 工具加载器（可选，用于 gated_rag 向量计算）
 */
function createRecallRuntimeService(deps = {}) {
    const profileResolver = deps.recallProfileResolver;
    if (!profileResolver) {
        throw new Error('[RecallRuntimeService] recallProfileResolver is required');
    }
    const dependencies = {
        deps,
        ragRetrieverPort: deps.ragRetrieverPort,
        ragConfig: deps.ragConfig || deps.ports?.configuration?.rag || {},
        profileResolver,
        defaultAgentPolicyResolver: deps.agentPolicyResolver || null,
        aiMemoConfigLoader: deps.aiMemoConfigLoader || defaultAiMemoConfigLoader,
        fullTextRetriever: typeof deps.fullTextRetriever === 'function'
            ? deps.fullTextRetriever
            : (params) => defaultFullTextRetriever({
                ...params,
                ragRetrieverPort: deps.ragRetrieverPort,
                ragConfig: deps.ragConfig || deps.ports?.configuration?.rag || {}
            }),
        collectRagItems: typeof deps.collectRagItems === 'function' ? deps.collectRagItems : collectRagItems,
        buildRecallResult,
        mapResolvedRecallFailure
    };
    return { executeRecall: createRecallPipeline(dependencies) };
}

module.exports = {
    createRecallRuntimeService,
    buildRecallResult,
    mapResolvedRecallFailure,
    applyBudgetPostProcessing,
    ...support,
    ...modifiers,
    ...fullText,
    aggregateDeduplicateItems,
    applyTruncate,
    createRecallBlock,
    deduplicateItems,
    interleaveItems,
    sortItemsByScore
};
