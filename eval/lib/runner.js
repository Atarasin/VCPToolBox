'use strict';

/**
 * 用例执行器。
 *
 * 五种 mode，各自的调用面不同：
 *   placeholder —— RAGDiaryPlugin.processMessages（占位符全链路）
 *   lightmemo   —— LightMemo.processToolCall（工具调用）
 *   direct      —— new DirectDiaryTextProcessor（纯文本，离线）
 *   time        —— new TimeExpressionParser（纯函数，离线）
 *   dedup       —— ResultDeduplicator（离线）
 *   searcher    —— DailyNoteSearcher（Rust JSON 契约）
 *
 * 双臂是核心：treatment 与 control 用同一语料、同一查询，只差一个修饰符。
 * 没有对照臂就无法回答"这个能力有没有用"。
 *
 * 两个必须守住的纪律：
 *   1. 每条 case 用**新的** ObservationCollector，跑完 seal()。旧 harness 复用同一个
 *      currentEvents 绑定，case N 的迟到异步事件会落进 case N+1 的桶里被当成它的结果。
 *   2. 依赖不可用时标记 SKIPPED，绝不标 PASSED。
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./profile');
const probes = require('./probes');
const metrics = require('./metrics');

function readSuite(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const cases = [];
    let lineNo = 0;
    for (const raw of text.split('\n')) {
        lineNo++;
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;
        try {
            cases.push(JSON.parse(line));
        } catch (error) {
            throw new Error(`${path.basename(filePath)} 第 ${lineNo} 行 JSON 解析失败：${error.message}`);
        }
    }
    return cases;
}

function loadSuites(evalRoot, names) {
    const dir = path.join(evalRoot, 'suites');
    const available = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    const selected = names && names.length
        ? available.filter(f => names.some(n => f.startsWith(n) || f.replace(/\.jsonl$/, '') === n))
        : available;
    if (names && names.length && !selected.length) {
        throw new Error(`没有匹配的 suite："${names.join(', ')}"。可用：${available.map(f => f.replace(/\.jsonl$/, '')).join(', ')}`);
    }
    const cases = [];
    for (const file of selected.sort()) {
        for (const c of readSuite(path.join(dir, file))) {
            cases.push({ ...c, _suite: file.replace(/\.jsonl$/, '') });
        }
    }
    return { cases, files: selected };
}

/** 把用例里的占位记号替换成与当前语料锚点日一致的实际值。 */
function materializeArgs(args, corpusManifest) {
    const anchor = corpusManifest?.anchorDate;
    const json = JSON.stringify(args);
    if (!anchor || !json.includes('__TIME_RANGE__')) return JSON.parse(json);
    const end = anchor;
    const d = new Date(`${anchor}T12:00:00`);
    d.setDate(d.getDate() - 30);
    const start = d.toISOString().slice(0, 10);
    return JSON.parse(json.replace(/__TIME_RANGE__/g, `${start}~${end}`));
}

/**
 * 跑一个占位符臂。
 */
async function runPlaceholderArm(params) {
    const { runtime, placeholder, query, history = [] } = params;
    const collector = new probes.ObservationCollector();
    runtime.sink.current = collector;

    const restoreLog = probes.installLogCapture(text => collector.appendLog(text));
    const startedAt = Date.now();
    let processed;
    let error = null;
    try {
        const messages = [
            { role: 'system', content: placeholder },
            ...history,
            { role: 'user', content: query }
        ];
        processed = await runtime.ragPlugin.processMessages(messages, {});
    } catch (e) {
        error = e;
    } finally {
        restoreLog();
        collector.seal();
        runtime.sink.current = null;
    }
    const latencyMs = Date.now() - startedAt;

    if (error) {
        return { error: error.message || String(error), latencyMs, collector, observation: null, gate: null };
    }

    const injectedContent = (processed.find(m => m.role === 'system') || {}).content || '';
    const observation = probes.summarize({ collector, injectedContent });
    observation.log = collector.log;
    const gate = probes.classifyGate({ injectedContent, observation, placeholder });

    return {
        latencyMs,
        injectedContent,
        injectedChars: injectedContent.length,
        collector,
        observation,
        gate
    };
}

/**
 * 跑一个 LightMemo 臂。
 * LightMemo 不发 pushVcpInfo 事件，唯一的机器可读信号是 stdout 与返回文本里的标记。
 */
async function runLightMemoArm(params) {
    const { runtime, args } = params;
    const collector = new probes.ObservationCollector();
    const restoreLog = probes.installLogCapture(text => collector.appendLog(text));
    const startedAt = Date.now();
    let out;
    let error = null;
    try {
        out = await runtime.lightMemo.processToolCall(args);
    } catch (e) {
        error = e;
    } finally {
        restoreLog();
        collector.seal();
    }
    const latencyMs = Date.now() - startedAt;

    if (error) {
        return { error: error.message || String(error), latencyMs, collector };
    }

    const text = extractLightMemoText(out);
    const observation = probes.summarize({ collector, injectedContent: text });
    observation.log = collector.log;
    // LightMemo 的结果条目从返回文本里的路径行解析（它没有结构化输出）
    observation.results = parseLightMemoResults(text);

    return {
        latencyMs,
        injectedContent: text,
        injectedChars: text.length,
        collector,
        observation,
        pluginError: out?.plugin_error || null,
        gate: { decision: text.trim() ? 'passed' : 'passed_empty', reason: null }
    };
}

function extractLightMemoText(out) {
    if (!out) return '';
    if (typeof out === 'string') return out;
    if (out.plugin_error) return String(out.plugin_error);
    const content = out.result?.content || out.content;
    if (Array.isArray(content)) {
        return content.map(c => c?.text || '').join('\n');
    }
    return typeof out.result === 'string' ? out.result : JSON.stringify(out);
}

/** 从 "[路径: file:///abs/path]" 行反解出相对语料根的文档 id。 */
function parseLightMemoResults(text) {
    const results = [];
    const re = /\[路径:\s*(?:file:\/\/)?([^\]]+)\]/g;
    let m;
    let rank = 0;
    while ((m = re.exec(String(text)))) {
        results.push({ fullPath: m[1].trim(), rank: ++rank, score: null });
    }
    return results;
}

/** 把绝对路径归约成 "日记本/文件名" 形式，便于与真值比对。 */
function relativizeResults(results, corpusRoot) {
    const rootNorm = path.resolve(corpusRoot).replace(/\\/g, '/');
    return (results || []).map(r => {
        if (!r.fullPath) return r;
        let p = String(r.fullPath).replace(/\\/g, '/');
        if (p.startsWith(rootNorm)) p = p.slice(rootNorm.length).replace(/^\/+/, '');
        return { ...r, fullPath: p };
    });
}

/**
 * 离线模式：DirectDiaryTextProcessor。
 */
async function runDirectCase(params) {
    const { theCase, resolved, corpusManifest } = params;
    const DirectDiaryTextProcessor = require(
        path.join(PROJECT_ROOT, 'Plugin', 'RAGDiaryPlugin', 'DirectDiaryTextProcessor')
    );
    const proc = new DirectDiaryTextProcessor({ dailyNoteRootPath: resolved.corpusRoot });

    const book = corpusManifest.books[bookKeyOf(theCase.book, corpusManifest)]?.folder || theCase.book;
    const collector = new probes.ObservationCollector();
    const restoreLog = probes.installLogCapture(t => collector.appendLog(t));
    const startedAt = Date.now();
    let payload = {};
    let error = null;
    try {
        switch (theCase.op) {
            case 'full':
                payload = { content: await proc.getDiaryContent(book) };
                break;
            case 'last':
                payload = { content: await proc.getLastDiaryContent(book, theCase.limit ?? 10) };
                break;
            case 'random':
                payload = { content: await proc.getRandomDiaryContent(book, theCase.limit ?? 1) };
                break;
            case 'bm25': {
                const mode = theCase.bm25Mode === 'tag' ? 'tag' : 'body';
                payload = await proc.getBM25DiaryContent(book, theCase.query, theCase.limit ?? 10, mode);
                break;
            }
            default:
                throw new Error(`未知的 direct op "${theCase.op}"`);
        }
    } catch (e) {
        error = e;
    } finally {
        restoreLog();
        collector.seal();
    }

    return {
        latencyMs: Date.now() - startedAt,
        error: error ? (error.message || String(error)) : null,
        payload,
        collector
    };
}

function bookKeyOf(folderOrKey, corpusManifest) {
    for (const [key, book] of Object.entries(corpusManifest.books || {})) {
        if (key === folderOrKey || book.folder === folderOrKey) return key;
    }
    return folderOrKey;
}

/** 离线模式：TimeExpressionParser。 */
async function runTimeCase(theCase) {
    const TimeExpressionParser = require(
        path.join(PROJECT_ROOT, 'Plugin', 'RAGDiaryPlugin', 'TimeExpressionParser')
    );
    const collector = new probes.ObservationCollector();
    const restoreLog = probes.installLogCapture(t => collector.appendLog(t));
    const startedAt = Date.now();
    let ranges = [];
    let error = null;
    try {
        const Parser = TimeExpressionParser.TimeExpressionParser || TimeExpressionParser;
        const parser = new Parser('zh-CN', 'Asia/Shanghai');
        ranges = parser.parse(theCase.query) || [];
    } catch (e) {
        error = e;
    } finally {
        restoreLog();
        collector.seal();
    }
    return {
        latencyMs: Date.now() - startedAt,
        error: error ? (error.message || String(error)) : null,
        ranges,
        collector
    };
}

/** 离线模式：ResultDeduplicator 的安全不变量。 */
async function runDedupCase(theCase) {
    const ResultDeduplicator = require(path.join(PROJECT_ROOT, 'ResultDeduplicator'));
    const collector = new probes.ObservationCollector();
    const restoreLog = probes.installLogCapture(t => collector.appendLog(t));
    const startedAt = Date.now();
    let outcome = {};
    let error = null;
    try {
        const Ctor = ResultDeduplicator.ResultDeduplicator || ResultDeduplicator;
        const dedup = typeof Ctor === 'function' ? new Ctor({}) : ResultDeduplicator;

        // 与 corpus-spec 的 dedup 族保持一致：全角变体必须是 NFKC 真的会折叠的形式
        // （全角字母数字 + U+3000 表意空格），而不是"在标点旁加空格"——后者不会被折叠。
        const sameText = '值班交接口径：P95 指标与未闭环告警需要逐条列出，交给下一班确认。';
        const fullwidth = '值班交接口径：Ｐ９５　指标与未闭环告警需要逐条列出，交给下一班确认。';
        const candidates = [
            { chunkId: 1, text: sameText, fullPath: '评测运维技术库/a.txt', source: 'rag', score: 0.9 },
            { chunkId: 2, text: sameText, fullPath: '评测运维技术库/b.txt', source: 'bm25_body', score: 0.8 },
            { chunkId: 3, text: fullwidth, fullPath: '评测运维技术库/c.txt', source: 'time', score: 0.7 },
            { chunkId: 4, text: '完全不同的另一段内容，用于确认非重复项不会被误删。', fullPath: '评测运维技术库/d.txt', source: 'rag', score: 0.6 },
            // 无向量的 BM25 候选：安全不变量要求永不丢弃
            { chunkId: 5, text: '只有 BM25 命中、没有向量的候选。', fullPath: '评测运维技术库/e.txt', source: 'bm25_tag', score: 0.5 },
            // 匿名候选：无 chunkId / 无 text / 无 path，必须全部保留
            { source: 'rag', score: 0.4 },
            { source: 'rag', score: 0.3 }
        ];
        const deduped = typeof dedup.hardDeduplicate === 'function'
            ? dedup.hardDeduplicate(candidates, {})
            : candidates;
        outcome = {
            inputCount: candidates.length,
            outputCount: deduped.length,
            outputIds: deduped.map(r => r.chunkId ?? null),
            texts: deduped.map(r => r.text ?? null)
        };
    } catch (e) {
        error = e;
    } finally {
        restoreLog();
        collector.seal();
    }
    return { latencyMs: Date.now() - startedAt, error: error ? (error.message || String(error)) : null, outcome, collector };
}

/** DailyNoteSearcher：JSON 契约（stdin 一次性调用）。 */
async function runSearcherCase(params) {
    const { theCase, resolved } = params;
    const { execFileSync } = require('child_process');
    const pluginDir = path.join(PROJECT_ROOT, 'Plugin', 'DailyNoteSearcher');
    const candidates = process.platform === 'win32'
        ? [path.join(pluginDir, 'DailyNoteSearcher.exe'), path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher.exe')]
        : [
            path.join(pluginDir, 'DailyNoteSearcher'),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher'),
            path.join(pluginDir, `DailyNoteSearcher-${process.arch === 'arm64' ? 'aarch64' : process.arch}-unknown-linux-musl`)
        ];
    const bin = candidates.find(p => fs.existsSync(p));
    if (!bin) {
        return { skip: true, skipReason: 'dailyNoteSearcher-binary-missing' };
    }

    // root_path 指向评测语料根（绝对路径）。Rust 侧的 find_project_root 会向上找
    // .git/package.json/Cargo.toml，传绝对路径可以绕开这层推断。
    const payload = { root_path: resolved.corpusRoot, allowed_extensions: 'md,txt', ...theCase.payload };
    const startedAt = Date.now();
    try {
        const stdout = execFileSync(bin, [], {
            input: JSON.stringify(payload),
            cwd: PROJECT_ROOT,
            encoding: 'utf-8',
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60000
        });
        return { latencyMs: Date.now() - startedAt, response: JSON.parse(stdout) };
    } catch (error) {
        // Rust 侧的业务错误是 HTTP 200 / 正常退出里的 status:"error"，
        // 只有进程级失败才走到这里
        const stdout = error.stdout ? String(error.stdout) : '';
        if (stdout.trim()) {
            try { return { latencyMs: Date.now() - startedAt, response: JSON.parse(stdout) }; } catch (_) {}
        }
        return { latencyMs: Date.now() - startedAt, error: error.message || String(error) };
    }
}

// ─────────────────────────────────────────────────────────────────────
// 离线用例的断言校验
// ─────────────────────────────────────────────────────────────────────

function checkDirectExpectations(theCase, result, corpusManifest) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
    const e = theCase.expect || {};
    const content = String(result.payload?.content ?? result.payload ?? '');

    if (result.error) {
        add('noError', false, result.error);
        return { checks, ok: false };
    }

    if (e.unreadable) {
        add('unreadable', /无法读取|不存在/.test(content), content.slice(0, 80));
        return { checks, ok: checks.every(c => c.ok) };
    }

    // {{}} 用 "\n\n---\n\n" 分隔文件，据此数出文件数
    const fileCount = content.trim() ? content.split('\n\n---\n\n').length : 0;

    if (Number.isFinite(e.fileCount)) add('fileCount', fileCount === e.fileCount, `期望 ${e.fileCount}，实际 ${fileCount}`);
    if (Number.isFinite(e.minFiles)) add('minFiles', fileCount >= e.minFiles, `期望 ≥${e.minFiles}，实际 ${fileCount}`);

    if (Array.isArray(e.exactFiles)) {
        const missing = e.exactFiles.filter(slug => !content.includes(slug.replace(/^.*\//, '')) && !contentHasSlug(content, slug, corpusManifest));
        add('exactFiles', missing.length === 0 && fileCount === e.exactFiles.length,
            missing.length ? `缺少 ${missing.join(', ')}（实际 ${fileCount} 篇）` : `${fileCount} 篇`);
    }

    if (e.subsetOfBook) {
        add('subsetOfBook', fileCount > 0 && content.includes('['), `${fileCount} 篇`);
    }

    if (theCase.op === 'bm25') {
        if (e.matched !== undefined) {
            add('bm25Matched', Boolean(result.payload?.matched) === e.matched,
                `期望 matched=${e.matched}，实际 ${result.payload?.matched}`);
        }
        if (e.reason) {
            const detail = result.payload?.reason || result.payload?.candidates?.reason || null;
            add('bm25Reason', true, `reason=${detail}（记录用，不做硬断言：兜底原因随分词实现变化）`);
        }
        if (Array.isArray(e.topFileAmong)) {
            const first = content.split('\n\n---\n\n')[0] || '';
            add('bm25TopFile', e.topFileAmong.some(slug => contentHasSlug(first, slug, corpusManifest)),
                `首篇内容片段：${first.slice(0, 60)}`);
        }
    }

    return { checks, ok: checks.every(c => c.ok) };
}

/** 内容里能否找到某个 slug 对应文档的特征（用 tag 行做指纹，正文可能被截断）。 */
function contentHasSlug(content, slug, corpusManifest) {
    const bare = String(slug).split('/').pop();
    const entry = (corpusManifest?.files || []).find(f => f.slug === bare);
    if (!entry) return false;
    // 用 tag 组合做指纹：Tag 行一定在内容里
    return content.includes(entry.tags.join(', '));
}

function checkTimeExpectations(theCase, result) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
    const e = theCase.expect || {};
    if (result.error) {
        add('noError', false, result.error);
        return { checks, ok: false };
    }
    const ranges = result.ranges || [];
    if (Number.isFinite(e.rangeCount)) {
        add('rangeCount', ranges.length === e.rangeCount, `期望 ${e.rangeCount}，实际 ${ranges.length}`);
    }
    if (ranges.length && (Number.isFinite(e.spansDays) || Number.isFinite(e.spansDaysAtLeast))) {
        const r = ranges[0];
        const start = new Date(r.start || r[0]);
        const end = new Date(r.end || r[1]);
        // 区间的 end 是当日 23:59:59.999，所以直接相减再 +1 会多算一天。
        // 按**日历日**计数：把两端归零到当天零点再算差值，然后 +1 表示闭区间。
        const startDay = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
        const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
        const days = Math.round((endDay - startDay) / 86400000) + 1;
        if (Number.isFinite(e.spansDays)) add('spansDays', days === e.spansDays, `期望 ${e.spansDays} 天，实际 ${days} 天`);
        if (Number.isFinite(e.spansDaysAtLeast)) add('spansDaysAtLeast', days >= e.spansDaysAtLeast, `期望 ≥${e.spansDaysAtLeast} 天，实际 ${days} 天`);
    }
    if (Number.isFinite(e.daysAgo) && ranges.length) {
        const start = new Date(ranges[0].start || ranges[0][0]);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const diff = Math.round((today - new Date(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000);
        add('daysAgo', diff === e.daysAgo, `期望 ${e.daysAgo} 天前，实际 ${diff} 天前`);
    }
    return { checks, ok: checks.every(c => c.ok) };
}

function checkDedupExpectations(theCase, result) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
    const e = theCase.expect || {};
    if (result.error) {
        add('noError', false, result.error);
        return { checks, ok: false };
    }
    const o = result.outcome || {};
    // 归一化后同族的文本应当只剩一条。半角与全角两种写法都归到同一族里数。
    const familyCount = (o.texts || []).filter(t =>
        t && /[Ｐp][９9][５5]/.test(t) && t.includes('未闭环告警')).length;
    if (e.collapsesIdenticalText) {
        add('collapsesIdenticalText', familyCount <= 1,
            `归一化后同族文本在输出里存活 ${familyCount} 条（应 ≤1）；输入含 2 条逐字节相同 + 1 条全角变体`);
    }
    if (e.collapsesFullwidthVariant) {
        add('collapsesFullwidthVariant', familyCount <= 1,
            `全角变体（Ｐ９５ + U+3000）应被 NFKC 折叠；实际存活 ${familyCount} 条`);
    }
    if (e.preservesVectorless) {
        add('preservesVectorless', (o.outputIds || []).includes(5),
            `无向量的 BM25 候选（chunkId=5）${(o.outputIds || []).includes(5) ? '已保留' : '被丢弃了'}`);
    }
    if (e.preservesAnonymous) {
        const anonymous = (o.outputIds || []).filter(id => id === null || id === undefined).length;
        add('preservesAnonymous', anonymous >= 2, `匿名候选保留 ${anonymous} 条（应 ≥2）`);
    }
    return { checks, ok: checks.every(c => c.ok) };
}

function checkSearcherExpectations(theCase, result) {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });
    const e = theCase.expect || {};
    if (result.error) {
        add('noProcessError', false, result.error);
        return { checks, ok: false };
    }
    const res = result.response || {};
    if (e.status) add('status', res.status === e.status, `期望 ${e.status}，实际 ${res.status}`);
    if (e.errorContains) {
        add('errorContains', String(res.error || '').toLowerCase().includes(e.errorContains.toLowerCase()),
            `实际 error=${String(res.error || '').slice(0, 120)}`);
    }
    const total = res.result?.total ?? res.total ?? 0;
    if (Number.isFinite(e.minTotal)) add('minTotal', total >= e.minTotal, `期望 ≥${e.minTotal}，实际 ${total}`);
    if (Number.isFinite(e.total)) add('total', total === e.total, `期望 ${e.total}，实际 ${total}`);
    if (e.queryTokensEcho) {
        const tokens = res.result?.query_tokens;
        add('queryTokensEcho', Array.isArray(tokens) && tokens.length > 1,
            `实际 query_tokens=${JSON.stringify(tokens)}`);
    }
    return { checks, ok: checks.every(c => c.ok) };
}

// ─────────────────────────────────────────────────────────────────────

/**
 * 执行整个 suite。
 */
async function runSuite(params) {
    const {
        cases, runtime, resolved, corpusManifest, capabilities,
        capabilityReasons = {}, artifactReady, onProgress = () => {}
    } = params;

    const matcher = metrics.makeDocMatcher(corpusManifest);
    const rawRows = [];
    const perCase = [];

    for (let i = 0; i < cases.length; i++) {
        const theCase = cases[i];
        onProgress({ index: i + 1, total: cases.length, id: theCase.id, mode: theCase.mode });

        const base = {
            id: theCase.id,
            suite: theCase._suite,
            tier: theCase.tier,
            mode: theCase.mode,
            family: theCase.family,
            capability: theCase.capability,
            note: theCase.note || null
        };

        // 依赖不可用 → SKIP。绝不当成 PASS。
        const missingCap = (theCase.requires || []).find(cap => !capabilities[cap]);
        if (missingCap) {
            perCase.push({
                ...base,
                status: 'skipped',
                skipReason: capabilityReasons[missingCap] || `capability-unavailable:${missingCap}`
            });
            continue;
        }

        try {
            const row = await runOneCase({
                theCase, runtime, resolved, corpusManifest, matcher, artifactReady
            });
            rawRows.push({ ...base, ...row.raw });
            perCase.push({ ...base, ...row.scored });
        } catch (error) {
            perCase.push({ ...base, status: 'error', error: error.message || String(error) });
            rawRows.push({ ...base, error: error.message || String(error) });
        }
    }

    return { rawRows, perCase };
}

async function runOneCase(params) {
    const { theCase, runtime, resolved, corpusManifest, matcher, artifactReady } = params;

    // ── 离线模式 ────────────────────────────────────────────────
    if (theCase.mode === 'direct') {
        const result = await runDirectCase({ theCase, resolved, corpusManifest });
        const { checks, ok } = checkDirectExpectations(theCase, result, corpusManifest);
        return {
            raw: { payload: truncatePayload(result.payload), error: result.error, latencyMs: result.latencyMs },
            scored: {
                status: result.error ? 'error' : 'scored',
                error: result.error, latencyMs: result.latencyMs,
                expectationChecks: checks, expectationsOk: ok,
                relevantCount: 0, irrelevantCount: 0, degradations: {}
            }
        };
    }

    if (theCase.mode === 'time') {
        const result = await runTimeCase(theCase);
        const { checks, ok } = checkTimeExpectations(theCase, result);
        return {
            raw: { ranges: result.ranges, error: result.error, latencyMs: result.latencyMs },
            scored: {
                status: result.error ? 'error' : 'scored',
                error: result.error, latencyMs: result.latencyMs,
                expectationChecks: checks, expectationsOk: ok,
                relevantCount: 0, irrelevantCount: 0, degradations: {}
            }
        };
    }

    if (theCase.mode === 'dedup') {
        const result = await runDedupCase(theCase);
        const { checks, ok } = checkDedupExpectations(theCase, result);
        return {
            raw: { outcome: result.outcome, error: result.error, latencyMs: result.latencyMs },
            scored: {
                status: result.error ? 'error' : 'scored',
                error: result.error, latencyMs: result.latencyMs,
                expectationChecks: checks, expectationsOk: ok,
                relevantCount: 0, irrelevantCount: 0, degradations: {}
            }
        };
    }

    if (theCase.mode === 'searcher') {
        const result = await runSearcherCase({ theCase, resolved });
        if (result.skip) {
            return {
                raw: { skipped: result.skipReason },
                scored: { status: 'skipped', skipReason: result.skipReason }
            };
        }
        const { checks, ok } = checkSearcherExpectations(theCase, result);
        return {
            raw: { response: truncateResponse(result.response), error: result.error, latencyMs: result.latencyMs },
            scored: {
                status: result.error ? 'error' : 'scored',
                error: result.error, latencyMs: result.latencyMs,
                expectationChecks: checks, expectationsOk: ok,
                relevantCount: 0, irrelevantCount: 0, degradations: {}
            }
        };
    }

    // ── 在线模式（需要 runtime）──────────────────────────────────
    const { resolved: relevant, missing: relevantMissing } = matcher.resolveAll(theCase.relevant);
    const { resolved: irrelevant, missing: irrelevantMissing } = matcher.resolveAll(theCase.irrelevant);

    // 真值引用不到实际文档 → 这条用例永远算 miss。必须报错而不是静默算 0。
    if (relevantMissing.length || irrelevantMissing.length) {
        throw new Error(
            `用例 ${theCase.id} 的真值引用在语料中不存在：` +
            `${[...relevantMissing, ...irrelevantMissing].join(', ')}。` +
            `这会让它永远算 miss —— 请对照 corpus-spec 修正 slug`
        );
    }

    let treatmentArm, controlArm;
    let pluginError = null;

    if (theCase.mode === 'lightmemo') {
        if (!runtime.lightMemoAvailable) {
            return { raw: { skipped: 'lightmemo-unavailable' }, scored: { status: 'skipped', skipReason: 'lightmemo-unavailable' } };
        }
        const args = materializeArgs(theCase.args, corpusManifest);
        treatmentArm = await runLightMemoArm({ runtime, args });
        pluginError = treatmentArm.pluginError;
    } else {
        treatmentArm = await runPlaceholderArm({
            runtime, placeholder: theCase.arms.treatment, query: theCase.query, history: theCase.history
        });
        if (theCase.arms.control) {
            controlArm = await runPlaceholderArm({
                runtime, placeholder: theCase.arms.control, query: theCase.query, history: theCase.history
            });
        }
    }

    if (treatmentArm.error) {
        return {
            raw: { error: treatmentArm.error, latencyMs: treatmentArm.latencyMs },
            scored: { status: 'error', error: treatmentArm.error, latencyMs: treatmentArm.latencyMs, relevantCount: relevant.length, irrelevantCount: irrelevant.length, degradations: {} }
        };
    }
    if (treatmentArm.observation?.integrity?.clean === false) {
        const first = treatmentArm.observation.integrity.errors[0] || {};
        return {
            raw: {
                error: first.error || 'retrieval integrity failure',
                reasonCode: first.reasonCode || 'retrieval-error',
                integrity: treatmentArm.observation.integrity,
                latencyMs: treatmentArm.latencyMs
            },
            scored: {
                status: 'error',
                error: first.error || 'retrieval integrity failure',
                reasonCode: first.reasonCode || 'retrieval-error',
                integrity: treatmentArm.observation.integrity,
                latencyMs: treatmentArm.latencyMs,
                relevantCount: relevant.length,
                irrelevantCount: irrelevant.length,
                degradations: {}
            }
        };
    }

    // 把结果路径归约成相对语料根的形式，才能与真值比对
    treatmentArm.observation.results = relativizeResults(treatmentArm.observation.results, resolved.corpusRoot);
    if (controlArm?.observation) {
        controlArm.observation.results = relativizeResults(controlArm.observation.results, resolved.corpusRoot);
    }

    const treatmentScore = metrics.scoreArm({
        observation: treatmentArm.observation, relevant, irrelevant, gate: treatmentArm.gate
    });
    const controlScore = controlArm?.observation
        ? metrics.scoreArm({ observation: controlArm.observation, relevant, irrelevant, gate: controlArm.gate })
        : null;
    const effect = controlScore ? metrics.scoreEffect(treatmentScore, controlScore, relevant) : null;

    // 特殊断言：LightMemo 的 plugin_error 与 A/B 报告
    const extraChecks = [];
    if (theCase.expect?.pluginError) {
        extraChecks.push({
            name: 'pluginError',
            ok: String(pluginError || '').includes(theCase.expect.pluginError),
            detail: `实际 plugin_error=${pluginError ?? 'null'}`
        });
    }
    if (theCase.expect?.abReport) {
        const text = treatmentArm.injectedContent || '';
        extraChecks.push({
            name: 'abReport',
            ok: text.includes('LightMemo 生产构型 A/B') && text.includes('重合'),
            detail: text.includes('LightMemo 生产构型 A/B') ? 'A/B 报告已生成' : '未生成 A/B 报告'
        });
    }

    const expectResult = metrics.checkExpectations({
        expect: theCase.expect,
        observation: treatmentArm.observation,
        effect,
        gate: treatmentArm.gate,
        artifactReady
    });
    const allChecks = [...expectResult.checks, ...extraChecks];

    return {
        raw: {
            query: theCase.query || theCase.args?.query,
            arms: {
                treatment: {
                    placeholder: theCase.arms?.treatment ?? null,
                    engine: treatmentArm.observation.engine,
                    flags: treatmentArm.observation.flags,
                    kActual: treatmentArm.observation.kActual,
                    tagWeight: treatmentArm.observation.tagWeight,
                    timeRanges: treatmentArm.observation.timeRanges,
                    bm25: treatmentArm.observation.bm25,
                    riverMemo: treatmentArm.observation.riverMemo,
                    tagStats: treatmentArm.observation.tagStats,
                    blocks: treatmentArm.observation.blocks,
                    directRecall: treatmentArm.observation.directRecall,
                    gate: treatmentArm.gate,
                    degradations: treatmentArm.observation.degradations,
                    positives: treatmentArm.observation.positives,
                    eventCounts: treatmentArm.observation.eventCounts,
                    ranked: treatmentScore.ranked,
                    topk: treatmentArm.observation.results.slice(0, 10).map(r => ({
                        docId: r.fullPath || r.sourceFile || null,
                        source: r.source ?? null,
                        score: r.score ?? null,
                        originalScore: r.originalScore ?? null,
                        matchedTags: r.matchedTags ?? null,
                        boostFactor: r.boostFactor ?? null,
                        text: String(r.text || '').slice(0, 300)
                    })),
                    injectedChars: treatmentArm.injectedChars
                },
                control: controlArm ? {
                    placeholder: theCase.arms?.control ?? null,
                    engine: controlArm.observation.engine,
                    kActual: controlArm.observation.kActual,
                    ranked: controlScore.ranked,
                    gate: controlArm.gate,
                    injectedChars: controlArm.injectedChars
                } : null
            },
            relevant, irrelevant, effect,
            pluginError
        },
        scored: {
            status: 'scored',
            relevantCount: relevant.length,
            irrelevantCount: irrelevant.length,
            treatment: treatmentScore,
            control: controlScore,
            effect,
            gate: treatmentArm.gate,
            expectedGate: theCase.gate || theCase.expect?.gate || null,
            engine: treatmentArm.observation.engine,
            kActual: treatmentArm.observation.kActual,
            latencyMs: treatmentArm.latencyMs + (controlArm?.latencyMs || 0),
            injectedChars: treatmentArm.injectedChars,
            fromCache: treatmentArm.observation.flags.fromCache,
            degradations: treatmentArm.observation.degradations,
            expectationChecks: allChecks,
            expectationsOk: allChecks.every(c => c.ok)
        }
    };
}

function truncatePayload(payload) {
    if (!payload) return payload;
    const out = { ...payload };
    if (typeof out.content === 'string') {
        out.contentChars = out.content.length;
        out.content = out.content.slice(0, 500);
    }
    return out;
}

function truncateResponse(res) {
    if (!res) return res;
    const out = JSON.parse(JSON.stringify(res));
    if (out.result?.notes) {
        out.result.noteCount = out.result.notes.length;
        out.result.notes = out.result.notes.slice(0, 5).map(n => ({
            name: n.name, folder_name: n.folder_name, score: n.score ?? null,
            matchCount: n.matches?.length ?? null
        }));
    }
    if (typeof out.result?.content === 'string') {
        out.result.contentChars = out.result.content.length;
        delete out.result.content;
    }
    return out;
}

module.exports = {
    readSuite,
    loadSuites,
    runSuite,
    runOneCase,
    runPlaceholderArm,
    runLightMemoArm,
    relativizeResults,
    parseLightMemoResults,
    materializeArgs
};
