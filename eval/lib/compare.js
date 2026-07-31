'use strict';

/**
 * 两次运行的对比与门禁。
 *
 * 相对旧实现的四处修正：
 *
 * 1. 明确区分**回退**（baseline 通过、candidate 失败）、**修复**（反之）、
 *    和**一直失败**。旧报告只 filter 了 candidate.perCase，根本无法区分这三者，
 *    于是"一直坏着"和"刚坏"长得一样。
 * 2. 同时产出 JSON 与 Markdown。旧实现只有 Markdown，没法被程序消费。
 * 3. 按 tier / family / capability 分桶。旧数据集每行都有 category、12 个取值，
 *    但报告从不分桶 —— 这是最便宜的一项改进。
 * 4. 门禁规则可配置、带方向元数据，失败时**非零退出**。
 *    旧门禁 5 项中 3 项数学上不可达（pass 恒为 false），而且脚本永远 exit 0，
 *    CI 拦不住任何东西。
 */

const path = require('path');

/** 默认门禁规则。direction 表示"越大越好"还是"越小越好"。 */
const DEFAULT_RULES = {
    $comment: '阈值以百分点（pp）为单位。可用 --rules <file> 覆盖。',
    rules: [
        {
            key: 'retrieval.5.recall', label: 'Recall@5 不得明显下降',
            direction: 'higher_better', minDelta: -0.01
        },
        {
            key: 'retrieval.5.ndcg', label: 'nDCG@5 不得明显下降',
            direction: 'higher_better', minDelta: -0.02
        },
        {
            key: 'gate.accuracy', label: '门控准确率不得下降',
            direction: 'higher_better', minDelta: -0.05
        },
        {
            key: 'counts.expectationsFailed', label: '能力断言失败数不得增加',
            direction: 'lower_better', maxDelta: 0
        },
        {
            key: 'counts.errored', label: '错误用例数不得增加',
            direction: 'lower_better', maxDelta: 0
        }
    ],
    absolute: [
        {
            key: 'integrity.clean', label: '不得出现静默降级（🛡️ Fallback 等）',
            mustBe: true
        }
    ]
};

function getPath(obj, dotted) {
    return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * 对比两次运行的指标。
 */
function compare(baseline, candidate) {
    const bm = baseline.metrics;
    const cm = candidate.metrics;

    const metricDiff = [];
    for (const depth of [1, 3, 5, 10]) {
        for (const key of ['recall', 'precision', 'ndcg', 'mrr', 'noise']) {
            const b = getPath(bm, `retrieval.${depth}.${key}`);
            const c = getPath(cm, `retrieval.${depth}.${key}`);
            if (!Number.isFinite(b) && !Number.isFinite(c)) continue;
            metricDiff.push({
                metric: `${key}@${depth}`,
                baseline: b, candidate: c,
                delta: Number.isFinite(b) && Number.isFinite(c) ? c - b : null
            });
        }
    }

    for (const key of ['gate.accuracy', 'effect.rankingChangedCount', 'effect.meanNdcgDelta',
        'counts.expectationsPassed', 'counts.expectationsFailed', 'counts.skipped',
        'counts.errored', 'cost.meanLatencyMs', 'cost.totalInjectedChars']) {
        const b = getPath(bm, key);
        const c = getPath(cm, key);
        if (b === undefined && c === undefined) continue;
        metricDiff.push({
            metric: key, baseline: b, candidate: c,
            delta: Number.isFinite(b) && Number.isFinite(c) ? c - b : null
        });
    }

    // 逐条用例分类
    const bByCase = new Map((baseline.perCase || []).map(c => [c.id, c]));
    const cByCase = new Map((candidate.perCase || []).map(c => [c.id, c]));
    const allIds = [...new Set([...bByCase.keys(), ...cByCase.keys()])];

    const regressions = [];
    const fixes = [];
    const persistentFailures = [];
    const newCases = [];
    const removedCases = [];

    for (const id of allIds) {
        const b = bByCase.get(id);
        const c = cByCase.get(id);
        if (!b) { newCases.push(id); continue; }
        if (!c) { removedCases.push(id); continue; }

        const bOk = b.status === 'scored' && b.expectationsOk;
        const cOk = c.status === 'scored' && c.expectationsOk;

        const entry = {
            id, family: c.family, capability: c.capability, tier: c.tier,
            baselineStatus: b.status, candidateStatus: c.status,
            failedChecks: (c.expectationChecks || []).filter(x => !x.ok).map(x => `${x.name}: ${x.detail}`),
            goldRank: { baseline: b.treatment?.goldRank ?? null, candidate: c.treatment?.goldRank ?? null }
        };

        if (bOk && !cOk) regressions.push(entry);
        else if (!bOk && cOk) fixes.push(entry);
        else if (!bOk && !cOk) persistentFailures.push(entry);
    }

    return {
        baseline: { runId: baseline.manifest.runId, profile: baseline.manifest.profile, model: baseline.manifest.embeddingModel, dimension: baseline.manifest.embeddingDimension },
        candidate: { runId: candidate.manifest.runId, profile: candidate.manifest.profile, model: candidate.manifest.embeddingModel, dimension: candidate.manifest.embeddingDimension },
        comparable: isComparable(baseline.manifest, candidate.manifest),
        metricDiff,
        regressions,
        fixes,
        persistentFailures,
        newCases,
        removedCases,
        byFamily: diffBuckets(bm.byFamily, cm.byFamily),
        byCapability: diffBuckets(bm.byCapability, cm.byCapability),
        byTier: diffBuckets(bm.byTier, cm.byTier)
    };
}

/**
 * 两次运行是否可比。语料或用例集变了就不可比 —— 这时任何 delta 都没有意义。
 * 旧实现完全不检查这一点，于是能拿一份 mock 结果和一份 real 结果"对比"。
 */
function isComparable(a, b) {
    const reasons = [];
    if (a.corpusHash !== b.corpusHash) reasons.push('语料内容不同（corpusHash 不一致）：指标 delta 无意义');
    if (a.suiteHash !== b.suiteHash) reasons.push('用例集不同（suiteHash 不一致）：指标 delta 无意义');
    return { ok: reasons.length === 0, reasons };
}

function diffBuckets(a = {}, b = {}) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.map(k => ({
        key: k,
        baseline: a[k] ? `${a[k].passed}/${a[k].total}` : '—',
        candidate: b[k] ? `${b[k].passed}/${b[k].total}` : '—',
        delta: (b[k]?.passed ?? 0) - (a[k]?.passed ?? 0)
    }));
}

/**
 * 门禁判定。
 */
function gate(comparison, baseline, candidate, rules = DEFAULT_RULES) {
    const checks = [];

    // 语料/用例集不同则直接不判定 —— 强行比较只会得出误导性结论
    if (!comparison.comparable.ok) {
        return {
            pass: false,
            abort: true,
            reason: comparison.comparable.reasons.join('；'),
            checks: []
        };
    }

    for (const rule of rules.rules || []) {
        const b = getPath(baseline.metrics, rule.key);
        const c = getPath(candidate.metrics, rule.key);
        if (!Number.isFinite(b) || !Number.isFinite(c)) {
            checks.push({ ...rule, baseline: b, candidate: c, delta: null, pass: null, skipped: '指标不可用' });
            continue;
        }
        const delta = c - b;
        let pass = true;
        if (Number.isFinite(rule.minDelta)) pass = pass && delta >= rule.minDelta;
        if (Number.isFinite(rule.maxDelta)) pass = pass && delta <= rule.maxDelta;
        checks.push({ key: rule.key, label: rule.label, baseline: b, candidate: c, delta, pass });
    }

    for (const rule of rules.absolute || []) {
        const c = getPath(candidate.metrics, rule.key);
        checks.push({
            key: rule.key, label: rule.label, candidate: c,
            pass: c === rule.mustBe
        });
    }

    // 回退用例一律否决
    checks.push({
        key: 'regressions', label: '不得出现回退用例（baseline 通过而 candidate 失败）',
        candidate: comparison.regressions.length,
        pass: comparison.regressions.length === 0,
        detail: comparison.regressions.map(r => r.id).join(', ') || null
    });

    const decided = checks.filter(c => c.pass !== null);
    return {
        pass: decided.every(c => c.pass),
        abort: false,
        checks,
        skipped: checks.filter(c => c.pass === null).length
    };
}

function pct(v) {
    if (!Number.isFinite(v)) return '—';
    return (v * 100).toFixed(1);
}

function signed(v, digits = 1) {
    if (!Number.isFinite(v)) return '—';
    const s = (v * 100).toFixed(digits);
    return v > 0 ? `+${s}` : s;
}

/** 生成 Markdown 对比报告。 */
function renderMarkdown(comparison, gateResult) {
    const L = [];
    L.push('# RAG 评估对比报告');
    L.push('');
    L.push(`- baseline：\`${comparison.baseline.runId}\`（${comparison.baseline.model} @ ${comparison.baseline.dimension} 维）`);
    L.push(`- candidate：\`${comparison.candidate.runId}\`（${comparison.candidate.model} @ ${comparison.candidate.dimension} 维）`);
    L.push('');

    if (!comparison.comparable.ok) {
        L.push('## ⛔ 两次运行不可比');
        L.push('');
        for (const r of comparison.comparable.reasons) L.push(`- ${r}`);
        L.push('');
        L.push('语料或用例集不同时，指标差值不代表检索质量变化。请用同一份语料与用例集重跑。');
        L.push('');
    }

    L.push('## 门禁');
    L.push('');
    if (gateResult.abort) {
        L.push(`**未判定** —— ${gateResult.reason}`);
    } else {
        L.push(`**${gateResult.pass ? '通过' : '未通过'}**${gateResult.skipped ? `（${gateResult.skipped} 项因指标不可用跳过）` : ''}`);
        L.push('');
        L.push('| 规则 | baseline | candidate | 变化 | 结论 |');
        L.push('| --- | --- | --- | --- | --- |');
        for (const c of gateResult.checks) {
            const verdict = c.pass === null ? '跳过' : (c.pass ? '✅' : '❌');
            L.push(`| ${c.label} | ${fmt(c.baseline)} | ${fmt(c.candidate)} | ${c.delta !== undefined && c.delta !== null ? signed(c.delta) + ' pp' : '—'} | ${verdict} |`);
        }
    }
    L.push('');

    L.push('## 指标对比');
    L.push('');
    L.push('| 指标 | baseline | candidate | 变化 |');
    L.push('| --- | --- | --- | --- |');
    for (const d of comparison.metricDiff) {
        const isRate = /recall|precision|ndcg|mrr|noise|accuracy/i.test(d.metric);
        L.push(`| ${d.metric} | ${isRate ? pct(d.baseline) : fmt(d.baseline)} | ${isRate ? pct(d.candidate) : fmt(d.candidate)} | ${isRate ? (d.delta !== null ? signed(d.delta) + ' pp' : '—') : fmtDelta(d.delta)} |`);
    }
    L.push('');

    // 回退是最重要的一节，放最前
    L.push(`## 回退（baseline 通过 → candidate 失败）：${comparison.regressions.length} 条`);
    L.push('');
    if (comparison.regressions.length) {
        for (const r of comparison.regressions) {
            L.push(`- **${r.id}**（${r.family} / ${r.capability}）`);
            L.push(`  - 金标排名：${r.goldRank.baseline ?? '—'} → ${r.goldRank.candidate ?? '—'}`);
            for (const f of r.failedChecks) L.push(`  - 失败断言：${f}`);
        }
    } else {
        L.push('无。');
    }
    L.push('');

    L.push(`## 修复（baseline 失败 → candidate 通过）：${comparison.fixes.length} 条`);
    L.push('');
    L.push(comparison.fixes.length ? comparison.fixes.map(f => `- ${f.id}（${f.family} / ${f.capability}）`).join('\n') : '无。');
    L.push('');

    L.push(`## 一直失败：${comparison.persistentFailures.length} 条`);
    L.push('');
    if (comparison.persistentFailures.length) {
        for (const r of comparison.persistentFailures.slice(0, 20)) {
            L.push(`- ${r.id}（${r.family} / ${r.capability}）${r.failedChecks.length ? ` —— ${r.failedChecks[0]}` : ''}`);
        }
        if (comparison.persistentFailures.length > 20) {
            L.push(`- …另有 ${comparison.persistentFailures.length - 20} 条，见 JSON`);
        }
    } else {
        L.push('无。');
    }
    L.push('');

    for (const [title, rows] of [['按能力族', comparison.byFamily], ['按能力', comparison.byCapability], ['按 tier', comparison.byTier]]) {
        L.push(`## ${title}`);
        L.push('');
        L.push('| 分组 | baseline | candidate | 通过数变化 |');
        L.push('| --- | --- | --- | --- |');
        for (const r of rows) {
            L.push(`| ${r.key} | ${r.baseline} | ${r.candidate} | ${r.delta > 0 ? '+' : ''}${r.delta} |`);
        }
        L.push('');
    }

    if (comparison.newCases.length || comparison.removedCases.length) {
        L.push('## 用例集变化');
        L.push('');
        if (comparison.newCases.length) L.push(`- 新增：${comparison.newCases.join(', ')}`);
        if (comparison.removedCases.length) L.push(`- 移除：${comparison.removedCases.join(', ')}`);
        L.push('');
    }

    return L.join('\n');
}

function fmt(v) {
    if (v === true) return '是';
    if (v === false) return '否';
    if (!Number.isFinite(v)) return v == null ? '—' : String(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
}

function fmtDelta(v) {
    if (!Number.isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + (Number.isInteger(v) ? String(v) : v.toFixed(3));
}

module.exports = { compare, gate, renderMarkdown, isComparable, DEFAULT_RULES };
