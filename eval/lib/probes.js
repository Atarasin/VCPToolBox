'use strict';

/**
 * 可观测性探针。
 *
 * 旧评估最根本的问题不是指标算错，而是**它看不见系统到底做了什么**。它只拿到一段
 * 注入文本，然后用子串匹配去猜。于是「检索完全失败」和「检索成功但答案不对」
 * 长得一模一样；「TagMemo 生效了」和「TagMemo 静默退化成纯 KNN」也长得一模一样。
 *
 * 实际上 VCP 早就把需要的信号全都吐出来了，只是没人接：
 *
 *  1. pushVcpInfo 事件 `RAG_RETRIEVAL_DETAILS` —— 带 useTagMemo / useRiverMemo /
 *     useTime / useGroup / useBM25 / tagWeight / k / timeRanges / tagStats，
 *     以及每条结果的 source / fullPath / originalScore / matchedTags。
 *  2. 注入文本自带的 `<!-- VCP_RAG_BLOCK_START {json} -->` —— 里面就有
 *     engine: 'RiverMemo' | 'TagMemo' | 'KNN' 和实际生效的 k、modifiers。
 *  3. stdout 上的诊断标记 —— 其中 `🛡️ Fallback to original order` 是**该次查询
 *     静默退化成纯 KNN** 的唯一证据。不扫它，一次全线退化的运行会产出一份好看的报告。
 *
 * 本模块把这三路收拢成结构化观测。
 */

/** 出现即代表某个能力静默失效了。这些不是噪声，是必须计数的失败信号。 */
const DEGRADATION_MARKERS = [
    { key: 'geodesicFallback', marker: '🛡️ Fallback to original order', meaning: 'TagMemo DTSC 重排放弃，退化为原始 KNN 顺序' },
    { key: 'tagKnnFallback', marker: 'tag_knn_fallback', meaning: '绕过 EPA/金字塔的裸 tag KNN，不是真正的 TagMemo' },
    { key: 'rerankNotConfigured', marker: 'Rerank not configured', meaning: 'Rerank 未配置，静默变成 slice(0,K)' },
    { key: 'tagMemoCriticalFail', marker: 'TagMemo V6 CRITICAL FAIL', meaning: 'TagMemo 抛异常后回退到原向量' },
    { key: 'dimensionMismatch', marker: 'Dimension mismatch', meaning: '向量维度不匹配，search() 返回空数组' },
    { key: 'jsGraphRetired', marker: 'TAGMEMO_JS_GRAPH_RUNTIME_RETIRED', meaning: '调用了已退役的 JS 图运行时' },
    { key: 'placeholderNotFound', marker: '⚠️ Placeholder not found in content', meaning: '占位符替换失败' },
    { key: 'thresholdSkipped', marker: 'Skipping RAG', meaning: '相似度低于阈值，门控拦截' },
    { key: 'roleValveBlocked', marker: 'RoleValve blocked', meaning: 'RoleValve 门控拦截' },
    { key: 'evalPlaceholderMissing', marker: '未找到匹配的元逻辑模块', meaning: '元思考簇缺失，降级模式' }
];

/** 证明某能力确实跑到了的正向标记。 */
const POSITIVE_MARKERS = [
    { key: 'geodesicCurve', marker: 'GeodesicCurve] α=', meaning: 'DTSC 曲线读出成功完成' },
    { key: 'riverMemoRanked', marker: '🌊 RiverMemo:', meaning: 'RiverMemo Topology V3 完成排序' },
    { key: 'groupBlended', marker: '已将查询向量与', meaning: '语义组向量确实混入了查询向量' },
    { key: 'timeDecayApplied', marker: '⏳ TimeDecay', meaning: 'TimeDecay 生效' },
    { key: 'truncateApplied', marker: 'Truncate applied', meaning: '::Truncate 生效' },
    { key: 'expandApplied', marker: '🌟 Expand:', meaning: '::Expand 完成父文档展开' },
    { key: 'associateApplied', marker: '🌟 Associate:', meaning: '::Associate 完成共现召回' },
    { key: 'bm25Recall', marker: 'sparse recall:', meaning: 'BM25 稀疏召回生效' },
    { key: 'dedupStage', marker: '[ResultDeduplicator] stage=', meaning: '结果去重执行了语义阶段' },
    { key: 'fastPath', marker: '纯文本快速路径完成', meaning: '{{}} 纯文本路径生效（未走向量化）' }
];

/**
 * 收集器：捕获一次 processMessages 调用期间的所有观测。
 *
 * 注意事件桶必须**每条 case 换一个新数组**而不是清空同一个数组——旧 harness 就是
 * 复用同一个 currentEvents 绑定，导致 case N 的迟到异步事件落进 case N+1 的桶里。
 */
class ObservationCollector {
    constructor() {
        this.events = [];
        this.logLines = [];
        this._sealed = false;
    }

    /** 传给 ragPlugin.initialize 的 vcpLogFunctions.pushVcpInfo。 */
    push(payload) {
        if (this._sealed) return; // 迟到的异步事件不允许污染下一条 case
        try {
            this.events.push(JSON.parse(JSON.stringify(payload)));
        } catch (_) {
            this.events.push(payload);
        }
    }

    appendLog(text) {
        if (this._sealed) return;
        for (const line of String(text).split('\n')) {
            if (line.trim()) this.logLines.push(line);
        }
    }

    seal() {
        this._sealed = true;
        return this;
    }

    get log() {
        return this.logLines.join('\n');
    }
}

/**
 * 劫持 console 与 stdout/stderr.write，把日志导到当前 collector 和一个总日志文件。
 * RAGDiaryPlugin / KnowledgeBaseManager 的诊断信息全走 console，没有别的出口。
 */
function installLogCapture(sink) {
    const original = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
        stdout: process.stdout.write.bind(process.stdout),
        stderr: process.stderr.write.bind(process.stderr)
    };

    const format = args => args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    }).join(' ');

    const relay = (...args) => sink(format(args));

    console.log = relay;
    console.warn = relay;
    console.error = relay;
    console.info = relay;
    process.stdout.write = chunk => { sink(String(chunk)); return true; };
    process.stderr.write = chunk => { sink(String(chunk)); return true; };

    return function restore() {
        console.log = original.log;
        console.warn = original.warn;
        console.error = original.error;
        console.info = original.info;
        process.stdout.write = original.stdout;
        process.stderr.write = original.stderr;
    };
}

/**
 * 从注入文本里解析 VCP_RAG_BLOCK 的自描述元数据。
 * 这是最可靠的引擎归因来源：它就是 RAGResultFormatter 在渲染时写下的事实。
 */
function parseRagBlocks(content) {
    const blocks = [];
    const re = /<!--\s*VCP_RAG_BLOCK_START\s*(\{[\s\S]*?\})\s*-->/g;
    let m;
    while ((m = re.exec(String(content || '')))) {
        try {
            blocks.push(JSON.parse(m[1]));
        } catch (_) {
            blocks.push({ _parseError: m[1].slice(0, 200) });
        }
    }
    return blocks;
}

/** 收集所有带 results 的检索详情事件。旧 harness 只取最后一个，多占位符时会丢数据。 */
function retrievalEvents(events) {
    return events.filter(e => e && e.type === 'RAG_RETRIEVAL_DETAILS' && Array.isArray(e.results));
}

/** 降级变体：没有 results 字段，只有 error。旧 harness 静默跳过，我们必须计数。 */
function retrievalErrorEvents(events) {
    return events.filter(e => e && e.type === 'RAG_RETRIEVAL_DETAILS' && !Array.isArray(e.results));
}

function directRecallEvents(events) {
    return events.filter(e => e && e.type === 'DailyNote');
}

function scanMarkers(logText, table) {
    const found = {};
    for (const { key, marker, meaning } of table) {
        // 用 split 计数而不是正则，避免 emoji / 特殊字符转义问题
        const count = logText.split(marker).length - 1;
        if (count > 0) found[key] = { count, marker, meaning };
    }
    return found;
}

/**
 * 把一次调用的原始观测归约成结构化事实。
 *
 * @param {object} params
 * @param {ObservationCollector} params.collector
 * @param {string} params.injectedContent  处理后 system 消息的内容
 */
function summarize(params) {
    const { collector, injectedContent } = params;
    const events = collector.events;
    const logText = collector.log;

    const details = retrievalEvents(events);
    const errors = retrievalErrorEvents(events);
    const direct = directRecallEvents(events);
    const blocks = parseRagBlocks(injectedContent);

    // 多占位符时把所有事件的结果按顺序拼起来，而不是只留最后一个
    const merged = [];
    for (const ev of details) {
        for (const r of ev.results) merged.push({ ...r, _dbName: ev.dbName });
    }

    // 引擎归因需要双确认：block 里的 engine 字段 + 事件里的 flag。
    // 只信一个的话，占位符解析失败时 block 缺失而 flag 也不会有，会误判成 KNN。
    const flags = {
        useTagMemo: details.some(e => e.useTagMemo === true),
        useRiverMemo: details.some(e => e.useRiverMemo === true),
        useGeodesicRerank: details.some(e => e.useGeodesicRerank === true),
        useTime: details.some(e => e.useTime === true),
        useGroup: details.some(e => e.useGroup === true),
        useBM25: details.some(e => e.useBM25 === true),
        useRerank: details.some(e => e.useRerank === true),
        useRerankPlus: details.some(e => e.useRerankPlus === true),
        useExpand: details.some(e => e.useExpand === true),
        useAssociate: details.some(e => e.useAssociate === true),
        virtualIndex: details.some(e => e.virtualIndex === true),
        fromCache: details.some(e => e.fromCache === true)
    };

    const enginesFromBlocks = [...new Set(blocks.map(b => b.engine).filter(Boolean))];
    const engine = enginesFromBlocks.length === 1
        ? enginesFromBlocks[0]
        : (flags.useRiverMemo ? 'RiverMemo' : flags.useTagMemo ? 'TagMemo' : enginesFromBlocks[0] || null);

    return {
        engine,
        enginesFromBlocks,
        flags,
        // 实际生效的 K。旧评估硬编码 5，而 VCP 的 K 是动态的 clamp(3,10) 再乘倍率，
        // 于是 precision@5 会惩罚"正确地只返回 3 条"。
        kActual: details.length ? (details[details.length - 1].k ?? null) : null,
        kPerPlaceholder: details.map(e => e.k ?? null),
        tagWeight: details.length ? (details[details.length - 1].tagWeight ?? null) : null,
        coreTags: details.flatMap(e => e.coreTags || []),
        timeRatio: details.length ? (details[details.length - 1].timeRatio ?? null) : null,
        timeRanges: details.flatMap(e => e.timeRanges || []),
        tagStats: details.map(e => e.tagStats).filter(Boolean),
        bm25: {
            mode: details.map(e => e.bm25Mode).find(Boolean) || null,
            matchedCount: details.reduce((s, e) => s + (e.bm25MatchedCount || 0), 0),
            queryTokens: details.flatMap(e => e.bm25QueryTokens || [])
        },
        riverMemo: details.map(e => e.riverMemo).find(Boolean) || null,
        blocks,
        results: merged,
        directRecall: direct.map(e => ({ action: e.action, dbName: e.dbName, message: e.message })),
        eventCounts: {
            retrievalDetails: details.length,
            retrievalErrors: errors.length,
            dailyNote: direct.length,
            total: events.length
        },
        retrievalErrors: errors.map(e => ({ dbName: e.dbName, error: e.error })),
        degradations: scanMarkers(logText, DEGRADATION_MARKERS),
        positives: scanMarkers(logText, POSITIVE_MARKERS),
        // 命中零结果的哨兵串。旧评估把这些算作 gatePassed=true，等于把失败记成成功。
        emptySentinels: countEmptySentinels(injectedContent)
    };
}

const EMPTY_SENTINELS = [
    '没有找到直接相关的记忆片段。',
    '共找到 0 条不重复记忆',
    '[未激活特定语义组]',
    '[检测到循环引用',
    '[无法读取'
];

function countEmptySentinels(content) {
    const text = String(content || '');
    const hits = {};
    for (const s of EMPTY_SENTINELS) {
        const c = text.split(s).length - 1;
        if (c > 0) hits[s] = c;
    }
    return hits;
}

/**
 * 三态门控判定，替代旧的 `content.trim().length > 0`。
 *
 * 旧判定完全没有信息量：RAGDiaryPlugin 即使 0 命中也会输出 VCP_RAG_BLOCK 包裹，
 * 所以 40/40 用例全是 true。真正需要区分的是四种状态：
 *   blocked        —— 门控确实拦下了（相似度低于阈值 / RoleValve）
 *   passed_empty   —— 门控放行但检索到 0 条
 *   passed         —— 门控放行且有结果
 *   not_recognized —— 占位符没被识别（modifiers 拼错），原文被回显
 */
function classifyGate(params) {
    const { injectedContent, observation, placeholder } = params;
    const content = String(injectedContent || '');

    // 占位符原文还在 → 根本没被解析。旧 harness 会把它当 gatePassed=true 并把
    // 占位符自身当成 topk[0]。
    if (placeholder && content.includes(placeholder)) {
        return { decision: 'not_recognized', reason: '占位符原文仍在输出中，未被解析' };
    }

    const blockedByThreshold = observation.degradations.thresholdSkipped;
    const blockedByValve = observation.degradations.roleValveBlocked;
    if (blockedByThreshold || blockedByValve) {
        return {
            decision: 'blocked',
            reason: blockedByValve ? 'RoleValve 拦截' : '相似度低于阈值',
            similarity: extractSimilarity(observation.log || '')
        };
    }

    const hasResults = observation.results.length > 0
        || observation.directRecall.length > 0
        || observation.blocks.length > 0;
    const hasEmptySentinel = Object.keys(observation.emptySentinels).length > 0;

    if (!content.trim()) {
        return { decision: 'blocked', reason: '输出为空（门控拒绝或 embedding 失败）' };
    }
    if (hasEmptySentinel && observation.results.length === 0) {
        return { decision: 'passed_empty', reason: '门控放行但检索到 0 条' };
    }
    if (!hasResults) {
        return { decision: 'passed_empty', reason: '无可识别的检索结果' };
    }
    return { decision: 'passed', reason: null };
}

/** 从 "similarity (0.4123) below threshold (0.35)" 这类日志里抠出数字。 */
function extractSimilarity(logText) {
    const m = /similarity\s*\(([\d.]+)\)\s*below threshold\s*\(([\d.]+)\)/i.exec(logText);
    if (!m) return null;
    return { similarity: Number(m[1]), threshold: Number(m[2]) };
}

module.exports = {
    ObservationCollector,
    installLogCapture,
    parseRagBlocks,
    retrievalEvents,
    retrievalErrorEvents,
    summarize,
    classifyGate,
    scanMarkers,
    DEGRADATION_MARKERS,
    POSITIVE_MARKERS
};
