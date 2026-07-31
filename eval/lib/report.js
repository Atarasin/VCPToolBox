'use strict';

/**
 * 单次运行的人读报告。
 *
 * 设计取向：先说**这次运行可不可信**，再说指标。
 * 旧报告只有五个数字，没有任何字段能回答"这次运行是不是整体坏掉了" ——
 * 而这恰恰是最常见的情况。
 */

function pct(v) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

function num(v, digits = 2) {
    return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

function render(params) {
    const { manifest, metrics, perCase, preflight, corpusManifest } = params;
    const L = [];

    L.push(`# RAG 评估报告 · ${manifest.runId}`);
    L.push('');
    L.push(`- 标签：${manifest.label || '（无）'}`);
    L.push(`- 时间：${manifest.createdAt} → ${manifest.finishedAt || '进行中'}（${num((manifest.durationMs || 0) / 1000, 1)}s）`);
    L.push(`- profile：\`${manifest.profile}\` ｜ suite：${(manifest.suites || []).join(', ')}`);
    L.push(`- embedding：${manifest.embeddingModel} @ ${manifest.embeddingDimension} 维`);
    L.push(`- 语料：${corpusManifest?.docCount ?? '—'} 篇 / ${corpusManifest?.uniqueTags ?? '—'} 个唯一 tag，锚点日 ${corpusManifest?.anchorDate ?? '—'}`);
    L.push(`- git：${manifest.git?.sha || '—'}${manifest.git?.dirty ? '（工作区有未提交改动）' : ''}`);
    L.push(`- configHash：\`${manifest.configHash}\` ｜ corpusHash：\`${String(manifest.corpusHash).slice(0, 12)}\``);
    L.push('');

    // ── 可信度先行 ────────────────────────────────────────────────
    L.push('## 运行可信度');
    L.push('');
    const integrity = metrics.integrity;
    if (integrity.clean) {
        L.push('✅ 未检测到静默降级。');
    } else {
        L.push('⚠️ **检测到静默降级 —— 相关用例的结论不可信**：');
        L.push('');
        L.push('| 信号 | 次数 | 含义 |');
        L.push('| --- | --- | --- |');
        for (const [key, count] of Object.entries(integrity.silentDegradations)) {
            L.push(`| \`${key}\` | ${count} | ${DEGRADATION_MEANING[key] || '见 probes.js'} |`);
        }
    }
    L.push('');
    L.push(`- 计分：${metrics.counts.scored} ｜ 跳过：${metrics.counts.skipped} ｜ 错误：${metrics.counts.errored}`);
    L.push(`- 能力断言：**通过 ${metrics.counts.expectationsPassed} / 失败 ${metrics.counts.expectationsFailed}**`);
    if (Object.keys(metrics.skippedReasons).length) {
        L.push(`- 跳过原因：${Object.entries(metrics.skippedReasons).map(([k, v]) => `${k} × ${v}`).join('；')}`);
        L.push('  （跳过**不等于**通过 —— 依赖缺失时相关能力未被验证）');
    }
    L.push('');

    if (preflight) {
        L.push('<details><summary>前置校验详情</summary>');
        L.push('');
        L.push('| 检查项 | 结果 | 详情 |');
        L.push('| --- | --- | --- |');
        for (const [name, c] of Object.entries(preflight.checks || {})) {
            L.push(`| ${name} | ${c.ok ? '✅' : (c.level === 'error' ? '❌' : '⚠️')} | ${String(c.detail).replace(/\|/g, '\\|')} |`);
        }
        L.push('');
        L.push('</details>');
        L.push('');
    }

    // ── 检索指标 ──────────────────────────────────────────────────
    L.push('## 检索指标');
    L.push('');
    L.push(`仅在 **门控放行且有真值** 的 ${metrics.counts.retrievalScored} 条用例上计算。`);
    L.push('门控拦截的用例不参与检索打分 —— 否则"正确拦截"会被当成召回失败扣分。');
    L.push('');
    L.push('| 深度 | Recall | Precision | nDCG | MRR | 噪声率 |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const k of [1, 3, 5, 10]) {
        const r = metrics.retrieval[k] || {};
        L.push(`| @${k} | ${pct(r.recall)} | ${pct(r.precision)} | ${pct(r.ndcg)} | ${pct(r.mrr)} | ${pct(r.noise)} |`);
    }
    L.push('');

    // ── 能力效应：本套件的核心 ────────────────────────────────────
    L.push('## 能力效应（treatment vs control）');
    L.push('');
    L.push('这一节回答"这个修饰符到底有没有改变结果"。单臂指标回答不了这个问题 ——');
    L.push('一个完全没生效的修饰符，单臂指标看起来和生效了一模一样。');
    L.push('');
    L.push(`- 带对照臂的用例：${metrics.effect.casesWithControl}`);
    L.push(`- 其中确实改变了 Top-K 排序：**${metrics.effect.rankingChangedCount}**`);
    L.push(`- nDCG 平均变化：${num(metrics.effect.meanNdcgDelta, 4)}`);
    L.push(`- 金标排名平均提升：${num(metrics.effect.meanGoldRankGain, 2)} 位`);
    L.push('');

    const withEffect = perCase.filter(c => c.effect);
    if (withEffect.length) {
        L.push('| 用例 | 能力 | 金标排名 control → treatment | 位移 | Top-K 重合 | 排序变化 |');
        L.push('| --- | --- | --- | --- | --- | --- |');
        for (const c of withEffect) {
            const e = c.effect;
            L.push(`| ${c.id} | \`${c.capability}\` | ${e.controlGoldRank || '未命中'} → ${e.treatmentGoldRank || '未命中'} | ${fmtGain(e.goldRankGain)} | ${e.topKOverlap} | ${e.rankingChanged ? '是' : '否'} |`);
        }
        L.push('');
    }

    // ── 门控 ──────────────────────────────────────────────────────
    L.push('## 门控');
    L.push('');
    if (metrics.gate.total) {
        L.push(`带门控标注的用例 ${metrics.gate.total} 条，判定正确 ${metrics.gate.correct} 条（${pct(metrics.gate.accuracy)}）。`);
        L.push('');
        L.push('| 期望 → 实际 | 数量 |');
        L.push('| --- | --- |');
        for (const [k, v] of Object.entries(metrics.gate.byDecision)) {
            L.push(`| ${k} | ${v} |`);
        }
    } else {
        L.push('本次运行没有带门控标注的用例。');
    }
    L.push('');

    // ── 分桶 ──────────────────────────────────────────────────────
    for (const [title, bucket] of [['按 tier', metrics.byTier], ['按能力族', metrics.byFamily], ['按能力', metrics.byCapability]]) {
        L.push(`## ${title}`);
        L.push('');
        L.push('| 分组 | 通过/总数 | 失败用例 |');
        L.push('| --- | --- | --- |');
        for (const [key, v] of Object.entries(bucket).sort()) {
            L.push(`| ${key} | ${v.passed}/${v.total} | ${v.cases.join(', ') || '—'} |`);
        }
        L.push('');
    }

    // ── 失败详情 ──────────────────────────────────────────────────
    const failed = perCase.filter(c => c.status === 'scored' && !c.expectationsOk);
    L.push(`## 断言失败详情：${failed.length} 条`);
    L.push('');
    if (failed.length) {
        for (const c of failed) {
            L.push(`### ${c.id}`);
            L.push('');
            L.push(`- 能力：\`${c.capability}\`（${c.family}）`);
            if (c.note) L.push(`- 用例说明：${c.note}`);
            L.push(`- 引擎：${c.engine ?? '—'} ｜ 实际 K：${c.kActual ?? '—'} ｜ 门控：${c.gate?.decision ?? '—'}`);
            for (const chk of (c.expectationChecks || []).filter(x => !x.ok)) {
                L.push(`- ❌ \`${chk.name}\`：${chk.detail}`);
            }
            L.push('');
        }
    } else {
        L.push('无。');
        L.push('');
    }

    const errored = perCase.filter(c => c.status === 'error');
    if (errored.length) {
        L.push(`## 执行错误：${errored.length} 条`);
        L.push('');
        for (const c of errored) L.push(`- **${c.id}**：${c.error}`);
        L.push('');
    }

    // ── 成本 ──────────────────────────────────────────────────────
    L.push('## 成本');
    L.push('');
    L.push(`- 总耗时（用例执行）：${num(metrics.cost.totalLatencyMs / 1000, 1)}s ｜ 单条平均：${num(metrics.cost.meanLatencyMs, 0)}ms`);
    L.push(`- 注入上下文总字符数：${metrics.cost.totalInjectedChars}`);
    L.push(`- 命中查询缓存的用例：${metrics.cost.fromCacheCount}（评估默认关闭查询缓存，此处应为 0）`);
    L.push('');

    L.push('---');
    L.push('');
    L.push('产物位置：`config/` 配置快照 ｜ `VectorStore/` 本次向量数据 ｜ `results/raw.jsonl` 原始记录 ｜ `metrics/` 指标 ｜ `logs/run.log` 完整日志');

    return L.join('\n');
}

const DEGRADATION_MEANING = {
    geodesicFallback: 'TagMemo DTSC 重排放弃，退化为原始 KNN 顺序',
    tagKnnFallback: '绕过 EPA/金字塔的裸 tag KNN，不是真正的 TagMemo',
    rerankNotConfigured: 'Rerank 未配置，静默变成 slice(0,K)',
    tagMemoCriticalFail: 'TagMemo 抛异常后回退到原向量',
    dimensionMismatch: '向量维度不匹配，search() 返回空数组',
    jsGraphRetired: '调用了已退役的 JS 图运行时',
    placeholderNotFound: '占位符替换失败',
    evalPlaceholderMissing: '元思考簇缺失，降级模式'
};

function fmtGain(gain) {
    if (gain === 'control_missed') return '对照臂未命中';
    if (gain === 'treatment_missed') return '**实验臂未命中**';
    if (!Number.isFinite(gain)) return '—';
    return gain > 0 ? `+${gain}` : String(gain);
}

module.exports = { render };
