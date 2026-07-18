const support = require('../runtimeSupport');
const modifiers = require('../modifiers');

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

function createRuleContext(state, rule, ruleIndex) {
    const type = support.resolveRuleType(rule);
    const target = support.resolveRuleTargetMode(rule);
    const diagnostic = {
        ruleIndex,
        type,
        baseMode: type,
        status: 'pending',
        durationMs: 0,
        itemCount: 0,
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
        Object.assign(diagnostic, {
            status: 'error',
            errorCode: support.AGW_ERROR_CODES.RECALL_EXECUTION_ERROR,
            errorMessage: target.error
        });
        return false;
    }
    const roleConfig = modifiers.parseRoleValveConfig(rule.modifiers?.roleValve);
    if (rule.modifiers?.roleValve !== undefined && roleConfig.mode === 'expression' && roleConfig.enabled !== false) {
        const startedAt = Date.now();
        const result = modifiers.evaluateRoleValveExpression(roleConfig.expression, state.roleValveMessages);
        preDetails.push({
            modifier: 'roleValve',
            durationMs: Date.now() - startedAt,
            inputCount: state.roleValveMessages.length,
            outputCount: result.passed ? state.roleValveMessages.length : 0,
            expression: result.expression,
            passed: result.passed,
            roleCounts: result.roleCounts,
            stage: 'pre'
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
        const gate = support.evaluateGateWithPort(rule, state.queryVector, dependencies.ragRetrieverPort);
        diagnostic.gatePassed = gate.passed;
        diagnostic.gateSimilarity = gate.similarity;
        if (!gate.passed) {
            diagnostic.status = 'gated';
            return false;
        }
    }
    return true;
}

function buildRagModifierDetails(rule, ragOptions) {
    if (!rule.modifiers || typeof rule.modifiers !== 'object' || Array.isArray(rule.modifiers)) return [];
    const details = [];
    for (const key of ['tagMemo', 'rerank']) {
        if (rule.modifiers[key] === undefined) continue;
        const detail = {
            modifier: key,
            durationMs: 0,
            inputCount: 0,
            outputCount: 0,
            applied: Boolean(ragOptions[key])
        };
        const weight = ragOptions[`${key}Weight`];
        if (typeof weight === 'number') detail.weight = weight;
        if (key === 'tagMemo' && ragOptions.tagMemoGeodesic === true) detail.geodesic = true;
        details.push(detail);
    }
    return details;
}

async function retrieveRule(ruleContext, state, dependencies) {
    const { rule, type, target } = ruleContext;
    const shared = {
        query: state.query,
        requestedDiaries: target.diaries,
        agentId: state.agentId,
        authContext: state.input.authContext || state.input.requestContext,
        agentPolicyResolver: state.policyResolver,
        adapterAppliedDefaultDiaryPolicy: state.input.adapterAppliedDefaultDiaryPolicy || false,
        ragRetrieverPort: dependencies.ragRetrieverPort,
        ragConfig: dependencies.ragConfig
    };
    if (support.FULL_TEXT_RULE_TYPES.has(type)) {
        return { result: await dependencies.fullTextRetriever({ ...shared, rule }), modifierDetails: [] };
    }
    const effectiveK = Math.max(1, Math.round(5 * support.resolveRuleKMultiplier(rule)));
    const { options: ragOptions } = support.buildRagOptionsFromModifiers(rule.modifiers, effectiveK);
    const result = await dependencies.collectRagItems({
        ...shared,
        ragOptions,
        ragConfig: dependencies.ragConfig,
        ragRetrieverPort: dependencies.ragRetrieverPort
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
        targetDiaries: result.targetDiaries || [],
        timeRangesCount: result.timeRanges?.length || 0,
        activatedGroupCount: result.activatedGroups?.size || 0,
        rerankApplied: result.rerankApplied || false,
        tagMemoCount: result.coreTags?.length || 0,
        coreTags: result.coreTags || []
    });
    const post = modifiers.applyS02Modifiers(items, rule.modifiers, { messages: state.roleValveMessages });
    items = post.items;
    diagnostic.modifierDetails = [...preDetails, ...retrieval.modifierDetails, ...post.modifierDetails];
    const truncate = post.modifierDetails.find((detail) => detail.modifier === 'truncate');
    if (truncate) Object.assign(diagnostic, {
        truncateInputCount: truncate.inputCount,
        truncateOutputCount: truncate.outputCount
    });
    if (post.attachments.length) {
        state.attachments.push(...post.attachments);
        diagnostic.attachmentCount = post.attachments.length;
    }
    const aiModifier = !state.input.inlineRule ? rule.modifiers?.aiMemo : undefined;
    if (aiModifier && support.parseModifierValue('aiMemo', aiModifier)) {
        const preset = typeof aiModifier === 'object' && !Array.isArray(aiModifier)
            ? support.normalizeString(aiModifier.preset)
            : '';
        const ai = await modifiers.applyAIMemo(items, {
            ...(dependencies.aiMemoConfigLoader() || {}),
            preset: preset || undefined
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
            status: 'error',
            errorCode: support.AGW_ERROR_CODES.RECALL_EXECUTION_ERROR,
            errorMessage: error.message
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

module.exports = { executeRulesStage };
