'use strict';

/**
 * CLI 实现。
 *
 * 设计目标是"人和 agent 都能用"：
 *   - 每个子命令都支持 --json，输出机器可读结构
 *   - gate 失败非零退出（旧门禁永远 exit 0，CI 拦不住任何东西）
 *   - 前置校验不通过就中止，不产出报告
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const profileLib = require('./profile');
const runstore = require('./runstore');
const corpusBuild = require('./corpusBuild');
const corpusVerify = require('./corpusVerify');
const preflight = require('./preflight');
const compareLib = require('./compare');
const reportLib = require('./report');
const metricsLib = require('./metrics');

const { EVAL_ROOT, PROJECT_ROOT } = profileLib;

// ── 参数解析 ─────────────────────────────────────────────────────────

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token.startsWith('--')) {
            const name = token.slice(2);
            const eq = name.indexOf('=');
            if (eq >= 0) {
                flags[name.slice(0, eq)] = name.slice(eq + 1);
            } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
                flags[name] = argv[++i];
            } else {
                flags[name] = true;
            }
        } else {
            positional.push(token);
        }
    }
    return { positional, flags };
}

function list(value) {
    if (!value || value === true) return [];
    return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

// ── 输出 ─────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (color, text) => (useColor ? `${C[color]}${text}${C.reset}` : text);

function out(text = '') {
    process.stdout.write(`${text}\n`);
}

function emitJson(value) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusIcon(ok, level) {
    if (ok) return c('green', '✔');
    return level === 'error' ? c('red', '✘') : c('yellow', '!');
}

// ── doctor ───────────────────────────────────────────────────────────

async function cmdDoctor(flags) {
    const resolved = profileLib.loadProfile(flags.profile || 'default');
    const result = await preflight.run(resolved, { skipNetwork: Boolean(flags.offline) });

    if (flags.json) {
        emitJson({
            ok: result.ok,
            profile: resolved.name,
            checks: result.checks,
            capabilities: result.capabilities,
            blocking: result.blocking
        });
        return result.ok ? 0 : 1;
    }

    out(c('bold', `\nVCP RAG 评估 · 环境自检（profile: ${resolved.name}）`));
    out('');
    for (const [name, check] of Object.entries(result.checks)) {
        out(`  ${statusIcon(check.ok, check.level)} ${name.padEnd(20)} ${check.detail}`);
    }
    out('');
    out(`  ${c('bold', '能力可用性')}（不可用的能力，相关用例会被 SKIP，不会伪装通过）`);
    for (const [cap, ok] of Object.entries(result.capabilities)) {
        out(`    ${ok ? c('green', '可用') : c('yellow', '不可用')}  ${cap}`);
    }
    out('');
    if (result.ok) {
        out(c('green', '  自检通过，可以执行 `vcp-eval run`。'));
    } else {
        out(c('red', '  自检未通过，以下项会导致运行无意义：'));
        for (const b of result.blocking) out(c('red', `    - ${b.name}: ${b.detail}`));
    }
    out('');
    return result.ok ? 0 : 1;
}

// ── corpus ───────────────────────────────────────────────────────────

async function cmdCorpus(positional, flags) {
    const sub = positional[0] || 'build';

    if (sub === 'build') {
        // 先校验 spec 再生成：从一份有问题的 spec 生成出来的语料，
        // 生成物层的检查未必能发现（例如"正文里混进了 Tag: 行"这类问题，
        // 渲染完就和正常的 Tag 行长得一样了）。有问题就别生成。
        const specCheck = corpusVerify.verifySpec();
        if (!specCheck.ok) {
            if (flags.json) { emitJson({ ok: false, stage: 'spec', findings: specCheck.findings }); return 1; }
            out(c('red', '\ncorpus-spec 校验未通过，未生成语料：'));
            printFindings(specCheck.findings);
            return 1;
        }

        const { outDir, manifest } = corpusBuild.build({
            anchor: typeof flags.anchor === 'string' ? flags.anchor : undefined,
            force: Boolean(flags.force)
        });
        const verified = corpusVerify.verifyGenerated(outDir);

        // 同时把评测需要的插件侧配置装好。不装的话 ::Group 会静默 no-op、
        // 门控会退回硬编码的 0.6 阈值，相关用例给出的失败是误导性的。
        const pluginConfig = require('./pluginConfig');
        const installed = flags['no-plugin-config'] ? null : pluginConfig.install();

        if (flags.json) {
            emitJson({
                ok: verified.ok, outDir,
                manifest: { ...manifest, files: undefined },
                findings: verified.findings,
                pluginConfig: installed
            });
            return verified.ok ? 0 : 1;
        }

        out(c('bold', '\n语料已生成'));
        out('');
        out(`  路径      ${path.relative(PROJECT_ROOT, outDir)}`);
        out(`  锚点日    ${manifest.anchorDate}（所有相对日期以它为基准）`);
        out(`  文档      ${manifest.docCount} 篇`);
        out(`  唯一 tag  ${manifest.uniqueTags} 个`);
        out(`  corpusHash ${manifest.corpusHash.slice(0, 16)}`);
        out('');
        for (const [key, book] of Object.entries(manifest.books)) {
            out(`  ${book.folder.padEnd(18)} ${String(book.docCount).padStart(3)} 篇   阈值 ${book.threshold ?? '—'}`);
        }
        out('');
        printFindings(verified.findings);

        if (installed) {
            const touched = [...installed.added, ...installed.updated];
            if (touched.length) {
                out('  已写入插件配置（只增不改，原文件已备份）：');
                for (const k of installed.added) out(`    ${c('green', '+')} ${k}`);
                for (const k of installed.updated) out(`    ${c('yellow', '~')} ${k}`);
                for (const b of installed.backups) out(c('dim', `    备份 ${b}`));
                out(c('dim', '    移除：node eval/vcp-eval.js corpus uninstall-config'));
            } else {
                out(c('dim', `  插件配置已是最新（${installed.unchanged.length} 项）。`));
            }
            out('');
        }

        out(verified.ok ? c('green', '  不变量校验通过。') : c('red', '  不变量校验未通过。'));
        out('');
        return verified.ok ? 0 : 1;
    }

    if (sub === 'install-config' || sub === 'uninstall-config') {
        const pluginConfig = require('./pluginConfig');
        const result = sub === 'install-config' ? pluginConfig.install() : pluginConfig.uninstall();
        if (flags.json) { emitJson(result); return 0; }
        out('');
        if (sub === 'install-config') {
            out(`  新增 ${result.added.length}，更新 ${result.updated.length}，未变 ${result.unchanged.length}`);
            for (const k of [...result.added, ...result.updated]) out(`    ${k}`);
            for (const b of result.backups) out(c('dim', `  备份 ${b}`));
        } else {
            out(`  已移除 ${result.removed.length} 项评测配置：`);
            for (const k of result.removed) out(`    ${k}`);
            out(c('dim', '  用户原有条目未受影响。'));
        }
        out('');
        return 0;
    }

    if (sub === 'verify') {
        const resolved = profileLib.loadProfile(flags.profile || 'default');
        const result = corpusVerify.verifyAll(resolved.corpusRoot);
        if (flags.json) {
            emitJson(result);
            return result.ok ? 0 : 1;
        }
        out(c('bold', '\n语料校验'));
        out('');
        out(`  ${c('bold', 'spec 层')}  ${JSON.stringify(result.spec.stats)}`);
        printFindings(result.spec.findings);
        if (result.generated) {
            out(`  ${c('bold', '生成物层')}  ${result.generated.stats ? `${result.generated.stats.docs} 篇 / 锚点日 ${result.generated.stats.anchorDate}` : ''}`);
            printFindings(result.generated.findings);
            if (result.generated.stats) {
                out('  mtime 最新 5 篇（::LastN 的依据）：');
                for (const f of result.generated.stats.newestByMtime) out(`    ${f}`);
                out('  日期最新 5 篇（{{}} 全量模式的排序依据是文件名，即日期）：');
                for (const f of result.generated.stats.newestByDate) out(`    ${f}`);
                out('  两者必须不同，否则 ::LastN 与全量模式无从区分。');
            }
        } else {
            out(c('yellow', '  语料尚未生成，先执行 `vcp-eval corpus build`。'));
        }
        out('');
        out(result.ok ? c('green', '  通过。') : c('red', '  未通过。'));
        out('');
        return result.ok ? 0 : 1;
    }

    if (sub === 'spec') {
        const result = corpusVerify.verifySpec();
        if (flags.json) { emitJson(result); return result.ok ? 0 : 1; }
        out(c('bold', '\ncorpus-spec 校验（离线，不需要生成语料）'));
        out('');
        out(`  ${JSON.stringify(result.stats, null, 2).split('\n').join('\n  ')}`);
        out('');
        printFindings(result.findings);
        return result.ok ? 0 : 1;
    }

    out(`未知子命令 "${sub}"。可用：build / verify / spec`);
    return 1;
}

function printFindings(findings) {
    const errors = findings.filter(f => f.level === 'error');
    const warns = findings.filter(f => f.level === 'warn');
    for (const f of errors) out(`    ${c('red', '✘')} [${f.code}] ${f.message}`);
    for (const f of warns) out(`    ${c('yellow', '!')} [${f.code}] ${f.message}`);
    if (!errors.length && !warns.length) out(`    ${c('green', '✔')} 无问题`);
    out('');
}

// ── run ──────────────────────────────────────────────────────────────

async function cmdRun(flags) {
    const resolved = profileLib.loadProfile(flags.profile || 'default');

    // 语料必须先就位 —— 未生成时直接中止，而不是跑出一份 recall=0 的报告
    const corpusManifest = corpusBuild.loadManifest(resolved.corpusRoot);
    if (!corpusManifest) {
        out(c('red', `\n语料未生成（${path.relative(PROJECT_ROOT, resolved.corpusRoot)}）。先执行：`));
        out('  node eval/vcp-eval.js corpus build\n');
        return 1;
    }

    // 插件侧配置必须先就位：缺 rag_tags 条目会让门控退回硬编码 0.6 阈值，
    // 缺 semantic_groups 条目会让 ::Group 静默 no-op —— 两者都会产出误导性的失败。
    const pluginStatus = require('./pluginConfig').status();
    if (!pluginStatus.ok) {
        out(c('red', '\n评测所需的插件配置尚未装入，中止运行：'));
        if (pluginStatus.missingBooks.length) {
            out(c('red', `  ${pluginStatus.ragTagsPath} 缺少日记本阈值：${pluginStatus.missingBooks.join('、')}`));
            out(c('dim', '    未注册的日记本会用硬编码的 0.6 阈值，门控用例两个方向都测不出来'));
        }
        if (pluginStatus.missingGroups.length) {
            out(c('red', `  ${pluginStatus.semanticGroupsPath} 缺少语义组：${pluginStatus.missingGroups.join('、')}`));
            out(c('dim', '    组不存在时 ::Group 静默返回原向量，等于没生效'));
        }
        out('\n执行 `node eval/vcp-eval.js corpus build`（或 `corpus install-config`）后重试。\n');
        return 1;
    }

    const runner = require('./runner');
    const suiteNames = list(flags.suite);
    const { cases: allCases, files: suiteFiles } = runner.loadSuites(EVAL_ROOT, suiteNames);

    let cases = allCases;
    if (flags.filter) {
        const re = new RegExp(String(flags.filter));
        cases = cases.filter(x => re.test(x.id));
    }
    if (flags.family) {
        const fams = list(flags.family);
        cases = cases.filter(x => fams.includes(x.family));
    }
    if (flags.tier) {
        const tiers = list(flags.tier).map(Number);
        cases = cases.filter(x => tiers.includes(x.tier));
    }
    if (!cases.length) {
        out(c('red', '\n没有匹配的用例。\n'));
        return 1;
    }

    const suiteHash = profileLib.hashOf(allCases.map(x => x.id).sort().join('|'));

    // ── 前置校验：不通过就中止 ────────────────────────────────────
    const needsNetwork = cases.some(x => x.mode === 'placeholder' || x.mode === 'lightmemo');
    const pf = await preflight.run(resolved, { skipNetwork: !needsNetwork });
    if (!pf.ok) {
        out(c('red', '\n前置校验未通过，中止运行（继续跑只会产出一份无意义但看起来正常的报告）：'));
        for (const b of pf.blocking) out(c('red', `  - ${b.name}: ${b.detail}`));
        out('\n用 `node eval/vcp-eval.js doctor` 查看完整自检。\n');
        return 1;
    }

    // ── 创建运行目录 ─────────────────────────────────────────────
    const handle = runstore.createRun({
        resolved,
        corpusHash: corpusManifest.corpusHash,
        suiteHash,
        suites: suiteFiles.map(f => f.replace(/\.jsonl$/, '')),
        label: typeof flags.label === 'string' ? flags.label : null
    });

    // 向量库落在运行目录内 —— 这就是"保存评估后留下的向量数据"
    resolved.storePath = handle.storePath;
    profileLib.applyEnv(resolved);

    runstore.writeJson(handle.paths.resolvedConfig, profileLib.snapshotConfig(resolved));
    runstore.writeJson(handle.paths.ragParams, resolved.ragParams);
    runstore.writeJson(handle.paths.corpusManifest, corpusManifest);

    out(c('bold', `\n运行 ${handle.runId}`));
    out('');
    out(`  profile     ${resolved.name}`);
    out(`  embedding   ${resolved.embedding.model} @ ${resolved.embedding.dimension} 维（maxToken ${resolved.embedding.maxToken}）`);
    out(`  语料        ${corpusManifest.docCount} 篇，锚点日 ${corpusManifest.anchorDate}`);
    out(`  用例        ${cases.length} 条（来自 ${suiteFiles.join(', ')}）`);
    out(`  产物        ${path.relative(PROJECT_ROOT, handle.dir)}`);
    out('');

    const logStream = fs.createWriteStream(handle.paths.log, { flags: 'a' });
    const logLine = text => { try { logStream.write(`${text}\n`); } catch (_) {} };

    let runtime = null;
    let artifactReady = false;
    let storeStats = null;

    try {
        if (needsNetwork) {
            out('  正在启动知识库并索引语料…（首次会产生 embedding 调用）');
            const bootLogs = [];
            const restore = require('./probes').installLogCapture(t => { bootLogs.push(t); logLine(t); });
            try {
                runtime = await require('./runtime').boot({
                    resolved,
                    withLightMemo: cases.some(x => x.mode === 'lightmemo'),
                    withColdKB: cases.some(x => x.tier === 4),
                    onLog: logLine
                });
                const warm = await runtime.warmup(Object.values(corpusManifest.books).map(b => b.folder));
                artifactReady = warm.ready;
            } finally {
                restore();
            }

            storeStats = require('./runtime').inspectStore(handle.storePath);

            // ── 索引真值核对：这是"语料真的进去了吗"的唯一可靠答案 ──
            const indexIssues = [];
            if (!storeStats.exists) {
                indexIssues.push('向量库文件不存在');
            } else {
                if (!storeStats.chunks) indexIssues.push('chunks 表为空：语料没有被索引');
                if (!storeStats.tags) indexIssues.push('tags 表为空：TagMemo / RiverMemo 全线失效（这正是旧评估 candidate 臂的状态）');
                if (storeStats.zeroPositionFileTags > 0) {
                    indexIssues.push(`file_tags.position 有 ${storeStats.zeroPositionFileTags} 行为 0：走的是无方向等权旧路径，RiverMemo 的方向信号失效`);
                }
                if (!storeStats.hasTagMemoArtifacts || !storeStats.hasRiverMemoArtifacts) {
                    indexIssues.push('向量库缺少 tagmemo_artifacts / rivermemo_artifacts 表：schema 与当前代码不匹配');
                }
                const expected = corpusManifest.docCount;
                const actual = (storeStats.byDiary || []).reduce((s, r) => s + r.files, 0);
                if (actual < expected) indexIssues.push(`只索引了 ${actual}/${expected} 篇文档`);
            }

            out(`  向量库：${storeStats.chunks ?? 0} chunk / ${storeStats.tags ?? 0} tag / ${storeStats.fileTags ?? 0} 条 file_tags`);
            out(`  TagMemo artifact：${artifactReady ? c('green', '就绪') : c('yellow', '未就绪（相关用例结论不可信）')}`);
            if (indexIssues.length) {
                out('');
                out(c('red', '  索引核对失败，中止运行：'));
                for (const issue of indexIssues) out(c('red', `    - ${issue}`));
                out('');
                runstore.finalizeRun(handle, { status: 'aborted', preflight: pf, indexIssues });
                await runtime.shutdown();
                logStream.end();
                return 1;
            }
            out('');
        }

        // ── 执行用例 ─────────────────────────────────────────────
        const startedAt = Date.now();
        const { rawRows, perCase } = await runner.runSuite({
            cases,
            runtime,
            resolved,
            corpusManifest,
            capabilities: pf.capabilities,
            artifactReady,
            onProgress: ({ index, total, id, mode }) => {
                const pad = String(index).padStart(String(total).length);
                process.stdout.write(`\r  [${pad}/${total}] ${id.padEnd(34)} ${c('dim', mode)}          `);
                logLine(`--- case ${index}/${total}: ${id} (${mode}) ---`);
            }
        });
        process.stdout.write('\r'.padEnd(80) + '\r');

        const metrics = metricsLib.aggregate(perCase);

        runstore.writeJsonl(handle.paths.rawResults, rawRows);
        runstore.writeJsonl(handle.paths.perCase, perCase);
        runstore.writeJson(handle.paths.metrics, metrics);

        // 先 finalize 再渲染报告：finalizeRun 才会写入 finishedAt / durationMs / status，
        // 顺序反了报告里会永远显示"进行中（0.0s）"。
        runstore.finalizeRun(handle, {
            status: metrics.counts.errored > 0 ? 'completed_with_errors' : 'completed',
            preflight: pf,
            artifactReady,
            storeStats: storeStats ? {
                chunks: storeStats.chunks, tags: storeStats.tags,
                fileTags: storeStats.fileTags, byDiary: storeStats.byDiary
            } : null,
            counts: metrics.counts,
            caseDurationMs: Date.now() - startedAt
        });

        const report = reportLib.render({
            manifest: handle.manifest, metrics, perCase, preflight: pf, corpusManifest
        });
        fs.writeFileSync(handle.paths.report, report, 'utf-8');

        if (flags.json) {
            emitJson({ runId: handle.runId, dir: handle.dir, metrics });
        } else {
            printRunSummary(handle, metrics, perCase);
        }

        return metrics.counts.errored > 0 ? 1 : 0;
    } catch (error) {
        runstore.finalizeRun(handle, { status: 'failed', error: error.message || String(error), preflight: pf });
        out('');
        out(c('red', `运行失败：${error.message || error}`));
        if (flags.verbose) out(String(error.stack || ''));
        return 1;
    } finally {
        try { await runtime?.shutdown(); } catch (_) {}
        logStream.end();
    }
}

function printRunSummary(handle, metrics, perCase) {
    out(c('bold', '  结果'));
    out('');
    out(`    计分 ${metrics.counts.scored}  跳过 ${metrics.counts.skipped}  错误 ${metrics.counts.errored}`);
    out(`    能力断言  ${c('green', `通过 ${metrics.counts.expectationsPassed}`)} / ${metrics.counts.expectationsFailed ? c('red', `失败 ${metrics.counts.expectationsFailed}`) : '失败 0'}`);
    out('');
    const r5 = metrics.retrieval[5] || {};
    out(`    Recall@5 ${fmtPct(r5.recall)}   Precision@5 ${fmtPct(r5.precision)}   nDCG@5 ${fmtPct(r5.ndcg)}   MRR@5 ${fmtPct(r5.mrr)}   噪声 ${fmtPct(r5.noise)}`);
    out(`    （仅在门控放行且有真值的 ${metrics.counts.retrievalScored} 条上计算）`);
    out('');
    out(`    能力效应：${metrics.effect.casesWithControl} 条带对照臂，其中 ${metrics.effect.rankingChangedCount} 条确实改变了排序`);
    if (metrics.gate.total) {
        out(`    门控准确率：${fmtPct(metrics.gate.accuracy)}（${metrics.gate.correct}/${metrics.gate.total}）`);
    }
    out('');

    if (!metrics.integrity.clean) {
        out(c('yellow', '    ⚠ 检测到静默降级（相关用例结论不可信）：'));
        for (const [k, v] of Object.entries(metrics.integrity.silentDegradations)) {
            out(c('yellow', `        ${k} × ${v}`));
        }
        out('');
    }
    if (Object.keys(metrics.skippedReasons).length) {
        out(`    跳过原因：${Object.entries(metrics.skippedReasons).map(([k, v]) => `${k}×${v}`).join('，')}`);
        out(c('dim', '    （跳过 ≠ 通过：依赖缺失时该能力未被验证）'));
        out('');
    }

    const failed = perCase.filter(x => x.status === 'scored' && !x.expectationsOk);
    if (failed.length) {
        out(c('red', `    断言失败的用例（前 10 条）：`));
        for (const x of failed.slice(0, 10)) {
            const first = (x.expectationChecks || []).find(k => !k.ok);
            out(c('red', `        ${x.id}  ${first ? `${first.name}: ${first.detail}` : ''}`));
        }
        if (failed.length > 10) out(c('red', `        …另有 ${failed.length - 10} 条`));
        out('');
    }

    out(`    报告  ${path.relative(PROJECT_ROOT, handle.paths.report)}`);
    out(`    产物  ${path.relative(PROJECT_ROOT, handle.dir)}`);
    out('');
}

function fmtPct(v) {
    return Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—';
}

// ── score（对已有 run 重新计分）───────────────────────────────────────

async function cmdScore(positional, flags) {
    const run = runstore.resolveRun(positional[0] || 'latest');
    const perCase = runstore.readJsonl(run.paths.perCase);
    if (!perCase.length) {
        out(c('red', `\n${run.runId} 没有 per-case 数据。\n`));
        return 1;
    }
    const metrics = metricsLib.aggregate(perCase);
    runstore.writeJson(run.paths.metrics, metrics);

    const corpusManifest = fs.existsSync(run.paths.corpusManifest)
        ? JSON.parse(fs.readFileSync(run.paths.corpusManifest, 'utf-8')) : null;
    const report = reportLib.render({
        manifest: run.manifest, metrics, perCase,
        preflight: run.manifest.preflight, corpusManifest
    });
    fs.writeFileSync(run.paths.report, report, 'utf-8');

    if (flags.json) { emitJson(metrics); return 0; }
    out(c('bold', `\n已重新计分 ${run.runId}`));
    out('');
    printRunSummary(run, metrics, perCase);
    return 0;
}

// ── compare / gate ───────────────────────────────────────────────────

function loadRunForCompare(id) {
    const run = runstore.resolveRun(id);
    const metricsPath = run.paths.metrics;
    if (!fs.existsSync(metricsPath)) {
        throw new Error(`${run.runId} 缺少 metrics.json，先执行 \`vcp-eval score ${run.runId}\``);
    }
    return {
        manifest: run.manifest,
        metrics: JSON.parse(fs.readFileSync(metricsPath, 'utf-8')),
        perCase: runstore.readJsonl(run.paths.perCase),
        dir: run.dir
    };
}

async function cmdCompare(positional, flags) {
    if (positional.length < 2) {
        out('用法：vcp-eval compare <baselineRunId> <candidateRunId> [--json] [--out <file>]');
        return 1;
    }
    const baseline = loadRunForCompare(positional[0]);
    const candidate = loadRunForCompare(positional[1]);
    const comparison = compareLib.compare(baseline, candidate);
    const gateResult = compareLib.gate(comparison, baseline, candidate, loadRules(flags));

    if (flags.json) {
        emitJson({ comparison, gate: gateResult });
        return gateResult.pass ? 0 : 1;
    }

    const md = compareLib.renderMarkdown(comparison, gateResult);
    const outFile = typeof flags.out === 'string'
        ? path.resolve(flags.out)
        : path.join(candidate.dir, `compare-vs-${baseline.manifest.runId}.md`);
    fs.writeFileSync(outFile, md, 'utf-8');

    out('');
    out(md);
    out('');
    out(c('dim', `报告已写入 ${path.relative(PROJECT_ROOT, outFile)}`));
    out('');
    return 0;
}

function loadRules(flags) {
    if (typeof flags.rules === 'string') {
        return JSON.parse(fs.readFileSync(path.resolve(flags.rules), 'utf-8'));
    }
    return compareLib.DEFAULT_RULES;
}

async function cmdGate(positional, flags) {
    if (positional.length < 2) {
        out('用法：vcp-eval gate <baselineRunId> <candidateRunId> [--rules <file>] [--json]');
        return 1;
    }
    const baseline = loadRunForCompare(positional[0]);
    const candidate = loadRunForCompare(positional[1]);
    const comparison = compareLib.compare(baseline, candidate);
    const gateResult = compareLib.gate(comparison, baseline, candidate, loadRules(flags));

    if (flags.json) {
        emitJson(gateResult);
    } else {
        out(c('bold', '\n门禁判定'));
        out('');
        if (gateResult.abort) {
            out(c('red', `  未判定：${gateResult.reason}`));
        } else {
            for (const chk of gateResult.checks) {
                const icon = chk.pass === null ? c('yellow', '—') : (chk.pass ? c('green', '✔') : c('red', '✘'));
                const delta = Number.isFinite(chk.delta) ? ` (Δ ${(chk.delta * 100).toFixed(1)} pp)` : '';
                out(`  ${icon} ${chk.label}${delta}${chk.detail ? ` — ${chk.detail}` : ''}`);
            }
            out('');
            out(gateResult.pass ? c('green', '  门禁通过。') : c('red', '  门禁未通过。'));
        }
        out('');
    }
    // 非零退出，CI 才拦得住
    return gateResult.pass ? 0 : 1;
}

// ── runs ─────────────────────────────────────────────────────────────

async function cmdRuns(positional, flags) {
    const sub = positional[0] || 'list';

    if (sub === 'list') {
        const runs = runstore.listRuns();
        if (flags.json) { emitJson(runs); return 0; }
        if (!runs.length) { out('\n还没有运行记录。执行 `vcp-eval run` 开始。\n'); return 0; }
        out(c('bold', '\n运行记录'));
        out('');
        out(`  ${'runId'.padEnd(38)} ${'状态'.padEnd(22)} ${'断言'.padEnd(10)} 模型`);
        for (const r of runs) {
            const counts = r.counts ? `${r.counts.expectationsPassed}/${r.counts.scored}` : '—';
            out(`  ${String(r.runId).padEnd(38)} ${String(r.status).padEnd(20)} ${counts.padEnd(10)} ${r.embeddingModel || '—'}`);
        }
        out('');
        return 0;
    }

    if (sub === 'show') {
        const run = runstore.resolveRun(positional[1] || 'latest');
        if (flags.json) {
            emitJson({
                manifest: run.manifest,
                metrics: fs.existsSync(run.paths.metrics) ? JSON.parse(fs.readFileSync(run.paths.metrics, 'utf-8')) : null
            });
            return 0;
        }
        if (fs.existsSync(run.paths.report)) {
            out('');
            out(fs.readFileSync(run.paths.report, 'utf-8'));
        } else {
            emitJson(run.manifest);
        }
        return 0;
    }

    if (sub === 'prune') {
        const keep = Number(flags.keep || 5);
        const removed = runstore.pruneRuns(keep);
        if (flags.json) { emitJson({ removed, keep }); return 0; }
        out(`\n已保留最近 ${keep} 次运行，删除 ${removed.length} 次${removed.length ? `：${removed.join(', ')}` : ''}。\n`);
        return 0;
    }

    out(`未知子命令 "${sub}"。可用：list / show / prune`);
    return 1;
}

// ── suite ────────────────────────────────────────────────────────────

async function cmdSuite(positional, flags) {
    const runner = require('./runner');
    const { cases, files } = runner.loadSuites(EVAL_ROOT, list(flags.suite));

    if (flags.json) {
        emitJson({
            files,
            total: cases.length,
            cases: cases.map(x => ({
                id: x.id, tier: x.tier, mode: x.mode, family: x.family,
                capability: x.capability, requires: x.requires || [],
                hasControl: Boolean(x.arms?.control), gate: x.gate || null
            }))
        });
        return 0;
    }

    out(c('bold', `\n用例集（${cases.length} 条，来自 ${files.join(', ')}）`));
    out('');

    if (flags.coverage) {
        const byCapability = new Map();
        for (const x of cases) {
            const key = x.capability || '—';
            if (!byCapability.has(key)) byCapability.set(key, []);
            byCapability.get(key).push(x);
        }
        out(`  ${'能力'.padEnd(34)} ${'条数'.padEnd(6)} ${'对照臂'.padEnd(8)} 依赖`);
        for (const [cap, xs] of [...byCapability.entries()].sort()) {
            const withControl = xs.filter(x => x.arms?.control).length;
            const requires = [...new Set(xs.flatMap(x => x.requires || []))].join(',') || '—';
            out(`  ${cap.padEnd(34)} ${String(xs.length).padEnd(6)} ${`${withControl}/${xs.length}`.padEnd(8)} ${requires}`);
        }
        out('');
        const tiers = {};
        for (const x of cases) tiers[x.tier] = (tiers[x.tier] || 0) + 1;
        out(`  按 tier：${Object.entries(tiers).map(([k, v]) => `tier${k}=${v}`).join('  ')}`);
        out(`  带对照臂：${cases.filter(x => x.arms?.control).length} / ${cases.length}`);
        out(`  带门控标注：${cases.filter(x => x.gate).length}`);
        out('');
        return 0;
    }

    for (const x of cases) {
        const marks = [
            x.arms?.control ? 'A/B' : '   ',
            x.gate ? `gate:${x.gate}` : '',
            (x.requires || []).length ? `需要:${x.requires.join(',')}` : ''
        ].filter(Boolean).join(' ');
        out(`  ${String(x.id).padEnd(32)} t${x.tier} ${String(x.mode).padEnd(12)} ${String(x.capability).padEnd(26)} ${marks}`);
    }
    out('');
    return 0;
}

// ── help ─────────────────────────────────────────────────────────────

function cmdHelp() {
    out(`
${c('bold', 'vcp-eval')} — VCP RAG / 记忆能力评估

${c('bold', '用法')}
  node eval/vcp-eval.js <命令> [参数]

${c('bold', '命令')}
  doctor                          环境自检：embedding / 原生模块 / rerank / 冷知识库 / 语料
  corpus build                    从 corpus-spec/ 生成语料 + 装入插件配置
  corpus verify                   校验语料不变量（spec 层 + 生成物层）
  corpus spec                     只校验 corpus-spec（离线，不需要生成语料）
  corpus install-config           只装插件配置（rag_tags 阈值 + 语义组），只增不改
  corpus uninstall-config         移除评测装入的插件配置，不动用户原有条目
  run                             执行评估，产出一个完整的运行目录
  score <runId|latest>            对已有运行重新计分并重生成报告
  compare <baseline> <candidate>  对比两次运行，输出 Markdown + 分类回退/修复
  gate <baseline> <candidate>     门禁判定（未通过时非零退出）
  runs list                       列出所有运行
  runs show [runId|latest]        查看某次运行的报告
  runs prune --keep N             只保留最近 N 次运行（向量库很占地方）
  suite list [--coverage]         列出用例 / 查看能力覆盖矩阵

${c('bold', '常用参数')}
  --profile <名称>     使用 eval/profiles/<名称>.json（默认 default）
  --suite <a,b>        只跑指定 suite（tier1 / tier2 / tier4）
  --tier <1,2>         只跑指定 tier
  --family <a,b>       只跑指定能力族（tagmemo / rivermemo / time / group / bm25 / gate …）
  --filter <正则>      按用例 id 过滤
  --label <文本>       给这次运行加个标签，便于日后回忆
  --anchor <日期>      corpus build 的锚点日 YYYY-MM-DD（默认今天）
  --json               输出 JSON（所有命令都支持，便于 agent 消费）
  --offline            doctor 跳过网络探测

${c('bold', '典型流程')}
  node eval/vcp-eval.js doctor
  node eval/vcp-eval.js corpus build
  node eval/vcp-eval.js run --suite tier1              # 纯离线，无网络
  node eval/vcp-eval.js run --label "基线"              # 完整评估
  node eval/vcp-eval.js compare <runA> <runB>

${c('bold', '设计要点')}
  · 每次运行的向量数据、结果、配置快照都留在 eval/runs/<runId>/ 内，可追溯、可对比
  · 语料由 corpus-spec/ 生成，日期锚定到运行日 —— 相对时间表达（上周/N天前）永不漂移
  · 用例分 treatment / control 双臂，能回答"这个能力有没有真的改变排序"
  · 依赖缺失时用例标记 SKIPPED 而非 PASSED；检测到静默降级会在报告里显式标注
`);
    return 0;
}

// ── 入口 ─────────────────────────────────────────────────────────────

async function main(argv) {
    const { positional, flags } = parseArgs(argv);
    const command = positional[0];
    const rest = positional.slice(1);

    if (!command || command === 'help' || flags.help) return cmdHelp();

    switch (command) {
        case 'doctor': return cmdDoctor(flags);
        case 'corpus': return cmdCorpus(rest, flags);
        case 'run': return cmdRun(flags);
        case 'score': return cmdScore(rest, flags);
        case 'compare': return cmdCompare(rest, flags);
        case 'gate': return cmdGate(rest, flags);
        case 'runs': return cmdRuns(rest, flags);
        case 'suite': return cmdSuite(rest, flags);
        default:
            out(c('red', `未知命令 "${command}"`));
            out('执行 `node eval/vcp-eval.js help` 查看可用命令。');
            return 1;
    }
}

module.exports = { main, parseArgs };
