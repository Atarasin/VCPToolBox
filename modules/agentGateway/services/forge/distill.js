'use strict';

const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { createKnowledgeWriter } = require('./knowledgeWriter');
const { extractJsonObject, salvageTruncatedPayload } = require('./jsonUtils');

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
 * - 输出整体不可解析时先尝试「抢救完整知识单元」，再考虑同 prompt 重试；
 * - finish_reason=length 且批内多份材料时拆半重蒸（同 prompt 重试大概率
 *   再次截断）；彻底失败前把原始输出留档 distill-failed/ 供事后诊断。
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
const DISTILL_MAX_TOKENS = 8000;

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
                materials.push({
                    url: meta.url,
                    title: meta.title,
                    fetchedAt: meta.fetchedAt,
                    plugin: meta.plugin,
                    content: body || meta.title || ''
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
 * 单批材料的蒸馏 LLM 调用与解析策略：
 * 整体解析 → 抢救完整单元 → （finish_reason=length 且批内多份材料）拆半重蒸
 * → 同 prompt 重试一次 → 留档并抛 FORGE_DISTILL_OUTPUT_INVALID。
 * 返回 { knowledgeUnits, droppedSources, salvaged }。
 */
async function distillMaterialBatch({ subskill, batch, template, llm, llmConfig, logger, runDir, existingCardTitles, depth = 0 }) {
    const prompt = renderTemplate(template, { subskill, materials: batch, existingCardTitles });
    const completeOnce = async () => llm.complete(llmConfig, {
        model: llmConfig.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: DISTILL_MAX_TOKENS
    });
    const attempts = [];
    for (let index = 1; index <= 2; index += 1) {
        const response = await completeOnce();
        const choice = response?.data?.choices?.[0];
        const content = choice?.message?.content || '';
        const finishReason = choice?.finish_reason || null;

        const payload = extractJsonObject(content);
        if (payload && Array.isArray(payload.knowledgeUnits)) {
            return { knowledgeUnits: payload.knowledgeUnits, droppedSources: payload.droppedSources, salvaged: false };
        }

        // 整体不可解析：先抢救完整单元（截断只损失被切开的那个尾单元）。
        const salvaged = salvageTruncatedPayload(content);
        if (salvaged) {
            logger?.(`distill: subskill ${subskill.id} 输出整体不可解析（finish_reason=${finishReason ?? 'unknown'}），抢救出 ${salvaged.knowledgeUnits.length} 个完整知识单元`);
            return { knowledgeUnits: salvaged.knowledgeUnits, droppedSources: salvaged.droppedSources, salvaged: true };
        }

        attempts.push({ index, finishReason, usage: response?.data?.usage ?? null, content });

        // 确认截断且批内多份材料：同 prompt 重试大概率再次截断，拆半各蒸一次。
        if (finishReason === 'length' && batch.length > 1 && depth < MAX_BATCH_HALVING_DEPTH) {
            const mid = Math.ceil(batch.length / 2);
            logger?.(`distill: subskill ${subskill.id} 批输出被截断（finish_reason=length），拆半重蒸（${mid}+${batch.length - mid} 份）`);
            const merged = { knowledgeUnits: [], droppedSources: [], salvaged: false };
            for (const half of [batch.slice(0, mid), batch.slice(mid)]) {
                const part = await distillMaterialBatch({
                    subskill, batch: half, template, llm, llmConfig, logger, runDir,
                    existingCardTitles, depth: depth + 1
                });
                merged.knowledgeUnits.push(...part.knowledgeUnits);
                merged.droppedSources.push(...part.droppedSources);
                merged.salvaged = merged.salvaged || part.salvaged;
            }
            return merged;
        }

        if (index === 1) {
            logger?.(`distill: subskill ${subskill.id} 输出不可解析（finish_reason=${finishReason ?? 'unknown'}），重试一次`);
        }
    }
    await dumpDistillFailure(runDir, subskill, batch, attempts, prompt.slice(0, 2000));
    const error = new Error(
        `subskill ${subskill.id} 蒸馏输出不可解析（已重试一次；finish_reason=${attempts.map((a) => a.finishReason ?? 'unknown').join('/')}，原始输出已留档 distill-failed/）`
    );
    error.code = 'FORGE_DISTILL_OUTPUT_INVALID';
    error.status = 502;
    throw error;
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

        // 增量学习：与 harvest 同 scope 过滤（材料为空的子技能本就跳过，此处显式对齐）。
        const scopeIds = Array.isArray(ctx.scope?.subskillIds) ? ctx.scope.subskillIds : null;
        const targetSubskills = scopeIds
            ? blueprint.subskills.filter((subskill) => scopeIds.includes(subskill.id))
            : blueprint.subskills;
        for (const subskill of targetSubskills) {
            const materials = await readRawMaterials(runDir, subskill.id);
            if (materials.length === 0) {
                logger?.(`distill: subskill ${subskill.id} 无原始材料，跳过（增量学习 scope 外或采集为空）`);
                continue;
            }

            // 材料分批：压低单次 LLM 输出体量，避免 max_tokens 截断
            //（2026-10-11 两单连续败于 10 份材料单次蒸馏超限）。
            for (const batch of chunkMaterials(materials, batchMaterials)) {
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
                    const normalized = { ...unit, sourceUrls };

                    if (unit.mergeInto && titleToCard.has(unit.mergeInto)) {
                        const mergeResult = await writer.mergeSources(titleToCard.get(unit.mergeInto), sourceUrls, {
                            fetchedAtByUrl: materialUrlToFetchedAt,
                            defaultFetchedAt: fetchedAt
                        });
                        merged.push({ into: unit.mergeInto, addedSources: mergeResult.addedCount });
                        continue;
                    }
                    // D2 分流：methodology → 长文档；其余 → 知识卡。
                    if (normalized.type === 'methodology') {
                        const result = await writer.writeLongDoc(normalized, {
                            fetchedAtByUrl: materialUrlToFetchedAt,
                            defaultFetchedAt: fetchedAt
                        });
                        written.push(result);
                    } else {
                        const result = await writer.writeCard(normalized, {
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

        // 质量过滤丢弃留档（§3.4）。
        if (dropped.length > 0) {
            await fsp.mkdir(runDir, { recursive: true });
            await fsp.writeFile(
                path.join(runDir, 'distill-dropped.json'),
                `${JSON.stringify({ libraryName, dropped, droppedAt: fetchedAt }, null, 2)}\n`,
                'utf8'
            );
        }

        // 入库验证（§3.4：写后 gateway_knowledge_search 冒烟查询新库；此处经
        // knowledgeStorePort 同源调用 TDB，权限层在 MCP 工具面，M3.S2 绑定）。
        const smokeQuery = blueprint.subskills[0]?.searchQueries?.[0] || blueprint.name;
        const smoke = await smokeSearchLibrary(ctx.knowledgeStorePort, {
            libraryName,
            query: smokeQuery,
            logger,
            retries: smokeRetries,
            intervalMs: smokeIntervalMs
        });

        const smokeNote = smoke.skipped
            ? '（冒烟跳过：TDB 未启用）'
            : (smoke.verified ? `（冒烟命中 ${smoke.hits} 条）` : '（冒烟未命中：索引延迟，TDB 队列自动重试）');
        const salvageNote = salvagedBatches.length > 0
            ? `（含 ${salvagedBatches.length} 批截断抢救：${salvagedBatches.map((b) => `${b.subskillId}×${b.units}`).join(', ')}）`
            : '';
        return {
            summary: `蒸馏完成：${written.length} 个新文件 / ${merged.length} 次合并 / 丢弃 ${dropped.length} 源${salvageNote}${smokeNote}`,
            artifacts: written.map((item) => `knowledge/${libraryName}/${item.fileName}`),
            state: {
                libraryName,
                writtenCount: written.length,
                mergedCount: merged.length,
                droppedCount: dropped.length,
                salvagedBatches,
                smoke
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
