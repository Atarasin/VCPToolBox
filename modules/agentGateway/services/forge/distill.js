'use strict';

const fsp = require('fs').promises;
const path = require('path');

const { readBlueprint, blueprintLibraryName } = require('./blueprint');
const { createKnowledgeWriter } = require('./knowledgeWriter');
const { extractJsonObject } = require('./jsonUtils');

/**
 * 蒸馏（distill）步骤：原始材料 → 知识单元 → knowledge/<库名>/ 落盘 → 冒烟可检索验证。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.4（D2 混合分流 / 去重合并 /
 * 质量过滤留档 / TDB watcher 自动索引）。
 *
 * - 模板优先读 baseDir/templates/distill.md（可热改），缺省回退模块内置文本；
 * - 每个 subskill 一次 LLM 蒸馏（同批材料天然同义合并，mergeInto 指回既有卡）；
 * - 入库验证：写入后经 knowledgeStorePort 冒烟查询新库（watcher 索引有秒级
 *   延迟，带重试）；端口不可用（TDB 未启用）记 warning 跳过，不阻断。
 */

const FALLBACK_DISTILL_TEMPLATE = `你是知识蒸馏引擎。从原始检索材料中蒸馏结构化知识单元（子技能：{{subskillTitle}}）。
材料清单：
{{materials}}
既有知识卡标题（同义知识点设 mergeInto 指回该标题，不新建）：
{{existingCardTitles}}
规则：type ∈ concept/methodology/checklist/case/pitfall；sourceUrls 必须来自材料 URL（宁可缺，不可编）；同义合并取来源并集；低质材料进 droppedSources 并给理由。
只输出 JSON：{"knowledgeUnits":[{"type":"","title":"","oneLiner":"","content":"","tags":[],"sourceUrls":[],"mergeInto":null}],"droppedSources":[{"url":"","reason":""}]}`;

const UNIT_TYPES = new Set(['concept', 'methodology', 'checklist', 'case', 'pitfall']);
const SMOKE_RETRY_COUNT = 10;
const SMOKE_RETRY_INTERVAL_MS = 3000;

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
            const hits = await knowledgeStorePort.search(query, { library: libraryName, topK: 3 });
            if (Array.isArray(hits) && hits.length > 0) {
                return { skipped: false, hits: hits.length, query };
            }
        } catch (error) {
            logger?.(`smoke: 查询失败（第 ${attempt} 次）：${error.message}`);
        }
        if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }
    const error = new Error(`入库冒烟验证未通过：新库 ${libraryName} 查询「${query}」无结果（watcher 索引可能失败，可重跑 distill 步骤）`);
    error.code = 'FORGE_INDEX_SMOKE_FAILED';
    error.status = 502;
    throw error;
}

function createDistillStepRunner({ knowledgeRoot, smokeRetries = SMOKE_RETRY_COUNT, smokeIntervalMs = SMOKE_RETRY_INTERVAL_MS }) {
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

        for (const subskill of blueprint.subskills) {
            const materials = await readRawMaterials(runDir, subskill.id);
            if (materials.length === 0) {
                logger?.(`distill: subskill ${subskill.id} 无原始材料，跳过（增量学习 scope 外或采集为空）`);
                continue;
            }

            const existingCards = writer.listCards();
            const prompt = renderTemplate(template, {
                subskill,
                materials,
                existingCardTitles: existingCards.map((card) => card.title)
            });
            const response = await llm.complete(llmConfig, {
                model: llmConfig.model,
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.2,
                max_tokens: 8000
            });
            const payload = extractJsonObject(response?.data?.choices?.[0]?.message?.content || '');
            if (!payload || !Array.isArray(payload.knowledgeUnits)) {
                const error = new Error(`subskill ${subskill.id} 蒸馏输出不可解析`);
                error.code = 'FORGE_DISTILL_OUTPUT_INVALID';
                error.status = 502;
                throw error;
            }

            const titleToCard = new Map(existingCards.map((card) => [card.title, card.file]));
            for (const unit of payload.knowledgeUnits) {
                if (!unit || !UNIT_TYPES.has(unit.type) || !unit.title || !unit.content) {
                    logger?.(`distill: 丢弃格式非法的知识单元：${JSON.stringify(unit?.title || unit)}`);
                    continue;
                }
                // 红线 4：无出处不入库。
                const sourceUrls = Array.isArray(unit.sourceUrls) ? unit.sourceUrls.filter(Boolean) : [];
                if (sourceUrls.length === 0) {
                    dropped.push({ url: '(no source)', reason: `知识单元「${unit.title}」无出处，不入库（红线 4）` });
                    continue;
                }
                const normalized = { ...unit, sourceUrls };

                if (unit.mergeInto && titleToCard.has(unit.mergeInto)) {
                    const mergeResult = await writer.mergeSources(titleToCard.get(unit.mergeInto), sourceUrls, { fetchedAt });
                    merged.push({ into: unit.mergeInto, addedSources: mergeResult.addedCount });
                    continue;
                }
                // D2 分流：methodology → 长文档；其余 → 知识卡。
                if (normalized.type === 'methodology') {
                    const result = await writer.writeLongDoc(normalized);
                    written.push(result);
                } else {
                    const result = await writer.writeCard(normalized, { subskillId: subskill.id, fetchedAt });
                    written.push(result);
                }
            }

            for (const drop of Array.isArray(payload.droppedSources) ? payload.droppedSources : []) {
                if (drop && drop.url) {
                    dropped.push({ url: drop.url, reason: drop.reason || '质量过滤' });
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

        return {
            summary: `蒸馏完成：${written.length} 个新文件 / ${merged.length} 次合并 / 丢弃 ${dropped.length} 源${smoke.skipped ? '（冒烟跳过：TDB 未启用）' : `（冒烟命中 ${smoke.hits} 条）`}`,
            artifacts: written.map((item) => `knowledge/${libraryName}/${item.fileName}`),
            state: {
                libraryName,
                writtenCount: written.length,
                mergedCount: merged.length,
                droppedCount: dropped.length,
                smoke
            }
        };
    };
}

module.exports = {
    FALLBACK_DISTILL_TEMPLATE,
    UNIT_TYPES,
    createDistillStepRunner,
    smokeSearchLibrary
};
