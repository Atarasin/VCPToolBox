const { applyTruncate } = require('./recallItem');
const {
    MODIFIER_PIPELINE_ORDER,
    normalizeString,
    normalizeStringArray,
    parseModifierValue,
    parseTimeDecayConfig,
    evaluateRoleValveExpression
} = require('./runtimeSupport');

function applyTimeDecay(items, modifierValue) {
    const config = parseTimeDecayConfig(modifierValue);
    if (!config) {
        return items;
    }

    const lambda = Math.log(2) / config.halfLifeDays;
    const now = Date.now();

    return items.map((item) => {
        const ts = item?.timestamp;
        if (!ts) {
            return item;
        }
        const ageMs = now - new Date(ts).getTime();
        if (ageMs <= 0) {
            return item;
        }
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const decayFactor = Math.exp(-lambda * ageDays);
        return {
            ...item,
            score: (item.score || 0) * decayFactor
        };
    });
}

function parseRoleValveConfig(modifierValue) {
    if (modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
        const enabled = modifierValue.enabled !== false;
        const roles = normalizeStringArray(modifierValue.roles);
        const rawExpression = normalizeString(modifierValue.expression);
        const expression = rawExpression.toUpperCase();
        const isExpressionMode = /[@<>=|&]/.test(rawExpression);
        return {
            enabled,
            mode: isExpressionMode ? 'expression' : 'roles',
            roles,
            expression: isExpressionMode
                ? rawExpression
                : (expression === 'AND' ? 'AND' : 'OR')
        };
    }
    const roles = normalizeStringArray(modifierValue);
    return {
        enabled: true,
        mode: 'roles',
        roles,
        expression: 'OR'
    };
}

function applyRoleValve(items, modifierValue, options = {}) {
    const config = parseRoleValveConfig(modifierValue);
    if (config.enabled === false) {
        return { items, expression: config.expression, matchedCount: items.length, passed: true };
    }
    if (config.mode === 'expression') {
        const expressionResult = evaluateRoleValveExpression(config.expression, options.messages);
        return {
            items: expressionResult.passed ? items : [],
            expression: config.expression,
            matchedCount: expressionResult.passed ? items.length : 0,
            passed: expressionResult.passed,
            roleCounts: expressionResult.roleCounts
        };
    }
    if (config.roles.length === 0) {
        return { items, expression: config.expression, matchedCount: items.length, passed: true };
    }
    const filtered = items.filter((item) => {
        const role = normalizeString(item?.role);
        if (!role) {
            // Items without a role pass through (full_text may not have role metadata)
            return true;
        }
        if (config.expression === 'AND') {
            return config.roles.includes(role);
        }
        // OR (default): any matching role passes
        return config.roles.includes(role);
    });
    return { items: filtered, expression: config.expression, matchedCount: filtered.length, passed: true };
}

function applyBase64Memo(items, modifierValue) {
    const isEnabled = parseModifierValue('base64Memo', modifierValue);
    if (!isEnabled) {
        return { items, attachments: [] };
    }

    const BASE64_PATTERN = /(?:data:(?:image|application|video|audio|text)\/[^;]+;base64,[A-Za-z0-9+/=]+)/g;

    const attachments = [];
    const processedItems = [];

    for (const item of items) {
        const text = normalizeString(item?.text);
        const matches = text.match(BASE64_PATTERN);
        if (matches && matches.length > 0) {
            for (const match of matches) {
                attachments.push({
                    sourceDiary: normalizeString(item?.sourceDiary),
                    sourceFile: normalizeString(item?.sourceFile || item?.source_file),
                    content: match
                });
            }
            // Strip base64 content from item text to keep output compact
            const strippedText = text.replace(BASE64_PATTERN, '[base64-attachment]');
            processedItems.push({
                ...item,
                text: strippedText
            });
        } else {
            processedItems.push(item);
        }
    }

    return { items: processedItems, attachments };
}

// --- AIMemo Post-Recall Summarization ---

function defaultAiMemoConfigLoader() {
    const url = (process.env.AIMemoUrl || '').trim();
    const apiKey = (process.env.AIMemoApi || '').trim();
    const model = (process.env.AIMemoModel || '').trim();
    if (url && apiKey && model) {
        return { url, apiKey, model };
    }
    return null;
}

const AIMEMO_PRESETS = Object.freeze(require('../../config/aimemo_presets.json'));
const AIMEMO_PROMPT = AIMEMO_PRESETS.default;

async function applyAIMemo(items, config, llmCompletionPort) {
    const startedAt = Date.now();
    const requestedPreset = normalizeString(config?.preset) || 'default';
    const modifierDetail = {
        modifier: 'aiMemo',
        durationMs: 0,
        inputCount: Array.isArray(items) ? items.length : 0,
        skipped: false,
        summaryLength: null,
        preset: AIMEMO_PRESETS[requestedPreset] ? requestedPreset : 'default',
        error: null
    };

    // Silently skip if config is missing or items are empty
    if (!config || !config.url || !config.apiKey || !config.model || !llmCompletionPort?.available) {
        modifierDetail.skipped = true;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary: null, modifierDetail };
    }

    if (!Array.isArray(items) || items.length === 0) {
        modifierDetail.skipped = true;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary: null, modifierDetail };
    }

    try {
        const knowledgeBase = items.map((item, idx) => {
            const text = normalizeString(item?.text);
            const sourceDiary = normalizeString(item?.sourceDiary);
            const sourceFile = normalizeString(item?.sourceFile);
            const sourceLabel = sourceDiary || sourceFile || '';
            return `[${idx + 1}]${sourceLabel ? ` (${sourceLabel})` : ''}\n${text}`;
        }).join('\n\n---\n\n');

        const presetName = normalizeString(config.preset) || 'default';
        const effectivePreset = AIMEMO_PRESETS[presetName] ? presetName : 'default';
        const presetPrompt = AIMEMO_PRESETS[presetName] || AIMEMO_PRESETS.default;
        modifierDetail.preset = effectivePreset;
        const prompt = presetPrompt.replace('{{knowledge_base}}', knowledgeBase);

        const response = await llmCompletionPort.complete(config, {
                model: config.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2000
            });

        const summary = response.data?.choices?.[0]?.message?.content || null;
        modifierDetail.summaryLength = summary ? summary.length : null;
        modifierDetail.durationMs = Date.now() - startedAt;
        return { items, summary, modifierDetail };
    } catch (error) {
        modifierDetail.durationMs = Date.now() - startedAt;
        modifierDetail.error = error.message;
        return { items, summary: null, modifierDetail };
    }
}

function applyS02Modifiers(items, modifiers, options = {}) {
    if (!modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers)) {
        return { items, attachments: [], modifierDetails: [] };
    }

    let currentItems = items;
    let accumulatedAttachments = [];
    const modifierDetails = [];

    const postModifiers = MODIFIER_PIPELINE_ORDER
        .map((key) => MODIFIER_REGISTRY[key])
        .filter((definition) => definition.stage === 'post' && modifiers[definition.key] !== undefined);
    for (const definition of postModifiers) {
        const modifierStartedAt = Date.now();
        const inputCount = currentItems.length;
        const result = definition.apply(currentItems, modifiers[definition.key], options);
        if (result.skip) continue;
        currentItems = result.items;
        accumulatedAttachments = accumulatedAttachments.concat(result.attachments || []);
        modifierDetails.push({
            modifier: definition.key,
            durationMs: Date.now() - modifierStartedAt,
            inputCount,
            outputCount: currentItems.length,
            ...(result.detail || {})
        });
    }

    return { items: currentItems, attachments: accumulatedAttachments, modifierDetails };
}

const MODIFIER_REGISTRY = Object.freeze({
    time: Object.freeze({ key: 'time', stage: 'retrieval' }),
    group: Object.freeze({ key: 'group', stage: 'retrieval' }),
    tagMemo: Object.freeze({ key: 'tagMemo', stage: 'retrieval' }),
    rerank: Object.freeze({ key: 'rerank', stage: 'retrieval' }),
    timeDecay: Object.freeze({
        key: 'timeDecay', stage: 'post',
        apply: (items, value) => ({ items: applyTimeDecay(items, value) })
    }),
    roleValve: Object.freeze({
        key: 'roleValve', stage: 'post',
        apply(items, value, options) {
            if (parseRoleValveConfig(value).mode === 'expression') return { items, skip: true };
            const result = applyRoleValve(items, value, options);
            return {
                items: result.items,
                detail: { expression: result.expression, matchedCount: result.matchedCount }
            };
        }
    }),
    base64Memo: Object.freeze({
        key: 'base64Memo', stage: 'post', apply: (items, value) => applyBase64Memo(items, value)
    }),
    truncate: Object.freeze({
        key: 'truncate', stage: 'post',
        apply: (items, value) => ({ items: applyTruncate(items, parseModifierValue('truncate', value)) })
    }),
    aiMemo: Object.freeze({ key: 'aiMemo', stage: 'global', apply: applyAIMemo })
});

// --- Budget post-processing (S02 profile-level) ---

// --- Result processing ---

module.exports = {
    AIMEMO_PRESETS,
    AIMEMO_PROMPT,
    applyAIMemo,
    applyBase64Memo,
    applyRoleValve,
    applyS02Modifiers,
    applyTimeDecay,
    defaultAiMemoConfigLoader,
    evaluateRoleValveExpression,
    MODIFIER_PIPELINE_ORDER,
    MODIFIER_REGISTRY,
    parseRoleValveConfig
};
