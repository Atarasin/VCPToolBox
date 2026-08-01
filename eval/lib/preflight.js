'use strict';

/**
 * 前置校验。
 *
 * 旧评估最危险的性质：**一次彻底失败也能产出一份格式完好的报告**。
 * 如果 embedding 调用失败，RAGDiaryPlugin 会把所有占位符剥成空串并提前返回，
 * 于是 40 条用例全部 gatePassed:false、recall 归零 —— 这与"候选方案质量下降"
 * 在报告里长得一模一样，没有任何字段能区分。
 *
 * 所以这里的规则是：**校验不通过就中止，不出报告**。
 * 并且"依赖缺失"必须标记为 SKIPPED 而不是 PASSED —— 一个静默 no-op 的 rerank
 * 用例"通过"了，比它明确失败要糟糕得多。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { PROJECT_ROOT } = require('./profile');

/**
 * 检查 embedding API 是否可达，以及返回的维度是否与 profile 一致。
 * 维度不匹配会让 searchService 打一行 'Dimension mismatch!' 然后返回 [] —— 表现为零结果。
 */
async function checkEmbedding(resolved) {
    const { apiUrl, apiKey, model, dimension } = resolved.embedding;
    if (!apiUrl || !apiKey) {
        return { ok: false, level: 'error', detail: 'API_URL / API_Key 缺失（在仓库根 config.env 中配置）' };
    }
    if (!model) {
        return { ok: false, level: 'error', detail: 'WhitelistEmbeddingModel 未配置' };
    }
    const url = `${apiUrl.replace(/\/+$/, '')}/v1/embeddings`;
    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({ model, input: ['评测连通性探针'] }),
            signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) {
            return { ok: false, level: 'error', detail: `HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
        }
        const json = await res.json();
        const vec = json?.data?.[0]?.embedding;
        if (!Array.isArray(vec)) {
            return { ok: false, level: 'error', detail: `响应中没有 embedding 数组：${JSON.stringify(json).slice(0, 200)}` };
        }
        const actualDim = vec.length;
        if (dimension && actualDim !== dimension) {
            return {
                ok: false, level: 'error',
                detail: `维度不匹配：profile 声明 ${dimension}，接口返回 ${actualDim}。` +
                        `不修正的话 search() 会打一行 Dimension mismatch 然后返回空数组，表现为"零结果"而非报错`
            };
        }
        return { ok: true, detail: `${model} @ ${actualDim} 维，${Date.now() - startedAt}ms`, dimension: actualDim };
    } catch (error) {
        return { ok: false, level: 'error', detail: `请求失败：${error.message}` };
    }
}

/**
 * Rerank 端点。未配置或不可达时 LightMemo/RAGDiaryPlugin 会静默退化成 slice(0, K)，
 * 只打一行 warn。所以必须显式探测，并让相关用例 SKIP。
 */
async function checkRerank(resolved) {
    const { url, api, model } = resolved.rerank;
    if (!url || !api || !model) {
        return { ok: false, level: 'warn', detail: 'RerankUrl / RerankApi / RerankModel 未全部配置：::Rerank 用例将 SKIP（不会伪装通过）' };
    }
    const endpoint = `${url.replace(/\/+$/, '')}/v1/rerank`;
    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api}` },
            body: JSON.stringify({ model, query: '限流治理', documents: ['入口配额与队列缓冲', '古城祭典巡游路线'], top_n: 2 }),
            signal: AbortSignal.timeout(20000)
        });
        const text = await res.text();
        if (!res.ok) {
            return { ok: false, level: 'warn', detail: `HTTP ${res.status}：${text.slice(0, 160)}；::Rerank 用例将 SKIP` };
        }
        if (!text.trim()) {
            return { ok: false, level: 'warn', detail: `${endpoint} 返回空响应（端点路径可能不对）；::Rerank 用例将 SKIP` };
        }
        let json;
        try { json = JSON.parse(text); } catch (_) {
            return { ok: false, level: 'warn', detail: `响应不是 JSON：${text.slice(0, 160)}；::Rerank 用例将 SKIP` };
        }
        const results = json.results || json.data;
        if (!Array.isArray(results)) {
            return { ok: false, level: 'warn', detail: `响应中没有 results 数组：${text.slice(0, 160)}；::Rerank 用例将 SKIP` };
        }
        return { ok: true, detail: `${model} 可用，返回 ${results.length} 条` };
    } catch (error) {
        return { ok: false, level: 'warn', detail: `请求失败：${error.message}；::Rerank 用例将 SKIP` };
    }
}

/** rust-vexus-lite 原生模块：缺失则 TagMemo/RiverMemo 直接抛 MEMO_NATIVE_ABI_UNAVAILABLE。 */
function checkNativeMemo() {
    try {
        const mod = require(path.join(PROJECT_ROOT, 'rust-vexus-lite'));
        const required = ['runMemoPipeline', 'rerankMemoDtsc', 'rerankRivermemoTopologyV3'];
        const Index = mod.VexusIndex || mod.default?.VexusIndex;
        const proto = Index?.prototype || {};
        const missing = required.filter(fn => typeof proto[fn] !== 'function');
        if (missing.length) {
            return {
                ok: false, level: 'error',
                detail: `rust-vexus-lite 缺少原生方法 ${missing.join(', ')}：TagMemo/RiverMemo 会抛 MEMO_NATIVE_ABI_UNAVAILABLE。需要重新编译 rust-vexus-lite`
            };
        }
        return { ok: true, detail: '原生 Memo ABI 完整（runMemoPipeline / rerankMemoDtsc / rerankRivermemoTopologyV3）' };
    } catch (error) {
        return { ok: false, level: 'error', detail: `无法加载 rust-vexus-lite：${error.message}` };
    }
}

/**
 * jieba 中文分词的原生绑定。
 *
 * 值得单独检查，因为它坏掉的方式极其隐蔽：
 *   - LightMemo 在 require 阶段就 `const { Jieba } = require('@node-rs/jieba')`，
 *     绑定缺失 → 整个插件初始化抛错 → 所有 LightMemo 用例被跳过
 *   - DirectDiaryTextProcessor 用它做 ::BM25 的查询分词，退化后 bm25MatchedCount 归零，
 *     而 useBM25 标志仍然是 true —— 看起来"BM25 开着但没召回"
 *
 * 平台专属包（如 @node-rs/jieba-linux-x64-gnu）是 optionalDependency，
 * 一次 `npm i <别的包>` 就可能把它当作多余依赖裁掉，而且不会有任何提示。
 */
function checkJieba() {
    try {
        const { Jieba } = require('@node-rs/jieba');
        const { dict } = require('@node-rs/jieba/dict');
        const tokens = Jieba.withDict(dict).cut('入口配额与队列缓冲');
        if (!Array.isArray(tokens) || tokens.length < 2) {
            return { ok: false, level: 'error', detail: `分词结果异常：${JSON.stringify(tokens)}` };
        }
        return { ok: true, detail: `@node-rs/jieba 可用（示例分词 ${tokens.length} 词）` };
    } catch (error) {
        return {
            ok: false, level: 'error',
            detail: `@node-rs/jieba 原生绑定加载失败：${String(error.message).split('\n')[0]}。` +
                    `后果是 LightMemo 全部用例被跳过、::BM25 的命中数静默归零。` +
                    `修复：npm i --no-save @node-rs/jieba-linux-x64-gnu（按本机平台替换后缀）`
        };
    }
}

/** better-sqlite3：向量库读写与真值核对都要它。 */
function checkSqlite() {
    try {
        require('better-sqlite3');
        return { ok: true, detail: 'better-sqlite3 可用' };
    } catch (error) {
        return { ok: false, level: 'error', detail: `better-sqlite3 不可用：${error.message}` };
    }
}

/**
 * DailyNoteSearcher 的可执行文件。
 * 仓库只提交了 Windows .exe 与 aarch64-musl 两个二进制，x86_64 Linux 上必须本机
 * cargo build。缺失时 BM25 相关用例只能走 JS 兜底或直接不可用。
 */
function checkDailyNoteSearcher() {
    const pluginDir = path.join(PROJECT_ROOT, 'Plugin', 'DailyNoteSearcher');
    const candidates = process.platform === 'win32'
        ? [
            path.join(pluginDir, 'DailyNoteSearcher.exe'),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher.exe')
        ]
        : [
            path.join(pluginDir, 'DailyNoteSearcher'),
            path.join(pluginDir, `DailyNoteSearcher-${process.arch === 'arm64' ? 'aarch64' : process.arch}-unknown-linux-musl`),
            path.join(pluginDir, 'src', 'target', 'release', 'DailyNoteSearcher')
        ];
    const found = candidates.find(p => fs.existsSync(p));
    if (found) {
        return { ok: true, detail: path.relative(PROJECT_ROOT, found) };
    }
    return {
        ok: false, level: 'warn',
        detail: `本平台（${process.platform}-${process.arch}）没有可用二进制。仓库只带了 .exe 与 aarch64-musl。` +
                `执行 \`cd Plugin/DailyNoteSearcher/src && cargo build --release\` 生成；` +
                `缺失时 DailyNoteSearcher 用例将 SKIP，::BM25 会走 JS 兜底实现`
    };
}

function coldCorpusFingerprint(resolved) {
    const root = resolved.coldKnowledge.rootPath;
    if (!fs.existsSync(root)) return null;
    const extensions = new Set(['.md', '.txt', '.json', '.html']);
    const excluded = new Set(['TDBdocs']);
    const rows = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!excluded.has(entry.name)) walk(absolute);
                continue;
            }
            if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            const contentHash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
            rows.push(`${relative}:${contentHash}`);
        }
    };
    walk(root);
    rows.sort();
    return rows.length
        ? `sha256:${crypto.createHash('sha256').update(rows.join('\n')).digest('hex')}`
        : null;
}

/** 冷知识库：triviumdb 缺失时 TDBKnowledge 静默 disabled，search() 返回 []。 */
function checkColdKB(resolved) {
    try {
        require('triviumdb');
    } catch (_) {
        return {
            ok: false, level: 'warn',
            detail: 'triviumdb 未安装（package.json 声明了 ^0.7.1，npm 上存在但 node_modules 里没有）。' +
                    'TDBKnowledge 会静默 disabled 并让 search() 返回空数组，因此 Tier4 冷知识库用例将 SKIP。' +
                    '需要时执行 `npm i triviumdb`'
        };
    }
    const knowledgeDir = resolved.coldKnowledge.rootPath;
    if (!fs.existsSync(knowledgeDir)) {
        return { ok: false, level: 'warn', detail: 'knowledge/ 目录不存在，Tier4 用例将 SKIP' };
    }
    const corpusFingerprint = coldCorpusFingerprint(resolved);
    if (!corpusFingerprint) {
        return { ok: false, level: 'warn', reasonCode: 'cold-kb-unavailable', detail: 'knowledge/ 没有可索引文件' };
    }
    return { ok: true, detail: 'triviumdb 已安装且 knowledge/ 存在可索引语料', corpusFingerprint };
}

function checkGateCalibration(resolved) {
    if (!resolved.gateCalibration.artifact) {
        return { ok: false, level: 'warn', reasonCode: 'gate-calibration-missing', detail: '当前 profile 没有 calibration artifact' };
    }
    if (resolved.gateCalibration.status === 'stale') {
        return { ok: false, level: 'warn', reasonCode: 'gate-calibration-stale', detail: 'calibration artifact 与 effective embedding identity 不一致' };
    }
    if (resolved.gateCalibration.status !== 'validated') {
        return { ok: false, level: 'warn', reasonCode: 'gate-calibration-stale', detail: `calibration 状态 ${resolved.gateCalibration.status} 不是 validated` };
    }
    return { ok: true, detail: `${resolved.gateCalibration.artifact.calibrationId || 'calibration'} 已验证` };
}

/** 语料是否已生成且通过不变量校验。 */
function checkCorpus(resolved) {
    const { verifyGenerated } = require('./corpusVerify');
    if (!fs.existsSync(resolved.corpusRoot)) {
        return { ok: false, level: 'error', detail: `语料未生成：先执行 \`vcp-eval corpus build\`` };
    }
    const result = verifyGenerated(resolved.corpusRoot);
    if (!result.ok) {
        const errs = result.findings.filter(f => f.level === 'error');
        return { ok: false, level: 'error', detail: `语料不变量校验失败（${errs.length} 项）：${errs.slice(0, 3).map(e => e.code).join(', ')}` };
    }
    return {
        ok: true,
        detail: `${result.stats.docs} 篇 / ${result.stats.uniqueTags} 个唯一 tag，锚点日 ${result.stats.anchorDate}`,
        stats: result.stats
    };
}

/** rag_params 里的死键 —— 不影响运行，但会误导调参，值得明确指出。 */
function checkRagParamsDeadKeys(resolved) {
    const notes = [];
    const kbm = resolved.ragParams?.KnowledgeBaseManager || {};
    if (kbm.riverMemo && kbm.riverMemo.enabled === false) {
        notes.push('riverMemo.enabled=false 是死键（没有任何代码读取它），RiverMemo 照常运行');
    }
    if (kbm.riverMemo?.dstc?.topologyV2RoleCaps) {
        notes.push('dstc.topologyV2RoleCaps / topologyV2RoleMultipliers 是装饰性的，实际值硬编码在 Rust 的 match 分支里');
    }
    return notes.length
        ? { ok: true, level: 'info', detail: notes.join('；') }
        : { ok: true, detail: '未发现已知死键' };
}

/**
 * 运行完整前置校验。
 * @returns {{ok:boolean, checks:object, capabilities:object}}
 */
async function run(resolved, options = {}) {
    const checks = {};

    checks.sqlite = checkSqlite();
    checks.jieba = checkJieba();
    checks.nativeMemo = checkNativeMemo();
    checks.corpus = checkCorpus(resolved);
    checks.ragParams = checkRagParamsDeadKeys(resolved);
    checks.dailyNoteSearcher = checkDailyNoteSearcher();
    checks.coldKB = checkColdKB(resolved);
    checks.gateCalibration = checkGateCalibration(resolved);

    if (options.skipNetwork) {
        checks.embedding = { ok: true, level: 'info', detail: '已跳过网络探测（--offline）' };
        checks.rerank = { ok: true, level: 'info', detail: '已跳过网络探测（--offline）' };
    } else {
        checks.embedding = await checkEmbedding(resolved);
        checks.rerank = await checkRerank(resolved);
    }

    // 能力可用性 —— 决定哪些用例 SKIP。SKIP ≠ PASS。
    const capabilities = {
        embedding: checks.embedding.ok,
        nativeMemo: checks.nativeMemo.ok,
        rerank: checks.rerank.ok,
        coldKB: checks.coldKB.ok,
        dailyNoteSearcher: checks.dailyNoteSearcher.ok
    };

    const blocking = Object.entries(checks).filter(([, c]) => !c.ok && c.level === 'error');

    return {
        ok: blocking.length === 0,
        blocking: blocking.map(([name, c]) => ({ name, detail: c.detail })),
        checks,
        capabilities,
        coldCorpusFingerprint: checks.coldKB.corpusFingerprint || coldCorpusFingerprint(resolved)
    };
}

module.exports = {
    run,
    checkJieba,
    checkEmbedding,
    checkRerank,
    checkNativeMemo,
    checkSqlite,
    checkColdKB,
    coldCorpusFingerprint,
    checkGateCalibration,
    checkCorpus,
    checkDailyNoteSearcher
};
