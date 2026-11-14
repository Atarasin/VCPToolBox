'use strict';

const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { createKnowledgeWriter } = require('./knowledgeWriter');
const { salvageTruncatedPayload } = require('./jsonUtils');
const { completeJsonResilient, describeAttemptFailure, resolveThinkingMode } = require('./jsonCompletion');
const qualityGate = require('./qualityGate');
const { createDispositionLedger, moveKnowledgeFile, STATES } = require('./knowledgeStates');

/**
 * 蒸馏（distill）步骤：原始材料 → 知识单元 → knowledge/<库名>/ 落盘 → 冒烟可检索验证。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.4（D2 混合分流 / 去重合并 /
 * 质量过滤留档 / TDB watcher 自动索引）。
 *
 * - 模板优先读 baseDir/templates/distill.md（可热改），缺省回退模块内置文本；
 * - 每个 subskill 一次 LLM 蒸馏（同批材料天然同义合并，mergeInto 指回既有卡）；
 * - 入库验证：写入后经 knowledgeStorePort 冒烟查询新库（watcher 索引有秒级
 *   延迟，带重试）；端口不可用（TDB 未启用）记 warning 跳过，不阻断。
 *
 * 截断韧性（2026-10-11 事故：两单 distill 连续败于 max_tokens=8000 截断，
 * 模型对 10 份材料的单次蒸馏输出稳定超限）：
 * - 材料按批（默认 4 份/批）分次蒸馏，单次输出预算减半以上；
 * - 输出整体不可解析时先尝试「抢救完整知识单元」，再考虑重试；
 * - 有正文但 finish_reason=length 且批内多份材料时拆半重蒸（批太大，拆小
 *   比抬预算对症）；彻底失败前把原始输出留档 distill-failed/ 供事后诊断。
 *
 * 空正文韧性（2026-10-17 事故：定期进修 distill 三次尝试 reasoning_tokens
 * 7467/6119/7247、正文 0 字符，整单报废）：
 * - 蒸馏是纯抽取/结构化任务，缺省关思考（thinking.type=disabled，
 *   FORGE_DISTILL_THINKING=enabled 可改回）——思考段曾把 8000 预算吃光；
 * - 正文为空/被截断时经 jsonCompletion 的阶梯抬预算重试（8k → 16k），
 *   正文为空且推理段有内容时从推理段抢救；
 * - 全部尝试正文为空抛 FORGE_LLM_EMPTY_CONTENT（与「不可解析」分开报），
 *   失败也把已写盘进度带回（部分入库的卡片不会被记成 0）。
 */

const FALLBACK_DISTILL_TEMPLATE = `你是知识蒸馏引擎。从原始检索材料中蒸馏结构化知识单元（子技能：{{subskillTitle}}）。
材料清单：
{{materials}}
既有知识卡标题（同义知识点设 mergeInto 指回该标题，不新建）：
{{existingCardTitles}}
规则：type ∈ concept/methodology/checklist/case/pitfall；sourceUrls 必须来自材料 URL（宁可缺，不可编）；同义合并取来源并集；低质材料进 droppedSources 并给理由。
只输出 JSON：{"knowledgeUnits":[{"type":"","title":"","oneLiner":"","content":"","tags":[],"sourceUrls":[],"mergeInto":null}],"droppedSources":[{"url":"","reason":""}]}`;

const UNIT_TYPES = new Set(['concept', 'methodology', 'checklist', 'case', 'pitfall']);
// 真实环境 embedding + batch 窗口可能 >30s（M2 门禁实测），窗口放宽到 60s。
const SMOKE_RETRY_COUNT = 20;
const SMOKE_RETRY_INTERVAL_MS = 3000;
// 4 份/批（每份材料截 4000 字符）实测把单次蒸馏输出压到 ~4k token，距
// max_tokens=8000 留一倍余量；批间刷新既有卡清单，跨批 mergeInto 仍生效。
const DEFAULT_BATCH_MATERIALS = 4;
// 拆半递归上限：4 份 → 2 → 1，深度 3 足够；防异常配置下无限递归。
const MAX_BATCH_HALVING_DEPTH = 3;
const DISTILL_MAX_ATTEMPTS = 3;
const DISTILL_MAX_TOKENS = 8000;
// 抬预算重试：正文为空/单材料被截断时给同一批更多输出空间（关思考后 16k
// 已是缺省 4k 产出的四倍余量）；供应商拒收则回落 12000。
const DISTILL_RETRY_MAX_TOKENS = 16000;
const DISTILL_RETRY_FALLBACK_TOKENS = 12000;
// 重试指令：旧实现是「同 prompt 重试」，空正文/截断时补一句强指令提高成功率。
const DISTILL_RETRY_NOTE = '\n\n【重试要求】上一次输出不可用（正文为空或被截断）。请直接输出 JSON 本体：不要输出推理过程、分析或解释文字；只输出一个完整可解析的 JSON 对象，不要代码围栏。';

function chunkMaterials(materials, batchSize) {
    const size = Math.max(1, batchSize);
    const chunks = [];
    for (let i = 0; i < materials.length; i += size) {
        chunks.push(materials.slice(i, i + size));
    }
    return chunks;
}

function loadTemplate(baseDir) {
    const templatePath = path.join(baseDir, 'templates', 'distill.md');
    try {
        return require('fs').readFileSync(templatePath, 'utf8');
    } catch {
        return FALLBACK_DISTILL_TEMPLATE;
    }
}

async function readRawMaterials(runDir, subskillId) {
    const rawDir = path.join(runDir, 'raw', subskillId);
    const materials = [];
    try {
        const names = await fsp.readdir(rawDir);
        for (const name of names) {
            if (!name.endsWith('.meta.json')) {
                continue;
            }
            try {
                const meta = JSON.parse(await fsp.readFile(path.join(rawDir, name), 'utf8'));
                const bodyFile = name.replace(/\.meta\.json$/, '.md');
                let body = '';
                try {
                    body = await fsp.readFile(path.join(rawDir, bodyFile), 'utf8');
                } catch {
                    // 正文缺失时用 meta 的 title/snippet 兜底。
                }
                // 全文证据（M4 T25）：有 evidencePath 则加载归档全文；
                // 无全文的材料保留发现价值，但规范/事实主张在门禁处不可证。
                let fullText = null;
                if (meta.evidencePath) {
                    try {
                        fullText = await fsp.readFile(path.join(runDir, meta.evidencePath), 'utf8');
                    } catch {
                        // 证据文件损坏：按无全文处理，门禁自会拦截。
                    }
                }
                materials.push({
                    url: meta.url,
                    title: meta.title,
                    fetchedAt: meta.fetchedAt,
                    plugin: meta.plugin,
                    content: body || meta.title || '',
                    snippetOnly: !fullText,
                    fullText: fullText || null
                });
            } catch {
                // 单份元数据损坏跳过，不阻断整批。
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
    return materials;
}

function renderTemplate(template, { subskill, materials, existingCardTitles }) {
    const materialsBlock = materials
        .map((material, index) => `[${index + 1}] ${material.title}\nURL: ${material.url}\n${String(material.content).slice(0, 4000)}`)
        .join('\n\n');
    return template
        .replace(/\{\{subskillTitle\}\}/g, subskill.title)
        .replace(/\{\{subskillId\}\}/g, subskill.id)
        .replace(/\{\{existingCardTitles\}\}/g, existingCardTitles.length > 0 ? existingCardTitles.map((t) => `- ${t}`).join('\n') : '（新库，暂无既有卡）')
        .replace(/\{\{materials\}\}/g, materialsBlock || '（无材料）');
}

// 彻底失败前把原始输出留档（用户侧排查依赖：解析失败时能看到模型到底吐了什么）。
// 留档自身失败只记日志，不掩盖原始错误。
async function dumpDistillFailure(runDir, subskill, batch, attempts, promptPreview) {
    try {
        const dir = path.join(runDir, 'distill-failed');
        await fsp.mkdir(dir, { recursive: true });
        for (const attempt of attempts) {
            await fsp.writeFile(
                path.join(dir, `${subskill.id}.attempt-${attempt.index}.json`),
                `${JSON.stringify({
                    subskillId: subskill.id,
                    attempt: attempt.index,
                    finishReason: attempt.finishReason,
                    usage: attempt.usage ?? null,
                    batchUrls: batch.map((material) => material.url),
                    promptPreview,
                    rawContent: attempt.content
                }, null, 2)}\n`,
                'utf8'
            );
        }
    } catch {
        // 尽力而为。
    }
}

/**
 * 单批材料的蒸馏 LLM 调用与解析策略（2026-10-17 起走 jsonCompletion 阶梯）：
 * 整体解析 → 抢救完整单元 → 从推理段抢救（正文为空时）→ 抬预算重试；
 * finish_reason=length 且批内多份材料时立即拆半重蒸（该形态同 prompt 抬预算
 * 只会重蒸同一批大材料，拆半更便宜）；彻底失败留档并抛
 * FORGE_LLM_EMPTY_CONTENT（全空正文）或 FORGE_DISTILL_OUTPUT_INVALID。
 * 返回 { knowledgeUnits, droppedSources, salvaged, salvagedFrom }。
 */
async function distillMaterialBatch({ subskill, batch, template, llm, llmConfig, logger, runDir, existingCardTitles, depth = 0 }) {
    const prompt = renderTemplate(template, { subskill, materials: batch, existingCardTitles });
    const halvingEligible = batch.length > 1 && depth < MAX_BATCH_HALVING_DEPTH;
    const result = await completeJsonResilient({
        llm,
        llmConfig,
        prompt,
        temperature: 0.2,
        label: `distill: subskill ${subskill.id}`,
        logger,
        maxTokens: DISTILL_MAX_TOKENS,
        retryMaxTokens: DISTILL_RETRY_MAX_TOKENS,
        retryFallbackTokens: DISTILL_RETRY_FALLBACK_TOKENS,
        maxAttempts: DISTILL_MAX_ATTEMPTS,
        retryNote: DISTILL_RETRY_NOTE,
        thinking: resolveThinkingMode('FORGE_DISTILL_THINKING', 'disabled'),
        validate: (payload) => Boolean(payload) && Array.isArray(payload.knowledgeUnits),
        salvage: (text) => salvageTruncatedPayload(text),
        // 有正文但被截断且可拆半：中止阶梯，交给拆半重蒸（保留 2026-10-11 的原始
        // 判据——批太大，拆小比抬预算对症）；「正文为空」不走拆半：那是推理段/
        // 输出预算的问题，抬预算才对症。
        onAttempt: (attempt) => (attempt.finishReason === 'length' && !attempt.blank && halvingEligible ? 'stop' : undefined)
    });

    if (result.payload) {
        const units = result.payload.knowledgeUnits;
        if (result.salvagedFrom) {
            logger?.(`distill: subskill ${subskill.id} 从${result.salvagedFrom.startsWith('reasoning') ? '推理段' : '截断输出'}抢救出 ${units.length} 个完整知识单元`);
        }
        return {
            knowledgeUnits: units,
            droppedSources: result.payload.droppedSources,
            salvaged: Boolean(result.salvagedFrom),
            salvagedFrom: result.salvagedFrom
        };
    }

    if (result.halted && halvingEligible) {
        const mid = Math.ceil(batch.length / 2);
        logger?.(`distill: subskill ${subskill.id} 批输出被截断（finish_reason=length），拆半重蒸（${mid}+${batch.length - mid} 份）`);
        const merged = { knowledgeUnits: [], droppedSources: [], salvaged: false, salvagedFrom: null };
        for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
            const part = await distillMaterialBatch({
                subskill, batch: half, template, llm, llmConfig, logger, runDir,
                existingCardTitles, depth: depth + 1
            });
            merged.knowledgeUnits.push(...part.knowledgeUnits);
            merged.droppedSources.push(...part.droppedSources);
            merged.salvaged = merged.salvaged || part.salvaged;
            merged.salvagedFrom = merged.salvagedFrom || part.salvagedFrom;
        }
        return merged;
    }

    await dumpDistillFailure(runDir, subskill, batch, result.attempts, prompt.slice(0, 2000));
    const failure = describeAttemptFailure(result.attempts);
    const emptyContent = result.failureReason === 'empty-content';
    const error = new Error(
        `subskill ${subskill.id} 蒸馏${failure.summary}（已尝试 ${result.attempts.length} 次：${attemptsBudgetNote(result.attempts)}；原始输出已留档 distill-failed/）`
    );
    error.code = emptyContent ? 'FORGE_LLM_EMPTY_CONTENT' : 'FORGE_DISTILL_OUTPUT_INVALID';
    error.status = 502;
    error.details = {
        subskillId: subskill.id,
        batchUrls: batch.map((material) => material.url),
        finishReasons: failure.finishReasons,
        reasoningTokens: failure.reasoningTokens,
        blankAttempts: failure.blankCount
    };
    throw error;
}

// 尝试预算轨迹（8k→16k 这类抬升在错误消息里可辨）。
function attemptsBudgetNote(attempts) {
    const budgets = [];
    for (const attempt of attempts) {
        if (budgets[budgets.length - 1] !== attempt.maxTokens) {
            budgets.push(attempt.maxTokens);
        }
    }
    return `预算 ${budgets.join('→')}，finish_reason=${attempts.map((a) => a.finishReason ?? 'unknown').join('/')}`;
}

// 质量过滤丢弃留档（§3.4）：成功与失败路径共用——失败时一并写，丢弃理由不丢。
async function recordDroppedSources(runDir, libraryName, dropped, stamp) {
    if (!Array.isArray(dropped) || dropped.length === 0) {
        return;
    }
    try {
        await fsp.mkdir(runDir, { recursive: true });
        await fsp.writeFile(
            path.join(runDir, 'distill-dropped.json'),
            `${JSON.stringify({ libraryName, dropped, droppedAt: stamp }, null, 2)}\n`,
            'utf8'
        );
    } catch {
        // 留档尽力而为，不掩盖原始错误。
    }
}

async function smokeSearchLibrary(knowledgeStorePort, { libraryName, query, logger, retries = SMOKE_RETRY_COUNT, intervalMs = SMOKE_RETRY_INTERVAL_MS }) {
    if (!knowledgeStorePort || knowledgeStorePort.available === false) {
        return { skipped: true, reason: 'knowledge store port unavailable（TDB 未启用）' };
    }
    try {
        const libraries = await knowledgeStorePort.listLibraries();
        if (!libraries.includes(libraryName)) {
            // watcher 尚未发现新目录：listLibraries 来自 metaDb ∪ 磁盘，重试等待。
            logger?.(`smoke: 新库 ${libraryName} 暂未出现在库清单（${libraries.length} 个库），等待 watcher 索引`);
        }
    } catch (error) {
        return { skipped: true, reason: `listLibraries 失败：${error.message}` };
    }

    for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
            const hits = await knowledgeStorePort.search(query, { libraries: [libraryName], topK: 3 });
                if (Array.isArray(hits) && hits.length > 0) {
                    return { skipped: false, verified: true, hits: hits.length, query };
                }
        } catch (error) {
            logger?.(`smoke: 查询失败（第 ${attempt} 次）：${error.message}`);
        }
        if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    // 索引完成是 TDB watcher 的异步职责（真实环境 embedding 延迟可达分钟级，
    // 且写入期的 TriviumDB 读打开可能与写句柄锁竞争——均非 distill 可控），
    // 冒烟尽力而为：未命中记告警留痕，不阻断 distill——产物已落盘，
    // 最终可检索性由门禁/人工在索引稳定后验证（TDB 队列自动重试 upsertFile）。
    logger?.(`smoke: 新库 ${libraryName} 在 ${retries * intervalMs / 1000}s 窗口内未命中（索引延迟或失败，TDB 队列将自动重试 upsertFile）`);
    return { skipped: false, verified: false, hits: 0, query, reason: 'index_lag_or_failed' };
}

function createDistillStepRunner({ knowledgeRoot, smokeRetries = SMOKE_RETRY_COUNT, smokeIntervalMs = SMOKE_RETRY_INTERVAL_MS, batchMaterials = DEFAULT_BATCH_MATERIALS }) {
    return async function runDistillStep(ctx) {
        const { runDir, llm, llmConfig, logger } = ctx;
        if (!ctx.blueprintPath) {
            const error = new Error('distill 需要 blueprintPath（blueprint 步骤产物）');
            error.code = 'FORGE_BLUEPRINT_MISSING';
            error.status = 400;
            throw error;
        }
        if (!llm || llm.available !== true) {
            const error = new Error('llmCompletion 端口不可用，无法蒸馏');
            error.code = 'FORGE_LLM_UNAVAILABLE';
            error.status = 503;
            throw error;
        }
        if (!llmConfig || !llmConfig.url || !llmConfig.apiKey || !llmConfig.model) {
            const error = new Error('未配置铸造 LLM，无法蒸馏');
            error.code = 'FORGE_LLM_UNAVAILABLE';
            error.status = 503;
            throw error;
        }

        const blueprint = await readBlueprint(ctx.blueprintPath);
        const libraryName = blueprintLibraryName(blueprint.name);
        const libraryDir = path.join(knowledgeRoot, libraryName);
        const writer = createKnowledgeWriter({ libraryDir });
        const template = loadTemplate(ctx.baseDir);
        const fetchedAt = new Date().toISOString();

        const written = [];
        const merged = [];
        const dropped = [];
        const salvagedBatches = [];
        // M4 质量门禁产物（§3.8.4 质量报告的原料）。
        const qualityVerdicts = [];
        const qualityClaims = [];
        const needsReviewUnits = [];
        const quarantineUnits = [];
        const mergeProposals = [];

        // 单元写入库外复核区（§2.2 needs_review：runs/<jobId>/review/<library>/）。
        // 复核区文件保留完整卡形制（frontmatter + sources），用户可直接采纳移入。
        const writeUnitToZone = async (zoneDir, unit, subskillId, fetchedAtByUrl, defaultFetchedAt) => {
            await fsp.mkdir(zoneDir, { recursive: true });
            const base = `${subskillId}_${String(unit.title || 'unit').slice(0, 40).replace(/[\\/:*?"<>|\s]+/g, '-')}`;
            let fileName = `R_${base}.md`;
            let counter = 2;
            while (fsSyncExists(path.join(zoneDir, fileName))) {
                fileName = `R_${base}-${counter}.md`;
                counter += 1;
            }
            const sources = (unit.sourceUrls || []).map((url) => `  - url: ${url}\n    fetchedAt: ${(fetchedAtByUrl && fetchedAtByUrl.get(url)) || defaultFetchedAt}`).join('\n');
            const body = [
                '---',
                `title: ${String(unit.title).replace(/\n/g, ' ')}`,
                `type: ${unit.type}`,
                `subskill: ${subskillId}`,
                'sources:',
                sources,
                '---',
                '',
                String(unit.content)
            ].join('\n');
            await fsp.writeFile(path.join(zoneDir, fileName), `${body}\n`, 'utf8');
            return fileName;
        };
        const fsSyncExists = (target) => {
            try {
                require('fs').accessSync(target);
                return true;
            } catch {
                return false;
            }
        };

        // 增量学习：与 harvest 同 scope 过滤（材料为空的子技能本就跳过，此处显式对齐）。
        const scopeIds = Array.isArray(ctx.scope?.subskillIds) ? ctx.scope.subskillIds : null;
        const targetSubskills = scopeIds
            ? blueprint.subskills.filter((subskill) => scopeIds.includes(subskill.id))
            : blueprint.subskills;
        try {
            for (const subskill of targetSubskills) {
                const materials = await readRawMaterials(runDir, subskill.id);
                if (materials.length === 0) {
                    logger?.(`distill: subskill ${subskill.id} 无原始材料，跳过（增量学习 scope 外或采集为空）`);
                    continue;
                }

                // 材料级主题门禁（§3.5.2：材料读取后、分批蒸馏前）：
                // out_of_scope 材料直接出局（记录判定），adjacent/uncertain 标记——
                // 只引用不确定材料的单元降级复核。
                const gatedMaterials = [];
                const materialTopicByurl = new Map();
                for (const material of materials) {
                    const verdict = qualityGate.assessMaterial({ blueprint, subskill, material });
                    materialTopicByurl.set(material.url, verdict.topic.verdict);
                    qualityVerdicts.push({ subjectType: 'material', subjectId: material.url, status: verdict.status, topic: verdict.topic.verdict, reason: verdict.topic.reason });
                    if (verdict.status === 'quarantine') {
                        dropped.push({ url: material.url, reason: `材料级主题门禁：${verdict.topic.reason}` });
                        continue;
                    }
                    gatedMaterials.push({ ...material, topicUncertain: verdict.status === 'needs_review' });
                }
                if (gatedMaterials.length === 0) {
                    logger?.(`distill: subskill ${subskill.id} 全部材料被主题门禁拦截，跳过`);
                    continue;
                }

                // 材料分批：压低单次 LLM 输出体量，避免 max_tokens 截断
                //（2026-10-11 两单连续败于 10 份材料单次蒸馏超限）。
                for (const batch of chunkMaterials(gatedMaterials, batchMaterials)) {
                    // 批间刷新既有卡：跨批同义知识点仍走 mergeInto 合并而非新建。
                    const existingCards = writer.listCards();
                    const payload = await distillMaterialBatch({
                        subskill,
                        batch,
                        template,
                        llm,
                        llmConfig,
                        logger,
                        runDir,
                        existingCardTitles: existingCards.map((card) => card.title)
                    });
                    if (payload.salvaged) {
                        salvagedBatches.push({ subskillId: subskill.id, units: payload.knowledgeUnits.length });
                    }

                    // 红线 4 白名单：sourceUrls 只认本批材料的 URL——LLM 幻觉出的
                    // 「貌似可信」来源一律降级进 dropped，不混入知识卡。
                    const materialUrlToFetchedAt = new Map(materials.map((material) => [material.url, material.fetchedAt]));
                    const titleToCard = new Map(existingCards.map((card) => [card.title, card.file]));
                    // 本批格式合法、过了来源白名单的单元 → 先主张核验再单元门禁。
                    const candidateUnits = [];
                    for (const unit of payload.knowledgeUnits) {
                        if (!unit || !UNIT_TYPES.has(unit.type) || !unit.title || !unit.content) {
                            logger?.(`distill: 丢弃格式非法的知识单元：${JSON.stringify(unit?.title || unit)}`);
                            continue;
                        }
                        const declared = Array.isArray(unit.sourceUrls) ? unit.sourceUrls.filter(Boolean) : [];
                        const fabricated = declared.filter((url) => !materialUrlToFetchedAt.has(url));
                        for (const url of fabricated) {
                            dropped.push({ url, reason: `LLM 声称的来源不在材料清单中（疑似编造），已剔除（红线 4）` });
                        }
                        const sourceUrls = declared.filter((url) => materialUrlToFetchedAt.has(url));
                        if (sourceUrls.length === 0) {
                            dropped.push({ url: '(no source)', reason: `知识单元「${unit.title}」无有效出处，不入库（红线 4）` });
                            continue;
                        }
                        candidateUnits.push({ ...unit, sourceUrls, sourceMaterials: batch.filter((m) => sourceUrls.includes(m.url)) });
                    }

                    // 主张核验（§3.5.3）：LLM 提取 → URL/引文确定性匹配 → 独立判定。
                    // 证据只认归档全文（snippetOnly 来源不构成证据，红线 3）。
                    const evidenceBySourceUrl = {};
                    for (const material of batch) {
                        if (material.fullText) evidenceBySourceUrl[material.url] = material.fullText;
                    }
                    const fullTextUrls = Object.keys(evidenceBySourceUrl);
                    let claimsByTitle = new Map();
                    let claimIssues = [];
                    if (candidateUnits.length > 0 && fullTextUrls.length > 0) {
                        try {
                            const verified = await qualityGate.verifyClaims({
                                units: candidateUnits,
                                evidenceBySourceUrl,
                                materialUrls: fullTextUrls,
                                llm,
                                llmConfig,
                                logger
                            });
                            claimsByTitle = verified.byUnitTitle;
                            claimIssues = verified.issues;
                            for (const claim of verified.allClaims) {
                                qualityClaims.push(claim);
                            }
                        } catch (error) {
                            // 主张核验是硬门禁：核验失败（LLM 不可用/输出不可解析）
                            // 不得静默放行——本批全部转复核。
                            logger?.(`distill: 主张核验失败（${error.message}），本批 ${candidateUnits.length} 个单元全部转待复核`);
                            claimIssues = [{ code: 'CLAIM_VERIFY_FAILED', message: `主张核验失败：${error.message}`, blocking: false }];
                            for (const unit of candidateUnits) {
                                needsReviewUnits.push({ subskillId: subskill.id, title: unit.title, reason: '主张核验基础设施失败' });
                            }
                            candidateUnits.length = 0;
                        }
                    }

                    for (const unit of candidateUnits) {
                        const unitClaims = claimsByTitle.get(unit.title) || [];
                        const unitClaimIssues = claimIssues.filter((issue) => !issue.blocking || issue.code !== 'CLAIM_VERIFY_FAILED');
                        const uncertainMaterialOnly = unit.sourceMaterials.length > 0
                            && unit.sourceMaterials.every((material) => material.topicUncertain);
                        const verdict = qualityGate.assessUnit({
                            blueprint,
                            subskill,
                            unit,
                            claims: unitClaims,
                            claimIssues: unitClaimIssues,
                            materialVerdicts: (unit.sourceUrls || []).map((url) => materialTopicByurl.get(url)).filter(Boolean)
                        });
                        qualityVerdicts.push({
                            subjectType: 'knowledgeUnit',
                            subjectId: unit.title,
                            status: verdict.status,
                            topic: verdict.topic.verdict,
                            reason: verdict.topic.reason,
                            issues: verdict.issues.map((issue) => `${issue.code}: ${issue.message}`)
                        });

                        if (verdict.status === 'quarantine') {
                            quarantineUnits.push({
                                subskillId: subskill.id,
                                title: unit.title,
                                reason: verdict.topic.reason
                            });
                            continue;
                        }
                        if (verdict.status === 'needs_review' || uncertainMaterialOnly) {
                            // §3.5.2：uncertain（含"来源材料主题不确定"）→ needs_review，
                            // 不是 quarantine——只有 out_of_scope 才隔离。
                            needsReviewUnits.push({
                                subskillId: subskill.id,
                                title: unit.title,
                                reason: uncertainMaterialOnly
                                    ? `来源材料主题不确定（${verdict.topic.reason}）`
                                    : (verdict.issues.map((issue) => issue.code).join(',') || verdict.topic.reason)
                            });
                            // 写入复核区（§2.2：候选与活跃知识分离），待用户复核采纳。
                            await writeUnitToZone(path.join(runDir, 'review', libraryName), unit, subskill.id, materialUrlToFetchedAt, fetchedAt);
                            continue;
                        }

                        // 合并分类（§3.3.3/T29）：mergeInto 命中既有卡时判定合并类别。
                        if (unit.mergeInto && titleToCard.has(unit.mergeInto)) {
                            const targetFile = titleToCard.get(unit.mergeInto);
                            let targetContent = '';
                            try {
                                const rawCard = await fsp.readFile(path.join(libraryDir, targetFile), 'utf8');
                                // 分类只比正文（剥 frontmatter——来源块新旧天然不同）。
                                const fmEnd = rawCard.indexOf('\n---\n');
                                targetContent = fmEnd >= 0 ? rawCard.slice(fmEnd + 5) : rawCard;
                            } catch { /* 读不到按内容型处理 */ }
                            const targetSubskill = /^K_([A-Za-z0-9-]+)_/.exec(targetFile)?.[1] || null;
                            const crossSubskill = targetSubskill && targetSubskill !== subskill.id;
                            const mergeClass = crossSubskill
                                ? 'cross-subskill'
                                : qualityGate.classifyMerge({ unit, targetCard: { content: targetContent } });
                            if (mergeClass === 'source-only') {
                                const mergeResult = await writer.mergeSources(targetFile, unit.sourceUrls, {
                                    fetchedAtByUrl: materialUrlToFetchedAt,
                                    defaultFetchedAt: fetchedAt
                                });
                                merged.push({ into: unit.mergeInto, targetFile, addedSources: mergeResult.addedCount, classification: 'source-only' });
                            } else {
                                // 内容修订/冲突/跨子技能：一律复核建议，绝不自动覆盖（红线 6）。
                                mergeProposals.push({
                                    subskillId: subskill.id,
                                    title: unit.title,
                                    target: unit.mergeInto,
                                    targetFile,
                                    classification: mergeClass,
                                    reason: mergeClass === 'conflict'
                                        ? '数值/规范级主张分歧（§3.3.3）'
                                        : mergeClass === 'cross-subskill' ? '跨子技能合并（§3.5.2）' : '正文存在实质差异'
                                });
                                await writeUnitToZone(path.join(runDir, 'review', libraryName), unit, subskill.id, materialUrlToFetchedAt, fetchedAt);
                            }
                            continue;
                        }
                        // D2 分流：methodology → 长文档；其余 → 知识卡。
                        if (unit.type === 'methodology') {
                            const result = await writer.writeLongDoc(unit, {
                                fetchedAtByUrl: materialUrlToFetchedAt,
                                defaultFetchedAt: fetchedAt
                            });
                            written.push(result);
                        } else {
                            const result = await writer.writeCard(unit, {
                                subskillId: subskill.id,
                                fetchedAtByUrl: materialUrlToFetchedAt,
                                defaultFetchedAt: fetchedAt
                            });
                            written.push(result);
                        }
                    }

                    for (const drop of Array.isArray(payload.droppedSources) ? payload.droppedSources : []) {
                        if (drop && drop.url) {
                            dropped.push({ url: drop.url, reason: drop.reason || '质量过滤' });
                        }
                    }
                }
            }
        } catch (error) {
            // 部分入库留痕（2026-10-17）：蒸馏边蒸边写盘，失败时前面已完成的子技能
            // 卡片其实已经落盘，但步骤 marker 不落——此前学习档案一律记
            // distilledFiles: 0，面板看起来整批白跑（实测失败单已写 11 个文件却记 0）。
            // 把已写盘进度带回错误里（学习档案/面板据此显示部分入库），产物不动。
            const partial = {
                writtenCount: written.length,
                mergedCount: merged.length,
                droppedCount: dropped.length,
                writtenFiles: written.map((item) => item.fileName)
            };
            error.details = { ...(error.details || {}), partial };
            if (written.length > 0 || merged.length > 0) {
                error.message = `${error.message}（该步骤已完成部分入库：${written.length} 个新文件 / ${merged.length} 次合并，已落盘产物保留）`;
            }
            await recordDroppedSources(runDir, libraryName, dropped, fetchedAt);
            throw error;
        }

        // 质量过滤丢弃留档（§3.4）。
        await recordDroppedSources(runDir, libraryName, dropped, fetchedAt);

        // 索引就绪门禁（§3.6.1，M4 T30）：从「首子技能任意命中」升级为合取条件——
        // initialized && compatible && 队列收敛 && 每个预期文件正向探针命中 &&
        // 内容型合并的新正文探针命中。任一不满足 = fail closed（§3.6.1）。
        // 就绪探针覆盖：新写文件 + 纯重复合并的目标卡（合并改写了卡文件，
        // watcher 会重新摄取——目标卡应仍可检索）。
        const expectedFiles = [
            ...written.map((item) => `${libraryName}/${item.fileName}`),
            ...merged.filter((m) => m.targetFile).map((m) => `${libraryName}/${m.targetFile}`)
        ];
        const ledger = createDispositionLedger(path.join(ctx.baseDir, blueprint.name, 'disposition-ledger.jsonl'));
        let indexReady = null;
        if (expectedFiles.length > 0) {
            indexReady = await qualityGate.assertIndexReady({
                knowledgeStorePort: ctx.knowledgeStorePort,
                expectedFiles,
                probes: [],
                timeoutMs: smokeRetries * smokeIntervalMs,
                pollIntervalMs: Math.min(smokeIntervalMs, 5000),
                logger
            });
            if (!indexReady.ok) {
                // §3.6.1：distill 不落步骤成功 marker——已短暂进入 publishing 的
                // 文件必须 demote 到复核区，并等待 unlink 收敛。
                const demoted = [];
                for (const item of written) {
                    const activeAbs = path.join(libraryDir, item.fileName);
                    if (!fsSyncExists(activeAbs)) continue;
                    const reviewPath = path.join(runDir, 'review', libraryName, item.fileName);
                    await moveKnowledgeFile({
                        ledger,
                        from: activeAbs,
                        to: reviewPath,
                        reason: `索引就绪门禁失败：${indexReady.reasons[0]}`,
                        fromState: STATES.PUBLISHING,
                        toState: STATES.NEEDS_REVIEW,
                        knowledgeRoot
                    }).catch(() => undefined); // 移动失败不掩盖门禁结论
                    demoted.push(item.fileName);
                }
                const failure = new Error(
                    `索引就绪门禁失败（fail closed）：${indexReady.reasons.join('；')}——`
                    + `${demoted.length} 个已写文件 demote 到复核区，本步骤不落成功 marker（可修复后 resume）`
                );
                failure.code = 'FORGE_INDEX_NOT_READY';
                failure.status = 503;
                failure.details = {
                    indexReady,
                    demotedFiles: demoted,
                    partial: { writtenCount: written.length, demotedCount: demoted.length, reviewCount: needsReviewUnits.length }
                };
                throw failure;
            }
        }

        // 质量报告（§3.8.4）：材料数/主题分布/主张支持率/合并分类/发布状态。
        const claimSupport = qualityClaims.reduce((acc, claim) => {
            acc[claim.support] = (acc[claim.support] || 0) + 1;
            return acc;
        }, {});
        const qualityReport = {
            ruleVersion: qualityGate.QUALITY_RULE_VERSION,
            generatedAt: new Date().toISOString(),
            libraryName,
            verdicts: {
                total: qualityVerdicts.length,
                byStatus: qualityVerdicts.reduce((acc, v) => { acc[v.status] = (acc[v.status] || 0) + 1; return acc; }, {}),
                detail: qualityVerdicts
            },
            claims: { total: qualityClaims.length, bySupport: claimSupport },
            merges: {
                sourceOnly: merged.length,
                proposals: mergeProposals
            },
            needsReviewUnits,
            quarantineUnits,
            indexReady,
            droppedCount: dropped.length,
            waterAdvance: indexReady?.ok === true && needsReviewUnits.length === 0 && quarantineUnits.length === 0 && written.length > 0
        };
        try {
            await fsp.writeFile(path.join(runDir, 'quality-report.json'), `${JSON.stringify(qualityReport, null, 2)}\n`, 'utf8');
        } catch { /* 报告留档尽力而为 */ }

        const salvageNote = salvagedBatches.length > 0
            ? `（含 ${salvagedBatches.length} 批截断抢救：${salvagedBatches.map((b) => `${b.subskillId}×${b.units}`).join(', ')}）`
            : '';
        return {
            summary: `蒸馏完成：${written.length} 个新文件 / ${merged.length} 次合并 / 复核 ${needsReviewUnits.length} / 隔离 ${quarantineUnits.length} / 丢弃 ${dropped.length} 源${salvageNote}${indexReady ? `（索引就绪：${indexReady.ok ? '通过' : '未通过'}）` : '（零产物，无索引门禁）'}`,
            artifacts: written.map((item) => `knowledge/${libraryName}/${item.fileName}`),
            state: {
                libraryName,
                writtenCount: written.length,
                mergedCount: merged.length,
                droppedCount: dropped.length,
                salvagedBatches,
                needsReviewCount: needsReviewUnits.length,
                quarantineCount: quarantineUnits.length,
                needsReviewUnits,
                quarantineUnits,
                mergeProposals,
                claims: { total: qualityClaims.length, bySupport: claimSupport },
                indexReady,
                qualityReport: 'quality-report.json',
                waterAdvance: qualityReport.waterAdvance
            }
        };
    };
}

module.exports = {
    FALLBACK_DISTILL_TEMPLATE,
    UNIT_TYPES,
    DEFAULT_BATCH_MATERIALS,
    createDistillStepRunner,
    smokeSearchLibrary
};
