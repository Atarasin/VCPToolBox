'use strict';

const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

/**
 * 采集（harvest）步骤：按画像 subskills 逐项检索抓取，原始材料永久存档（D6）。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.3。
 *
 * - 检索走 toolInvoker（forge 白名单：AnySearch → FlashDeepSearch → BrowserSearch
 *   顺序 fallback，前者失败/空结果才换下一个）；
 * - 来源多样性：每 subskill 统计不同域名数，不足 minDomainsPerSubskill 记
 *   warning 继续（蒸馏红线 4：宁可缺，不可编——材料不足不虚构）；
 * - 每份材料落盘 runs/<jobId>/raw/<subskillId>/ 下一个文件 + 元数据
 *   {url, fetchedAt, contentHash, plugin}；
 * - 抓取礼貌（红线 6）：只消费搜索插件返回的摘要/正文，不做整站爬取；
 *   同域名二次请求（正文扩展位）经 per-domain 节流 ≥2s。
 */

const SEARCH_TOOL_CHAIN = ['AnySearch', 'FlashDeepSearch', 'BrowserSearch'];
const SAME_DOMAIN_INTERVAL_MS = 2000;
const URL_PATTERN = /^https?:\/\/\S+$/i;

function sha256(text) {
    return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function domainOf(url) {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

function slugify(text, maxLength = 48) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, maxLength) || 'untitled';
}

// BrowserSearch：markdown `### n. [title](url)` + 后续行为摘要。
function parseBrowserSearchMarkdown(text) {
    const entries = [];
    const lines = String(text || '').split('\n');
    let current = null;
    for (const line of lines) {
        const heading = line.match(/^#{2,4}\s+\d*[.、]?\s*\[(.+?)\]\((https?:\/\/[^\s)]+)\)/);
        if (heading) {
            if (current) {
                entries.push(current);
            }
            current = { title: heading[1].trim(), url: heading[2].trim(), snippet: '' };
            continue;
        }
        const inline = line.match(/\[([^\]]{4,200})\]\((https?:\/\/[^\s)]+)\)/);
        if (inline && !current) {
            current = { title: inline[1].trim(), url: inline[2].trim(), snippet: '' };
            continue;
        }
        if (current) {
            const stripped = line.replace(/^>\s?/, '').replace(/^-\s+/, '').trim();
            if (stripped && !stripped.startsWith('查询:') && !stripped.startsWith('## ')) {
                current.snippet = `${current.snippet}\n${stripped}`.trim();
            }
        }
    }
    if (current) {
        entries.push(current);
    }
    return entries.filter((entry) => entry.title && URL_PATTERN.test(entry.url));
}

// AnySearch：`title\nURL\nsummary` 空行分块。
function parsePlainBlocks(text) {
    const entries = [];
    const blocks = String(text || '').split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const urlIndex = lines.findIndex((line) => URL_PATTERN.test(line));
        if (urlIndex === -1) {
            continue;
        }
        const url = lines[urlIndex];
        const title = lines[urlIndex - 1] || url;
        const summary = lines.slice(urlIndex + 1).join('\n');
        entries.push({ title, url, snippet: summary });
    }
    return entries;
}

function extractEntriesFromText(toolName, text) {
    const raw = String(text || '');
    const parsed = toolName === 'BrowserSearch'
        ? [...parseBrowserSearchMarkdown(raw), ...parsePlainBlocks(raw)]
        : [...parsePlainBlocks(raw), ...parseBrowserSearchMarkdown(raw)];
    const byUrl = new Map();
    for (const entry of parsed) {
        if (!byUrl.has(entry.url)) {
            byUrl.set(entry.url, entry);
        }
    }
    return Array.from(byUrl.values());
}

// sourcePolicy.preferOfficialDocs：官方文档域名轻量加权（排序优先，不丢弃其他来源）。
const OFFICIAL_DOC_DOMAIN_PATTERN = /(^|\.)((docs|developer|developers|dev)\.[a-z0-9.-]+)$/i;
const OFFICIAL_DOC_DOMAIN_HINTS = [/\.org$/i, /(^|\.)developer\./i, /(^|\.)docs\./i, /(^|\.)learn\./i, /(^|\.)mdn\./i];

function officialDocWeight(domain) {
    if (OFFICIAL_DOC_DOMAIN_PATTERN.test(domain)) {
        return 0;
    }
    if (OFFICIAL_DOC_DOMAIN_HINTS.some((pattern) => pattern.test(domain))) {
        return 1;
    }
    return 2;
}

// 红线 6：同域名请求间隔 ≥2s（正文抓取/同域扩展时生效；搜索 API 本身对不同站点）。
function createDomainThrottle(intervalMs = SAME_DOMAIN_INTERVAL_MS) {
    const lastHit = new Map();
    return {
        async waitForDomain(domain) {
            if (!domain) {
                return;
            }
            const previous = lastHit.get(domain) || 0;
            const elapsed = Date.now() - previous;
            if (previous && elapsed < intervalMs) {
                await new Promise((resolve) => setTimeout(resolve, intervalMs - elapsed));
            }
            lastHit.set(domain, Date.now());
        }
    };
}

function buildSearchArgs(toolName, query) {
    switch (toolName) {
    case 'AnySearch':
        return { query, max_results: 10 };
    case 'FlashDeepSearch':
        return { SearchContent: query, SearchBroadness: 8 };
    case 'BrowserSearch':
        return { query, maxResults: 10 };
    default:
        return { query };
    }
}

async function searchWithFallback(toolInvoker, queries, { logger } = {}) {
    const attempts = [];
    for (const query of queries) {
        for (const toolName of SEARCH_TOOL_CHAIN) {
            try {
                const result = await toolInvoker.invoke(toolName, buildSearchArgs(toolName, query));
                const text = result?.content?.[0]?.text ||
                    (typeof result?.original_plugin_output === 'string' ? result.original_plugin_output : '') ||
                    (typeof result === 'string' ? result : '');
                const entries = extractEntriesFromText(toolName, text);
                attempts.push({ toolName, query, entries, ok: entries.length > 0 });
                if (entries.length > 0) {
                    return { toolName, query, entries };
                }
            } catch (error) {
                attempts.push({ toolName, query, entries: [], ok: false, error: error.message });
                logger?.(`search fallback: ${toolName} 失败（${error.message}），尝试下一个插件`);
            }
        }
    }
    return { toolName: null, query: null, entries: [], attempts };
}

function createHarvestStepRunner() {
    return async function runHarvestStep(ctx) {
        const { runDir, toolInvoker, logger } = ctx;
        if (!ctx.blueprintPath) {
            const error = new Error('harvest 需要 blueprintPath（blueprint 步骤产物）');
            error.code = 'FORGE_BLUEPRINT_MISSING';
            error.status = 400;
            throw error;
        }
        if (!toolInvoker) {
            const error = new Error('toolInvoker 端口不可用，无法采集');
            error.code = 'FORGE_TOOL_INVOKER_UNAVAILABLE';
            error.status = 503;
            throw error;
        }

        const { readBlueprint } = require('./blueprint');
        const blueprint = await readBlueprint(ctx.blueprintPath);
        // 增量学习（§3.7/§3.8）：scope.subskillIds 限定只采缺口子技能，不推倒重来。
        const scopeIds = Array.isArray(ctx.scope?.subskillIds) ? ctx.scope.subskillIds : null;
        const subskills = scopeIds
            ? blueprint.subskills.filter((subskill) => scopeIds.includes(subskill.id))
            : blueprint.subskills;
        if (subskills.length === 0) {
            const error = new Error(`scope.subskillIds 未命中任何子技能：${JSON.stringify(scopeIds)}`);
            error.code = 'FORGE_SCOPE_EMPTY';
            error.status = 400;
            throw error;
        }
        const minDomains = Number(blueprint.sourcePolicy?.minDomainsPerSubskill) || 3;
        const throttle = createDomainThrottle();

        const manifests = [];
        const warnings = [];
        for (const subskill of subskills) {
            const queries = [...(subskill.searchQueries || [])];
            const rawDir = path.join(runDir, 'raw', subskill.id);
            await fsp.mkdir(rawDir, { recursive: true });

            // 每条 query 一次 fallback 搜索，直至域名多样性达标或 query 用尽。
            const collected = new Map(); // url -> entry
            const usedBy = [];
            for (const query of queries) {
                if (new Set(Array.from(collected.values()).map((e) => domainOf(e.url))).size >= minDomains) {
                    break;
                }
                const hit = await searchWithFallback(toolInvoker, [query], { logger });
                if (hit.toolName) {
                    usedBy.push({ query, plugin: hit.toolName, hits: hit.entries.length });
                }
                for (const entry of hit.entries) {
                    if (!collected.has(entry.url)) {
                        collected.set(entry.url, { ...entry, plugin: hit.toolName, query });
                    }
                }
            }

            // 官方文档域名加权排序后截取（避免单 query 淹没多样性）。
            const materials = Array.from(collected.values())
                .sort((a, b) => officialDocWeight(domainOf(a.url)) - officialDocWeight(domainOf(b.url)));

            const fetchedAt = new Date().toISOString();
            const savedFiles = [];
            let sequence = 0;
            for (const material of materials) {
                sequence += 1;
                await throttle.waitForDomain(domainOf(material.url)); // 红线 6
                const slug = slugify(material.title);
                const baseName = `${String(sequence).padStart(2, '0')}-${slug}`;
                const body = `# ${material.title}\n\n来源: ${material.url}\n\n${material.snippet || '（无摘要）'}\n`;
                const meta = {
                    url: material.url,
                    domain: domainOf(material.url),
                    title: material.title,
                    fetchedAt,
                    contentHash: sha256(body),
                    plugin: material.plugin,
                    query: material.query
                };
                await fsp.writeFile(path.join(rawDir, `${baseName}.md`), body, 'utf8');
                await fsp.writeFile(path.join(rawDir, `${baseName}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
                savedFiles.push(`${baseName}.md`);
            }

            const domains = Array.from(new Set(materials.map((m) => domainOf(m.url)).filter(Boolean)));
            if (domains.length < minDomains) {
                warnings.push(`subskill「${subskill.id}」域名多样性不足：${domains.length}/${minDomains}（继续蒸馏，材料不足不虚构——红线 4）`);
                logger?.(warnings[warnings.length - 1]);
            }

            const manifest = {
                subskillId: subskill.id,
                title: subskill.title,
                queries,
                searchRuns: usedBy,
                materials: savedFiles.length,
                domains,
                warnings: domains.length < minDomains ? [`${domains.length}/${minDomains}`] : []
            };
            await fsp.writeFile(
                path.join(rawDir, 'manifest.json'),
                `${JSON.stringify(manifest, null, 2)}\n`,
                'utf8'
            );
            manifests.push(manifest);
        }

        const totalMaterials = manifests.reduce((sum, manifest) => sum + manifest.materials, 0);
        if (totalMaterials === 0) {
            const error = new Error('全部搜索插件与关键词均未取回任何材料');
            error.code = 'FORGE_HARVEST_EMPTY';
            error.status = 502;
            throw error;
        }

        return {
            summary: `采集完成：${manifests.length} 个子技能 / ${totalMaterials} 份材料（域名多样性${warnings.length === 0 ? '达标' : '部分不足'}）`,
            artifacts: manifests.map((manifest) => `raw/${manifest.subskillId}/`),
            state: {
                manifests,
                warnings
            }
        };
    };
}

module.exports = {
    SEARCH_TOOL_CHAIN,
    SAME_DOMAIN_INTERVAL_MS,
    createHarvestStepRunner,
    extractEntriesFromText,
    createDomainThrottle,
    domainOf,
    slugify
};
