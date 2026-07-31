'use strict';

/**
 * 指标计算。
 *
 * 与旧实现的四处实质差异：
 *
 * 1. 真值按**文档路径**判定，不再用子串匹配。
 *    旧做法拿 gold_snippets 去 String.includes 拼接后的 chunk 文本，五种脆法叠在一起：
 *    Tag 行本身也在被匹配的文本里（于是 tag 词汇能满足正文金标）；没有归一化（一个全角
 *    字符就让整条用例归零）；不看命中位置（在 2000 字整库转储里命中和精确 chunk 命中同分）；
 *    两个金标是 OR 而非 AND（部分证据拿满分）；连 "[EVAL_ERROR]" 都能被当成正常文本匹配。
 *    现在用 fullPath / sourceFile 做文档级判定，子串证据降级为辅助信号。
 *
 * 2. 深度不再硬编码 5。
 *    被测系统的 K 是 clamp(k_base + adjustment, 3, 10) 再乘倍率，也就是说 precision@5
 *    会惩罚"正确地只返回 3 条"（3/3 相关 → 0.6），同时无视第 6-10 位。而旧实现里
 *    noiseRate 扫全部 10 条、recall/precision 只看 5 条 —— 同一次运行用两个深度评判。
 *    现在在 {1,3,5,10} 与实际 K 上都出指标，深度可配。
 *
 * 3. 检索指标只在**门控放行**的用例上计算。
 *    旧数据集里 4 条 gate_expect:false 的用例同时带 gold_snippets，于是门控**正确拦截**时
 *    反而扣 Recall/MRR —— 系统做对了却被罚分。
 *
 * 4. 新增能力效应指标（treatment vs control）。
 *    这是回答"这个能力到底有没有用"的唯一办法：同语料、同查询、只差一个修饰符，
 *    比较金标排名位移、Top-K 重合、Kendall τ。旧评估完全没有对照臂，
 *    所谓"提升"其实只是两个 arm 用了不同的测量仪器。
 */

const DEFAULT_CUTOFFS = [1, 3, 5, 10];

/** 把检索结果里的一条归约成可比对的文档 id。 */
function docIdOf(result) {
    // fullPath 是相对语料根的路径，形如 "RAG评测主库/2026-07-27-...-限流治理.txt"
    if (result.fullPath) return normalizeDocId(result.fullPath);
    if (result.sourceFile) return normalizeDocId(result.sourceFile);
    return null;
}

function normalizeDocId(p) {
    return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * 用例声明的 relevant/irrelevant 是 "书名/slug" 形式（不含日期，因为日期是生成期决定的）。
 * 这里把它解析成实际文档 id 的匹配器。
 */
function makeDocMatcher(corpusManifest) {
    const bySlug = new Map();   // "RAG评测主库/限流治理" -> "RAG评测主库/2026-...-限流治理.txt"
    for (const entry of corpusManifest?.files || []) {
        const id = normalizeDocId(entry.id);
        const folder = id.split('/')[0];
        bySlug.set(`${folder}/${entry.slug}`, id);
        bySlug.set(entry.slug, id);
    }
    return {
        resolve(ref) {
            const key = normalizeDocId(ref);
            return bySlug.get(key) || bySlug.get(key.split('/').pop()) || null;
        },
        /** 用例引用的文档必须真的存在，否则这条用例永远算 miss 而不报错。 */
        resolveAll(refs) {
            const resolved = [];
            const missing = [];
            for (const ref of refs || []) {
                const id = this.resolve(ref);
                if (id) resolved.push(id); else missing.push(ref);
            }
            return { resolved, missing };
        }
    };
}

/** 结果数组 → 去重后的有序文档 id 列表（同一文档的多个 chunk 折叠为首次出现的位次）。 */
function rankedDocIds(results) {
    const seen = new Set();
    const out = [];
    for (const r of results || []) {
        const id = docIdOf(r);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

function recallAt(ranked, relevant, k) {
    if (!relevant.length) return null;
    const top = new Set(ranked.slice(0, k));
    const hit = relevant.filter(id => top.has(id)).length;
    return hit / relevant.length;
}

function precisionAt(ranked, relevant, k) {
    if (k <= 0) return null;
    const top = ranked.slice(0, k);
    if (!top.length) return 0;
    const rel = new Set(relevant);
    // 分母用实际返回条数而不是 k：否则"正确地只返回 3 条且全对"会被算成 0.6
    return top.filter(id => rel.has(id)).length / top.length;
}

function firstRelevantRank(ranked, relevant) {
    const rel = new Set(relevant);
    for (let i = 0; i < ranked.length; i++) {
        if (rel.has(ranked[i])) return i + 1;
    }
    return 0;
}

/** MRR 与 recall 必须用同一个深度，否则会出现 hit@5=false 而 mrr>0 的自相矛盾。 */
function reciprocalRankAt(ranked, relevant, k) {
    const rank = firstRelevantRank(ranked.slice(0, k), relevant);
    return rank > 0 ? 1 / rank : 0;
}

function ndcgAt(ranked, relevant, k) {
    if (!relevant.length) return null;
    const rel = new Set(relevant);
    let dcg = 0;
    ranked.slice(0, k).forEach((id, i) => {
        if (rel.has(id)) dcg += 1 / Math.log2(i + 2);
    });
    let idcg = 0;
    for (let i = 0; i < Math.min(relevant.length, k); i++) {
        idcg += 1 / Math.log2(i + 2);
    }
    return idcg > 0 ? dcg / idcg : null;
}

/** 噪声率：硬负例是否混进了前 k。与 recall 用同一深度。 */
function noiseAt(ranked, irrelevant, k) {
    if (!irrelevant.length) return null;
    const top = new Set(ranked.slice(0, k));
    return irrelevant.some(id => top.has(id)) ? 1 : 0;
}

/** Kendall τ-b：衡量两个排序的一致程度。用于"这个修饰符到底改没改顺序"。 */
function kendallTau(a, b) {
    const common = a.filter(x => b.includes(x));
    if (common.length < 2) return null;
    const posA = new Map(common.map(x => [x, a.indexOf(x)]));
    const posB = new Map(common.map(x => [x, b.indexOf(x)]));
    let concordant = 0, discordant = 0;
    for (let i = 0; i < common.length; i++) {
        for (let j = i + 1; j < common.length; j++) {
            const x = common[i], y = common[j];
            const sa = Math.sign(posA.get(x) - posA.get(y));
            const sb = Math.sign(posB.get(x) - posB.get(y));
            if (sa === sb) concordant++; else discordant++;
        }
    }
    const total = concordant + discordant;
    return total ? (concordant - discordant) / total : null;
}

function overlapAt(a, b, k) {
    const sa = new Set(a.slice(0, k));
    return b.slice(0, k).filter(x => sa.has(x)).length;
}

/**
 * 单臂打分。
 */
function scoreArm(params) {
    const { observation, relevant, irrelevant, cutoffs = DEFAULT_CUTOFFS, gate } = params;
    const ranked = rankedDocIds(observation.results);

    const kActual = Number.isFinite(observation.kActual) ? observation.kActual : ranked.length;
    const depths = [...new Set([...cutoffs, kActual].filter(k => k > 0))].sort((a, b) => a - b);

    const at = {};
    for (const k of depths) {
        at[k] = {
            recall: recallAt(ranked, relevant, k),
            precision: precisionAt(ranked, relevant, k),
            ndcg: ndcgAt(ranked, relevant, k),
            rr: reciprocalRankAt(ranked, relevant, k),
            noise: noiseAt(ranked, irrelevant, k)
        };
    }

    return {
        ranked,
        returned: ranked.length,
        chunksReturned: (observation.results || []).length,
        kActual,
        goldRank: firstRelevantRank(ranked, relevant),
        at,
        // 检索指标是否可信：门控没放行时它们没有意义
        scorable: !gate || gate.decision === 'passed'
    };
}

/**
 * 能力效应：treatment 相对 control 的变化。
 * 这才是"某能力确实改变了排序"的证据，单臂指标做不到。
 */
function scoreEffect(treatment, control, relevant, k = 10) {
    if (!treatment || !control) return null;
    const tRanked = treatment.ranked;
    const cRanked = control.ranked;

    const tGold = treatment.goldRank;
    const cGold = control.goldRank;

    // 金标排名提升多少位。两边都没命中则为 null（无从比较）。
    let goldRankGain = null;
    if (tGold > 0 && cGold > 0) goldRankGain = cGold - tGold;
    else if (tGold > 0 && cGold === 0) goldRankGain = Infinity;  // control 完全没捞到
    else if (tGold === 0 && cGold > 0) goldRankGain = -Infinity;

    const pick = (arm, key) => {
        const depth = Object.keys(arm.at).map(Number).filter(d => d <= k).sort((a, b) => b - a)[0];
        return depth ? arm.at[depth][key] : null;
    };

    return {
        goldRankGain: goldRankGain === Infinity ? 'control_missed'
            : goldRankGain === -Infinity ? 'treatment_missed'
            : goldRankGain,
        treatmentGoldRank: tGold,
        controlGoldRank: cGold,
        topKOverlap: overlapAt(tRanked, cRanked, k),
        rankingChanged: JSON.stringify(tRanked.slice(0, k)) !== JSON.stringify(cRanked.slice(0, k)),
        kendallTau: kendallTau(tRanked.slice(0, k), cRanked.slice(0, k)),
        ndcgDelta: safeDelta(pick(treatment, 'ndcg'), pick(control, 'ndcg')),
        recallDelta: safeDelta(pick(treatment, 'recall'), pick(control, 'recall')),
        noiseDelta: safeDelta(pick(treatment, 'noise'), pick(control, 'noise'))
    };
}

function safeDelta(a, b) {
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a - b;
}

/**
 * 校验用例的 expect 断言。
 * 每一项都对应一个已验证的静默失效模式 —— 断言不通过意味着"能力没生效"，
 * 而这在旧评估里会被记成一次普通的检索失败。
 */
function checkExpectations(params) {
    const { expect, observation, effect, gate, artifactReady } = params;
    const checks = [];

    const add = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail ?? null });

    if (!expect) return { checks, ok: true };

    // 引擎归因
    if (expect.engine) {
        add('engine', observation.engine === expect.engine,
            `期望 ${expect.engine}，实际 ${observation.engine ?? 'null'}`);
    }

    // 事件 flag
    for (const [flag, want] of Object.entries(expect.flags || {})) {
        add(`flag:${flag}`, observation.flags[flag] === want,
            `期望 ${want}，实际 ${observation.flags[flag]}`);
    }

    if (Number.isFinite(expect.minResults)) {
        add('minResults', observation.results.length >= expect.minResults,
            `期望 ≥${expect.minResults}，实际 ${observation.results.length}`);
    }

    // 门控三态
    if (expect.gate) {
        add('gate', gate?.decision === expect.gate,
            `期望 ${expect.gate}，实际 ${gate?.decision}（${gate?.reason ?? '-'}）`);
    }

    // 能力效应
    if (expect.effect) {
        const e = expect.effect;
        if (e.rankingChanged !== undefined) {
            add('effect:rankingChanged', effect?.rankingChanged === e.rankingChanged,
                `期望 ${e.rankingChanged}，实际 ${effect?.rankingChanged}`);
        }
        if (Number.isFinite(e.minGoldRankGain)) {
            const gain = effect?.goldRankGain;
            const ok = gain === 'control_missed' || (Number.isFinite(gain) && gain >= e.minGoldRankGain);
            add('effect:goldRankGain', ok, `期望 ≥${e.minGoldRankGain}，实际 ${gain}`);
        }
        if (Number.isFinite(e.maxTopKOverlap)) {
            add('effect:topKOverlap', (effect?.topKOverlap ?? Infinity) <= e.maxTopKOverlap,
                `期望 ≤${e.maxTopKOverlap}，实际 ${effect?.topKOverlap}`);
        }
    }

    // 时间路径：必须真的解析出了时间范围，否则 ::Time 与不加它字节一致
    if (expect.timeRangesParsed) {
        add('timeRangesParsed', observation.timeRanges.length > 0,
            `解析出 ${observation.timeRanges.length} 个时间范围`);
    }

    // BM25：必须真的命中，否则会静默兜底到 ::LastN
    if (Number.isFinite(expect.minBm25Matched)) {
        add('bm25Matched', observation.bm25.matchedCount >= expect.minBm25Matched,
            `期望 ≥${expect.minBm25Matched}，实际 ${observation.bm25.matchedCount}`);
    }

    // {{}} 纯文本路径的动作类型
    if (expect.directRecallAction) {
        const actions = observation.directRecall.map(d => d.action);
        add('directRecallAction', actions.includes(expect.directRecallAction),
            `期望包含 ${expect.directRecallAction}，实际 ${JSON.stringify(actions)}`);
    }

    // 语义组必须真的混入了向量，而不只是"没报错"
    if (expect.groupBlended !== undefined) {
        const blended = Boolean(observation.positives.groupBlended);
        add('groupBlended', blended === expect.groupBlended,
            `期望 ${expect.groupBlended}，实际 ${blended}`);
    }

    // 完整性：任何静默降级都算这条用例不可信
    if (expect.noDegradation !== false) {
        const keys = Object.keys(observation.degradations)
            // 门控拦截与 RoleValve 拦截是被期望的行为，不算降级
            .filter(k => k !== 'thresholdSkipped' && k !== 'roleValveBlocked');
        add('noSilentDegradation', keys.length === 0,
            keys.length ? `检测到静默降级：${keys.join(', ')}` : '无');
    }

    if (expect.requiresArtifact) {
        add('artifactReady', artifactReady === true,
            artifactReady ? 'artifact 就绪' : 'TagMemo artifact 未就绪，本条结果不可信');
    }

    return { checks, ok: checks.every(c => c.ok) };
}

/**
 * 汇总。按 tier / family / capability 分桶 —— 旧报告有 category 字段却从不分桶，
 * 这是最便宜也最有用的一项改进。
 */
function aggregate(perCase) {
    const scored = perCase.filter(c => c.status === 'scored');
    const skipped = perCase.filter(c => c.status === 'skipped');
    const errored = perCase.filter(c => c.status === 'error');

    // 检索指标只在门控放行的用例上算
    const retrievalCases = scored.filter(c => c.treatment?.scorable && c.relevantCount > 0);

    const mean = (rows, fn) => {
        const vals = rows.map(fn).filter(v => Number.isFinite(v));
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const atDepth = k => ({
        recall: mean(retrievalCases, c => c.treatment.at[k]?.recall),
        precision: mean(retrievalCases, c => c.treatment.at[k]?.precision),
        ndcg: mean(retrievalCases, c => c.treatment.at[k]?.ndcg),
        mrr: mean(retrievalCases, c => c.treatment.at[k]?.rr),
        noise: mean(retrievalCases.filter(c => c.irrelevantCount > 0), c => c.treatment.at[k]?.noise)
    });

    // 门控指标独立计算，且只在带 gate 标注的用例上算
    const gateCases = perCase.filter(c => c.expectedGate);
    const gateCorrect = gateCases.filter(c => c.gate?.decision === c.expectedGate).length;

    const bucket = keyFn => {
        const out = {};
        for (const c of scored) {
            const key = keyFn(c) || 'unknown';
            if (!out[key]) out[key] = { total: 0, passed: 0, failed: 0, cases: [] };
            out[key].total++;
            if (c.expectationsOk) out[key].passed++; else { out[key].failed++; out[key].cases.push(c.id); }
        }
        return out;
    };

    const degradationTally = {};
    for (const c of perCase) {
        for (const [key, info] of Object.entries(c.degradations || {})) {
            if (key === 'thresholdSkipped' || key === 'roleValveBlocked') continue;
            degradationTally[key] = (degradationTally[key] || 0) + (info.count || 1);
        }
    }

    return {
        counts: {
            total: perCase.length,
            scored: scored.length,
            skipped: skipped.length,
            errored: errored.length,
            expectationsPassed: scored.filter(c => c.expectationsOk).length,
            expectationsFailed: scored.filter(c => !c.expectationsOk).length,
            retrievalScored: retrievalCases.length
        },
        retrieval: {
            1: atDepth(1), 3: atDepth(3), 5: atDepth(5), 10: atDepth(10)
        },
        gate: {
            total: gateCases.length,
            correct: gateCorrect,
            accuracy: gateCases.length ? gateCorrect / gateCases.length : null,
            byDecision: gateCases.reduce((acc, c) => {
                const k = `${c.expectedGate}→${c.gate?.decision}`;
                acc[k] = (acc[k] || 0) + 1;
                return acc;
            }, {})
        },
        effect: {
            casesWithControl: scored.filter(c => c.effect).length,
            rankingChangedCount: scored.filter(c => c.effect?.rankingChanged).length,
            meanNdcgDelta: mean(scored.filter(c => c.effect), c => c.effect.ndcgDelta),
            meanGoldRankGain: mean(scored.filter(c => c.effect && Number.isFinite(c.effect.goldRankGain)),
                c => c.effect.goldRankGain)
        },
        cost: {
            totalLatencyMs: scored.reduce((s, c) => s + (c.latencyMs || 0), 0),
            meanLatencyMs: mean(scored, c => c.latencyMs),
            totalInjectedChars: scored.reduce((s, c) => s + (c.injectedChars || 0), 0),
            fromCacheCount: scored.filter(c => c.fromCache).length
        },
        integrity: {
            silentDegradations: degradationTally,
            // 出现任何静默降级都意味着这次运行的部分结论不可信
            clean: Object.keys(degradationTally).length === 0
        },
        byTier: bucket(c => `tier${c.tier}`),
        byFamily: bucket(c => c.family),
        byCapability: bucket(c => c.capability),
        skippedReasons: skipped.reduce((acc, c) => {
            acc[c.skipReason || 'unknown'] = (acc[c.skipReason || 'unknown'] || 0) + 1;
            return acc;
        }, {})
    };
}

module.exports = {
    DEFAULT_CUTOFFS,
    docIdOf,
    normalizeDocId,
    makeDocMatcher,
    rankedDocIds,
    recallAt,
    precisionAt,
    ndcgAt,
    noiseAt,
    firstRelevantRank,
    reciprocalRankAt,
    kendallTau,
    overlapAt,
    scoreArm,
    scoreEffect,
    checkExpectations,
    aggregate
};
