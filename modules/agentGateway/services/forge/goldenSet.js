'use strict';

/**
 * Golden query 集与检索回归（设计 §2.3.5 / §3.2.3，M2.S2 T15）。
 *
 * - 直接消费 TDBKnowledgeManager.search() 的 sourceFile/chunkIndex/score/text；
 * - 排名评测显式 expand:false（非 Expand 前 500 字预览）；
 * - required 探针：expected sourceFile 必须命中 topK，requiredText 必须出现在
 *   命中 text 中；
 * - negative 探针：forbiddenSourceFiles 不得进入 topK（M2 记录、M3 隔离后
 *   strict 模式阻断——偏题文件还在活动库时不能把基线判死）；
 * - preview 探针：expand:false 命中文本不得含 sources 头（fetchedAt / 来源：）；
 * - 指标（Recall@K / MRR / nDCG@K / noise）只在与报告头记录的同一
 *   语料快照 + chunker + embedding + K/alpha/minScore 下比较。
 */

function codedError(code, message, detail = {}) {
    const error = new Error(message);
    error.code = code;
    Object.assign(error, detail);
    return error;
}

const QUERY_KINDS = new Set(['required', 'negative', 'preview', 'incremental']);

function validateGoldenQuery(entry, index) {
    const where = `golden[${index}]`;
    if (!entry || typeof entry !== 'object') throw codedError('FORGE_GOLDEN_INVALID', `${where} 不是对象`);
    for (const field of ['id', 'library', 'query', 'topK', 'kind']) {
        if (entry[field] === undefined || entry[field] === null || entry[field] === '') {
            throw codedError('FORGE_GOLDEN_INVALID', `${where} 缺 ${field}`);
        }
    }
    if (!QUERY_KINDS.has(entry.kind)) {
        throw codedError('FORGE_GOLDEN_INVALID', `${where} kind 必须为 ${[...QUERY_KINDS].join(' | ')}`);
    }
    if (entry.expand !== false) {
        throw codedError('FORGE_GOLDEN_INVALID', `${where} 排名评测必须显式 expand:false（§3.2.3）`);
    }
    if (!Number.isInteger(entry.topK) || entry.topK < 1 || entry.topK > 50) {
        throw codedError('FORGE_GOLDEN_INVALID', `${where} topK 必须为 1..50`);
    }
    if (entry.kind === 'required' || entry.kind === 'incremental') {
        if (!Array.isArray(entry.requiredSourceFiles) || entry.requiredSourceFiles.length === 0) {
            throw codedError('FORGE_GOLDEN_INVALID', `${where} ${entry.kind} 需要 requiredSourceFiles`);
        }
    }
    if (entry.kind === 'negative' && (!Array.isArray(entry.forbiddenSourceFiles) || entry.forbiddenSourceFiles.length === 0)) {
        throw codedError('FORGE_GOLDEN_INVALID', `${where} negative 需要 forbiddenSourceFiles`);
    }
    return true;
}

function loadGoldenSet(parsed) {
    if (!Array.isArray(parsed?.queries)) {
        throw codedError('FORGE_GOLDEN_INVALID', 'golden 集需要 { queries: [...] }');
    }
    parsed.queries.forEach(validateGoldenQuery);
    const ids = new Set(parsed.queries.map((q) => q.id));
    if (ids.size !== parsed.queries.length) {
        throw codedError('FORGE_GOLDEN_INVALID', 'golden id 重复');
    }
    return parsed.queries;
}

function dcgAtK(relevance) {
    return relevance.reduce((sum, rel, i) => sum + (rel > 0 ? Number(rel) / Math.log2(i + 2) : 0), 0);
}

function ndcgAtK(hits, relevantPaths, topK) {
    // 同一文件多 chunk 命中只计一次（按分数序去重），否则 nDCG 会无界超 1。
    const seen = new Set();
    const deduped = hits.slice(0, topK).filter((hit) => {
        if (seen.has(hit.sourceFile)) return false;
        seen.add(hit.sourceFile);
        return true;
    });
    const relevance = deduped.map((hit) => (relevantPaths.includes(hit.sourceFile) ? 1 : 0));
    const dcg = dcgAtK(relevance);
    const ideal = dcgAtK(new Array(Math.min(relevantPaths.length, topK)).fill(1));
    return ideal > 0 ? dcg / ideal : 0;
}

function textContainsRequired(hitTexts, requiredText) {
    const normalize = (s) => String(s || '').replace(/\s+/g, '');
    return hitTexts.some((text) => normalize(text).includes(normalize(requiredText)));
}

/**
 * 运行一个 golden 集。
 * @param manager TDBKnowledgeManager（须已 initialized）
 * @param queries 载入后的 golden queries
 * @param options { strictNegatives = false, timeoutMs }
 */
async function runGoldenSet(manager, queries, options = {}) {
    const strictNegatives = Boolean(options.strictNegatives);
    if (!manager.initialized) {
        throw codedError('FORGE_GOLDEN_STORE_NOT_READY', 'store 未初始化（fail closed：不冒充零命中）');
    }
    const results = [];
    for (const query of queries) {
        let error = null;
        let hits = [];
        try {
            hits = await manager.search(query.query, {
                libraries: [query.library],
                topK: query.topK,
                expand: false
            });
        } catch (e) {
            error = e; // 检索异常与真实零命中分开报告（§3.7 原则在探针层同样适用）
        }

        const entry = {
            id: query.id,
            kind: query.kind,
            library: query.library,
            query: query.query,
            hitCount: hits.length,
            topFiles: hits.slice(0, 5).map((hit) => ({ sourceFile: hit.sourceFile, score: Number(hit.score?.toFixed?.(4) ?? hit.score) })),
            requiredSourceFiles: Array.isArray(query.requiredSourceFiles) ? query.requiredSourceFiles : [],
            error: error ? `${error.code || 'ERROR'}: ${error.message}` : null,
            passed: false,
            verdict: null
        };

        if (error) {
            entry.verdict = 'search_error';
        } else if (query.kind === 'required' || query.kind === 'incremental') {
            const positions = query.requiredSourceFiles
                .map((required) => hits.findIndex((hit) => hit.sourceFile === required))
                .filter((pos) => pos >= 0);
            const allHit = positions.length === query.requiredSourceFiles.length;
            const textOk = !Array.isArray(query.requiredText) || query.requiredText.every((requiredText) => textContainsRequired(hits.map((hit) => hit.text), requiredText));
            entry.passed = allHit && textOk;
            entry.firstRequiredRank = positions.length ? Math.min(...positions) + 1 : null;
            entry.reciprocalRank = entry.firstRequiredRank ? 1 / entry.firstRequiredRank : 0;
            entry.ndcg = ndcgAtK(hits, query.requiredSourceFiles, query.topK);
            entry.verdict = entry.passed ? 'pass' : (allHit ? 'required_text_missing' : 'required_file_missed');
        } else if (query.kind === 'negative') {
            const leaked = hits.filter((hit) => query.forbiddenSourceFiles.includes(hit.sourceFile));
            entry.leakedFiles = leaked.map((hit) => hit.sourceFile);
            entry.passed = leaked.length === 0;
            entry.verdict = entry.passed ? 'pass' : 'negative_leak';
            if (!entry.passed && !strictNegatives) {
                entry.verdict = 'negative_leak_pending_quarantine'; // M3 隔离前仅记录
            }
        } else if (query.kind === 'preview') {
            const requiredFiles = query.requiredSourceFiles || [];
            const positions = requiredFiles.map((required) => hits.findIndex((hit) => hit.sourceFile === required)).filter((pos) => pos >= 0);
            const sourcesLeak = hits.some((hit) => /fetchedAt|>\s*来源[：:]/.test(String(hit.text || '')));
            entry.passed = positions.length === requiredFiles.length && requiredFiles.length > 0 && !sourcesLeak;
            entry.sourcesHeaderLeak = sourcesLeak;
            entry.verdict = entry.passed ? 'pass' : (sourcesLeak ? 'preview_contains_sources_header' : 'preview_target_missed');
        }

        if (query.kind === 'negative' && !entry.passed && !strictNegatives) {
            entry.passed = true; // 基线阶段不因未隔离的偏题文件判死；结果仍如实记录 leak
        }
        results.push(entry);
    }

    const rankable = results.filter((r) => r.kind === 'required' || r.kind === 'incremental');
    const mrr = rankable.length ? rankable.reduce((sum, r) => sum + (r.reciprocalRank || 0), 0) / rankable.length : null;
    const ndcg = rankable.length ? rankable.reduce((sum, r) => sum + (r.ndcg || 0), 0) / rankable.length : null;
    const noise = rankable.length
        ? rankable.reduce((sum, r) => {
            const noiseHits = r.topFiles.filter((hit) => !r.requiredSourceFiles.includes(hit.sourceFile)).length;
            return sum + noiseHits / Math.max(1, r.topFiles.length);
        }, 0) / rankable.length
        : null;
    const requiredPassed = results.filter((r) => (r.kind === 'required' || r.kind === 'incremental' || r.kind === 'preview') && r.passed).length;
    const requiredTotal = results.filter((r) => r.kind === 'required' || r.kind === 'incremental' || r.kind === 'preview').length;
    const blockingFailures = results.filter((r) => !r.passed || (r.kind === 'negative' && strictNegatives && r.verdict === 'negative_leak'));

    return {
        ok: blockingFailures.length === 0 && requiredPassed === requiredTotal,
        strictNegatives,
        summary: {
            total: results.length,
            requiredTotal,
            requiredPassed,
            negativeLeaks: results.filter((r) => r.verdict === 'negative_leak_pending_quarantine' || r.verdict === 'negative_leak').length,
            searchErrors: results.filter((r) => r.verdict === 'search_error').length,
            mrr: mrr != null ? Number(mrr.toFixed(4)) : null,
            ndcg: ndcg != null ? Number(ndcg.toFixed(4)) : null,
            noise: noise != null ? Number(noise.toFixed(4)) : null
        },
        provenance: {
            initializationState: manager.initializationState,
            storeManifestHash: manager.storeManifestHash || null,
            model: manager.config.model,
            dimension: manager.config.dimension,
            retrievedAt: new Date().toISOString(),
            expand: false,
            rankingDefaults: { managerTopKDefault: 10, hybridAlphaDefault: 0.7, minScoreDefault: 0.1, expandDepthDefault: 1 },
            note: '指标只在同一语料快照 + chunker/embedding/K/alpha/minScore 下比较（§3.2.3）；topK 逐探针显式指定（见每条 query 的 topK 字段），alpha/minScore/expandDepth 未覆写、用 manager 默认'
        },
        results
    };
}

module.exports = { loadGoldenSet, runGoldenSet, validateGoldenQuery, QUERY_KINDS, ndcgAtK };
