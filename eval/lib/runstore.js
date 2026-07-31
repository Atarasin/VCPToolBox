'use strict';

/**
 * 运行产物存储。
 *
 * 需求：每次评估留下的向量数据、评估结果、以及评估时用的配置，都要能被找回来。
 * 做法是一次运行 = 一个自包含目录：
 *
 *   eval/runs/<runId>/
 *     manifest.json            运行身份与 provenance
 *     config/resolved.json     解析后的完整配置（凭据已指纹化）
 *     config/rag_params.json   本次实际生效的 rag_params 快照
 *     config/corpus.manifest.json  语料清单（路径/哈希/日期/tag）
 *     VectorStore/             ← 本次运行的向量库，KNOWLEDGEBASE_STORE_PATH 指向这里
 *     results/raw.jsonl        每条 case 每个 arm 的完整原始记录
 *     metrics/metrics.json     汇总指标
 *     metrics/per-case.jsonl   逐条指标
 *     logs/run.log             完整 stdout（供 🛡️ Fallback 这类标记扫描）
 *     report.md                人读报告
 *
 * runId 里嵌了 configHash，所以"同配置重跑"和"换了配置"一眼可辨。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { EVAL_ROOT, PROJECT_ROOT } = require('./profile');

const RUNS_DIR = path.join(EVAL_ROOT, 'runs');
const LATEST_LINK = path.join(RUNS_DIR, 'latest');

function shortHash(value) {
    return crypto.createHash('sha256')
        .update(typeof value === 'string' ? value : JSON.stringify(value))
        .digest('hex').slice(0, 8);
}

/** 本地时间戳（评估是本机行为，UTC 只会让人对不上号）。 */
function timestampSlug(date = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
        + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function gitSha() {
    try {
        return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (_) {
        return null;
    }
}

function gitDirty() {
    try {
        const out = execFileSync('git', ['status', '--porcelain'], {
            cwd: PROJECT_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore']
        });
        return out.trim().length > 0;
    } catch (_) {
        return null;
    }
}

/**
 * 创建一次运行的目录骨架。
 * @param {object} params
 * @param {object} params.resolved   profile.loadProfile 的结果
 * @param {string} params.corpusHash 语料内容哈希
 * @param {string} params.suiteHash  用例集哈希
 * @param {string[]} params.suites   本次跑了哪些 suite
 * @param {string} [params.label]    人给的标签，便于回忆"这次跑的是啥"
 */
function createRun(params) {
    const { resolved, corpusHash, suiteHash, suites = [], label = null } = params;

    const configHash = shortHash({
        profile: resolved.name,
        ragParamsHash: resolved.ragParamsHash,
        embedding: resolved.embedding.model,
        dimension: resolved.embedding.dimension,
        maxToken: resolved.embedding.maxToken,
        corpusHash,
        suiteHash
    });

    const runId = `${timestampSlug()}-${resolved.name}-${configHash}`;
    const dir = path.join(RUNS_DIR, runId);
    if (fs.existsSync(dir)) {
        throw new Error(`运行目录已存在：${dir}`);
    }

    for (const sub of ['config', 'VectorStore', 'results', 'metrics', 'logs']) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }

    const manifest = {
        runId,
        label,
        configHash,
        createdAt: new Date().toISOString(),
        status: 'running',
        profile: resolved.name,
        suites,
        corpusHash,
        suiteHash,
        ragParamsHash: resolved.ragParamsHash,
        embeddingModel: resolved.embedding.model,
        embeddingDimension: resolved.embedding.dimension,
        git: { sha: gitSha(), dirty: gitDirty() },
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        counts: null,
        preflight: null,
        finishedAt: null,
        durationMs: null
    };

    const handle = {
        runId,
        dir,
        configHash,
        manifest,
        storePath: path.join(dir, 'VectorStore'),
        paths: {
            manifest: path.join(dir, 'manifest.json'),
            resolvedConfig: path.join(dir, 'config', 'resolved.json'),
            ragParams: path.join(dir, 'config', 'rag_params.json'),
            corpusManifest: path.join(dir, 'config', 'corpus.manifest.json'),
            rawResults: path.join(dir, 'results', 'raw.jsonl'),
            metrics: path.join(dir, 'metrics', 'metrics.json'),
            perCase: path.join(dir, 'metrics', 'per-case.jsonl'),
            log: path.join(dir, 'logs', 'run.log'),
            report: path.join(dir, 'report.md')
        }
    };

    writeManifest(handle);
    return handle;
}

function writeManifest(handle) {
    fs.writeFileSync(handle.paths.manifest, JSON.stringify(handle.manifest, null, 2), 'utf-8');
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function writeJsonl(filePath, rows) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf-8');
}

function readJsonl(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    if (!text) return [];
    return text.split('\n').map(line => JSON.parse(line));
}

/** 收尾：写状态、耗时，并把 latest 指过来。 */
function finalizeRun(handle, patch = {}) {
    Object.assign(handle.manifest, patch);
    handle.manifest.finishedAt = new Date().toISOString();
    handle.manifest.durationMs =
        new Date(handle.manifest.finishedAt) - new Date(handle.manifest.createdAt);
    if (handle.manifest.status === 'running') handle.manifest.status = 'completed';
    writeManifest(handle);
    updateLatest(handle.runId);
    return handle;
}

function updateLatest(runId) {
    try {
        if (fs.existsSync(LATEST_LINK) || fs.lstatSync(LATEST_LINK, { throwIfNoEntry: false })) {
            fs.rmSync(LATEST_LINK, { force: true, recursive: false });
        }
    } catch (_) { /* 不存在就算了 */ }
    try {
        fs.symlinkSync(runId, LATEST_LINK, 'dir');
    } catch (_) {
        // 不支持软链的文件系统上退化成一个指针文件，listRuns/resolveRun 都能读。
        try { fs.writeFileSync(`${LATEST_LINK}.txt`, runId, 'utf-8'); } catch (_) {}
    }
}

function listRuns() {
    if (!fs.existsSync(RUNS_DIR)) return [];
    return fs.readdirSync(RUNS_DIR)
        .filter(name => {
            if (name === 'latest' || name === 'latest.txt') return false;
            return fs.existsSync(path.join(RUNS_DIR, name, 'manifest.json'));
        })
        .map(name => {
            try {
                return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, name, 'manifest.json'), 'utf-8'));
            } catch (_) {
                return { runId: name, status: 'corrupt' };
            }
        })
        .sort((a, b) => String(b.runId).localeCompare(String(a.runId)));
}

/** 支持 "latest"、完整 runId、以及唯一前缀。 */
function resolveRun(idOrLatest) {
    if (!idOrLatest) throw new Error('需要 runId（或 "latest"）。');

    if (idOrLatest === 'latest') {
        const runs = listRuns();
        if (!runs.length) throw new Error('还没有任何运行记录，先执行 `vcp-eval run`。');
        return loadRun(runs[0].runId);
    }

    const direct = path.join(RUNS_DIR, idOrLatest);
    if (fs.existsSync(path.join(direct, 'manifest.json'))) return loadRun(idOrLatest);

    const matches = listRuns().filter(r => String(r.runId).startsWith(idOrLatest));
    if (matches.length === 1) return loadRun(matches[0].runId);
    if (matches.length > 1) {
        throw new Error(`runId 前缀 "${idOrLatest}" 匹配到多个：${matches.map(m => m.runId).join(', ')}`);
    }
    throw new Error(`未找到运行记录 "${idOrLatest}"。用 \`vcp-eval runs list\` 查看。`);
}

function loadRun(runId) {
    const dir = path.join(RUNS_DIR, runId);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    return {
        runId,
        dir,
        manifest,
        storePath: path.join(dir, 'VectorStore'),
        paths: {
            manifest: path.join(dir, 'manifest.json'),
            resolvedConfig: path.join(dir, 'config', 'resolved.json'),
            ragParams: path.join(dir, 'config', 'rag_params.json'),
            corpusManifest: path.join(dir, 'config', 'corpus.manifest.json'),
            rawResults: path.join(dir, 'results', 'raw.jsonl'),
            metrics: path.join(dir, 'metrics', 'metrics.json'),
            perCase: path.join(dir, 'metrics', 'per-case.jsonl'),
            log: path.join(dir, 'logs', 'run.log'),
            report: path.join(dir, 'report.md')
        }
    };
}

/** 删掉最近 keep 次之外的运行（向量库很占地方）。 */
function pruneRuns(keep = 5) {
    const runs = listRuns();
    const removed = [];
    for (const run of runs.slice(keep)) {
        fs.rmSync(path.join(RUNS_DIR, run.runId), { recursive: true, force: true });
        removed.push(run.runId);
    }
    if (removed.length && runs.length > removed.length) updateLatest(runs[0].runId);
    return removed;
}

module.exports = {
    RUNS_DIR,
    createRun,
    finalizeRun,
    writeManifest,
    writeJson,
    writeJsonl,
    readJsonl,
    listRuns,
    resolveRun,
    loadRun,
    pruneRuns,
    shortHash,
    gitSha
};
