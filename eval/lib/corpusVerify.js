'use strict';

/**
 * 语料不变量校验。
 *
 * 存在的理由：VCP 的 RAG 能力几乎全都是"静默失效"的 —— 缺一行 Tag、月份没补零、
 * tag 超长，对应能力就悄悄变成 no-op，不报错、不告警，评测照样跑出一份看起来
 * 正常的报告。旧评估之所以能带着"candidate 向量库 0 个 tag"跑完并给出
 * "recall 提升 10 个百分点"的结论，就是因为没有任何一层在检查这些前提。
 *
 * 这里把每条前提写成可执行断言。verify 不过，run 就不该开始。
 */

const fs = require('fs');
const path = require('path');

const { TAG_DATE_RE, loadSpec, loadManifest, hasCJK } = require('./corpusBuild');

const MAX_CJK_TAG_LEN = 15;      // textPreprocessor.js:59
const MAX_LATIN_TAG_LEN = 30;    // textPreprocessor.js:60
const MAX_TAGS_PER_FILE = 50;    // KNOWLEDGEBASE_MAX_TAGS_PER_FILE 默认值
const MIN_TAGS_FOR_EDGE = 2;     // build_fact_matrix 跳过 tags<2 的文件
const TAG_RECURRENCE_MIN = 3;    // 一条共现边至少要被 3 篇独立印证才不算循环自证

/** 日记本目录名的 ignore 规则（命中即整个库不可见，且无任何报错）。 */
const FORBIDDEN_FOLDER_PREFIXES = ['已整理', '.'];
const FORBIDDEN_FOLDER_SUFFIXES = ['夜伽'];
const FORBIDDEN_FOLDER_NAMES = ['VCP论坛', 'MusicDiary', 'image', 'dist', 'target', 'node_modules'];

function check(list, ok, level, code, message, detail) {
    if (ok) return;
    list.push({ level, code, message, ...(detail ? { detail } : {}) });
}

/**
 * 校验 spec 本身（不需要生成语料，可离线跑）。
 */
function verifySpec() {
    const findings = [];
    const { books, docs } = loadSpec();

    // ── 日记本层面 ──────────────────────────────────────────────
    const folders = [];
    for (const [key, book] of Object.entries(books.books)) {
        const folder = book.folder;
        folders.push(folder);

        check(findings,
            !FORBIDDEN_FOLDER_PREFIXES.some(p => folder.startsWith(p)),
            'error', 'folder-ignored-prefix',
            `日记本 "${key}" 的目录名 "${folder}" 命中 ignore 前缀，整个库会被静默跳过`);
        check(findings,
            !FORBIDDEN_FOLDER_SUFFIXES.some(s => folder.endsWith(s)),
            'error', 'folder-ignored-suffix',
            `日记本 "${key}" 的目录名 "${folder}" 命中 ignore 后缀，整个库会被静默跳过`);
        check(findings,
            !FORBIDDEN_FOLDER_NAMES.includes(folder),
            'error', 'folder-ignored-name',
            `日记本 "${key}" 的目录名 "${folder}" 在 ignore 名单里`);
        check(findings,
            !folder.includes(' '),
            'error', 'folder-has-space',
            `日记本 "${key}" 的目录名含空格，写入路径会被转成下划线导致寻址不一致`);
        // LightMemo 的 folder 过滤是 SQL LIKE '%folder%'，互为前缀的库名会串味
        check(findings,
            !folder.endsWith('簇'),
            'warn', 'folder-forces-persist',
            `日记本 "${key}" 的目录名以「簇」结尾，会强制索引持久化，改变缓存行为`);
    }
    for (const a of folders) {
        for (const b of folders) {
            if (a === b) continue;
            check(findings, !b.includes(a),
                'error', 'folder-substring-collision',
                `日记本目录名 "${a}" 是 "${b}" 的子串：LightMemo 的 folder 过滤用 LIKE '%name%'，两个库会互相串味`);
        }
    }

    // ── 文档层面 ────────────────────────────────────────────────
    const slugs = new Set();
    const tagOccurrences = new Map();   // tag -> 出现的文档数
    const bodyByBook = new Map();

    for (const doc of docs) {
        const where = `${doc.book}/${doc.slug}`;

        check(findings, !slugs.has(doc.slug),
            'error', 'duplicate-slug',
            `slug "${doc.slug}" 重复：会生成同名文件互相覆盖`);
        slugs.add(doc.slug);

        check(findings, typeof doc.dayOffset === 'number' || typeof doc.dateRule === 'string',
            'error', 'missing-date', `${where} 既没有 dayOffset 也没有 dateRule`);

        const tags = Array.isArray(doc.tags) ? doc.tags : [];
        check(findings, tags.length >= MIN_TAGS_FOR_EDGE,
            'error', 'too-few-tags',
            `${where} 只有 ${tags.length} 个 tag：少于 ${MIN_TAGS_FOR_EDGE} 个则不产生任何共现边，TagMemo/RiverMemo 对它完全失效`);
        check(findings, tags.length <= MAX_TAGS_PER_FILE,
            'error', 'too-many-tags', `${where} 的 tag 数 ${tags.length} 超过 ${MAX_TAGS_PER_FILE}`);
        check(findings, tags.length < 100,
            'error', 'tags-exceed-graph-cap',
            `${where} 的 tag 数 ≥100：build_fact_matrix 会整篇跳过`);
        check(findings, new Set(tags).size === tags.length,
            'error', 'duplicate-tags', `${where} 的 tag 有重复`);

        for (const tag of tags) {
            check(findings, !TAG_DATE_RE.test(tag),
                'error', 'date-like-tag',
                `${where} 的 tag "${tag}" 形似日期，extractTags 会静默丢弃它`);
            const limit = hasCJK(tag) ? MAX_CJK_TAG_LEN : MAX_LATIN_TAG_LEN;
            check(findings, tag.length <= limit,
                'error', 'tag-too-long',
                `${where} 的 tag "${tag}" 长度 ${tag.length} 超过上限 ${limit}（含中文 ${MAX_CJK_TAG_LEN}／纯西文 ${MAX_LATIN_TAG_LEN}），会被静默丢弃`);
            check(findings, tag.trim() === tag && tag.length > 0,
                'error', 'tag-whitespace', `${where} 的 tag "${tag}" 首尾有空白`);

            tagOccurrences.set(tag, (tagOccurrences.get(tag) || 0) + 1);
        }

        const body = String(doc.body || '');
        check(findings, body.trim().length > 0, 'error', 'empty-body', `${where} 正文为空`);
        check(findings, !/^\s*\[\d{4}/.test(body),
            'error', 'body-starts-with-date',
            `${where} 的正文以日期开头：生成器会自己加首行日期，重复会破坏日期索引`);
        check(findings, !body.includes('Tag:') && !body.includes('Tags:'),
            'error', 'body-contains-tag-line',
            `${where} 的正文里出现 Tag: —— Tag 行必须由生成器统一追加在最后`);
        // 占位符写进语料会被替换成 [循环占位符已移除]
        check(findings, !/\[\[|\{\{|《《|<</.test(body),
            'error', 'body-contains-placeholder',
            `${where} 的正文含占位符语法，会被当成循环引用移除`);

        const key = doc.book;
        if (!bodyByBook.has(key)) bodyByBook.set(key, []);
        bodyByBook.get(key).push({ slug: doc.slug, body, family: doc.family });
    }

    // ── 跨文档结构 ──────────────────────────────────────────────
    // 只出现在 1 篇里的 tag 无法形成可传播的图；但"稀有锚点"族刻意需要这种 tag。
    const rareTags = [...tagOccurrences.entries()].filter(([, n]) => n === 1).map(([t]) => t);
    const recurringTags = [...tagOccurrences.entries()].filter(([, n]) => n >= TAG_RECURRENCE_MIN);
    check(findings, recurringTags.length >= 8,
        'error', 'insufficient-recurring-tags',
        `只有 ${recurringTags.length} 个 tag 跨 ≥${TAG_RECURRENCE_MIN} 篇复现。共现图会过于稀疏：` +
        `场熵过不了 minFieldEntropy 0.12 的门，geodesicRerank 会直接放弃重排并退回 KNN 顺序`);

    // EPA 需要 ≥8 个带向量的 tag 才能建基；场节点下限 minFieldTags/minGeoSamples = 4
    const uniqueTags = tagOccurrences.size;
    check(findings, uniqueTags >= 40,
        'error', 'insufficient-unique-tags',
        `唯一 tag 只有 ${uniqueTags} 个。低于约 40 个时 maxFieldNodes(48)、` +
        `sparseAssociationMinContacts(3)、topologyV2MinimumPeers(3) 这些下限会持续触发低置信兜底`);

    check(findings, docs.length >= 40,
        'error', 'insufficient-docs',
        `文档只有 ${docs.length} 篇。动态 K 落在 [3,10] 再乘倍率，rerank 还会 2 倍超取，` +
        `语料太小的话 top-k 等于整库返回，Precision 与 MRR 会被钉死在常数上`);

    // hub 惩罚 (1 - sqrt(inbound/maxInbound), 地板 0.35) 需要入度落差才可测
    const maxOccurrence = Math.max(0, ...tagOccurrences.values());
    check(findings, maxOccurrence >= 12,
        'warn', 'no-hub-tag',
        `出现次数最多的 tag 只覆盖 ${maxOccurrence} 篇。没有高入度 hub 的话，hub 惩罚这条路径无法测量`);
    check(findings, rareTags.length >= 1,
        'warn', 'no-rare-tag',
        '没有任何只出现一次的 tag：RiverMemo 的稀有直锚通道（上限 0.10，位移最大）无法测量');

    // 族完整性：每个对抗族都需要它的角色齐全，缺角色的族测不出东西
    const familyRoles = new Map();
    for (const doc of docs) {
        if (!doc.family) continue;
        if (!familyRoles.has(doc.family)) familyRoles.set(doc.family, new Set());
        familyRoles.get(doc.family).add(doc.role);
    }
    const requiredRoles = {
        tagmemo_tagonly: ['gold', 'bridge', 'hardneg'],
        tagmemo_position: ['position_first', 'position_last'],
        rivermemo_order: ['gold_forward', 'distractor_reverse'],
        rivermemo_corroboration: ['corroborated', 'uncorroborated'],
        dedup: ['exact_a', 'exact_b', 'fullwidth', 'paraphrase_a', 'paraphrase_b'],
        bm25_lexical: ['lexical_decoy', 'semantic_only'],
        timedecay: ['fresh', 'mid', 'stale']
    };
    for (const [family, roles] of Object.entries(requiredRoles)) {
        const present = familyRoles.get(family) || new Set();
        for (const role of roles) {
            check(findings, present.has(role),
                'error', 'family-role-missing',
                `对抗族 "${family}" 缺少角色 "${role}"，该族的断言无法成立`);
        }
    }

    // dedup 族的精确重复必须真的逐字节一致 —— 日期/时间/tag 任一不同就不成立
    const dedupDocs = docs.filter(d => d.family === 'dedup');
    const exactPair = dedupDocs.filter(d => d.role === 'exact_a' || d.role === 'exact_b');
    if (exactPair.length === 2) {
        const [a, b] = exactPair;
        check(findings, a.body === b.body,
            'error', 'dedup-exact-body-differs', '精确重复对的正文不一致');
        check(findings, a.dayOffset === b.dayOffset,
            'error', 'dedup-exact-date-differs',
            '精确重复对的 dayOffset 不同：首行日期会不同，chunk 文本因此不是逐字节相同，精确去重不会触发');
        check(findings, a.hhmm && a.hhmm === b.hhmm,
            'error', 'dedup-exact-time-differs',
            '精确重复对必须显式指定相同的 hhmm：缺省值由 slug 派生，两篇会不同');
        check(findings, JSON.stringify(a.tags) === JSON.stringify(b.tags),
            'error', 'dedup-exact-tags-differ',
            '精确重复对的 tags 不同：Tag 行属于 chunk 文本，不同则不是逐字节相同');
    }

    // 语义组的组词绝不能出现在目标库的正文里，否则测的是词面重叠而非向量混合
    const groups = books.semanticGroups || {};
    for (const [groupName, group] of Object.entries(groups)) {
        for (const word of group.words || []) {
            const targetBook = group.targetBook;
            const docsToScan = targetBook
                ? docs.filter(d => d.book === targetBook)
                : docs;
            const leaked = docsToScan.filter(d => String(d.body).includes(word) && d.role !== 'group_probe');
            check(findings, leaked.length === 0,
                'error', 'group-word-leaked-into-corpus',
                `语义组 "${groupName}" 的组词 "${word}" 出现在语料正文里（${leaked.map(d => d.slug).join(', ')}）：` +
                `::Group 的效果将无法与词面重叠区分开`);
        }
    }

    return {
        ok: findings.filter(f => f.level === 'error').length === 0,
        findings,
        stats: {
            books: Object.keys(books.books).length,
            docs: docs.length,
            uniqueTags,
            recurringTags: recurringTags.length,
            rareTags: rareTags.length,
            maxTagOccurrence: maxOccurrence,
            families: [...familyRoles.keys()].sort()
        }
    };
}

/**
 * 校验已生成的语料（磁盘层面 + 格式层面）。
 */
function verifyGenerated(corpusRoot) {
    const findings = [];
    const manifest = loadManifest(corpusRoot);
    if (!manifest) {
        return {
            ok: false,
            findings: [{
                level: 'error', code: 'corpus-not-built',
                message: `${corpusRoot} 下没有 .corpus-manifest.json —— 先执行 \`vcp-eval corpus build\``
            }],
            stats: null
        };
    }

    const mtimes = [];
    for (const entry of manifest.files) {
        const abs = path.join(corpusRoot, entry.id);
        if (!fs.existsSync(abs)) {
            check(findings, false, 'error', 'file-missing', `清单里的文件不存在：${entry.id}`);
            continue;
        }
        const content = fs.readFileSync(abs, 'utf-8');
        const lines = content.split('\n');

        // 首行日期：月日必须两位，否则该文件对 ::Time 的日期索引完全不可见
        check(findings, /^\[\d{4}-\d{2}-\d{2}\]/.test(lines[0]),
            'error', 'bad-date-header',
            `${entry.id} 首行不是 [YYYY-MM-DD]（月日必须补零）：该文件将不进日期索引，::Time 永远命中不到它`);
        check(findings, !content.startsWith('﻿'),
            'error', 'bom-present', `${entry.id} 含 BOM，会破坏首行日期正则`);
        check(findings, !content.includes('\r'),
            'error', 'crlf-present', `${entry.id} 含 CRLF`);

        // Tag: 必须是最后一行（detectTagLine 自底向上扫，只认最后一条）
        const lastLine = lines[lines.length - 1];
        check(findings, /^Tag:\s*.+/.test(lastLine),
            'error', 'tag-line-not-last',
            `${entry.id} 的最后一行不是 "Tag: ..."：extractTags 拿不到 tag，TagMemo/RiverMemo 对它完全失效`);
        // Tags: 是 DailyNoteSearcher 的 tag 模式唯一认的 marker（它不认 Tag:）
        check(findings, lines.some(l => /^Tags:\s*.+/.test(l)),
            'warn', 'searcher-tag-line-missing',
            `${entry.id} 缺少 "Tags: ..." 行：DailyNoteSearcher 的 bm25_search_mode=tag 对它返回 0 条`);

        const st = fs.statSync(abs);
        // 必须复刻被测代码的排序键 max(mtimeMs, birthtimeMs, ctimeMs)，
        // 只看 mtimeMs 会漏掉"ctime 压过 mtime"这个失效模式（已经踩过一次）。
        mtimes.push({
            id: entry.id,
            mtimeMs: st.mtimeMs,
            effectiveMs: Math.max(st.mtimeMs || 0, st.birthtimeMs || 0, st.ctimeMs || 0),
            usesMtime: st.mtimeMs >= Math.max(st.birthtimeMs || 0, st.ctimeMs || 0),
            date: entry.date
        });
    }

    // 排序键必须真的由 mtime 决定，否则 mtimeRank 完全没有作用
    const notUsingMtime = mtimes.filter(m => !m.usesMtime);
    check(findings, notUsingMtime.length === 0,
        'error', 'ctime-dominates-sort-key',
        `${notUsingMtime.length} 个文件的排序键取自 ctime/birthtime 而非 mtime。` +
        `getRecentDiaryFileMetas 用 max(mtimeMs, birthtimeMs, ctimeMs)，而 utimes() 会把 ctime 刷成当前时刻 —— ` +
        `mtime 必须设到未来才能压过 ctime，否则 ::LastN 的顺序完全不受 mtimeRank 控制`);

    // 排序键顺序必须与日期顺序不同，否则 ::LastN 与 {{}} 全量模式无法区分
    const byMtime = [...mtimes].sort((a, b) => b.effectiveMs - a.effectiveMs).map(x => x.id);
    const byDate = [...mtimes].sort((a, b) => String(b.date).localeCompare(String(a.date))).map(x => x.id);
    check(findings, JSON.stringify(byMtime.slice(0, 5)) !== JSON.stringify(byDate.slice(0, 5)),
        'error', 'mtime-order-equals-date-order',
        'mtime 的前 5 名与日期的前 5 名完全相同：::LastN（按 mtime）与 {{}} 全量（按文件名）会产出一样的结果，等于没测');

    // 排序键必须真的被区分开（git checkout 会把所有文件设成同一时刻）
    const uniqueKeys = new Set(mtimes.map(m => Math.round(m.effectiveMs))).size;
    check(findings, uniqueKeys >= mtimes.length - 1,
        'error', 'mtime-not-pinned',
        `${mtimes.length} 个文件只有 ${uniqueKeys} 个不同的排序键：::LastN 的顺序不确定`);

    return {
        ok: findings.filter(f => f.level === 'error').length === 0,
        findings,
        stats: {
            docs: manifest.files.length,
            uniqueTags: manifest.uniqueTags,
            corpusHash: manifest.corpusHash,
            anchorDate: manifest.anchorDate,
            books: manifest.books,
            newestByMtime: byMtime.slice(0, 5),
            newestByDate: byDate.slice(0, 5)
        }
    };
}

function verifyAll(corpusRoot) {
    const spec = verifySpec();
    const generated = fs.existsSync(corpusRoot) ? verifyGenerated(corpusRoot) : null;
    return {
        ok: spec.ok && (generated ? generated.ok : true),
        spec,
        generated
    };
}

module.exports = { verifySpec, verifyGenerated, verifyAll };
