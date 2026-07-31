'use strict';

/**
 * 进程内运行时引导。
 *
 * KnowledgeBaseManager 是 `module.exports = new KnowledgeBaseManager()`——require 时
 * 就构造，构造时就读 process.env。所以 profile.applyEnv() 必须在 require 之前跑完，
 * 这里用惰性 require 来保证顺序。
 *
 * 预热与静默等待的逻辑沿用旧 harness（eval/legacy/real-run-eval.js:246-412）已经
 * 验证过的做法，不重新发明：
 *   - hasPendingKnowledgeBaseWork()：轮询一组实例字段判断后台是否收敛
 *   - waitForKnowledgeBaseQuiescent()：等初始扫描/批处理/Rust 写租约结束
 *   - warmupTagMemoArtifacts()：正式计分前确认 TagMemo artifact 就绪
 *
 * 预热不是可选优化。EPA 在启动阶段 deferRustRecompute=true，artifact 冷启动时
 * applyTagBoost 会因 MEMO_ARTIFACT_UNAVAILABLE 让整个 search() 返回 []——而 search()
 * 把一切都包在 try/catch 里，所以表现为"零结果"而不是报错。旧 harness 的
 * case_002 在两次存档运行里都返回空，就是被自己的预热探针污染的。
 */

const fs = require('fs');
const path = require('path');

const { PROJECT_ROOT } = require('./profile');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 后台是否还有未收敛的工作。字段集沿用旧 harness 已验证的那一组。 */
function hasPendingKnowledgeBaseWork(kbm) {
    if (!kbm) return false;
    return Boolean(
        kbm.isProcessing
        || kbm.isProcessingDeletes
        || kbm.externalMutationActive
        || kbm.rustWriteLease
        || kbm.indexRecoveryActive
        || kbm.dbHealthState === 'recovering'
        || kbm.batchTimer
        || kbm.deleteBatchTimer
        || (kbm.pendingFiles instanceof Set && kbm.pendingFiles.size > 0)
        || (kbm.pendingDeletes instanceof Set && kbm.pendingDeletes.size > 0)
    );
}

async function waitForKnowledgeBaseQuiescent(kbm, options = {}) {
    if (!kbm) return;
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 180000);
    const pollMs = Math.max(25, Number(options.pollMs) || 200);
    const startedAt = Date.now();

    for (;;) {
        if (kbm.databaseCorruptionDetected || kbm.dbHealthState === 'corrupt') {
            throw new Error('知识库数据库损坏，无法继续。');
        }
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (remainingMs <= 0) {
            throw new Error(`等待知识库收敛超时（${timeoutMs}ms）。`);
        }
        if (typeof kbm.databaseCoordinator?.waitForIdle === 'function') {
            await kbm.databaseCoordinator.waitForIdle({
                timeoutMs: remainingMs,
                pollMs: Math.min(pollMs, 50)
            });
        }
        if (!hasPendingKnowledgeBaseWork(kbm)) return;
        await delay(pollMs);
    }
}

/** 非破坏性地探一下 TagMemo/RiverMemo artifact 是否已就绪。 */
function getMemoArtifactSnapshot(kbm) {
    if (!kbm) return null;
    const wrapped = typeof kbm.getTagMemoV10ArtifactSnapshot === 'function'
        ? kbm.getTagMemoV10ArtifactSnapshot({ buildIfMissing: false })?.bundle
        : null;
    const direct = kbm.tagMemoV10Engine?.getArtifactSnapshot?.({ buildIfMissing: false }) || null;
    const snap = wrapped || direct;
    return snap?.artifactSig ? snap : null;
}

/**
 * 预热 TagMemo artifact。
 *
 * 与旧 harness 的关键差异：预热探针**不再用评测集里的用例**。旧做法拿第一条
 * /TagMemo/ 用例去探针，而 artifact 还冷着，空结果被查询缓存吃下，正式计分时重放
 * 同一个空结果——被污染的恰好是它想保护的那条用例。这里用一句与任何用例都无关的
 * 探针查询，并且 profile 已经强制 RAG_QUERY_CACHE_ENABLED=false。
 */
async function warmupMemoArtifacts(params) {
    const { kbm, ragPlugin, books = [], timeoutMs = 180000, onLog = () => {} } = params;
    const startedAt = Date.now();

    try {
        await waitForKnowledgeBaseQuiescent(kbm, { timeoutMs });
    } catch (error) {
        onLog(`预热等待未干净收敛：${error.message || error}`);
    }

    let snapshot = getMemoArtifactSnapshot(kbm);
    if (snapshot) {
        onLog(`TagMemo artifact 已就绪：artifact=${snapshot.artifactSig}, nativeGeneration=${snapshot.nativeGeneration ?? 'lazy'}`);
        return { ready: true, warmupTriggered: false, artifactSig: snapshot.artifactSig, elapsedMs: Date.now() - startedAt };
    }

    // 用一句与评测集无关的探针触发 artifact 构建
    let warmupTriggered = false;
    const probeBook = books[0];
    if (probeBook && ragPlugin?.processMessages) {
        onLog(`用探针查询预热 TagMemo artifact（日记本：${probeBook}）…`);
        try {
            await ragPlugin.processMessages([
                { role: 'system', content: `[[${probeBook}日记本::TagMemo]]` },
                { role: 'user', content: '预热探针查询，与评测用例无关' }
            ], {});
            warmupTriggered = true;
        } catch (error) {
            onLog(`预热探针失败：${error.message || error}`);
        }
    }

    while (Date.now() - startedAt < timeoutMs) {
        snapshot = getMemoArtifactSnapshot(kbm);
        if (snapshot) {
            onLog(`TagMemo artifact 预热完成：artifact=${snapshot.artifactSig}, nativeGeneration=${snapshot.nativeGeneration ?? 'lazy'}`);
            return { ready: true, warmupTriggered, artifactSig: snapshot.artifactSig, elapsedMs: Date.now() - startedAt };
        }
        if (hasPendingKnowledgeBaseWork(kbm)) {
            try {
                await waitForKnowledgeBaseQuiescent(kbm, {
                    timeoutMs: Math.max(1000, timeoutMs - (Date.now() - startedAt))
                });
            } catch (error) {
                onLog(`预热仍在等待后台工作：${error.message || error}`);
                break;
            }
            continue;
        }
        await delay(200);
    }

    onLog('⚠️ TagMemo artifact 预热超时；相关用例将被标记为不可信。');
    return { ready: false, warmupTriggered, artifactSig: null, elapsedMs: Date.now() - startedAt };
}

/**
 * 等待冷知识库把 knowledge/ 摄取完。
 *
 * TDBKnowledge.initialize() 只是**排队**，真正的分块+向量化在后台队列里跑
 * （knowledge/ 下有 260+ 个文件）。不等它收敛就查询的话，所有冷知识库用例都返回 0 条 ——
 * 表现为"检索不到"，而不是"还没准备好"。首次运行会产生大量 embedding 调用，耗时可观。
 */
async function warmupColdKB(params) {
    const { tdb, timeoutMs = 900000, onLog = () => {} } = params;
    if (!tdb) return { ready: false, reason: 'cold-kb-unavailable' };

    const startedAt = Date.now();
    let lastPending = null;
    let idleTicks = 0;

    while (Date.now() - startedAt < timeoutMs) {
        let queue = null;
        try {
            queue = tdb.getMemoryProfile?.()?.queue || null;
        } catch (_) { /* profile 失败就按未知处理，继续轮询 */ }

        const pending = queue
            ? (queue.pending || 0) + (queue.retry || 0) + (queue.processing || 0)
            : null;

        if (pending !== null && pending === 0) {
            // 队列可能瞬时为空但下一批还没入队，连续几次为 0 才认为收敛
            if (++idleTicks >= 3) {
                onLog(`冷知识库摄取完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
                return { ready: true, elapsedMs: Date.now() - startedAt };
            }
        } else {
            idleTicks = 0;
            if (pending !== null && pending !== lastPending) {
                onLog(`冷知识库摄取中：队列剩余 ${pending}`);
                lastPending = pending;
            }
        }
        await delay(2000);
    }

    onLog('⚠️ 冷知识库摄取超时；相关用例结果不可信。');
    return { ready: false, reason: 'ingest-timeout' };
}

/**
 * 启动完整运行时。
 *
 * @param {object} params
 * @param {object} params.resolved   已经 applyEnv 过的 profile
 * @param {boolean} [params.withLightMemo]
 * @param {boolean} [params.withColdKB]
 * @param {function} [params.onLog]
 */
async function boot(params) {
    const { resolved, withLightMemo = false, withColdKB = false, onLog = () => {} } = params;

    if (!process.env.KNOWLEDGEBASE_STORE_PATH) {
        throw new Error('KNOWLEDGEBASE_STORE_PATH 未设置——runstore 必须先创建运行目录。');
    }

    // 惰性 require：必须在 applyEnv 之后
    const kbm = require(path.join(PROJECT_ROOT, 'KnowledgeBaseManager'));
    const ragPlugin = require(path.join(PROJECT_ROOT, 'Plugin', 'RAGDiaryPlugin', 'RAGDiaryPlugin'));

    // rag_params 要在 initialize 前后各设一次：initialize 内部会重新加载。
    const applyRagParams = () => {
        kbm.ragParams = resolved.ragParams;
        ragPlugin.ragParams = resolved.ragParams;
    };

    // 事件汇聚点。runner 每条 case 换一个 collector，通过这个可变引用切换。
    const sink = { current: null };
    const pushVcpInfo = payload => { sink.current?.push(payload); };

    applyRagParams();
    await kbm.initialize();

    let tdb = null;
    if (withColdKB) {
        try {
            tdb = require(path.join(PROJECT_ROOT, 'TDBKnowledge'));
            if (typeof tdb.initialize === 'function') await tdb.initialize();
            // triviumdb 缺失时 TDBKnowledge 会静默 disabled 并让 search() 返回 []。
            // 必须显式判断，否则冷知识库用例会"通过"得毫无意义。
            if (tdb.initialized !== true) {
                onLog('⚠️ 冷知识库未启用（triviumdb 缺失或初始化失败）；Tier4 用例将 SKIP。');
                tdb = null;
            }
        } catch (error) {
            onLog(`⚠️ 冷知识库不可用：${error.message || error}`);
            tdb = null;
        }
    }

    await ragPlugin.initialize({}, {
        vectorDBManager: kbm,
        vcpLogFunctions: { pushVcpInfo },
        ...(tdb ? { tdbKnowledgeManager: tdb } : {})
    });
    applyRagParams();

    let lightMemo = null;
    if (withLightMemo) {
        try {
            lightMemo = require(path.join(PROJECT_ROOT, 'Plugin', 'LightMemo', 'LightMemo'));
            lightMemo.initialize({ PROJECT_BASE_PATH: PROJECT_ROOT }, {
                vectorDBManager: kbm,
                getSingleEmbedding: ragPlugin.getSingleEmbedding.bind(ragPlugin),
                aiMemoBridge: typeof ragPlugin.getAIMemoBridge === 'function' ? ragPlugin.getAIMemoBridge() : undefined,
                ...(tdb ? { tdbKnowledgeManager: tdb } : {})
            });
        } catch (error) {
            onLog(`⚠️ LightMemo 初始化失败：${error.message || error}`);
            lightMemo = null;
        }
    }

    return {
        kbm,
        ragPlugin,
        lightMemo,
        tdb,
        sink,
        coldKBAvailable: Boolean(tdb),
        lightMemoAvailable: Boolean(lightMemo),
        async warmup(books) {
            const memo = await warmupMemoArtifacts({ kbm, ragPlugin, books, onLog });
            // 冷知识库单独等：它的摄取队列与 KBM 完全独立，KBM 静默不代表 TDB 也好了
            const coldKB = tdb ? await warmupColdKB({ tdb, onLog }) : null;
            return { ...memo, coldKB };
        },
        async shutdown() {
            try { ragPlugin?.shutdown?.(); } catch (_) {}
            try { await kbm?.shutdown?.(); } catch (_) {}
            try { await tdb?.shutdown?.(); } catch (_) {}
        }
    };
}

/**
 * 直接读向量库做真值核对。
 * 这是"语料真的进索引了吗"的唯一可靠答案——不查它的话，一次索引失败会产出
 * 一份 recall=0 的报告，与真实的质量回退无法区分。
 */
function inspectStore(storePath) {
    const dbFile = path.join(storePath, 'knowledge_base.sqlite');
    if (!fs.existsSync(dbFile)) {
        return { exists: false, dbFile };
    }
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (error) {
        return { exists: true, dbFile, error: `better-sqlite3 不可用：${error.message}` };
    }

    const db = new Database(dbFile, { readonly: true });
    try {
        const tableNames = db.prepare("select name from sqlite_master where type='table'").all().map(r => r.name);
        const q = (sql, fallback = null) => {
            try { return db.prepare(sql).all(); } catch (_) { return fallback; }
        };
        const one = (sql, fallback = null) => {
            try { return db.prepare(sql).get(); } catch (_) { return fallback; }
        };
        return {
            exists: true,
            dbFile,
            tables: tableNames,
            byDiary: q('select diary_name, count(*) as files from files group by diary_name', []) || [],
            chunks: one('select count(*) as c from chunks', { c: 0 })?.c ?? 0,
            tags: one('select count(*) as c from tags', { c: 0 })?.c ?? 0,
            fileTags: one('select count(*) as c from file_tags', { c: 0 })?.c ?? 0,
            // position=0 代表 migration 之前的旧数据，走的是"无方向等权"分支，
            // RiverMemo 的方向信号会整体失效。必须为 0。
            zeroPositionFileTags: one('select count(*) as c from file_tags where position = 0', { c: 0 })?.c ?? 0,
            paths: (q('select path from files', []) || []).map(r => r.path),
            hasTagMemoArtifacts: tableNames.includes('tagmemo_artifacts'),
            hasRiverMemoArtifacts: tableNames.includes('rivermemo_artifacts')
        };
    } finally {
        db.close();
    }
}

module.exports = {
    boot,
    delay,
    hasPendingKnowledgeBaseWork,
    waitForKnowledgeBaseQuiescent,
    warmupMemoArtifacts,
    warmupColdKB,
    getMemoArtifactSnapshot,
    inspectStore
};
