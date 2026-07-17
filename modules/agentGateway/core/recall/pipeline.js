const { AGW_ERROR_CODES } = require('../../contracts/errorCodes');
const {
    aggregateDeduplicateItems,
    applyTruncate,
    createRecallBlock,
    interleaveItems,
    itemKey,
    sortItemsByScore
} = require('./recallItem');
const { applyBudgetPostProcessing } = require('./tokenBudget');
const support = require('./runtimeSupport');
const modifiers = require('./modifiers');

function appendRuleStage(state, diagnostic) {
    state.ruleDiagnostics.push(diagnostic);
    state.pipelineStages.push({
        name: 'ruleExecution',
        ruleIndex: diagnostic.ruleIndex,
        type: diagnostic.type,
        durationMs: diagnostic.durationMs,
        status: diagnostic.status
    });
}

function resolveProfileStage(input, dependencies) {
    const startedAt = Date.now();
    const agentId = support.normalizeString(input.agentId);
    const query = support.normalizeString(input.query);
    if (!agentId || !query) {
        return { failure: dependencies.buildRecallResult({
            success: false,
            agentId: agentId || undefined,
            code: AGW_ERROR_CODES.RECALL_INVALID_QUERY,
            error: `${!agentId ? 'agentId' : 'query'} is required`,
            status: 400
        }) };
    }
    const resolved = input.inlineRule && typeof input.inlineRule === 'object'
        ? { resolved: true, rules: [input.inlineRule], profileName: '_inline_' }
        : dependencies.profileResolver.resolveForAgent(agentId, input.profileName);
    if (!resolved.resolved) {
        const failure = dependencies.mapResolvedRecallFailure(resolved, agentId, input.profileName);
        return { failure: dependencies.buildRecallResult({
            success: false, agentId, profileName: resolved.profileName || input.profileName || null,
            ...failure,
            diagnostics: { totalDurationMs: Date.now() - input.startedAt, rules: [] }
        }) };
    }
    return {
        agentId, query, resolved,
        stage: {
            name: 'resolveProfile', durationMs: Date.now() - startedAt, status: 'ok',
            detail: { profileName: resolved.profileName, ruleCount: resolved.rules.length }
        }
    };
}

async function precomputeVectorStage(state, dependencies) {
    const startedAt = Date.now();
    let vector = null;
    let error = null;
    if (!state.input.inlineRule) {
        try {
            vector = await support.getQueryVector(
                state.query,
                support.getRagPlugin(dependencies.deps, dependencies.pluginManager),
                support.getKnowledgeBaseManager(dependencies.deps, dependencies.pluginManager),
                dependencies.embeddingUtilsLoader
            );
        } catch (caught) { error = caught; }
    }
    state.queryVector = vector;
    state.vectorFetchError = error;
    state.pipelineStages.push({
        name: 'precomputeVector', durationMs: Date.now() - startedAt, status: error ? 'error' : 'ok',
        detail: { vectorPrecomputed: Array.isArray(vector) && vector.length > 0, skipped: Boolean(state.input.inlineRule) }
    });
}

function createRuleContext(state, rule, ruleIndex) {
    const type = support.resolveRuleType(rule);
    const target = support.resolveRuleTargetMode(rule);
    const diagnostic = {
        ruleIndex, type, baseMode: type, status: 'pending', durationMs: 0, itemCount: 0,
        targetMode: target.mode
    };
    const projection = support.resolveRuleProjection(rule);
    if (projection) diagnostic.projection = projection;
    if (target.aggregate) diagnostic.targetAggregate = true;
    if (target.inferredFromLegacy) diagnostic.targetAggregateInferred = true;
    return { rule, ruleIndex, type, target, diagnostic, startedAt: Date.now(), preDetails: [] };
}

function applyRuleGates(ruleContext, state, dependencies) {
    const { rule, type, target, diagnostic, preDetails } = ruleContext;
    if (!target.supported) {
        Object.assign(diagnostic, { status: 'error', errorCode: AGW_ERROR_CODES.RECALL_EXECUTION_ERROR, errorMessage: target.error });
        return false;
    }
    const roleConfig = modifiers.parseRoleValveConfig(rule.modifiers?.roleValve);
    if (rule.modifiers?.roleValve !== undefined && roleConfig.mode === 'expression' && roleConfig.enabled !== false) {
        const startedAt = Date.now();
        const result = modifiers.evaluateRoleValveExpression(roleConfig.expression, state.roleValveMessages);
        preDetails.push({
            modifier: 'roleValve', durationMs: Date.now() - startedAt,
            inputCount: state.roleValveMessages.length, outputCount: result.passed ? state.roleValveMessages.length : 0,
            expression: result.expression, passed: result.passed, roleCounts: result.roleCounts, stage: 'pre'
        });
        diagnostic.roleValvePassed = result.passed;
        diagnostic.roleCounts = result.roleCounts;
        if (!result.passed) {
            diagnostic.status = 'gated';
            diagnostic.modifierDetails = preDetails;
            return false;
        }
    }
    if (!state.input.inlineRule && support.GATED_RULE_TYPES.has(type)) {
        const ragPlugin = support.getRagPlugin(dependencies.deps, dependencies.pluginManager);
        const gate = support.evaluateGate(rule, state.queryVector, ragPlugin);
        diagnostic.gatePassed = gate.passed;
        diagnostic.gateSimilarity = gate.similarity;
        if (!gate.passed) { diagnostic.status = 'gated'; return false; }
    }
    return true;
}

function buildRagModifierDetails(rule, ragOptions) {
    if (!rule.modifiers || typeof rule.modifiers !== 'object' || Array.isArray(rule.modifiers)) return [];
    const details = [];
    for (const key of ['tagMemo', 'rerank']) {
        if (rule.modifiers[key] === undefined) continue;
        const appliedKey = key === 'tagMemo' ? 'tagMemo' : 'rerank';
        const detail = { modifier: key, durationMs: 0, inputCount: 0, outputCount: 0, applied: Boolean(ragOptions[appliedKey]) };
        const weight = ragOptions[`${key}Weight`];
        if (typeof weight === 'number') detail.weight = weight;
        if (key === 'tagMemo' && ragOptions.tagMemoGeodesic === true) detail.geodesic = true;
        details.push(detail);
    }
    return details;
}

async function retrieveRule(ruleContext, state, dependencies) {
    const { rule, type, target } = ruleContext;
    if (support.FULL_TEXT_RULE_TYPES.has(type)) {
        return {
            result: await dependencies.fullTextRetriever({
                pluginManager: dependencies.pluginManager, query: state.query,
                requestedDiaries: target.diaries, agentId: state.agentId,
                authContext: state.input.authContext || state.input.requestContext,
                agentPolicyResolver: state.policyResolver,
                adapterAppliedDefaultDiaryPolicy: state.input.adapterAppliedDefaultDiaryPolicy || false,
                rule
            }),
            modifierDetails: []
        };
    }
    const effectiveK = Math.max(1, Math.round(5 * support.resolveRuleKMultiplier(rule)));
    const { options: ragOptions } = support.buildRagOptionsFromModifiers(rule.modifiers, effectiveK);
    const result = await dependencies.collectRagItems({
        pluginManager: dependencies.pluginManager, query: state.query, requestedDiaries: target.diaries,
        adapterAppliedDefaultDiaryPolicy: state.input.adapterAppliedDefaultDiaryPolicy || false,
        agentId: state.agentId, authContext: state.input.authContext || state.input.requestContext,
        ragOptions, embeddingUtilsLoader: dependencies.embeddingUtilsLoader,
        ragRetrieverPort: dependencies.deps.ragRetrieverPort, agentPolicyResolver: state.policyResolver
    });
    return { result, modifierDetails: buildRagModifierDetails(rule, ragOptions) };
}

async function finalizeRule(ruleContext, retrieval, state, dependencies) {
    const { rule, diagnostic, preDetails } = ruleContext;
    const result = retrieval.result;
    if (!result.success) {
        Object.assign(diagnostic, { status: 'error', errorCode: result.code, errorMessage: result.error });
        return;
    }
    let items = Array.isArray(result.items) ? result.items : [];
    Object.assign(diagnostic, {
        targetDiaries: result.targetDiaries || [], timeRangesCount: result.timeRanges?.length || 0,
        activatedGroupCount: result.activatedGroups?.size || 0, rerankApplied: result.rerankApplied || false,
        tagMemoCount: result.coreTags?.length || 0, coreTags: result.coreTags || []
    });
    const post = modifiers.applyS02Modifiers(items, rule.modifiers, { messages: state.roleValveMessages });
    items = post.items;
    diagnostic.modifierDetails = [...preDetails, ...retrieval.modifierDetails, ...post.modifierDetails];
    const truncate = post.modifierDetails.find((detail) => detail.modifier === 'truncate');
    if (truncate) Object.assign(diagnostic, { truncateInputCount: truncate.inputCount, truncateOutputCount: truncate.outputCount });
    if (post.attachments.length) {
        state.attachments.push(...post.attachments);
        diagnostic.attachmentCount = post.attachments.length;
    }
    const aiModifier = !state.input.inlineRule ? rule.modifiers?.aiMemo : undefined;
    if (aiModifier && support.parseModifierValue('aiMemo', aiModifier)) {
        const preset = typeof aiModifier === 'object' && !Array.isArray(aiModifier) ? support.normalizeString(aiModifier.preset) : '';
        const ai = await modifiers.applyAIMemo(items, {
            ...(dependencies.aiMemoConfigLoader() || {}), preset: preset || undefined
        }, dependencies.deps.llmCompletionPort);
        diagnostic.modifierDetails.push(ai.modifierDetail);
        diagnostic.aiMemoSummary = ai.summary;
    }
    state.ruleItems.push(items);
    diagnostic.status = 'ok';
    diagnostic.itemCount = items.length;
}

async function executeRuleStage(rule, ruleIndex, state, dependencies) {
    const context = createRuleContext(state, rule, ruleIndex);
    try {
        if (applyRuleGates(context, state, dependencies)) {
            const retrieval = await retrieveRule(context, state, dependencies);
            await finalizeRule(context, retrieval, state, dependencies);
        }
    } catch (error) {
        Object.assign(context.diagnostic, {
            status: 'error', errorCode: AGW_ERROR_CODES.RECALL_EXECUTION_ERROR, errorMessage: error.message
        });
    }
    context.diagnostic.durationMs = Date.now() - context.startedAt;
    appendRuleStage(state, context.diagnostic);
}

async function executeRulesStage(state, dependencies) {
    state.roleValveMessages = support.resolveRoleValveMessages(state.input);
    for (let index = 0; index < state.resolved.rules.length; index += 1) {
        await executeRuleStage(state.resolved.rules[index], index, state, dependencies);
    }
}

function mergeResultsStage(state) {
    const startedAt = Date.now();
    const strategy = state.resolved.merge;
    const aggregate = state.resolved.aggregate;
    const flat = state.ruleItems.flat();
    let items;
    const detail = {
        strategy: strategy || 'default', aggregate: aggregate || 'max',
        inputRuleCount: state.ruleItems.length, inputItemCount: flat.length, outputItemCount: 0
    };
    if (strategy === 'interleave') {
        const deduped = aggregateDeduplicateItems(flat, aggregate);
        const byKey = new Map(deduped.map((item) => [itemKey(item), item]));
        const seen = new Set();
        const byRule = state.ruleItems.map((group) => group.flatMap((item) => {
            const key = itemKey(item);
            if (seen.has(key) || !byKey.has(key)) return [];
            seen.add(key);
            return [byKey.get(key)];
        }));
        items = interleaveItems(byRule.map(sortItemsByScore));
        detail.interleavedRuleCount = byRule.filter((group) => group.length).length;
    } else {
        items = sortItemsByScore(aggregateDeduplicateItems(flat, aggregate));
        detail.deduplicatedCount = items.length;
    }
    items = applyTruncate(items, state.resolved.truncateTo).map(createRecallBlock);
    detail.outputItemCount = items.length;
    state.items = items;
    state.pipelineStages.push({ name: 'mergeResults', durationMs: Date.now() - startedAt, status: 'ok', detail });
}

function applyBudgetStage(state) {
    const startedAt = Date.now();
    const result = applyBudgetPostProcessing(state.items, state.resolved);
    state.items = result.items;
    if (!result.skipped) {
        state.pipelineStages.push({
            name: 'budgetFilter', durationMs: Date.now() - startedAt, status: 'ok',
            detail: {
                inputItemCount: result.inputItemCount, outputItemCount: result.outputItemCount,
                minScoreApplied: result.minScoreApplied, tokenBudgetApplied: result.tokenBudgetApplied,
                maxTokenRatioApplied: result.maxTokenRatioApplied, tokensConsumed: result.consumedTokens
            }
        });
    }
}

async function applyAiMemoStage(state, dependencies) {
    const config = !state.input.inlineRule ? state.resolved.aiMemo : undefined;
    state.aiMemoSummary = null;
    if (!config) return;
    const preset = typeof config === 'object' && !Array.isArray(config) ? support.normalizeString(config.preset) : '';
    const result = await modifiers.applyAIMemo(state.items, {
        ...(dependencies.aiMemoConfigLoader() || {}), preset: preset || undefined
    }, dependencies.deps.llmCompletionPort);
    state.pipelineStages.push({
        name: 'aiMemo', durationMs: result.modifierDetail.durationMs,
        status: result.summary ? 'ok' : (result.modifierDetail.error ? 'error' : 'skipped'),
        detail: {
            inputCount: result.modifierDetail.inputCount, skipped: result.modifierDetail.skipped,
            summaryLength: result.modifierDetail.summaryLength, error: result.modifierDetail.error || undefined
        }
    });
    state.aiMemoSummary = result.summary;
}

function buildProfileMeta(resolved) {
    const meta = {
        profileName: resolved.profileName, ruleCount: resolved.rules.length,
        modifierKeys: [...new Set(resolved.rules.flatMap((rule) => Object.keys(rule.modifiers || {})))]
    };
    for (const key of ['truncateTo', 'merge', 'aggregate', 'projection', 'tokenBudget', 'maxTokenRatio', 'minScore', 'aiMemo']) {
        if (resolved[key] !== undefined) meta[key] = resolved[key];
    }
    return meta;
}

function createRecallPipeline(dependencies) {
    return async function executeRecall(input) {
        const startedAt = Date.now();
        const resolved = resolveProfileStage({ ...input, startedAt }, dependencies);
        if (resolved.failure) return resolved.failure;
        const state = {
            input, startedAt, ...resolved, pipelineStages: [resolved.stage], ruleDiagnostics: [],
            ruleItems: [], attachments: [], items: [],
            policyResolver: input.agentPolicyResolver || dependencies.defaultAgentPolicyResolver
        };
        await precomputeVectorStage(state, dependencies);
        await executeRulesStage(state, dependencies);
        mergeResultsStage(state);
        applyBudgetStage(state);
        await applyAiMemoStage(state, dependencies);
        return dependencies.buildRecallResult({
            success: true, agentId: state.agentId, profileName: state.resolved.profileName, items: state.items,
            diagnostics: {
                totalDurationMs: Date.now() - startedAt, rules: state.ruleDiagnostics,
                pipelineStages: state.pipelineStages, profileMeta: buildProfileMeta(state.resolved),
                attachments: state.attachments.length ? state.attachments : undefined,
                vectorPrecomputed: Array.isArray(state.queryVector) && state.queryVector.length > 0,
                vectorPrecomputeError: state.vectorFetchError?.message || null,
                summary: state.aiMemoSummary || undefined
            }
        });
    };
}

module.exports = {
    applyAiMemoStage,
    applyBudgetStage,
    createRecallPipeline,
    executeRulesStage,
    mergeResultsStage,
    precomputeVectorStage,
    resolveProfileStage
};
