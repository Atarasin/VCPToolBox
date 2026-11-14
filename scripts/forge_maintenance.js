#!/usr/bin/env node
'use strict';

/**
 * forge/TDB 维护工具（砚尺知识库质量优化设计 M1：§3.1.2、§3.2.2、§3.6.2）。
 *
 * 子命令（CLI 全部支持 --json，人和 agent 都能用；失败非零退出）：
 *   lock / unlock / lease-status   —— 每专家维护租约（跨进程文件协议）
 *   backup / verify-backup         —— 备份与 SHA-256 清单校验（含回滚配对记录）
 *   estimate-rebuild               —— 临时 store 全量摄取演练（耗时测算，不动生产 store）
 *   audit                          —— 磁盘↔SQLite↔TriviumDB 三层一致性审计（§3.2.2）
 *   smoke                          —— 重开后的每库文本+向量查询冒烟
 *
 * 生产使用约定见 docs/design/2026-11-14_砚尺知识库质量优化设计.md §3.1.2：
 * 备份与测算在维护窗口外完成；预计 30 分钟内无法完成清空+重建+验证+回滚时，
 * 不得开始清空。
 *
 * 注意：涉及原生模块（better-sqlite3 / triviumdb）的子命令（audit /
 * estimate-rebuild / smoke）必须用与模块编译一致的 Node 版本运行
 * （当前生产为 Node 22；Node 24 会报 NODE_MODULE_VERSION 不匹配）。
 *
 * 测试约定：命令函数只返回 { report, exitCode }（或抛错），不在进程内
 * process.exit；main() 负责输出与退出码。测试可 require 本模块直连调用。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const {
    LEASE_MODES,
    createExpertLeaseManager,
    inspectLease
} = require(path.join(REPO_ROOT, 'modules/agentGateway/services/forge/maintenanceLock'));

// ── 通用 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const eq = token.indexOf('=');
        if (eq >= 0) {
            flags[token.slice(2, eq)] = token.slice(eq + 1);
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
            flags[token.slice(2)] = argv[++i];
        } else {
            flags[token.slice(2)] = true;
        }
    }
    return flags;
}

const sha256File = async (file) => {
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return `sha256:${hash.digest('hex')}`;
};

function gitHead(root) {
    try {
        return require('node:child_process')
            .execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8' })
            .trim();
    } catch {
        return null;
    }
}

// ── 租约子命令 ───────────────────────────────────────────────────────────

const FORGE_DIR = path.resolve(String(process.env.FORGE_MAINTENANCE_FORGE_DIR || path.join(REPO_ROOT, 'Agent', 'forge')));

function forgeDirFrom(flags) {
    return String(flags['forge-dir'] || FORGE_DIR);
}

function cmdLock(flags) {
    const expert = String(flags.expert || '');
    const mode = String(flags.mode || '');
    const owner = String(flags.owner || `cli_${process.pid}_${Date.now()}`);
    if (!expert) throw new Error('lock 需要 --expert <name>');
    if (!LEASE_MODES.has(mode)) throw new Error(`lock 需要 --mode <${[...LEASE_MODES].join('|')}>`);
    const ttlMs = Number(flags['ttl-ms']) || undefined;
    const manager = createExpertLeaseManager({ baseDir: forgeDirFrom(flags), ...(ttlMs ? { ttlMs } : {}) });
    // detached：CLI 编排进程随即退出，租约不绑定进程存活，
    // 由 TTL + 显式 unlock 管辖（§3.1.2 维护窗口语义）。
    const handle = manager.acquire({ expertName: expert, ownerJobId: owner, mode, detached: true });
    return {
        exitCode: 0,
        report: { ok: true, expertName: expert, ownerJobId: owner, mode, leasePath: handle.path, lease: handle.lease }
    };
}

function cmdUnlock(flags) {
    const expert = String(flags.expert || '');
    const owner = String(flags.owner || '');
    if (!expert || !owner) throw new Error('unlock 需要 --expert 与 --owner（防误删他人租约）');
    const manager = createExpertLeaseManager({ baseDir: forgeDirFrom(flags) });
    const handle = manager.acquire({ expertName: expert, ownerJobId: owner, mode: 'learn', detached: true }); // 幂等获取（同 owner 续期）
    const removed = handle.release();
    return { exitCode: 0, report: { ok: removed, expertName: expert, ownerJobId: owner, removed } };
}

function cmdLeaseStatus(flags) {
    const baseDir = forgeDirFrom(flags);
    const experts = flags.expert
        ? [String(flags.expert)]
        : fs.existsSync(baseDir)
            ? fs.readdirSync(baseDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
            : [];
    const entries = experts.map((expertName) => {
        const state = inspectLease(baseDir, expertName);
        return {
            expertName,
            lease: state?.lease || null,
            active: Boolean(state?.active),
            expired: Boolean(state?.expired),
            pidAlive: state?.pidAlive ?? null,
            corrupted: Boolean(state?.corrupted)
        };
    });
    return { exitCode: 0, report: { ok: true, baseDir, entries } };
}

// ── 备份子命令（§3.1.2 步骤 1/3） ────────────────────────────────────────

const BACKUP_SOURCES = ['knowledge', 'VectorStoreTDB', 'Agent/forge', 'config.env'];

async function walkFiles(root, dir = root, acc = []) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(root, abs, acc);
        } else if (entry.isFile()) {
            acc.push(path.relative(root, abs));
        }
    }
    return acc;
}

async function cmdBackup(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const dest = path.resolve(String(flags.dest || path.join(root, 'backups', 'forge-maintenance', timestamp)));

    const missing = BACKUP_SOURCES.filter((source) => !fs.existsSync(path.join(root, source)));
    if (missing.length) throw new Error(`备份源缺失：${missing.join(', ')}（--root 指向仓库根？）`);

    await fsp.mkdir(dest, { recursive: true });
    const startedAt = Date.now();
    for (const source of BACKUP_SOURCES) {
        await fsp.cp(path.join(root, source), path.join(dest, source), { recursive: true, force: true });
    }
    const items = [];
    for (const source of BACKUP_SOURCES) {
        const sourcePath = path.join(dest, source);
        const files = fs.statSync(sourcePath).isDirectory()
            ? await walkFiles(dest, sourcePath)
            : [source]; // config.env 等单文件源
        for (const rel of files) {
            const abs = path.join(dest, rel);
            const stat = await fsp.stat(abs);
            items.push({ path: rel, size: stat.size, sha256: await sha256File(abs) });
        }
    }
    items.sort((a, b) => a.path.localeCompare(b.path));

    let embeddingManifest = null;
    try {
        embeddingManifest = JSON.parse(await fsp.readFile(path.join(dest, 'VectorStoreTDB', 'embedding-manifest.json'), 'utf-8'));
    } catch { /* 无 manifest（空 store）如实记录 null */ }

    const manifest = {
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        root,
        codeVersion: gitHead(root),
        sources: BACKUP_SOURCES,
        embeddingManifest,
        totals: {
            files: items.length,
            bytes: items.reduce((sum, item) => sum + item.size, 0)
        },
        items
    };
    const manifestPath = path.join(dest, 'backup-manifest.json');
    const manifestHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;

    // 回滚配对记录（T3）：代码版本 ↔ store manifest ↔ 备份位置 ↔ 恢复路径。
    const pairing = {
        schemaVersion: 1,
        createdAt: manifest.createdAt,
        backupDir: dest,
        backupManifestPath: manifestPath,
        backupManifestSha256: manifestHash,
        codeVersion: manifest.codeVersion,
        embeddingManifest,
        restore: {
            summary: '代码与 store 成对回滚：git checkout <codeVersion> + 恢复备份目录三处内容',
            steps: [
                `git -C ${root} checkout ${manifest.codeVersion || '<codeVersion>'}`,
                `rm -rf ${path.join(root, 'VectorStoreTDB')} && cp -r ${path.join(dest, 'VectorStoreTDB')} ${path.join(root, 'VectorStoreTDB')}`,
                '恢复 knowledge/ 与 Agent/forge/ 同理（见 backup-manifest.json items）',
                '重启生产进程并按 §3.2.2 重跑 audit + smoke'
            ]
        }
    };
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    await fsp.writeFile(path.join(dest, 'rollback-pairing.json'), `${JSON.stringify(pairing, null, 2)}\n`, 'utf-8');
    // complete 标记最后落盘：中断的备份没有该文件，verify 拒绝。
    await fsp.writeFile(path.join(dest, 'COMPLETE'), `${manifest.createdAt}\n`, 'utf-8');

    return {
        exitCode: 0,
        report: {
            ok: true,
            backupDir: dest,
            files: manifest.totals.files,
            bytes: manifest.totals.bytes,
            durationMs: Date.now() - startedAt,
            backupManifestSha256: manifestHash,
            codeVersion: manifest.codeVersion
        }
    };
}

async function cmdVerifyBackup(flags) {
    const backupDir = String(flags.backup || '');
    if (!backupDir || !fs.existsSync(backupDir)) throw new Error('--backup <dir> 须指向备份目录');
    const manifestPath = path.join(backupDir, 'backup-manifest.json');
    let manifest;
    try {
        manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
    } catch (error) {
        throw new Error(`备份清单不可读：${error.message}`);
    }
    if (!fs.existsSync(path.join(backupDir, 'COMPLETE'))) {
        return { exitCode: 1, report: { ok: false, error: '备份不完整（缺 COMPLETE 标记，可能被中断）——必须重新备份', issues: ['备份不完整（缺 COMPLETE 标记）'] } };
    }

    const issues = [];
    let checked = 0;
    let bytesVerified = 0;
    let items = manifest.items || [];
    const sample = Number(flags.sample);
    if (Number.isInteger(sample) && sample > 0 && sample < items.length) {
        // 随机抽验（确定性 LCG 种子，报告可复现）。
        const seed = Number(flags['sample-seed']) || 20261115;
        let state = seed;
        const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
        const picked = new Set();
        while (picked.size < sample) picked.add(Math.floor(next() * items.length));
        items = items.filter((_, index) => picked.has(index));
    }
    for (const item of items) {
        const abs = path.join(backupDir, item.path);
        try {
            const stat = await fsp.stat(abs);
            if (stat.size !== item.size) {
                issues.push(`${item.path}: size 不一致（清单 ${item.size}，实际 ${stat.size}）`);
                continue;
            }
            const hash = await sha256File(abs);
            if (hash !== item.sha256) {
                issues.push(`${item.path}: sha256 不一致（清单 ${String(item.sha256).slice(0, 19)}…，实际 ${hash.slice(0, 19)}…）`);
                continue;
            }
            checked += 1;
            bytesVerified += item.size;
        } catch (error) {
            issues.push(`${item.path}: 读取失败 ${error.message}`);
        }
    }
    return {
        exitCode: issues.length === 0 ? 0 : 1,
        report: {
            ok: issues.length === 0,
            backupDir,
            sampled: items.length !== (manifest.items || []).length,
            listedFiles: (manifest.items || []).length,
            verifiedFiles: checked,
            bytesVerified,
            issues
        }
    };
}

// ── TDB 配置解析 ─────────────────────────────────────────────────────────

// config.env 解析（沿用 eval/lib/profile.js 的"刻意不用 dotenv"约定：
// 先看清内容再决定搬哪些；不整体写入 process.env）。
function loadConfigEnv(root) {
    const file = path.join(root, 'config.env');
    const parsed = {};
    if (!fs.existsSync(file)) return parsed;
    for (const line of fs.readFileSync(file, 'utf-8').split(/\r?\n/)) {
        if (line.trim().startsWith('#')) continue;
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match) continue;
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        parsed[match[1]] = value;
    }
    return parsed;
}

function tdbConfig(root, overrides = {}) {
    const env = { ...loadConfigEnv(root), ...process.env };
    return {
        enabled: true,
        rootPath: path.resolve(root, env.TDB_KNOWLEDGE_ROOT_PATH || 'knowledge'),
        storePath: path.resolve(root, env.TDB_KNOWLEDGE_STORE_PATH || 'VectorStoreTDB'),
        apiKey: env.API_Key || undefined,
        apiUrl: env.API_URL || undefined,
        model: env.TDB_KNOWLEDGE_MODEL || env.WhitelistEmbeddingModel || 'google/gemini-embedding-001',
        dimension: Number(env.TDB_KNOWLEDGE_DIMENSION || env.VECTORDB_DIMENSION) || 3072,
        ...overrides
    };
}

// ── 三层一致性审计（§3.2.2） ─────────────────────────────────────────────

async function cmdAudit(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const config = tdbConfig(root, {
        ...(flags.knowledge ? { rootPath: path.resolve(String(flags.knowledge)) } : {}),
        ...(flags.store ? { storePath: path.resolve(String(flags.store)) } : {})
    });
    const { TDBKnowledgeManager } = require(path.join(REPO_ROOT, 'TDBKnowledge'));
    const { chunkText } = require(path.join(REPO_ROOT, 'TextChunker'));
    const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
    let TriviumDB = null;
    try {
        const module = require(path.join(REPO_ROOT, 'node_modules', 'triviumdb'));
        TriviumDB = module.TriviumDB || module.default || module;
    } catch (error) {
        throw new Error(`triviumdb 不可用：${error.message}`);
    }

    const helper = new TDBKnowledgeManager(config); // 仅复用 _isIndexable/_resolveLibrary 等纯配置方法
    const metaPath = path.join(config.storePath, 'tdb_knowledge_meta.sqlite');
    if (!fs.existsSync(metaPath)) throw new Error(`meta DB 不存在：${metaPath}（store 未初始化？）`);
    const metaDb = new Database(metaPath, { readonly: true });

    const issues = [];
    const report = { ok: false, root: config.rootPath, store: config.storePath, layers: {} };

    // ── Layer 1：磁盘 ↔ SQLite files ──
    const diskFiles = new Map(); // relPath → {library, checksum, size}
    const walkDisk = async (dir) => {
        let entries;
        try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (error) {
            issues.push(`磁盘扫描失败 ${dir}: ${error.message}`);
            return;
        }
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.') || helper.config.excludeFolders.includes(entry.name)) continue;
                await walkDisk(abs);
            } else if (entry.isFile() && helper._isIndexable(abs)) {
                const { library, relPath } = helper._resolveLibrary(abs);
                const content = await fsp.readFile(abs, 'utf-8');
                diskFiles.set(relPath, {
                    library,
                    checksum: crypto.createHash('sha256').update(content).digest('hex'),
                    size: Buffer.byteLength(content)
                });
            }
        }
    };
    await walkDisk(config.rootPath);

    const sqliteFiles = new Map(); // relPath → row
    for (const row of metaDb.prepare('SELECT library, path, checksum, size, doc_node_id FROM files').all()) {
        sqliteFiles.set(row.path, row);
    }
    const layer1 = { new: [], missing: [], changed: [], diskCount: diskFiles.size, sqliteCount: sqliteFiles.size };
    for (const [relPath] of diskFiles) {
        if (!sqliteFiles.has(relPath)) layer1.new.push(relPath);
    }
    for (const [relPath, row] of sqliteFiles) {
        const disk = diskFiles.get(relPath);
        if (!disk) {
            layer1.missing.push(relPath);
            continue;
        }
        if (disk.checksum !== row.checksum || disk.size !== row.size) layer1.changed.push(relPath);
    }
    for (const name of layer1.new) issues.push(`L1 new（磁盘有、索引无）: ${name}`);
    for (const name of layer1.missing) issues.push(`L1 missing（索引有、磁盘无）: ${name}`);
    for (const name of layer1.changed) issues.push(`L1 changed（checksum/size 不一致）: ${name}`);

    const queueCounts = {};
    for (const row of metaDb.prepare('SELECT status, COUNT(*) AS n FROM ingest_queue GROUP BY status').all()) {
        queueCounts[row.status] = row.n;
    }
    const queueActive = (queueCounts.pending || 0) + (queueCounts.retry || 0) + (queueCounts.processing || 0) + (queueCounts.failed || 0);
    if (queueActive > 0) issues.push(`L1 队列未收敛: ${JSON.stringify(queueCounts)}`);
    layer1.queue = queueCounts;

    // ── Layer 2：SQLite ↔ 重算 chunks ──
    // 与摄取管线（TDBKnowledge._upsertFileUnlocked）同源：raw → chunkText → filter(Boolean)。
    // M2 在两处同步插入 normalizeForIndex（§3.2.1）。
    const layer2 = { checked: 0, mismatched: [] };
    const chunkRowsByPath = new Map();
    for (const row of metaDb.prepare('SELECT library, path, chunk_index, node_id, checksum FROM chunks ORDER BY library, path, chunk_index').all()) {
        if (!chunkRowsByPath.has(row.path)) chunkRowsByPath.set(row.path, []);
        chunkRowsByPath.get(row.path).push(row);
    }
    for (const [relPath] of diskFiles) {
        const rows = chunkRowsByPath.get(relPath);
        if (!rows || rows.length === 0) continue; // layer1 的 new/changed 已覆盖
        const content = await fsp.readFile(path.join(config.rootPath, relPath), 'utf-8');
        const chunks = chunkText(content).filter(Boolean);
        const problems = [];
        if (rows.length !== chunks.length) {
            problems.push(`块数不一致（sqlite=${rows.length}, 重算=${chunks.length}）`);
        }
        for (let index = 0; index < rows.length; index++) {
            if (rows[index].chunk_index !== index) {
                problems.push(`chunk_index 不连续: 位置 ${index} 实为 ${rows[index].chunk_index}`);
                break;
            }
        }
        for (let index = 0; index < Math.min(rows.length, chunks.length); index++) {
            const expectedHash = crypto.createHash('sha256').update(chunks[index]).digest('hex');
            if (rows[index].checksum !== expectedHash) {
                problems.push(`chunk ${index} checksum 不一致（sqlite=${String(rows[index].checksum).slice(0, 12)}…, 重算=${expectedHash.slice(0, 12)}…）`);
                break;
            }
        }
        layer2.checked += 1;
        if (problems.length) {
            layer2.mismatched.push({ path: relPath, problems });
            issues.push(`L2 ${relPath}: ${problems.join('; ')}`);
        }
    }

    // ── Layer 3：SQLite ↔ TriviumDB 节点/payload ──
    let manifestDimension = null;
    try {
        const manifest = JSON.parse(await fsp.readFile(path.join(config.storePath, 'embedding-manifest.json'), 'utf-8'));
        manifestDimension = Number(manifest.embedding?.dimension) || null;
    } catch {
        issues.push('L3 embedding-manifest.json 不可读');
    }
    const openDim = manifestDimension || config.dimension;

    const libraries = [...new Set([
        ...metaDb.prepare('SELECT DISTINCT library FROM files').all().map((r) => r.library),
        ...metaDb.prepare('SELECT DISTINCT library FROM chunks').all().map((r) => r.library)
    ])];
    const layer3 = { libraries: {} };
    for (const library of libraries) {
        const dbPath = path.join(config.storePath, `${library}.tdb`);
        const entry = { dbPath, docNodes: 0, chunkNodes: 0, missingNodes: [], orphanNodes: [], payloadMismatches: [], dimension: null };
        layer3.libraries[library] = entry;
        if (!fs.existsSync(dbPath)) {
            issues.push(`L3 库文件缺失: ${dbPath}`);
            continue;
        }
        const db = new TriviumDB(dbPath, { dim: openDim, dtype: 'f32', syncMode: 'normal', storageMode: 'mmap', autoBuildQuiver: true, loadTextIndex: true });
        try {
            entry.dimension = db.dim();
            if (entry.dimension !== openDim) issues.push(`L3 ${library}: 维度不一致（store=${entry.dimension}, manifest=${openDim}）`);
            const nodeIds = new Set(db.allNodeIds());

            const fileRows = metaDb.prepare('SELECT path, doc_node_id, checksum FROM files WHERE library = ?').all(library);
            const chunkRows = metaDb.prepare('SELECT path, chunk_index, node_id, checksum FROM chunks WHERE library = ? ORDER BY path, chunk_index').all(library);
            const expectedIds = new Set();
            for (const row of fileRows) {
                if (row.doc_node_id != null) {
                    expectedIds.add(row.doc_node_id);
                    if (!nodeIds.has(row.doc_node_id)) {
                        entry.missingNodes.push(`doc ${row.path} node=${row.doc_node_id}`);
                    } else {
                        const payload = db.getPayload(row.doc_node_id) || {};
                        if (payload.type !== 'document' || payload.source_path !== row.path || payload.checksum !== row.checksum) {
                            entry.payloadMismatches.push(`doc ${row.path} payload 不一致`);
                        }
                    }
                }
            }
            for (const row of chunkRows) {
                expectedIds.add(row.node_id);
                if (!nodeIds.has(row.node_id)) {
                    entry.missingNodes.push(`chunk ${row.path}#${row.chunk_index} node=${row.node_id}`);
                    continue;
                }
                const payload = db.getPayload(row.node_id) || {};
                let previewMismatch = null;
                const disk = diskFiles.get(row.path);
                if (disk) {
                    const content = await fsp.readFile(path.join(config.rootPath, row.path), 'utf-8');
                    const chunks = chunkText(content).filter(Boolean);
                    const expectedPreview = (chunks[row.chunk_index] || '').slice(0, 500);
                    if (payload.text_preview !== expectedPreview) previewMismatch = `text_preview 不一致（chunk ${row.chunk_index}）`;
                }
                if (payload.type !== 'chunk' || payload.source_path !== row.path
                    || payload.chunk_index !== row.chunk_index || payload.checksum !== row.checksum || previewMismatch) {
                    entry.payloadMismatches.push(`chunk ${row.path}#${row.chunk_index}: ${previewMismatch || 'payload 字段不一致'}`);
                }
            }
            entry.docNodes = fileRows.filter((r) => r.doc_node_id != null).length;
            entry.chunkNodes = chunkRows.length;
            for (const id of nodeIds) {
                if (!expectedIds.has(id)) entry.orphanNodes.push(`node=${id}`);
            }
            if (entry.missingNodes.length) issues.push(`L3 ${library}: 缺 ${entry.missingNodes.length} 个预期节点（如 ${entry.missingNodes[0]}）`);
            if (entry.orphanNodes.length) issues.push(`L3 ${library}: ${entry.orphanNodes.length} 个孤儿节点（如 ${entry.orphanNodes.slice(0, 2).join(', ')}）`);
            if (entry.payloadMismatches.length) issues.push(`L3 ${library}: ${entry.payloadMismatches.length} 处 payload 不一致（如 ${entry.payloadMismatches[0]}）`);
        } finally {
            try { db.close(); } catch { /* 关闭失败不掩盖审计结论 */ }
        }
    }

    // 磁盘上多余的 .tdb 库文件（如已删除知识库的残留 store）。
    for (const file of fs.existsSync(config.storePath) ? fs.readdirSync(config.storePath) : []) {
        if (!file.endsWith('.tdb')) continue;
        const name = path.basename(file, '.tdb');
        if (!libraries.includes(name)) {
            issues.push(`L3 孤儿库文件（knowledge/ 无对应目录）: ${file}`);
        }
    }

    report.layers = {
        diskVsSqlite: layer1,
        sqliteVsChunks: { checked: layer2.checked, mismatchedCount: layer2.mismatched.length, mismatched: layer2.mismatched.slice(0, 20) },
        sqliteVsTrivium: layer3
    };
    report.ok = issues.length === 0;
    report.issueCount = issues.length;
    report.issues = issues.slice(0, 100);
    metaDb.close();
    return { exitCode: report.ok ? 0 : 1, report };
}

// ── 全量重建演练（耗时测算，§3.1.2 步骤 1/4） ────────────────────────────

async function cmdEstimateRebuild(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const tempStore = flags.store
        ? path.resolve(String(flags.store))
        : await fsp.mkdtemp(path.join(os.tmpdir(), 'tdb-estimate-'));
    const timeoutMs = Number(flags['timeout-ms']) || 25 * 60 * 1000;
    const pollMs = Math.max(200, Number(flags['poll-ms']) || 3000);
    const config = tdbConfig(root, { storePath: tempStore, fullScanOnStartup: true });
    const { TDBKnowledgeManager } = require(path.join(REPO_ROOT, 'TDBKnowledge'));

    await fsp.mkdir(tempStore, { recursive: true });
    const manager = new TDBKnowledgeManager(config);
    const startedAt = Date.now();
    const silenced = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    console.log = (...args) => silenced.push(['log', args.join(' ')]);
    console.warn = (...args) => silenced.push(['warn', args.join(' ')]);
    console.error = (...args) => silenced.push(['error', args.join(' ')]);
    let report;
    try {
        await manager.initialize();
        // 等待队列收敛：连续 2 次（间隔 ≥pollMs）pendingIngestCount()===0 且 worker 空闲。
        // 「watcher 尚未入队时短暂为零不构成成功」（§3.6.1）——初始扫描在
        // initialize() 内同步完成入队，这里再要求两次连续空轮询兜底。
        let consecutiveQuiet = 0;
        while (Date.now() - startedAt < timeoutMs) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            const status = manager.getIngestStatus();
            const busy = status.pending + status.retry + status.processing;
            if (busy === 0 && !manager.isQueueWorkerRunning) {
                consecutiveQuiet += 1;
                if (consecutiveQuiet >= 2) break;
            } else {
                consecutiveQuiet = 0;
            }
        }
        const elapsedMs = Date.now() - startedAt;
        const status = manager.getIngestStatus();
        const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));
        const metaDb = new Database(path.join(tempStore, 'tdb_knowledge_meta.sqlite'), { readonly: true });
        const filesIndexed = metaDb.prepare('SELECT COUNT(*) AS n FROM files').get().n;
        const chunksIndexed = metaDb.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
        metaDb.close();
        const converged = status.pending + status.retry + status.processing === 0 && consecutiveQuiet >= 2;
        report = {
            ok: converged && status.failed === 0 && manager.initialized,
            tempStore,
            elapsedMs,
            converged,
            timeout: !converged,
            filesIndexed,
            chunksIndexed,
            embeddingVectors: filesIndexed + chunksIndexed,
            queueStatus: status,
            timedOutMs: timeoutMs,
            errors: silenced.filter(([level]) => level === 'error').map(([, message]) => message).slice(0, 20)
        };
    } finally {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
        await manager.shutdown().catch(() => undefined);
    }
    return { exitCode: report.ok ? 0 : 1, report };
}

// ── 重开后查询冒烟（每库 文本+向量 检索） ────────────────────────────────

async function cmdSmoke(flags) {
    const root = path.resolve(String(flags.root || REPO_ROOT));
    const config = tdbConfig(root, {
        ...(flags.knowledge ? { rootPath: path.resolve(String(flags.knowledge)) } : {}),
        ...(flags.store ? { storePath: path.resolve(String(flags.store)) } : {}),
        fullScanOnStartup: false
    });
    const { TDBKnowledgeManager } = require(path.join(REPO_ROOT, 'TDBKnowledge'));
    const { chunkText } = require(path.join(REPO_ROOT, 'TextChunker'));
    const Database = require(path.join(REPO_ROOT, 'node_modules', 'better-sqlite3'));

    const manager = new TDBKnowledgeManager(config);
    await manager.initialize();
    try {
        if (!manager.initialized || manager.initializationState !== 'compatible') {
            throw new Error(`store 未处于 compatible 状态：${JSON.stringify(manager.getInitializationStatus())}`);
        }
        const metaDb = new Database(path.join(config.storePath, 'tdb_knowledge_meta.sqlite'), { readonly: true });
        const results = {};
        let allOk = true;
        for (const library of manager.listLibraries()) {
            const sample = metaDb.prepare('SELECT path FROM files WHERE library = ? ORDER BY path LIMIT 1').get(library);
            if (!sample) {
                results[library] = { ok: false, error: '库内无文件（sqlite files 表为空）' };
                allOk = false;
                continue;
            }
            const content = await fsp.readFile(path.join(config.rootPath, sample.path), 'utf-8');
            const firstChunk = chunkText(content).filter(Boolean)[0] || content.slice(0, 400);
            const query = firstChunk.slice(0, 120).replace(/\s+/g, ' ').trim();
            const hits = await manager.search(query, { libraries: [library], topK: 5 });
            const topFile = hits[0]?.sourceFile || null;
            const entry = {
                ok: hits.length > 0 && topFile === sample.path,
                query: query.slice(0, 60),
                expectedFile: sample.path,
                topFile,
                hitCount: hits.length,
                topScore: hits[0]?.score ?? null
            };
            if (!entry.ok) allOk = false;
            results[library] = entry;
        }
        metaDb.close();
        return { exitCode: allOk ? 0 : 1, report: { ok: allOk, libraries: results } };
    } finally {
        await manager.shutdown().catch(() => undefined);
    }
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseArgs(rest);
    const commands = {
        lock: cmdLock,
        unlock: cmdUnlock,
        'lease-status': cmdLeaseStatus,
        backup: cmdBackup,
        'verify-backup': cmdVerifyBackup,
        audit: cmdAudit,
        'estimate-rebuild': cmdEstimateRebuild,
        smoke: cmdSmoke
    };
    const handler = commands[command];
    if (!handler) {
        process.stderr.write(`未知或缺失子命令：${command || '(none)'}（可用：${Object.keys(commands).join(' / ')}）\n`);
        process.exit(1);
    }
    let outcome;
    try {
        outcome = await handler(flags);
    } catch (error) {
        const report = { ok: false, error: error.message, code: error.code || null, lease: error.details?.lease || null };
        if (flags.json) {
            process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
            process.stderr.write(`✗ ${error.message}\n`);
            if (report.lease) process.stderr.write(`  当前租约：${JSON.stringify(report.lease)}\n`);
        }
        process.exit(1);
    }
    if (flags.json) {
        process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
    } else if (outcome.report?.issues?.length) {
        for (const issue of outcome.report.issues) process.stderr.write(`✗ ${issue}\n`);
    }
    process.exit(outcome.exitCode);
}

if (require.main === module) {
    main().catch((error) => {
        process.stderr.write(`✗ ${error.stack || error.message}\n`);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    tdbConfig,
    loadConfigEnv,
    cmdLock,
    cmdUnlock,
    cmdLeaseStatus,
    cmdBackup,
    cmdVerifyBackup,
    cmdAudit,
    cmdEstimateRebuild,
    cmdSmoke
};
