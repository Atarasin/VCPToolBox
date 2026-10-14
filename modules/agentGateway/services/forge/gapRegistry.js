'use strict';

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

/**
 * 知识缺口登记、学习档案与专家归档（§3.8）。
 *
 * - Agent/forge/<name>/gaps.json：缺口 {id, ts, status: open|closed, subskillId,
 *   question, whyInsufficient, closedAt?}——只追加/关闭，不删除（红线 3）；
 * - Agent/forge/<name>/learning-history.jsonl：学习档案逐行追加
 *   {ts, trigger, scope, status, sources, distilledFiles, costCny, jobId}——
 *   读过什么、学过什么、为什么学（含失败），全部可查；只追加。
 * - Agent/forge/<name>/archived.json：归档标记 {archivedAt, reason?}（2026-10-14）
 *   ——归档 = 退役：不再被定期进修枚举（listExpertNames 默认排除）、不再接受
 *   新的进修；缺口与学习档案仍可只读回看。不做删除，可逆（unarchive）。
 */

async function readJsonArray(filePath) {
    try {
        const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

async function writeJsonAtomic(filePath, payload) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpPath, filePath);
}

function createGapRegistry({ baseDir }) {
    const gapsFile = (expertName) => path.join(baseDir, expertName, 'gaps.json');
    const historyFile = (expertName) => path.join(baseDir, expertName, 'learning-history.jsonl');

    return {
        async appendGap({ expertName, subskillId, question, whyInsufficient }) {
            const gaps = await readJsonArray(gapsFile(expertName));
            const gap = {
                id: `gap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
                ts: new Date().toISOString(),
                status: 'open',
                subskillId,
                question,
                whyInsufficient
            };
            gaps.push(gap);
            await writeJsonAtomic(gapsFile(expertName), gaps);
            return gap;
        },
        async listOpenGaps(expertName) {
            const gaps = await readJsonArray(gapsFile(expertName));
            return gaps.filter((gap) => gap?.status === 'open');
        },
        // 全量缺口（含已关闭）：AdminPanel 专家档案只读视图用（2026-10-13）。
        async readGaps(expertName) {
            return readJsonArray(gapsFile(expertName));
        },
        // 全量学习档案（时间正序，与文件追加顺序一致）；坏行跳过不掩盖其余记录。
        async readLearningHistory(expertName) {
            let raw;
            try {
                raw = await fsp.readFile(historyFile(expertName), 'utf8');
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return [];
                }
                throw error;
            }
            const entries = [];
            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) {
                    continue;
                }
                try {
                    entries.push(JSON.parse(trimmed));
                } catch {
                    // 半行/损坏行跳过——档案是只追加的运行数据。
                }
            }
            return entries;
        },
        // 进修完成后关闭相关 subskill 的 open 缺口（不删除历史条目）。
        async closeGaps(expertName, subskillIds) {
            const ids = new Set(subskillIds);
            const gaps = await readJsonArray(gapsFile(expertName));
            let closed = 0;
            for (const gap of gaps) {
                if (gap?.status === 'open' && (!ids.size || ids.has(gap.subskillId))) {
                    gap.status = 'closed';
                    gap.closedAt = new Date().toISOString();
                    closed += 1;
                }
            }
            if (closed > 0) {
                await writeJsonAtomic(gapsFile(expertName), gaps);
            }
            return closed;
        },
        async appendLearningHistory(expertName, entry) {
            await fsp.mkdir(path.dirname(historyFile(expertName)), { recursive: true });
            await fsp.appendFile(historyFile(expertName), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
        },
        async lastLearningAt(expertName) {
            try {
                const raw = await fsp.readFile(historyFile(expertName), 'utf8');
                const lines = raw.trim().split('\n').filter(Boolean);
                if (lines.length === 0) {
                    return null;
                }
                const last = JSON.parse(lines[lines.length - 1]);
                return last.ts || null;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return null;
                }
                throw error;
            }
        }
    };
}

/**
 * 专家名单（有缺口档案或画像的目录）。baseDir 是唯一口径，必须显式传入
 * 已解析的 forge 产物根目录（服务侧缺省 <repo>/Agent/forge）。
 *
 * 2026-10-13 空转缺陷：baseDir 缺失时这里曾静默返回空名单，导致定期进修
 * 每个周期都「成功触发但 0 个专家」，日志里没有任何错误。故缺失一律抛错；
 * 目录存在但为空/尚未铸造，才是合法的空名单。
 *
 * 归档（2026-10-14）：默认排除带 archived.json 的专家——定期进修按此名单
 * 发起，归档即「不再触发」；只读展示面（AdminPanel）用 includeArchived 全量取。
 */
function listExpertNames({ baseDir, includeArchived = false } = {}) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
        const error = new Error('listExpertNames 需要 baseDir（forge 产物根目录）');
        error.code = 'FORGE_BASE_DIR_UNRESOLVED';
        throw error;
    }
    if (!fs.existsSync(baseDir)) {
        return [];
    }
    return fs.readdirSync(baseDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(baseDir, name, 'gaps.json')) ||
            fs.existsSync(path.join(baseDir, 'blueprints', `${name}.json`)))
        .filter((name) => includeArchived || !fs.existsSync(path.join(baseDir, name, 'archived.json')))
        .sort();
}

function expertArchiveFile(baseDir, expertName) {
    return path.join(baseDir, expertName, 'archived.json');
}

// 归档标记读取：无 marker（或损坏）视为未归档——读侧永不被坏文件阻断。
function readExpertArchive(baseDir, expertName) {
    try {
        const parsed = JSON.parse(fs.readFileSync(expertArchiveFile(baseDir, expertName), 'utf8'));
        return parsed && typeof parsed === 'object' && parsed.archivedAt ? parsed : null;
    } catch {
        return null;
    }
}

// 归档标记写入（原子替换）：归档是标记，不删除任何产物（红线 3 同款纪律）。
async function writeExpertArchive(baseDir, expertName, { reason = null, archivedBy = null } = {}) {
    const file = expertArchiveFile(baseDir, expertName);
    const marker = {
        archivedAt: new Date().toISOString(),
        ...(reason ? { reason } : {}),
        ...(archivedBy ? { archivedBy } : {})
    };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await fsp.rename(tmpPath, file);
    return marker;
}

async function removeExpertArchive(baseDir, expertName) {
    try {
        await fsp.unlink(expertArchiveFile(baseDir, expertName));
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

module.exports = {
    createGapRegistry,
    listExpertNames,
    readExpertArchive,
    writeExpertArchive,
    removeExpertArchive
};
