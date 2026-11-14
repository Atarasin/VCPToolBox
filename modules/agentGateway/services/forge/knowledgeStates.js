'use strict';

/**
 * 知识发布状态机与物理区域（设计 §2.2，M2.S1 T11）。
 *
 * 核心原则：发布状态由"物理位置 + 发布清单"共同表达，不能只写 frontmatter。
 * candidate / needs_review / quarantine 一律落在活动 knowledge/ 根之外——
 * TDB 对 knowledge/ 递归扫描，任何库内"隔离目录"都会继续被检索。
 *
 * 处置台账（disposition ledger）是可恢复处置清单的单一记录源：
 * 每次移动记录 from → to / 理由 / 判定 / 恢复路径，append-only JSONL。
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ── 状态与流转表 ─────────────────────────────────────────────────────────

const STATES = Object.freeze({
    CANDIDATE: 'candidate',
    NEEDS_REVIEW: 'needs_review',
    QUARANTINE: 'quarantine',
    PUBLISHING: 'publishing',
    ACTIVE: 'active',
    ACTIVE_LEGACY: 'active-legacy'
});

// §2.2 状态表的合法流转（publishing 失败必须 demote 到 needs_review，
// 且等待 TDB unlink 队列消化后才能重新发布——由 waitForUnlink 收敛把关）。
const ALLOWED_TRANSITIONS = Object.freeze(new Map([
    [STATES.CANDIDATE, new Set([STATES.NEEDS_REVIEW, STATES.QUARANTINE, STATES.PUBLISHING])],
    [STATES.NEEDS_REVIEW, new Set([STATES.CANDIDATE, STATES.QUARANTINE, STATES.PUBLISHING])],
    [STATES.QUARANTINE, new Set([STATES.NEEDS_REVIEW])], // 隔离区只能进复核，不得直接发布
    [STATES.PUBLISHING, new Set([STATES.ACTIVE, STATES.NEEDS_REVIEW])],
    [STATES.ACTIVE, new Set([STATES.QUARANTINE, STATES.NEEDS_REVIEW])],
    [STATES.ACTIVE_LEGACY, new Set([STATES.ACTIVE, STATES.NEEDS_REVIEW, STATES.QUARANTINE])]
]));

const NON_ACTIVE_STATES = new Set([STATES.CANDIDATE, STATES.NEEDS_REVIEW, STATES.QUARANTINE]);

function assertTransition(from, to) {
    if (!ALLOWED_TRANSITIONS.has(from)) {
        throw invalidTransition(from, to, `未知来源状态 ${from}`);
    }
    if (!ALLOWED_TRANSITIONS.get(from).has(to)) {
        throw invalidTransition(from, to, `不允许 ${from} → ${to}`);
    }
    return true;
}

function invalidTransition(from, to, reason) {
    const error = new Error(`知识状态流转被拒绝：${reason}`);
    error.code = 'FORGE_KNOWLEDGE_STATE_TRANSITION_INVALID';
    error.details = { from, to, reason };
    return error;
}

// ── 区域路径解析 ─────────────────────────────────────────────────────────

/**
 * 非活跃状态的物理区域（全部在活动 knowledge/ 之外）：
 * - candidate      Agent/forge/runs/<jobId>/candidates/<library>/
 * - needs_review   Agent/forge/<expert>/review/<library>/（专家复核区）
 *                  或 Agent/forge/runs/<jobId>/review/<library>/（run 级）
 * - quarantine     Agent/forge/<expert>/quarantine/<library>/
 * publishing/active 的物理位置就是 knowledge/<library>/（由发布器负责）。
 */
function resolveZonePath({ state, forgeRoot, expertName, jobId = null, library = 'Root', fileName }) {
    if (!NON_ACTIVE_STATES.has(state)) {
        const error = new Error(`resolveZonePath 只解析非活跃状态，收到 ${state}`);
        error.code = 'FORGE_KNOWLEDGE_STATE_ZONE_INVALID';
        throw error;
    }
    let zoneDir;
    if (state === STATES.CANDIDATE) {
        if (!jobId) throw new Error('candidate 区域需要 jobId');
        zoneDir = path.join(forgeRoot, 'runs', jobId, 'candidates', library);
    } else if (state === STATES.NEEDS_REVIEW) {
        zoneDir = jobId
            ? path.join(forgeRoot, 'runs', jobId, 'review', library)
            : path.join(forgeRoot, expertName, 'review', library);
    } else {
        zoneDir = path.join(forgeRoot, expertName, 'quarantine', library);
    }
    return fileName ? path.join(zoneDir, fileName) : zoneDir;
}

/** 守卫：目标路径必须在 knowledge 根之外（§2.2 禁止库内隔离）。 */
function assertOutsideKnowledge(targetPath, knowledgeRoot) {
    const relative = path.relative(path.resolve(knowledgeRoot), path.resolve(targetPath));
    const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    if (inside) {
        const error = new Error(`非活跃知识必须落在 knowledge/ 之外：${targetPath}`);
        error.code = 'FORGE_KNOWLEDGE_ZONE_INSIDE_LIBRARY';
        error.details = { targetPath, knowledgeRoot };
        throw error;
    }
    return true;
}

// ── 处置台账（可恢复处置清单） ────────────────────────────────────────────

function createDispositionLedger(ledgerPath) {
    async function append(entry) {
        const record = {
            id: `disp_${crypto.randomBytes(8).toString('hex')}`,
            at: new Date().toISOString(),
            ...entry
        };
        await fsp.mkdir(path.dirname(ledgerPath), { recursive: true });
        await fsp.appendFile(ledgerPath, `${JSON.stringify(record)}\n`, 'utf-8');
        return record;
    }

    async function readAll() {
        try {
            const raw = await fsp.readFile(ledgerPath, 'utf-8');
            return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
    }

    return { ledgerPath, append, readAll };
}

/**
 * 物理移动一个知识文件并记录台账。
 * - 目标存在时拒绝（不静默覆盖，红线 6）；
 * - moveKind=copy 保留原件（candidate 快照场景）；
 * - 返回台账记录与最终路径。
 */
async function moveKnowledgeFile({ ledger, from, to, reason, fromState, toState, moveKind = 'move' }) {
    assertTransition(fromState, toState);
    const fromAbs = path.resolve(from);
    const toAbs = path.resolve(to);
    if (fs.existsSync(toAbs)) {
        const error = new Error(`目标已存在，拒绝覆盖：${toAbs}`);
        error.code = 'FORGE_KNOWLEDGE_MOVE_TARGET_EXISTS';
        error.details = { from: fromAbs, to: toAbs };
        throw error;
    }
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });
    if (moveKind === 'copy') {
        await fsp.copyFile(fromAbs, toAbs);
    } else {
        await fsp.rename(fromAbs, toAbs).catch(async (error) => {
            if (error.code !== 'EXDEV') throw error;
            await fsp.copyFile(fromAbs, toAbs); // 跨设备回退
            await fsp.rm(fromAbs);
        });
    }
    return ledger.append({
        action: 'move',
        moveKind,
        from: fromAbs,
        to: toAbs,
        fromState,
        toState,
        reason: String(reason || ''),
        restoreHint: moveKind === 'copy'
            ? `原件仍在 ${fromAbs}`
            : `恢复：将 ${toAbs} 移回 ${fromAbs}（核对 contentHash 后执行）`
    });
}

// ── demote 与 unlink 收敛 ────────────────────────────────────────────────

/**
 * publishing 失败的 demote：移出 knowledge/ 并等待索引删除收敛。
 * §2.2：不得只移动文件而不等 TDB unlink 队列消化。
 *
 * pollUnlink 需返回"未消化删除/摄取任务数"（生产传 manager 的
 * pendingIngestCount；未知返回 null——按未收敛处理，fail closed）。
 */
async function demoteFromPublishing({ ledger, activePath, knowledgeRoot, forgeRoot, expertName, reason, pollUnlink, timeoutMs = 10 * 60 * 1000, pollIntervalMs = 2000 }) {
    const fileName = path.basename(activePath);
    const library = path.basename(path.dirname(path.resolve(knowledgeRoot, activePath)));
    const toPath = resolveZonePath({ state: STATES.NEEDS_REVIEW, forgeRoot, expertName, library, fileName });
    assertOutsideKnowledge(toPath, knowledgeRoot);
    const record = await moveKnowledgeFile({
        ledger,
        from: path.resolve(knowledgeRoot, activePath),
        to: toPath,
        reason: `publishing 失败 demote：${reason}`,
        fromState: STATES.PUBLISHING,
        toState: STATES.NEEDS_REVIEW
    });
    const converged = await waitForUnlinkConvergence({ pollUnlink, timeoutMs, pollIntervalMs });
    return { record, toPath, converged };
}

async function waitForUnlinkConvergence({ pollUnlink, timeoutMs = 10 * 60 * 1000, pollIntervalMs = 2000 }) {
    const deadline = Date.now() + timeoutMs;
    let quietStreak = 0;
    while (Date.now() < deadline) {
        const pending = typeof pollUnlink === 'function' ? pollUnlink() : null;
        if (pending === 0) {
            quietStreak += 1;
            if (quietStreak >= 2) return true; // 连续两次静默才算收敛（§3.6.1）
        } else {
            quietStreak = 0; // 未知(null)按未收敛处理
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
}

module.exports = {
    STATES,
    ALLOWED_TRANSITIONS,
    NON_ACTIVE_STATES,
    assertTransition,
    resolveZonePath,
    assertOutsideKnowledge,
    createDispositionLedger,
    moveKnowledgeFile,
    demoteFromPublishing,
    waitForUnlinkConvergence
};
