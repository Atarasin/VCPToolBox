#!/usr/bin/env node
/**
 * M2.S4 新旧引擎召回质量对比工具。
 *
 * 方法（双指标）：
 * 1. known-item retrieval——从真实日记文件中采样有信息量的子句作为 query，以来源文件为
 *    期望命中目标，统计 hit@k 与 MRR（偏严格：奖励精确命中，惩罚拓扑多样性扩散）。
 * 2. Jev 盲评——对每条 query，将 river / knn 两份 top-k 结果匿名（A/B 随机）交给共享
 *    JevClient 裁决哪份结果集更契合 query（人工抽查语义的自动化近似，允许平局）。
 *
 * 两种模式均跑网关共享检索主流程 collectRagItems（与 gateway_recall_run /
 * gateway_memory_search / gateway_context_assemble 同路径）。产出 JSON 与 Markdown 报告。
 *
 * 用法：
 *   node scripts/agent-gateway-river-comparison.js \
 *     --config /abs/config.env --dairynote-root /abs/dailynote \
 *     --vector-store /abs/VectorStore --out /abs/report.md \
 *     [--json /abs/results.json] [--k 5] [--no-judge]
 */

const fs = require('node:fs');
const path = require('node:path');

const MAIN_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
    const args = { k: 5, out: null, json: null, 'dairynote-root': null, 'vector-store': null, config: null, judge: true };
    for (let i = 2; i < argv.length; i += 2) {
        const key = argv[i] && argv[i].replace(/^--/, '');
        const value = argv[i + 1];
        if (key === 'k') args.k = Math.max(1, parseInt(value, 10) || 5);
        else if (key === 'out') args.out = value;
        else if (key === 'json') args.json = value;
        else if (key === 'dairynote-root') args['dairynote-root'] = value;
        else if (key === 'vector-store') args['vector-store'] = value;
        else if (key === 'config') args.config = value;
        else if (key === 'no-judge') { args.judge = false; i -= 1; }
    }
    return args;
}

const args = parseArgs(process.argv);

// 必须在 require KBM 单例之前设置：KBM 构造器读取 env 决定 root/store。
if (args['dairynote-root']) process.env.KNOWLEDGEBASE_ROOT_PATH = path.resolve(args['dairynote-root']);
if (args['vector-store']) process.env.KNOWLEDGEBASE_STORE_PATH = path.resolve(args['vector-store']);

require(path.join(MAIN_ROOT, 'modules/dotenvPatch.js'));
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(args.config || path.join(MAIN_ROOT, 'config.env')) });
// 对比工具按只读方式使用索引：禁用启动全扫与增量重嵌入，避免污染快照与抢占 embedding API
process.env.KNOWLEDGEBASE_FULL_SCAN_ON_STARTUP = 'false';

const knowledgeBaseManager = require(path.join(MAIN_ROOT, 'KnowledgeBaseManager.js'));
const embeddingUtils = require(path.join(MAIN_ROOT, 'EmbeddingUtils.js'));
const jevClient = require(path.join(MAIN_ROOT, 'modules/jevClient.js'));
const { createRagBindings } = require(path.join(MAIN_ROOT, 'modules/agentGateway/composition/vcpPortBindings.js'));
const { createRagRetrieverPort } = require(path.join(MAIN_ROOT, 'modules/agentGateway/ports/index.js'));
const { collectRagItems } = require(path.join(MAIN_ROOT, 'modules/agentGateway/core/recall/ragRetriever.js'));

// 三类角色场景（§2.2 消费者画像）：Midas 术语精确 / FuPeng 宏观观点 / Yui 长期记忆关联
const SCENARIOS = [
    {
        role: 'Midas（术语精确）',
        diaries: ['迈达斯', '迈达斯因子与策略库', '迈达斯量化工程', '迈达斯量化小论坛学习笔记'],
        samples: { '迈达斯因子与策略库': 8, '迈达斯量化工程': 8, '迈达斯量化小论坛学习笔记': 4 }
    },
    {
        role: 'FuPeng（宏观观点）',
        diaries: ['付鹏市场判断'],
        samples: { '付鹏市场判断': 8 }
    },
    {
        role: 'Yui（长期记忆关联）',
        diaries: ['阿里阿德涅', '阿里阿德涅的知识'],
        samples: { '阿里阿德涅': 7, '阿里阿德涅的知识': 4 }
    }
];

// 确定性采样，保证报告可复现
let seed = 20261009;
function seededRandom() {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
}

function buildQueries(dairyRoot) {
    const queries = [];
    for (const scenario of SCENARIOS) {
        for (const [diary, count] of Object.entries(scenario.samples)) {
            const dir = path.join(dairyRoot, diary);
            let files = [];
            try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort(); } catch (_e) { continue; }
            if (files.length === 0) continue;
            const picked = new Set();
            let attempts = 0;
            while (picked.size < Math.min(count, files.length) && attempts < 200) {
                attempts += 1;
                picked.add(files[Math.floor(seededRandom() * files.length)]);
            }
            for (const file of picked) {
                const query = extractQueryWorthyLine(path.join(dir, file));
                if (query) {
                    queries.push({ role: scenario.role, scenario: scenario.role, diaries: scenario.diaries, diary, file, query });
                }
            }
        }
    }
    return queries;
}

function extractQueryWorthyLine(filePath) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_e) { return null; }
    // 排除 Tag 头与格式行：它们靠标签精确匹配即可命中，对语义检索无区分度
    const rawLines = content.split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 12 && !/^(tag[:：]|#{1,6}\s|\[\d{4}-)/i.test(line));
    // 长段落拆子句（按。；分割），取 16~60 字的内容子句
    const candidates = [];
    for (const line of rawLines) {
        const segments = line.length > 60 ? line.split(/[。；;]/) : [line];
        for (const segment of segments) {
            const trimmed = segment.trim().replace(/^[-*>\d\.\s、]+/, '').trim();
            if (trimmed.length < 16 || trimmed.length > 60) continue;
            const cjk = (trimmed.match(/[\u4e00-\u9fa5]/g) || []).length;
            if (cjk >= 8) candidates.push(trimmed);
        }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(seededRandom() * candidates.length)];
}

async function runMode(mode, queryItem, k, port) {
    const previous = process.env.AGENT_GATEWAY_RECALL_MODE;
    try {
        if (mode === 'knn') process.env.AGENT_GATEWAY_RECALL_MODE = 'knn';
        else delete process.env.AGENT_GATEWAY_RECALL_MODE;
        const result = await collectRagItems({
            query: queryItem.query,
            requestedDiaries: queryItem.diaries,
            agentId: 'ComparisonRunner',
            ragOptions: { mode: 'rag', k, timeAware: false, groupAware: false, rerank: false, tagMemo: true },
            ragRetrieverPort: port,
            ragConfig: { allowCrossRoleAccess: true }
        });
        if (!result.success) throw new Error(result.error || 'retrieval failed');
        return result.items.map((item) => ({
            sourceFile: item.sourceFile || '',
            sourceDiary: item.sourceDiary || '',
            score: item.score,
            text: String(item.text || '').slice(0, 120)
        }));
    } finally {
        if (previous === undefined) delete process.env.AGENT_GATEWAY_RECALL_MODE;
        else process.env.AGENT_GATEWAY_RECALL_MODE = previous;
    }
}

function rankOf(items, expectedFile) {
    for (let i = 0; i < items.length; i += 1) {
        if (items[i].sourceFile === expectedFile) return i + 1;
    }
    return 0;
}

function aggregate(rows) {
    const hitAtK = rows.filter((r) => r.rank > 0).length;
    const mrr = rows.reduce((sum, r) => sum + (r.rank > 0 ? 1 / r.rank : 0), 0);
    return { hitAtK, total: rows.length, hitRate: rows.length ? hitAtK / rows.length : 0, mrr: rows.length ? mrr / rows.length : 0 };
}

function fmtPct(v) { return `${(v * 100).toFixed(1)}%`; }

const JUDGE_TIE_THRESHOLD = 0.15;

/**
 * 与 RAGDiaryPlugin._rerankDocumentsWithJev 同形的 Jev 重排（生产链路语义）：
 * 候选映射为 doc_NNN choice，probabilities 排序。两引擎同权使用。
 */
async function rerankWithJev(query, documents, topK) {
    const criteria = {};
    const documentByChoice = new Map();
    const maxDocumentChars = 1500;
    documents.forEach((document, index) => {
        const choiceId = `doc_${String(index).padStart(3, '0')}`;
        const text = String(document.text || '').trim();
        const boundedText = text.length > maxDocumentChars
            ? `${text.substring(0, maxDocumentChars)}…`
            : text;
        criteria[choiceId] = [
            `候选记忆 ${index + 1}`,
            document.sourceDiary ? `来源类型: ${document.sourceDiary}` : null,
            `内容:\n${boundedText}`
        ].filter(Boolean).join('\n');
        documentByChoice.set(choiceId, document);
    });
    const response = await jevClient.decide(
        { task: 'rag_memory_rerank', query: String(query || ''), candidate_count: documents.length },
        {
            best_memory: {
                type: 'choice',
                instructions: '请选择最值得用于回答当前查询的记忆。请从逻辑关联、记忆叙事连续性、信息解释力三个层面综合判断；优先保留能直接解释当前问题、补足关键背景或维持人物与事件连续性的内容，压低仅有表面词汇重合、重复、跑题或缺乏上下文价值的内容。',
                criteria
            }
        }
    );
    const answer = response?.answers?.best_memory;
    const probabilities = answer?.probabilities || {};
    return Array.from(documentByChoice.entries())
        .map(([choiceId, document], index) => ({
            ...document,
            rerank_score: Number(probabilities[choiceId]) || 0,
            _choiceId: choiceId,
            _stableIndex: index
        }))
        .sort((left, right) => (right.rerank_score - left.rerank_score)
            || (Number(answer?.choice === right._choiceId) - Number(answer?.choice === left._choiceId))
            || (left._stableIndex - right._stableIndex))
        .map((document) => { delete document._stableIndex; delete document._choiceId; return document; })
        .slice(0, topK);
}

function formatJudgeSet(items) {
    return items
        .map((item, index) => [
            `条目 ${index + 1}`,
            item.sourceDiary ? `日记: ${item.sourceDiary}` : null,
            `内容:\n${item.text}`
        ].filter(Boolean).join('\n'))
        .join('\n\n');
}

async function judgeQuery(query, riverItems, knnItems) {
    // A/B 盲评：随机（种子确定性）交换两侧，避免位置偏置
    const riverAsA = seededRandom() >= 0.5;
    const setA = riverAsA ? riverItems : knnItems;
    const setB = riverAsA ? knnItems : riverItems;
    const criteria = { setA: formatJudgeSet(setA), setB: formatJudgeSet(setB) };
    const response = await jevClient.decide(
        { task: 'rag_engine_comparison', query, candidate_count: 2 },
        {
            better_result_set: {
                type: 'choice',
                instructions: '给定同一查询的两个召回结果集（setA / setB），判断哪个结果集整体更能用于回答该查询：综合语义相关性、信息解释力与内容多样性；两者质量接近时选择你认为更契合的，系统会依据概率分布判定平局。',
                criteria
            }
        }
    );
    const answer = response?.answers?.better_result_set;
    const probabilities = answer?.probabilities || {};
    const pA = Number(probabilities.setA) || 0;
    const pB = Number(probabilities.setB) || 0;
    if (Math.abs(pA - pB) < JUDGE_TIE_THRESHOLD) {
        return { verdict: 'tie', pA, pB, riverAsA };
    }
    const winnerIsA = pA > pB;
    return {
        verdict: (winnerIsA === riverAsA) ? 'river' : 'knn',
        pA, pB, riverAsA
    };
}

function renderReport(perQuery, k, generatedAt, judgeEnabled) {
    const byScenario = new Map();
    for (const row of perQuery) {
        if (!byScenario.has(row.scenario)) byScenario.set(row.scenario, []);
        byScenario.get(row.scenario).push(row);
    }
    const lines = [];
    lines.push('# M2.S4 River / KNN 召回质量对比报告');
    lines.push('');
    lines.push(`> 生成时间：${generatedAt} | query：确定性随机种子（20261009）从真实日记采样内容子句 | k=${k} | 候选池=${Math.max(10, k * 2)} → ${judgeEnabled ? '同权 Jev 重排 → top-k（生产链路形态）' : '直接 top-k（rerank=off）'}`);
    lines.push('');
    const riverAll = aggregate(perQuery.map((r) => ({ rank: r.riverRank })));
    const knnAll = aggregate(perQuery.map((r) => ({ rank: r.knnRank })));
    const judged = judgeEnabled ? perQuery.filter((r) => r.judge) : [];
    const judgeRiver = judged.filter((r) => r.judge.verdict === 'river').length;
    const judgeKnn = judged.filter((r) => r.judge.verdict === 'knn').length;
    const judgeTie = judged.filter((r) => r.judge.verdict === 'tie').length;

    lines.push('## 总体结论');
    lines.push('');
    const riverNotWorse = judgeEnabled
        ? (judgeRiver + judgeTie) >= (judgeKnn + judgeTie) && (judgeRiver + judgeTie) >= judged.length * 0.5
        : riverAll.hitRate >= knnAll.hitRate && riverAll.mrr >= knnAll.mrr;
    lines.push(`- **river 不劣于 knn（裁决口径）：${riverNotWorse ? '✅ 是' : '❌ 否（详见分项）'}**`);
    lines.push(`- known-item（严格口径）：river hit@${k} = ${fmtPct(riverAll.hitRate)}（${riverAll.hitAtK}/${riverAll.total}），MRR = ${riverAll.mrr.toFixed(3)}；knn hit@${k} = ${fmtPct(knnAll.hitRate)}（${knnAll.hitAtK}/${knnAll.total}），MRR = ${knnAll.mrr.toFixed(3)}`);
    if (judgeEnabled && judged.length > 0) {
        lines.push(`- Jev 盲评（人工抽查近似口径）：river 胜 ${judgeRiver} / knn 胜 ${judgeKnn} / 平局 ${judgeTie}（共 ${judged.length}）`);
    }
    lines.push('');
    lines.push('## 分场景指标');
    lines.push('');
    lines.push(`| 场景 | 用例数 | river hit@${k} | knn hit@${k} | river MRR | knn MRR | 盲评 river胜/knn胜/平 |`);
    lines.push('|---|---|---|---|---|---|---|');
    for (const [scenario, rows] of byScenario) {
        const rv = aggregate(rows.map((r) => ({ rank: r.riverRank })));
        const kn = aggregate(rows.map((r) => ({ rank: r.knnRank })));
        const jr = rows.filter((r) => r.judge?.verdict === 'river').length;
        const jk = rows.filter((r) => r.judge?.verdict === 'knn').length;
        const jt = rows.filter((r) => r.judge?.verdict === 'tie').length;
        lines.push(`| ${scenario} | ${rows.length} | ${fmtPct(rv.hitRate)} | ${fmtPct(kn.hitRate)} | ${rv.mrr.toFixed(3)} | ${kn.mrr.toFixed(3)} | ${jr}/${jk}/${jt} |`);
    }
    lines.push('');
    lines.push(`## 明细（query → 两引擎首次命中排名，0=未命中${judgeEnabled ? '；盲评裁决' : ''}）`);
    lines.push('');
    lines.push(`| # | 场景 | 来源日记 | 期望文件 | query | river 排名 | knn 排名 |${judgeEnabled ? ' 盲评 |' : ''}`);
    lines.push(`|---|---|---|---|---|---|---|${judgeEnabled ? '---|' : ''}`);
    perQuery.forEach((row, index) => {
        const q = row.query.length > 42 ? `${row.query.slice(0, 42)}…` : row.query;
        const verdict = row.judge
            ? ({ river: 'river', knn: 'knn', tie: '平局' })[row.judge.verdict]
            : '-';
        lines.push(`| ${index + 1} | ${row.scenario} | ${row.diary} | ${row.file} | ${q.replace(/\|/g, '\\|')} | ${row.riverRank} | ${row.knnRank} |${judgeEnabled ? ` ${verdict} |` : ''}`);
    });
    lines.push('');
    lines.push('## 方法附注');
    lines.push('');
    lines.push('- 检索走网关共享主流程 collectRagItems（与 gateway_recall_run / gateway_memory_search / gateway_context_assemble 同路径），river 模式对整个 diary scope 一次 executeNativeRiverQuery，knn 模式逐日记本 searchDiary（1.33 融合系数）。');
    lines.push('- known-item 口径偏严格：奖励精确命中来源文件，惩罚 RiverMemo 拓扑多样性带来的近邻扩散（设计 §2.2 已将 Midas 术语精确收益预期映射到 M3.S3 BM25 混合检索）。');
    if (judgeEnabled) {
        lines.push('- Jev 盲评口径为「人工抽查」的自动化近似：两侧结果集匿名随机 A/B，裁决整体契合度，|pA−pB| < 0.15 记平局。');
    }
    lines.push('');
    return lines.join('\n');
}

async function main() {
    const dairyRoot = process.env.KNOWLEDGEBASE_ROOT_PATH;
    console.log(`[compare] diary root: ${dairyRoot}`);
    console.log('[compare] initializing KnowledgeBaseManager...');
    await knowledgeBaseManager.initialize();
    const bindings = createRagBindings(knowledgeBaseManager, null, embeddingUtils);
    const port = createRagRetrieverPort(bindings);
    console.log(`[compare] riverQuery available: ${port.capabilities().riverQuery}`);
    const judgeEnabled = args.judge && jevClient?.isConfigured?.() === true;
    console.log(`[compare] jev judge enabled: ${judgeEnabled}`);

    const queries = buildQueries(dairyRoot);
    console.log(`[compare] built ${queries.length} known-item queries`);
    if (queries.length < 20) {
        console.error('[compare] FATAL: fewer than 20 queries built; aborting');
        process.exit(1);
    }

    // 冷启动快照可能触发 post-startup 原生 Memo bootstrap；等待 river 查询就绪
    const probeScenario = queries[0];
    for (let attempt = 1; attempt <= 30; attempt += 1) {
        try {
            await runMode('river', probeScenario, 1, port);
            console.log(`[compare] river ready after ${attempt} probe attempt(s)`);
            break;
        } catch (error) {
            if (attempt === 30) throw error;
            process.stdout.write(`[compare] river not ready (attempt ${attempt}): ${error.message}\n`);
            await new Promise((resolve) => setTimeout(resolve, 10000));
        }
    }

    const perQuery = [];
    const poolSize = Math.max(10, args.k * 2);
    for (let i = 0; i < queries.length; i += 1) {
        const q = queries[i];
        process.stdout.write(`[compare] ${i + 1}/${queries.length} ${q.diary}/${q.file} ... `);
        // 生产链路形态：两引擎各取 poolSize 候选池 → 同权 Jev 重排 → top-k
        let riverItems = await runMode('river', q, poolSize, port);
        let knnItems = await runMode('knn', q, poolSize, port);
        const rawRiverRank = rankOf(riverItems, q.file);
        const rawKnnRank = rankOf(knnItems, q.file);
        let rerankApplied = false;
        if (judgeEnabled) {
            try {
                const rerankedRiver = await rerankWithJev(q.query, riverItems, args.k);
                const rerankedKnn = await rerankWithJev(q.query, knnItems, args.k);
                riverItems = rerankedRiver;
                knnItems = rerankedKnn;
                rerankApplied = true;
            } catch (error) {
                console.warn(`[compare] rerank failed for query ${i + 1}: ${error.message}; using raw order`);
            }
        }
        const row = {
            scenario: q.scenario, diary: q.diary, file: q.file, query: q.query,
            riverRank: rankOf(riverItems, q.file),
            knnRank: rankOf(knnItems, q.file),
            rawRiverRank, rawKnnRank, rerankApplied,
            riverTop: (riverItems[0] || {}).sourceFile || '',
            knnTop: (knnItems[0] || {}).sourceFile || '',
            riverCount: riverItems.length, knnCount: knnItems.length,
            riverItems, knnItems
        };
        if (judgeEnabled) {
            try {
                row.judge = await judgeQuery(q.query, riverItems, knnItems);
            } catch (error) {
                console.warn(`[compare] judge failed for query ${i + 1}: ${error.message}`);
            }
        }
        perQuery.push(row);
        console.log(`river=${row.riverRank} knn=${row.knnRank}${row.judge ? ` judge=${row.judge.verdict}` : ''}`);
    }

    const generatedAt = new Date().toISOString();
    const report = renderReport(perQuery, args.k, generatedAt, judgeEnabled);
    if (args.out) {
        fs.mkdirSync(path.dirname(args.out), { recursive: true });
        fs.writeFileSync(args.out, report, 'utf8');
        console.log(`[compare] report written: ${args.out}`);
    }
    if (args.json) {
        fs.mkdirSync(path.dirname(args.json), { recursive: true });
        fs.writeFileSync(args.json, JSON.stringify({ generatedAt, k: args.k, perQuery }, null, 2), 'utf8');
        console.log(`[compare] json written: ${args.json}`);
    }

    const riverAll = aggregate(perQuery.map((r) => ({ rank: r.riverRank })));
    const knnAll = aggregate(perQuery.map((r) => ({ rank: r.knnRank })));
    const riverRaw = aggregate(perQuery.map((r) => ({ rank: r.rawRiverRank })));
    const knnRaw = aggregate(perQuery.map((r) => ({ rank: r.rawKnnRank })));
    console.log(`[compare] SUMMARY ${judgeEnabled ? 'reranked' : 'raw'} known-item: river hit@${args.k}=${fmtPct(riverAll.hitRate)} mrr=${riverAll.mrr.toFixed(3)} | knn hit@${args.k}=${fmtPct(knnAll.hitRate)} mrr=${knnAll.mrr.toFixed(3)}`);
    if (judgeEnabled) {
        console.log(`[compare] SUMMARY raw(no-rerank) known-item: river hit@${args.k}=${fmtPct(riverRaw.hitRate)} mrr=${riverRaw.mrr.toFixed(3)} | knn hit@${args.k}=${fmtPct(knnRaw.hitRate)} mrr=${knnRaw.mrr.toFixed(3)}`);
    }
    if (judgeEnabled) {
        const judged = perQuery.filter((r) => r.judge);
        console.log(`[compare] SUMMARY judge: river=${judged.filter((r) => r.judge.verdict === 'river').length} knn=${judged.filter((r) => r.judge.verdict === 'knn').length} tie=${judged.filter((r) => r.judge.verdict === 'tie').length}`);
    }
}

main().then(async () => {
    await knowledgeBaseManager.shutdown?.();
    // KBM 的 watcher/定时器句柄不总是随 shutdown 释放；对比工具跑完即退
    process.exit(process.exitCode || 0);
}).catch(async (error) => {
    console.error('[compare] fatal:', error);
    try { await knowledgeBaseManager.shutdown?.(); } catch (_e) { /* shutdown best-effort */ }
    process.exit(1);
});
