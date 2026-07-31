'use strict';

/**
 * 语料生成器：corpus-spec/*.jsonl  →  eval/dailynote_eval/<日记本>/*.txt
 *
 * 为什么要生成而不是直接提交语料：
 *
 * ::Time 的时间表达（今天/上周/N天前）是相对"运行时刻"解析的，且 TimeExpressionParser
 * 没有可注入的时钟。旧语料写死 2026-01~03，查询写「上周」，跑起来解析出的窗口早就
 * 滑出语料范围——存档结果里 case_001 命中 0 条就是这么来的。把日期改成"相对锚点日的
 * 偏移"并在生成时落地，这个问题就永久消失。
 *
 * 另外 ::LastN 和 DailyNoteSearcher 的 BM25 候选窗口都按**文件系统 mtime** 排序，
 * 跟文件名、跟首行日期都无关。git checkout 会把所有文件的 mtime 设成同一时刻，
 * 于是 ::LastN 的行为完全不可控。所以生成时必须用 utimes() 显式钉死 mtime，
 * 并且刻意让 mtime 顺序 ≠ 文件名顺序 ≠ 首行日期顺序——否则 {{}} 全量模式和 ::LastN
 * 根本区分不开，测了等于没测。
 *
 * 文件格式的每一条都是硬要求，违反任何一条都会静默失效（不报错）：
 *   第 1 行  `[YYYY-MM-DD] - <署名>`   月日必须补零，否则该文件对 ::Time 完全不可见
 *   正文     判别词必须在正文里，不能只在 Tag 行（::BM25+ body 模式会剔除 Tag 行）
 *   `Tags:`  DailyNoteSearcher 的 tag 模式只认 Tags:/tags:/标签:，不认 Tag:
 *   `Tag:`   KnowledgeBaseManager.extractTags 只认 Tag:，这是 TagMemo/RiverMemo 的命脉
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { EVAL_ROOT } = require('./profile');

const SPEC_DIR = path.join(EVAL_ROOT, 'corpus-spec');
const DEFAULT_OUT = path.join(EVAL_ROOT, 'dailynote_eval');
const SIGNATURE = '评测助手';

/** extractTags 的日期过滤器（textPreprocessor.js:56）。含日期形的 tag 会被静默丢弃。 */
const TAG_DATE_RE = /(\d{4}年\d{1,2}月\d{1,2}日|\d{4}年\d{1,2}月|\d{1,2}月\d{1,2}日|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{2}[-./]\d{1,2}[-./]\d{1,2}|\d{4}[-./]\d{1,2})/;

function hasCJK(text) {
    return /[一-龥]/.test(text);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** 本地日历日加减。刻意不用 UTC：VCP 的时间解析走 Asia/Shanghai 本地边界。 */
function addDays(base, days) {
    const d = new Date(base.getTime());
    d.setDate(d.getDate() + days);
    return d;
}

function formatDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 日历相对日期规则。
 *
 * 单纯的 dayOffset 表达不了「上周三」「上月中」这类日历语义，而 ::Time 恰恰要靠它们。
 * 注意两个已验证的实现事实：
 *   - dayjs 的 locale 从未设置，所以**周从星期日开始**（与代码注释相反）
 *   - 「上周三」解析出的是整个上周（周日..周六），不是单独那一天；
 *     「本月初」解析出的是整个当月，不是 1-10 日。这些是被测系统的既有行为，
 *     评测要如实覆盖它们，而不是假设它们"应该"怎样。
 */
const DATE_RULES = {
    /** 上一周（周日起）里的星期三 */
    lastWeekWed(anchor) {
        const sundayThisWeek = addDays(anchor, -anchor.getDay());
        return addDays(sundayThisWeek, -7 + 3);
    },
    /** 上一周里的星期一 */
    lastWeekMon(anchor) {
        const sundayThisWeek = addDays(anchor, -anchor.getDay());
        return addDays(sundayThisWeek, -7 + 1);
    },
    /** 本周内（周日起）第 2 天，且不越过锚点日 */
    thisWeek(anchor) {
        const sundayThisWeek = addDays(anchor, -anchor.getDay());
        const candidate = addDays(sundayThisWeek, 1);
        return candidate > anchor ? sundayThisWeek : candidate;
    },
    /** 上个月 1-10 日 */
    prevMonthEarly(anchor) {
        return new Date(anchor.getFullYear(), anchor.getMonth() - 1, 5, 12, 0, 0, 0);
    },
    /** 上个月 11-20 日 */
    prevMonthMid(anchor) {
        return new Date(anchor.getFullYear(), anchor.getMonth() - 1, 15, 12, 0, 0, 0);
    },
    /** 上个月 21 日至月末 */
    prevMonthLate(anchor) {
        const lastDay = new Date(anchor.getFullYear(), anchor.getMonth(), 0).getDate();
        return new Date(anchor.getFullYear(), anchor.getMonth() - 1, Math.max(21, lastDay - 2), 12, 0, 0, 0);
    },
    /** 本月 1-10 日（可能晚于锚点日则回退到 1 号） */
    thisMonthEarly(anchor) {
        const candidate = new Date(anchor.getFullYear(), anchor.getMonth(), 3, 12, 0, 0, 0);
        return candidate > anchor ? new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12, 0, 0, 0) : candidate;
    },
    /** 恰好三个自然月前 */
    threeMonthsAgo(anchor) {
        return new Date(anchor.getFullYear(), anchor.getMonth() - 3, 12, 12, 0, 0, 0);
    }
};

/** 求出一篇文档最终落在哪一天。dateRule 优先于 dayOffset。 */
function resolveDate(doc, anchor) {
    if (doc.dateRule) {
        const rule = DATE_RULES[doc.dateRule];
        if (!rule) {
            throw new Error(`文档 "${doc.slug}" 使用了未知的 dateRule "${doc.dateRule}"，可用：${Object.keys(DATE_RULES).join(', ')}`);
        }
        const d = rule(anchor);
        d.setHours(12, 0, 0, 0);
        return d;
    }
    if (typeof doc.dayOffset !== 'number') {
        throw new Error(`文档 "${doc.slug}" 既没有 dayOffset 也没有 dateRule`);
    }
    return addDays(anchor, doc.dayOffset);
}

function readSpecFile(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('//'))
        .map((line, i) => {
            try {
                return JSON.parse(line);
            } catch (e) {
                throw new Error(`${path.basename(filePath)} 第 ${i + 1} 行 JSON 解析失败：${e.message}`);
            }
        });
}

/** books.json 里以 $ 开头的键是给人看的注释，不是数据。 */
function stripCommentKeys(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key.startsWith('$')) continue;
        out[key] = value;
    }
    return out;
}

function loadSpec() {
    const booksFile = path.join(SPEC_DIR, 'books.json');
    if (!fs.existsSync(booksFile)) {
        throw new Error(`缺少语料定义 ${booksFile}`);
    }
    const books = JSON.parse(fs.readFileSync(booksFile, 'utf-8'));
    // 注释键不能流进下游 —— 否则 "$comment" 会被当成一个语义组装进 semantic_groups.json
    books.books = stripCommentKeys(books.books);
    books.semanticGroups = stripCommentKeys(books.semanticGroups);
    for (const book of Object.values(books.books)) {
        for (const key of Object.keys(book)) if (key.startsWith('$')) delete book[key];
    }

    const docs = [];
    for (const [bookKey, book] of Object.entries(books.books)) {
        const specFile = path.join(SPEC_DIR, `${bookKey}.jsonl`);
        if (!fs.existsSync(specFile)) {
            throw new Error(`日记本 "${bookKey}" 在 books.json 中声明，但缺少 ${path.basename(specFile)}`);
        }
        for (const doc of readSpecFile(specFile)) {
            docs.push({ ...doc, book: bookKey, folder: book.folder });
        }
    }
    return { books, docs };
}

/**
 * 渲染单篇文档。
 * `time` 用 spec 里的 hhmm，缺省按 slug 派生一个稳定值——避免全语料同一时刻，
 * 也保证同一份 spec 每次生成的内容字节一致（内容哈希才有意义）。
 */
function renderDoc(doc, dateStr) {
    const hhmm = doc.hhmm || deriveTime(doc.slug);
    const lines = [`[${dateStr}] - ${SIGNATURE}`];

    const body = String(doc.body || '').trim();
    lines.push(`[${hhmm}] ${body.split('\n')[0]}`);
    for (const extra of body.split('\n').slice(1)) {
        if (extra.trim()) lines.push(extra.trim());
    }

    // ── 标签行：只写一行 `Tag: …`，且必须是最后一行 ─────────────────────
    //
    // 与生产语料（DailyNote 插件写出的日记）格式完全一致。
    //
    // 历史：Rust searcher 修复前只认 `tags:`/`标签:`、看不见 `Tag:`，当时语料被迫
    // 同时写 `Tags:` 与 `Tag:` 两行。修复（main.rs tag_line_value 与 JS 参照对齐）后
    // 实测发现那行 `Tags:` 其实是**死行**：两套引擎的标签行提取都是自底向上扫、
    // 只取最后一条匹配，`Tag:` 永远在最后，上面的 `Tags:` 根本不会被读到
    // （双行探针实测：查 Tags: 行独有词 total=0，查 Tag: 行独有词 total=1）。
    // 变体写法（Tags:/标签:/大小写/全角冒号）的兼容性由 Rust 单元测试
    // （main.rs tag_line_tests）钉住，不需要语料来兜。
    //
    // 顺序约束依旧：`Tag:` 必须是最后一行 —— extractTagLine 取最后一条匹配，
    // 且 KnowledgeBaseManager 的 detectTagLine 同样自底向上。
    const tagList = doc.tags.join(', ');
    lines.push(`Tag: ${tagList}`);

    return lines.join('\n');
}

/** 由 slug 派生稳定的 HH:MM，保证生成可复现。 */
function deriveTime(slug) {
    const h = crypto.createHash('sha256').update(String(slug)).digest();
    return `${pad2(8 + (h[0] % 12))}:${pad2(h[1] % 60)}`;
}

function fileNameFor(doc, dateStr) {
    const hhmm = doc.hhmm || deriveTime(doc.slug);
    const [hh, mm] = hhmm.split(':');
    const ss = pad2(crypto.createHash('sha256').update(String(doc.slug)).digest()[2] % 60);
    // `YYYY-MM-DD-HH_MM_SS-<slug>.txt`：DailyNoteManager 的 list 要求日期后面跟横杠，
    // 旧语料用的下划线，因此对 list 完全不可见。
    return `${dateStr}-${hh}_${mm}_${ss}-${doc.slug}.txt`;
}

/**
 * 生成语料。
 * @param {object} options
 * @param {string} [options.anchor]  锚点日 YYYY-MM-DD，默认今天。所有 dayOffset 相对它计算。
 * @param {string} [options.outDir]
 * @param {boolean} [options.force]  已存在时是否清空重建
 */
function build(options = {}) {
    const outDir = path.resolve(options.outDir || DEFAULT_OUT);
    const anchor = options.anchor ? parseAnchor(options.anchor) : new Date();
    anchor.setHours(12, 0, 0, 0); // 正午锚定，避开跨日边界抖动

    const { books, docs } = loadSpec();

    if (fs.existsSync(outDir)) {
        if (!options.force && fs.readdirSync(outDir).length > 0) {
            // 语料是生成物，重建是常态，不需要用户确认——但要明说清掉了什么。
        }
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(outDir, { recursive: true });

    const manifest = {
        generatedAt: new Date().toISOString(),
        anchorDate: formatDate(anchor),
        signature: SIGNATURE,
        books: {},
        files: []
    };

    // ── mtime 基准：必须落在**未来** ────────────────────────────────────
    //
    // 这里有个不踩过就想不到的坑。DirectDiaryTextProcessor.getRecentDiaryFileMetas
    // 用的排序键是 `max(mtimeMs, birthtimeMs, ctimeMs)`（:610），而 fs.utimes() 只能设
    // atime 和 mtime —— 它会把 **ctime 更新为当前时刻**，而 ctime 无法被调早。
    // 于是如果把 mtime 设成过去，max() 永远选中 ctime，所有文件的排序键都挤在"生成那一刻"，
    // mtimeRank 完全失效，::LastN 退化成写入顺序。
    //
    // 解法是把 mtime 设到未来：此时 max() 必然选中 mtime，排序完全由 mtimeRank 决定。
    // 未来时间戳在这里是安全的 —— 语料是 gitignore 的生成物，且时间戳稳定不变，
    // 索引的增量判定（checksum + size + mtime）不会因此反复失效。
    const mtimeBase = new Date(Date.now() + 30 * 86400000).getTime();

    for (const doc of docs) {
        const date = resolveDate(doc, anchor);
        const dateStr = formatDate(date);
        const folder = doc.folder;
        const fileName = fileNameFor(doc, dateStr);
        const relPath = path.join(folder, fileName);
        const absPath = path.join(outDir, relPath);

        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const content = renderDoc(doc, dateStr);
        // 无 BOM、LF、无尾随换行——BOM 会破坏首行日期正则。
        fs.writeFileSync(absPath, content, { encoding: 'utf-8' });

        const rank = Number.isFinite(doc.mtimeRank) ? doc.mtimeRank : 10000;
        const mtime = new Date(mtimeBase - rank * 3600 * 1000);
        fs.utimesSync(absPath, mtime, mtime);

        manifest.files.push({
            id: relPath,
            book: doc.book,
            folder,
            slug: doc.slug,
            family: doc.family || null,
            role: doc.role || null,
            date: dateStr,
            dayOffset: typeof doc.dayOffset === 'number' ? doc.dayOffset : null,
            dateRule: doc.dateRule || null,
            // 相对锚点日的实际天数差，供 ::TimeDecay 等用例核对
            ageDays: Math.round((anchor.getTime() - date.getTime()) / 86400000),
            mtimeRank: rank,
            mtime: mtime.toISOString(),
            tags: doc.tags,
            bytes: Buffer.byteLength(content, 'utf-8'),
            sha256: crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
        });
    }

    for (const [key, book] of Object.entries(books.books)) {
        manifest.books[key] = {
            folder: book.folder,
            placeholder: book.folder,
            threshold: book.threshold ?? null,
            docCount: manifest.files.filter(f => f.book === key).length
        };
    }

    manifest.docCount = manifest.files.length;
    manifest.uniqueTags = [...new Set(manifest.files.flatMap(f => f.tags))].length;
    manifest.corpusHash = crypto.createHash('sha256')
        .update(manifest.files.map(f => `${f.id}:${f.sha256}`).join('|'))
        .digest('hex');

    fs.writeFileSync(path.join(outDir, '.corpus-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    return { outDir, manifest };
}

function parseAnchor(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text).trim());
    if (!m) throw new Error(`锚点日格式应为 YYYY-MM-DD，收到 "${text}"`);
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function loadManifest(corpusRoot) {
    const file = path.join(corpusRoot, '.corpus-manifest.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

module.exports = {
    SPEC_DIR,
    DEFAULT_OUT,
    SIGNATURE,
    TAG_DATE_RE,
    DATE_RULES,
    stripCommentKeys,
    build,
    loadSpec,
    loadManifest,
    renderDoc,
    resolveDate,
    formatDate,
    addDays,
    hasCJK
};
