const axios = require('axios');
const { AGW_ERROR_CODES } = require('../contracts/errorCodes');
const { collectRagItems } = require('./contextRuntimeService');

const MODIFIER_TO_RAG_OPTION = Object.freeze({
    time: 'timeAware',
    group: 'groupAware',
    rerank: 'rerank',
    tagMemo: 'tagMemo'
});

const MODIFIER_PIPELINE_ORDER = Object.freeze([
    'time',
    'group',
    'tagMemo',
    'rerank',
    'timeDecay',
    'roleValve',
    'base64Memo',
    'truncate',
    'aiMemo'
]);

const GATED_RULE_TYPES = new Set(['gated_rag', 'gated_full_text']);

const FULL_TEXT_RULE_TYPES = new Set(['full_text', 'gated_full_text']);

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => normalizeString(item)).filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
    return [];
}

function parseModifierValue(key, value) {
    if (key === 'truncate') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return normalized === 'true' || normalized === '1';
    }
    return Boolean(value);
}

function parseTimeDecayConfig(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const halfLifeDays = value.halfLifeDays;
        if (typeof halfLifeDays === 'number' && Number.isFinite(halfLifeDays) && halfLifeDays > 0) {
            return { halfLifeDays };
        }
    }
    return null;
}

function buildRagOptionsFromModifiers(modifiers, baseK = 5) {
    const normalizedModifiers = modifiers && typeof modifiers === 'object' && !Array.isArray(modifiers)
        ? modifiers
        : {};

    const options = {
        mode: 'rag',
        k: baseK,
        timeAware: false,
        groupAware: false,
        rerank: false,
        tagMemo: false
    };

    for (const modifierKey of MODIFIER_PIPELINE_ORDER) {
        if (modifierKey === 'truncate') {
            continue;
        }
        const ragOptionKey = MODIFIER_TO_RAG_OPTION[modifierKey];
        if (ragOptionKey && normalizedModifiers[modifierKey] !== undefined) {
            const modifierValue = normalizedModifiers[modifierKey];
            // Structured object modifiers: extract nested fields while preserving boolean compatibility
            if (modifierKey === 'tagMemo' && modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
                options.tagMemo = true;
                if (typeof modifierValue.weight === 'number' && Number.isFinite(modifierValue.weight)) {
                    options.tagMemoWeight = modifierValue.weight;
                }
                if (modifierValue.geodesic === true) {
                    options.tagMemoGeodesic = true;
                }
            } else if (modifierKey === 'rerank' && modifierValue && typeof modifierValue === 'object' && !Array.isArray(modifierValue)) {
                options.rerank = true;
                if (typeof modifierValue.weight === 'number' && Number.isFinite(modifierValue.weight)) {
                    options.rerankWeight = modifierValue.weight;
                }
            } else {
                options[ragOptionKey] = parseModifierValue(modifierKey, modifierValue);
            }
        }
    }

    const truncateValue = parseModifierValue('truncate', normalizedModifiers.truncate);

    return { options, truncate: truncateValue };
}

function computeCosineSimilarity(vectorA, vectorB) {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || vectorA.length !== vectorB.length || vectorA.length === 0) {
        return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let index = 0; index < vectorA.length; index += 1) {
        dotProduct += vectorA[index] * vectorB[index];
        normA += vectorA[index] * vectorA[index];
        normB += vectorB[index] * vectorB[index];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function getQueryVector(query, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader) {
    if (ragPlugin?.getSingleEmbeddingCached) {
        return await ragPlugin.getSingleEmbeddingCached(query);
    }
    const { getEmbeddingsBatch } = embeddingUtilsLoader();
    const [vector] = await getEmbeddingsBatch([query], {
        apiKey: knowledgeBaseManager?.config?.apiKey,
        apiUrl: knowledgeBaseManager?.config?.apiUrl,
        model: knowledgeBaseManager?.config?.model
    });
    return vector || null;
}

function getDiaryConceptVectors(ragPlugin, diaries) {
    const vectors = [];
    const cache = ragPlugin?.enhancedVectorCache;
    if (!cache || typeof cache !== 'object') {
        return vectors;
    }
    for (const diary of normalizeStringArray(diaries)) {
        const vec = cache[diary];
        if (Array.isArray(vec) && vec.length > 0) {
            vectors.push({ diary, vector: vec });
        }
    }
    return vectors;
}

function evaluateGate(rule, queryVector, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader) {
    if (!GATED_RULE_TYPES.has(rule.type)) {
        return { passed: true, similarity: null };
    }
    if (typeof rule.gateThreshold !== 'number' || !Number.isFinite(rule.gateThreshold)) {
        return { passed: true, similarity: null };
    }
    if (!Array.isArray(queryVector) || queryVector.length === 0) {
        return { passed: false, similarity: 0 };
    }

    const conceptVectors = getDiaryConceptVectors(ragPlugin, rule.diaries);
    if (conceptVectors.length === 0) {
        // No concept vectors available — gate cannot block, pass through
        return { passed: true, similarity: null };
    }

    let maxSimilarity = 0;
    for (const { vector } of conceptVectors) {
        const similarity = computeCosineSimilarity(queryVector, vector);
        if (similarity > maxSimilarity) {
            maxSimilarity = similarity;
        }
    }

    return {
        passed: maxSimilarity >= rule.gateThreshold,
        similarity: maxSimilarity
    };
}

// --- S02 Post-Processing Modifiers ---

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

function applyRoleValve(items, modifierValue) {
    const allowedRoles = normalizeStringArray(modifierValue);
    if (allowedRoles.length === 0) {
        return items;
    }
    return items.filter((item) => {
        const role = normalizeString(item?.role);
        if (!role) {
            // Items without a role pass through (full_text may not have role metadata)
            return true;
        }
        return allowedRoles.includes(role);
    });
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

const AIMEMO_PROMPT = [
    '你是一个知识摘要助手。以下是检索系统为用户查询召回的相关记忆条目。',
    '请阅读所有条目，生成一段结构化的中文摘要，突出关键信息、重要事实和有价值的关联。',
    '如果条目数量较多，请按主题或时间线组织摘要。',
    '',
    '召回条目：',
    '{{knowledge_base}}',
    '',
    '请生成摘要：'
].join('\n');

async function applyAIMemo(items, config) {
    const startedAt = Date.now();
    const modifierDetail = {
        modifier: 'aiMemo',
        durationMs: 0,
        inputCount: Array.isArray(items) ? items.length : 0,
        skipped: false,
        summaryLength: null,
        error: null
    };

    // Silently skip if config is missing or items are empty
    if (!config || !config.url || !config.apiKey || !config.model) {
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

        const prompt = AIMEMO_PROMPT.replace('{{knowledge_base}}', knowledgeBase);

        const response = await axios.post(
            `${config.url}v1/chat/completions`,
            {
                model: config.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.3,
                max_tokens: 2000
            },
            {
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000
            }
        );

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

function applyS02Modifiers(items, modifiers) {
    if (!modifiers || typeof modifiers !== 'object' || Array.isArray(modifiers)) {
        return { items, attachments: [], modifierDetails: [] };
    }

    let currentItems = items;
    let accumulatedAttachments = [];
    const modifierDetails = [];

    // Apply modifiers in pipeline order (only S02 post-processing modifiers)
    for (const modifierKey of MODIFIER_PIPELINE_ORDER) {
        if (modifierKey === 'time' || modifierKey === 'group' || modifierKey === 'tagMemo' ||
            modifierKey === 'rerank' || modifierKey === 'truncate' || modifierKey === 'aiMemo') {
            continue;
        }

        const modifierValue = modifiers[modifierKey];
        if (modifierValue === undefined) {
            continue;
        }

        const modifierStartedAt = Date.now();
        const inputCount = currentItems.length;

        if (modifierKey === 'timeDecay') {
            currentItems = applyTimeDecay(currentItems, modifierValue);
        } else if (modifierKey === 'roleValve') {
            currentItems = applyRoleValve(currentItems, modifierValue);
        } else if (modifierKey === 'base64Memo') {
            const result = applyBase64Memo(currentItems, modifierValue);
            currentItems = result.items;
            accumulatedAttachments = accumulatedAttachments.concat(result.attachments);
        }

        modifierDetails.push({
            modifier: modifierKey,
            durationMs: Date.now() - modifierStartedAt,
            inputCount,
            outputCount: currentItems.length
        });
    }

    return { items: currentItems, attachments: accumulatedAttachments, modifierDetails };
}

// --- Result processing ---

function deduplicateItems(items) {
    const seen = new Map();
    for (const item of items) {
        const key = [
            normalizeString(item?.sourceDiary),
            normalizeString(item?.sourceFile || item?.source_file),
            normalizeString(item?.text)
        ].join('::');
        const existing = seen.get(key);
        if (!existing || (item?.score || 0) > (existing?.score || 0)) {
            seen.set(key, item);
        }
    }
    return Array.from(seen.values());
}

function sortItemsByScore(items) {
    return [...items].sort((left, right) => (right?.score || 0) - (left?.score || 0));
}

function applyTruncate(items, truncateLimit) {
    if (typeof truncateLimit !== 'number' || !Number.isFinite(truncateLimit) || truncateLimit <= 0) {
        return items;
    }
    return items.slice(0, truncateLimit);
}

function createRecallBlock(item) {
    return {
        text: normalizeString(item?.text),
        score: typeof item?.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
        sourceDiary: normalizeString(item?.sourceDiary),
        sourceFile: normalizeString(item?.sourceFile || item?.source_file),
        timestamp: item?.timestamp || null,
        tags: normalizeStringArray(item?.tags || item?.matchedTags)
    };
}

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

/**
 * Recall Runtime Service — 编译并执行预置召回配置。
 *
 * 工厂函数接收依赖注入：
 *   - pluginManager          插件总线（用于 collectRagItems 定位 RAGDiaryPlugin / KnowledgeBaseManager）
 *   - contextRuntimeService   上下文运行时服务（提供 collectRagItems）
 *   - recallProfileResolver   配置文件解析器（resolveForAgent）
 *   - embeddingUtilsLoader    Embedding 工具加载器（可选，用于 gated_rag 向量计算）
 */
function createRecallRuntimeService(deps = {}) {
    const pluginManager = deps.pluginManager;
    const profileResolver = deps.recallProfileResolver;
    const embeddingUtilsLoader = deps.embeddingUtilsLoader || (() => require('../../../EmbeddingUtils'));
    const aiMemoConfigLoader = deps.aiMemoConfigLoader || defaultAiMemoConfigLoader;

    if (!profileResolver) {
        throw new Error('[RecallRuntimeService] recallProfileResolver is required');
    }

    async function executeRecall({
        agentId,
        query,
        profileName,
        requestContext,
        inlineRule,
        authContext,
        agentPolicyResolver,
        adapterAppliedDefaultDiaryPolicy
    }) {
        const startedAt = Date.now();
        const pipelineStages = [];
        const normalizedAgentId = normalizeString(agentId);
        const normalizedQuery = normalizeString(query);

        if (!normalizedAgentId) {
            return buildRecallResult({
                success: false,
                code: AGW_ERROR_CODES.RECALL_INVALID_QUERY,
                error: 'agentId is required',
                status: 400
            });
        }
        if (!normalizedQuery) {
            return buildRecallResult({
                success: false,
                agentId: normalizedAgentId,
                code: AGW_ERROR_CODES.RECALL_INVALID_QUERY,
                error: 'query is required',
                status: 400
            });
        }

        const resolveStartedAt = Date.now();
        let resolved;
        if (inlineRule && typeof inlineRule === 'object') {
            resolved = {
                resolved: true,
                rules: [inlineRule],
                profileName: '_inline_'
            };
        } else {
            resolved = profileResolver.resolveForAgent(normalizedAgentId, profileName);
        }
        if (!resolved.resolved) {
            return buildRecallResult({
                success: false,
                agentId: normalizedAgentId,
                profileName: resolved.profileName || profileName || null,
                code: resolved.code || AGW_ERROR_CODES.RECALL_NO_PROFILE,
                error: `No recall profile resolved for agent "${normalizedAgentId}"`,
                status: 404,
                diagnostics: { totalDurationMs: Date.now() - startedAt, rules: [] }
            });
        }
        pipelineStages.push({
            name: 'resolveProfile',
            durationMs: Date.now() - resolveStartedAt,
            status: 'ok',
            detail: { profileName: resolved.profileName, ruleCount: resolved.rules.length }
        });

        // Pre-compute query vector once for all gated evaluations
        // Skip for inlineRule path since gated rules are not applicable there
        const vectorStartedAt = Date.now();
        let queryVector = null;
        let vectorFetchError = null;
        if (!inlineRule) {
            try {
                const ctxService = deps.contextRuntimeService;
                const knowledgeBaseManager = ctxService?.getKnowledgeBaseManager
                    ? ctxService.getKnowledgeBaseManager(pluginManager)
                    : null;
                const ragPlugin = ctxService?.getRagPlugin
                    ? ctxService.getRagPlugin(pluginManager)
                    : null;
                queryVector = await getQueryVector(normalizedQuery, ragPlugin, knowledgeBaseManager, embeddingUtilsLoader);
            } catch (error) {
                vectorFetchError = error;
            }
        }
        pipelineStages.push({
            name: 'precomputeVector',
            durationMs: Date.now() - vectorStartedAt,
            status: vectorFetchError ? 'error' : 'ok',
            detail: { vectorPrecomputed: Array.isArray(queryVector) && queryVector.length > 0, skipped: Boolean(inlineRule) }
        });

        const ruleDiagnostics = [];
        const allItems = [];
        const allAttachments = [];

        for (let ruleIndex = 0; ruleIndex < resolved.rules.length; ruleIndex += 1) {
            const rule = resolved.rules[ruleIndex];
            const ruleStartedAt = Date.now();
            const ruleDiagnostic = {
                ruleIndex,
                type: rule.type,
                status: 'pending',
                durationMs: 0,
                itemCount: 0
            };

            try {
                // --- Gate evaluation for gated_rag / gated_full_text ---
                // Skip gate evaluation for inlineRule path (no precomputed vector)
                if (!inlineRule && GATED_RULE_TYPES.has(rule.type)) {
                    const ctxService = deps.contextRuntimeService;
                    const knowledgeBaseManager = ctxService?.getKnowledgeBaseManager
                        ? ctxService.getKnowledgeBaseManager(pluginManager)
                        : null;
                    const ragPlugin = ctxService?.getRagPlugin
                        ? ctxService.getRagPlugin(pluginManager)
                        : null;

                    const gateResult = evaluateGate(
                        rule,
                        queryVector,
                        ragPlugin,
                        knowledgeBaseManager,
                        embeddingUtilsLoader
                    );
                    ruleDiagnostic.gatePassed = gateResult.passed;
                    ruleDiagnostic.gateSimilarity = gateResult.similarity;

                    if (!gateResult.passed) {
                        ruleDiagnostic.status = 'gated';
                        ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                        ruleDiagnostics.push(ruleDiagnostic);
                        pipelineStages.push({
                            name: 'ruleExecution',
                            ruleIndex,
                            type: rule.type,
                            durationMs: ruleDiagnostic.durationMs,
                            status: ruleDiagnostic.status
                        });
                        continue;
                    }
                }

                // --- Determine baseK based on rule type ---
                // full_text variants use a larger k to retrieve more comprehensive content
                const isFullText = FULL_TEXT_RULE_TYPES.has(rule.type);
                const baseK = isFullText ? 20 : 5;
                const effectiveK = (typeof rule.kMultiplier === 'number' && Number.isFinite(rule.kMultiplier) && rule.kMultiplier > 0) ? Math.max(1, Math.round(baseK * rule.kMultiplier)) : baseK;

                // --- Build ragOptions from modifiers ---
                const { options: ragOptions } = buildRagOptionsFromModifiers(rule.modifiers, effectiveK);

                // --- Execute RAG via collectRagItems ---
                const collectResult = await collectRagItems({
                    pluginManager,
                    query: normalizedQuery,
                    requestedDiaries: rule.diaries,
                    adapterAppliedDefaultDiaryPolicy: adapterAppliedDefaultDiaryPolicy || false,
                    agentId: normalizedAgentId,
                    authContext: authContext || requestContext,
                    ragOptions,
                    embeddingUtilsLoader,
                    agentPolicyResolver: agentPolicyResolver || null
                });

                if (!collectResult.success) {
                    ruleDiagnostic.status = 'error';
                    ruleDiagnostic.errorCode = collectResult.code;
                    ruleDiagnostic.errorMessage = collectResult.error;
                    ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                    ruleDiagnostics.push(ruleDiagnostic);
                    pipelineStages.push({
                        name: 'ruleExecution',
                        ruleIndex,
                        type: rule.type,
                        durationMs: ruleDiagnostic.durationMs,
                        status: ruleDiagnostic.status
                    });
                    continue;
                }

                let ruleItems = Array.isArray(collectResult.items) ? collectResult.items : [];

                // --- Enrich rule diagnostics from collectRagItems result ---
                ruleDiagnostic.targetDiaries = collectResult.targetDiaries || [];
                ruleDiagnostic.timeRangesCount = collectResult.timeRanges?.length || 0;
                ruleDiagnostic.activatedGroupCount = collectResult.activatedGroups?.size || 0;
                ruleDiagnostic.rerankApplied = collectResult.rerankApplied || false;
                ruleDiagnostic.tagMemoCount = collectResult.coreTags?.length || 0;
                ruleDiagnostic.coreTags = collectResult.coreTags || [];

                // --- Apply S02 post-processing modifiers ---
                const s02Result = applyS02Modifiers(ruleItems, rule.modifiers);
                ruleItems = s02Result.items;
                ruleDiagnostic.modifierDetails = s02Result.modifierDetails;
                if (s02Result.attachments.length > 0) {
                    allAttachments.push(...s02Result.attachments);
                    ruleDiagnostic.attachmentCount = s02Result.attachments.length;
                }

                allItems.push(...ruleItems);

                ruleDiagnostic.status = 'ok';
                ruleDiagnostic.itemCount = ruleItems.length;
                ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                ruleDiagnostics.push(ruleDiagnostic);
                pipelineStages.push({
                    name: 'ruleExecution',
                    ruleIndex,
                    type: rule.type,
                    durationMs: ruleDiagnostic.durationMs,
                    status: ruleDiagnostic.status
                });
            } catch (error) {
                ruleDiagnostic.status = 'error';
                ruleDiagnostic.errorCode = AGW_ERROR_CODES.RECALL_EXECUTION_ERROR;
                ruleDiagnostic.errorMessage = error.message;
                ruleDiagnostic.durationMs = Date.now() - ruleStartedAt;
                ruleDiagnostics.push(ruleDiagnostic);
                pipelineStages.push({
                    name: 'ruleExecution',
                    ruleIndex,
                    type: rule.type,
                    durationMs: ruleDiagnostic.durationMs,
                    status: ruleDiagnostic.status
                });
            }
        }

        // --- Merge results: deduplicate → sort → truncate ---
        const mergeStartedAt = Date.now();
        let mergedItems = deduplicateItems(allItems);
        mergedItems = sortItemsByScore(mergedItems);

        // Apply global truncate from profile-level modifiers if any,
        // otherwise use the first rule's truncate as a sensible default.
        const globalTruncate = resolved.rules[0]?.modifiers?.truncate
            ? parseModifierValue('truncate', resolved.rules[0].modifiers.truncate)
            : null;
        mergedItems = applyTruncate(mergedItems, globalTruncate);
        mergedItems = mergedItems.map((item) => createRecallBlock(item));
        pipelineStages.push({
            name: 'mergeResults',
            durationMs: Date.now() - mergeStartedAt,
            status: 'ok',
            detail: { inputItemCount: allItems.length, outputItemCount: mergedItems.length }
        });

        // --- AIMemo post-recall summarization ---
        // Skip AIMemo for inlineRule path (profile-level only)
        let aiMemoSummary = null;
        const globalAiMemo = !inlineRule && resolved.rules[0]?.modifiers?.aiMemo
            ? parseModifierValue('aiMemo', resolved.rules[0].modifiers.aiMemo)
            : false;

        if (globalAiMemo) {
            const aiMemoConfig = aiMemoConfigLoader();
            const aiMemoResult = await applyAIMemo(mergedItems, aiMemoConfig);
            if (aiMemoResult.modifierDetail) {
                // Attach modifier detail to the last rule diagnostic for per-modifier reporting
                const lastRuleDiag = ruleDiagnostics[ruleDiagnostics.length - 1];
                if (lastRuleDiag) {
                    if (!lastRuleDiag.modifierDetails) {
                        lastRuleDiag.modifierDetails = [];
                    }
                    lastRuleDiag.modifierDetails.push(aiMemoResult.modifierDetail);
                }
                pipelineStages.push({
                    name: 'aiMemo',
                    durationMs: aiMemoResult.modifierDetail.durationMs,
                    status: aiMemoResult.summary ? 'ok'
                        : (aiMemoResult.modifierDetail.error ? 'error' : 'skipped'),
                    detail: {
                        inputCount: aiMemoResult.modifierDetail.inputCount,
                        skipped: aiMemoResult.modifierDetail.skipped,
                        summaryLength: aiMemoResult.modifierDetail.summaryLength,
                        error: aiMemoResult.modifierDetail.error || undefined
                    }
                });
            }
            aiMemoSummary = aiMemoResult.summary;
        }

        const totalDurationMs = Date.now() - startedAt;

        return buildRecallResult({
            success: true,
            agentId: normalizedAgentId,
            profileName: resolved.profileName,
            items: mergedItems,
            diagnostics: {
                totalDurationMs,
                rules: ruleDiagnostics,
                pipelineStages,
                profileMeta: {
                    profileName: resolved.profileName,
                    ruleCount: resolved.rules.length,
                    modifierKeys: [...new Set(resolved.rules.flatMap((r) => Object.keys(r.modifiers || {})))]
                },
                attachments: allAttachments.length > 0 ? allAttachments : undefined,
                vectorPrecomputed: Array.isArray(queryVector) && queryVector.length > 0,
                vectorPrecomputeError: vectorFetchError ? vectorFetchError.message : null,
                summary: aiMemoSummary || undefined
            }
        });
    }

    return {
        executeRecall
    };
}

module.exports = {
    createRecallRuntimeService,
    buildRagOptionsFromModifiers,
    computeCosineSimilarity,
    evaluateGate,
    deduplicateItems,
    sortItemsByScore,
    applyTruncate,
    createRecallBlock,
    buildRecallResult,
    applyTimeDecay,
    applyRoleValve,
    applyBase64Memo,
    applyAIMemo,
    applyS02Modifiers,
    defaultAiMemoConfigLoader,
    AIMEMO_PROMPT,
    MODIFIER_PIPELINE_ORDER,
    MODIFIER_TO_RAG_OPTION,
    GATED_RULE_TYPES,
    FULL_TEXT_RULE_TYPES
};
