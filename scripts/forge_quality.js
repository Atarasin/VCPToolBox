#!/usr/bin/env node
'use strict';

/**
 * forge 质量工具（砚尺知识库质量优化设计 M2）。
 *
 * 子命令：
 *   inventory   离线盘点（§3.3.1 步骤 1）：输出文件、来源、主题、证据、
 *               完整性信号与重复/冲突候选清单。只读，不写任何生产路径。
 *
 * 约定同 forge_maintenance.js：--json / --out；失败非零退出；
 * 原生模块相关命令用与生产一致的 Node 版本运行。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

// ── K 卡 frontmatter 宽松解析（盘点用：畸形是"发现"，不是崩溃） ──────────

function parseFrontmatterLenient(raw) {
    const text = raw.replace(/^\uFEFF/, '');
    if (!text.startsWith('---')) {
        return { hasFrontmatter: false, entries: {}, malformed: null };
    }
    let closeAt = -1;
    for (const candidate of [text.indexOf('\n---\n', 3), text.indexOf('\n---\r\n', 3)]) {
        if (candidate !== -1 && (closeAt === -1 || candidate < closeAt)) closeAt = candidate;
    }
    if (closeAt === -1) {
        return { hasFrontmatter: true, entries: {}, malformed: 'frontmatter 缺少闭合 ---' };
    }
    const body = text.slice(text.indexOf('\n') + 1, closeAt);
    const entries = {};
    let currentKey = null;
    for (const line of body.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue;
        const topKey = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (topKey && !line.startsWith(' ') && !line.startsWith('\t')) {
            currentKey = topKey[1];
            entries[currentKey] = topKey[2].trim();
            continue;
        }
        if (currentKey && /^\s+-\s/.test(line)) {
            if (!Array.isArray(entries[currentKey])) entries[currentKey] = [];
            entries[currentKey].push(line.replace(/^\s+-\s*/, '').trim());
        }
    }
    return { hasFrontmatter: true, entries, malformed: null };
}

function extractSourcesUrls(entries) {
    const urls = [];
    const raw = entries.sources;
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const match = String(item).match(/https?:\/\/\S+/);
            if (match) urls.push(match[0]);
        }
    } else if (typeof raw === 'string') {
        for (const match of String(raw).matchAll(/https?:\/\/\S+/g)) urls.push(match[0]);
    }
    return urls;
}

// 编号长文档的来源在正文头部 `> 来源：` 行（writer 格式，§3.2.1）。
function extractBodySourceUrls(bodyText) {
    const urls = [];
    for (const match of bodyText.matchAll(/^>\s*来源：(.+)$/gm)) {
        for (const url of match[1].matchAll(/https?:\/\/\S+/g)) {
            urls.push(url[0].replace(/[;；,，]$/, ''));
        }
    }
    return urls;
}

const OFFICIAL_DOMAINS = ['w3.org', 'whatwg.org', 'developer.mozilla.org', 'developer.apple.com', 'developer.android.com', 'material.io', 'www.w3.org'];

function classifySourceType(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (OFFICIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return 'official-standard';
        return 'secondary';
    } catch {
        return 'other';
    }
}

// ── 完整性信号（确定性，§3.3.2 表格的机器可判部分） ─────────────────────

const CN_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 两: 2 };

function promisedItemCount(title) {
    const digit = title.match(/(\d+)\s*(项|条|个|步)/);
    if (digit) return Number(digit[1]);
    const cn = title.match(/([一二三四五六七八九十两]+)\s*(项|条|个|步)/);
    if (cn) {
        const text = cn[1];
        if (text === '十') return 10;
        if (text.startsWith('十')) return 10 + (CN_NUMERALS[text[1]] || 0);
        if (text.endsWith('十')) return (CN_NUMERALS[text[0]] || 1) * 10 + (text.length > 2 ? CN_NUMERALS[text[2]] || 0 : 0);
        return CN_NUMERALS[text] ?? null;
    }
    return null;
}

function completenessSignals({ kind, title, headings, listItemCount, bodyLength }) {
    const signals = [];
    if (kind !== 'K_card') return signals; // 长文档的完整性以人工/后续门禁判定
    const promised = promisedItemCount(title);
    if (promised != null && listItemCount >= 0 && listItemCount < promised) {
        signals.push(`标题承诺 ${promised} 项，正文清单仅 ${listItemCount} 项`);
    }
    if (/清单|列表/.test(title) && listItemCount === 0) {
        signals.push('标题含"清单/列表"但正文无列表项');
    }
    if (/方法|步骤|流程/.test(title) && !headings.some((h) => /步骤|流程|实施/.test(h))) {
        signals.push('标题承诺方法/步骤但无对应章节');
    }
    if (bodyLength < 200 && /方法|体系|指南|全解/.test(title)) {
        signals.push(`标题承诺系统性内容但正文仅 ${bodyLength} 字`);
    }
    return signals;
}

// ── inventory 主流程 ─────────────────────────────────────────────────────

async function walkLibrary(libDir) {
    const files = [];
    const walk = async (dir) => {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                await walk(abs);
            } else if (entry.isFile() && /\.(md|txt)$/.test(entry.name)) {
                files.push(abs);
            }
        }
    };
    await walk(libDir);
    return files.sort();
}

function normalizeTitleForDedup(title) {
    return title
        .toLowerCase()
        .replace(/[\s\-—_：:，,。.!！?？'"「」『』()（）]/g, '')
        .replace(/的|与|和|及|在|中|从|到|为|是/g, '');
}

async function cmdInventory(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const knowledgeRoot = path.resolve(String(flags.knowledge || path.join(root, 'knowledge')));
    const libraries = flags.library
        ? [String(flags.library)]
        : (await fsp.readdir(knowledgeRoot, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !['TDBdocs', 'node_modules'].includes(e.name))
            .map((e) => e.name);

    const report = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        knowledgeRoot,
        libraries: {},
        totals: { files: 0, kCards: 0, numberedDocs: 0, others: 0, filesWithoutSources: 0 }
    };

    for (const library of libraries) {
        const libDir = path.join(knowledgeRoot, library);
        if (!fs.existsSync(libDir)) continue;
        const filePaths = await walkLibrary(libDir);
        const entries = [];
        const byTitleHash = new Map();
        const byBodyHash = new Map();
        const byUrl = new Map();

        for (const abs of filePaths) {
            const rel = path.relative(knowledgeRoot, abs);
            const raw = await fsp.readFile(abs, 'utf-8');
            const { entries: fm, malformed } = parseFrontmatterLenient(raw);
            const kind = path.basename(abs).startsWith('K_') ? 'K_card'
                : /^\d+_/.test(path.basename(abs)) ? 'numbered' : 'other';
            const bodyStart = fm && raw.replace(/^\uFEFF/, '').indexOf('\n---\n') !== -1
                ? raw.replace(/^\uFEFF/, '').split(/\r?\n---\r?\n/).slice(1).join('\n---\n')
                : raw;
            const headings = [...bodyStart.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].trim());
            const listItemCount = [...bodyStart.matchAll(/^\s*(?:\d+\.|[-*])\s+\S/gm)].length;
            const urls = kind === 'K_card'
                ? extractSourcesUrls(fm)
                : [...extractSourcesUrls(fm), ...extractBodySourceUrls(bodyStart)];
            const title = String(fm.title || path.basename(abs, path.extname(abs)));
            const titleKey = normalizeTitleForDedup(title);
            const bodyHash = `sha256:${crypto.createHash('sha256').update(bodyStart.trim()).digest('hex')}`;
            const entry = {
                path: rel,
                kind,
                title,
                oneLiner: typeof fm.oneLiner === 'string' ? fm.oneLiner : null,
                type: typeof fm.type === 'string' ? fm.type : null,
                subskill: typeof fm.subskill === 'string' ? fm.subskill : (kind === 'K_card' ? (path.basename(abs).match(/^K_([A-Za-z0-9-]+)_/)?.[1] ?? null) : null),
                tags: Array.isArray(fm.tags) ? fm.tags : (typeof fm.tags === 'string' ? fm.tags : []),
                bytes: Buffer.byteLength(raw),
                bodyLength: bodyStart.trim().length,
                frontmatterMalformed: malformed,
                sources: {
                    count: urls.length,
                    urls,
                    sourceTypes: [...new Set(urls.map(classifySourceType))]
                },
                headingsCount: headings.length,
                listItemCount,
                completenessSignals: completenessSignals({ kind, title, headings, listItemCount, bodyLength: bodyStart.trim().length })
            };
            entries.push(entry);
            if (titleKey) {
                if (!byTitleHash.has(titleKey)) byTitleHash.set(titleKey, []);
                byTitleHash.get(titleKey).push(rel);
            }
            if (!byBodyHash.has(bodyHash)) byBodyHash.set(bodyHash, []);
            byBodyHash.get(bodyHash).push(rel);
            for (const url of urls) {
                if (!byUrl.has(url)) byUrl.set(url, []);
                byUrl.get(url).push(rel);
            }
        }

        const duplicateCandidates = [];
        for (const [hash, paths] of byBodyHash) {
            if (paths.length > 1) duplicateCandidates.push({ kind: 'identical-body', key: hash, paths, autoMergeHint: '纯重复合并来源（§3.3.3），需无新增主张核验' });
        }
        for (const [titleKey, paths] of byTitleHash) {
            if (paths.length > 1) {
                const bodies = paths.map((p) => entries.find((e) => e.path === p)?.bodyLength ?? 0);
                const identicalBody = duplicateCandidates.some((c) => paths.every((p) => c.paths.includes(p)));
                if (!identicalBody) {
                    duplicateCandidates.push({
                        kind: bodies.some((b) => Math.abs(b - Math.max(...bodies)) > 200) ? 'same-title-divergent-body' : 'same-title',
                        key: `title:${titleKey}`,
                        paths,
                        autoMergeHint: '有补充/更新/正文变化 → 生成 mergeProposal 进复核（§3.3.3），不得自动覆盖'
                    });
                }
            }
        }
        for (const [url, paths] of byUrl) {
            if (paths.length > 1) duplicateCandidates.push({ kind: 'shared-url', key: url, paths, autoMergeHint: '同源采集——结合标题/正文聚类判定纯重复或内容修订' });
        }

        report.libraries[library] = {
            files: entries.length,
            byKind: {
                K_card: entries.filter((e) => e.kind === 'K_card').length,
                numbered: entries.filter((e) => e.kind === 'numbered').length,
                other: entries.filter((e) => e.kind === 'other').length
            },
            subskillDistribution: entries.reduce((acc, e) => {
                if (e.subskill) acc[e.subskill] = (acc[e.subskill] || 0) + 1;
                return acc;
            }, {}),
            filesWithoutSources: entries.filter((e) => e.sources.count === 0).length,
            frontmatterMalformed: entries.filter((e) => e.frontmatterMalformed).length,
            officialSourcedFiles: entries.filter((e) => e.sources.sourceTypes.includes('official-standard')).length,
            entries,
            duplicateCandidates
        };
        report.totals.files += entries.length;
        report.totals.kCards += entries.filter((e) => e.kind === 'K_card').length;
        report.totals.numberedDocs += entries.filter((e) => e.kind === 'numbered').length;
        report.totals.others += entries.filter((e) => e.kind === 'other').length;
        report.totals.filesWithoutSources += entries.filter((e) => e.sources.count === 0).length;
    }

    return { exitCode: 0, report };
}

function requireQuiet(modulePath) {
    const original = console.log;
    console.log = () => {};
    try {
        return require(modulePath);
    } finally {
        console.log = original;
    }
}

function silenceNativeStdout() {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    return () => { process.stdout.write = originalWrite; };
}

function tdbConfigFor(root, flags) {
    const maintenance = require(path.join(REPO_ROOT, 'scripts', 'forge_maintenance'));
    return maintenance.tdbConfig(root, {
        ...(flags.knowledge ? { rootPath: path.resolve(String(flags.knowledge)) } : {}),
        ...(flags.store ? { storePath: path.resolve(String(flags.store)) } : {})
    });
}


// ── golden 检索回归（§2.3.5/§3.2.3，M2.S2 T15） ──────────────────────────

async function cmdGolden(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const setPath = String(flags.set || path.join(REPO_ROOT, 'modules', 'agentGateway/services/forge/golden/yanchi_ui.json'));
    const config = {
        ...tdbConfigFor(root, flags),
        fullScanOnStartup: false
    };
    const { TDBKnowledgeManager } = requireQuiet(path.join(REPO_ROOT, 'TDBKnowledge'));
    const goldenSet = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/goldenSet'));

    const parsed = JSON.parse(await fsp.readFile(setPath, 'utf-8'));
    const queries = goldenSet.loadGoldenSet(parsed);
    const manager = new TDBKnowledgeManager(config);
    const originalLog = console.log;
    console.log = () => {};
    const restoreNative = silenceNativeStdout();
    try {
        await manager.initialize();
        const report = await goldenSet.runGoldenSet(manager, queries, { strictNegatives: Boolean(flags.strictNegatives) });
        report.goldenSetPath = setPath;
        return { exitCode: report.ok ? 0 : 1, report };
    } finally {
        await manager.shutdown().catch(() => undefined);
        console.log = originalLog;
        restoreNative();
    }
}


// ── main ─────────────────────────────────────────────────────────────────



function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const eq = token.indexOf('=');
        if (eq >= 0) flags[token.slice(2, eq)] = token.slice(eq + 1);
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[token.slice(2)] = argv[++i];
        else flags[token.slice(2)] = true;
    }
    return flags;
}

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseArgs(rest);
    const commands = { inventory: cmdInventory, golden: cmdGolden };
    const handler = commands[command];
    if (!handler) {
        process.stderr.write(`未知或缺失子命令：${command || '(none)'}（可用：${Object.keys(commands).join(' / ')}）\n`);
        process.exit(1);
    }
    const outcome = await handler(flags);
    if (flags.out) {
        fs.writeFileSync(String(flags.out), `${JSON.stringify(outcome.report, null, 2)}\n`, 'utf-8');
        process.stderr.write(`report → ${flags.out}\n`);
    }
    if (flags.json) {
        process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
    }
    process.exit(outcome.exitCode);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`✗ ${error.stack || error.message}\n`);
        process.exit(1);
    });
}

module.exports = { cmdInventory, cmdGolden, parseFrontmatterLenient, normalizeTitleForDedup };
