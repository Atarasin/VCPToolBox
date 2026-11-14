'use strict';

/**
 * 每专家维护租约（砚尺质量优化设计 §3.6.2）。
 *
 * forge 对同一专家的知识写入（进修 learn / 存量清洗 cleanup / TDB 重建 rebuild）
 * 通过 `Agent/forge/<name>/maintenance-lease.json` 互斥：
 * - 原子独占创建（O_EXCL），heartbeat 续期，finally 释放；
 * - 过期或持约进程已死时可被接管（takeover 记录被顶替方，留审计痕迹）；
 * - 暂停期内的进修入口返回明确的 FORGE_EXPERT_WRITE_PAUSED。
 *
 * 租约是跨进程的（生产 server 与维护 CLI 共用同一文件协议）；
 * TDB 每库索引 Promise 队列不能替代它（那是库内排队，不是专家写锁）。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LEASE_FILE = 'maintenance-lease.json';
const LEASE_MODES = new Set(['learn', 'cleanup', 'rebuild']);
const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000;

class ForgeWritePausedError extends Error {
    constructor(expertName, lease, reason) {
        super(
            `专家 ${expertName} 写入已暂停：存在活动维护租约`
            + `（mode=${lease.mode}, owner=${lease.ownerJobId}${reason ? `, ${reason}` : ''}）`
        );
        this.name = 'ForgeWritePausedError';
        this.code = 'FORGE_EXPERT_WRITE_PAUSED';
        this.status = 409;
        this.details = { expertName, lease, reason: reason || null };
    }
}

function leasePath(baseDir, expertName) {
    return path.join(baseDir, String(expertName || ''), LEASE_FILE);
}

function writeJsonAtomic(filePath, value) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8');
    fs.renameSync(temporary, filePath);
}

function isPidAlive(pid) {
    const numeric = Number(pid);
    if (!Number.isInteger(numeric) || numeric <= 0) return false;
    if (numeric === process.pid) return true;
    try {
        process.kill(numeric, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM'; // EPERM = 进程存在但属别的用户
    }
}

/**
 * 读取租约并评估状态。
 * 返回 null（无租约/文件损坏且无活跃 PID 可信度）或
 * { lease, active, expired, pidAlive, corrupted }。
 * corrupted 的租约保守视为活动（不能因为文件可被破坏就放行写入）。
 */
function inspectLease(baseDir, expertName, now = Date.now()) {
    const file = leasePath(baseDir, expertName);
    let lease;
    try {
        lease = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        // 损坏文件：无从判断过期/PID，保守按活动处理，force 接管需显式 --force。
        return { lease: { ownerJobId: null, mode: 'corrupted', pid: null, path: file }, active: true, expired: false, pidAlive: null, corrupted: true };
    }
    if (!lease || typeof lease !== 'object' || !LEASE_MODES.has(lease.mode)) {
        return { lease, active: true, expired: false, pidAlive: null, corrupted: true };
    }
    const expiresAt = Number(lease.expiresAt);
    const expired = !Number.isFinite(expiresAt) || now >= expiresAt;
    // pid<=0（detached，如维护 CLI 编排进程）不依赖进程存活，仅靠过期时间判断；
    // 正常进程租约（pid>0）在进程死亡后可被接管。
    const pidAlive = lease.pid === process.pid
        ? true
        : (Number.isInteger(Number(lease.pid)) && Number(lease.pid) > 0 ? isPidAlive(lease.pid) : null);
    return { lease, active: !expired && pidAlive !== false, expired, pidAlive, corrupted: false };
}

/** 活动租约快照（供日志/错误详情），无活动租约返回 null。 */
function readActiveLease(baseDir, expertName, now = Date.now()) {
    const state = inspectLease(baseDir, expertName, now);
    return state && state.active ? state : null;
}

/** 写入口前置检查：存在活动租约时抛 FORGE_EXPERT_WRITE_PAUSED。 */
function assertExpertWritable(baseDir, expertName, now = Date.now()) {
    const state = readActiveLease(baseDir, expertName, now);
    if (state) {
        const reason = state.corrupted
            ? '租约文件损坏，保守拒绝'
            : (state.expired ? null : state.pidAlive ? null : '持约进程已死，可接管');
        throw new ForgeWritePausedError(expertName, state.lease, reason);
    }
    return true;
}

function createExpertLeaseManager(options = {}) {
    const baseDir = options.baseDir;
    if (typeof baseDir !== 'string' || !baseDir) {
        throw new Error('createExpertLeaseManager 需要 baseDir（Agent/forge 根目录）');
    }
    const ttlMs = Number.isFinite(Number(options.ttlMs)) && Number(options.ttlMs) > 0
        ? Number(options.ttlMs)
        : Number.parseInt(process.env.FORGE_LEASE_TTL_MS || '', 10) || DEFAULT_LEASE_TTL_MS;
    const heartbeatMs = Math.max(1000, Math.floor(ttlMs / 3));
    const now = typeof options.now === 'function' ? options.now : Date.now;

    const held = new Map(); // jobId → handle
    let heartbeatTimer = null;

    function ensureHeartbeatTimer() {
        if (heartbeatTimer) return;
        heartbeatTimer = setInterval(() => {
            for (const handle of held.values()) {
                try {
                    handle.heartbeat();
                } catch {
                    // 单个心跳失败不拖垮其他租约；步骤级 ensureStep 会兜底暴露。
                }
            }
        }, heartbeatMs);
        heartbeatTimer.unref?.();
    }

    function buildLease({ expertName, ownerJobId, mode, superseded = null, detached = false }) {
        const startedAt = now();
        return {
            ownerJobId: String(ownerJobId),
            mode,
            pid: detached ? 0 : process.pid,
            heartbeatAt: new Date(startedAt).toISOString(),
            expiresAt: startedAt + ttlMs,
            acquiredAt: new Date(startedAt).toISOString(),
            superseded
        };
    }

    /**
     * 独占获取。冲突时：同 owner 幂等续期；过期/持约进程已死则接管；
     * 其余抛 ForgeWritePausedError。
     * detached=true 供维护 CLI 编排：租约不绑定进程存活（pid=0），
     * 由 TTL + 显式 unlock 管辖——编排者崩溃则等 TTL 自然过期。
     * force=true 允许接管"损坏"租约（无法判定过期/PID 的文件），
     * 供人工恢复使用；正常路径绝不自动 force。
     */
    function acquire({ expertName, ownerJobId, mode, detached = false, force = false }) {
        if (!LEASE_MODES.has(mode)) {
            throw new Error(`无效租约 mode：${mode}（允许 ${[...LEASE_MODES].join(' | ')}）`);
        }
        const normalizedOwner = String(ownerJobId || '');
        if (!String(expertName || '').trim() || !normalizedOwner) {
            throw new Error('acquire 需要 expertName 与 ownerJobId');
        }
        const file = leasePath(baseDir, expertName);
        fs.mkdirSync(path.dirname(file), { recursive: true });

        const lease = buildLease({ expertName, ownerJobId: normalizedOwner, mode, detached });
        try {
            const descriptor = fs.openSync(file, 'wx'); // 原子独占创建
            fs.writeFileSync(descriptor, JSON.stringify(lease, null, 2), 'utf-8');
            fs.closeSync(descriptor);
            return register(expertName, normalizedOwner, lease);
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }

        const state = inspectLease(baseDir, expertName, now());
        if (!state) {
            // 竞态：检查前被释放——重试一次独占创建。
            try {
                const descriptor = fs.openSync(file, 'wx');
                fs.writeFileSync(descriptor, JSON.stringify(lease, null, 2), 'utf-8');
                fs.closeSync(descriptor);
                return register(expertName, normalizedOwner, lease);
            } catch (retryError) {
                if (retryError.code !== 'EEXIST') throw retryError;
            }
            throw new ForgeWritePausedError(expertName, { mode: 'unknown', ownerJobId: null }, '独占创建竞态，稍后重试');
        }
        if (state.lease.ownerJobId === normalizedOwner && !state.corrupted) {
            // 幂等：同 owner 再次 acquire（如 resume）→ 续期即可。
            // 记录 pid 若非本进程且已死（旧进程崩溃后同 jobId 续跑），
            // 改写为当前 pid——否则第三方按 pid-dead 接管会拿走运行中任务的写权。
            // pid=0（detached）是刻意的"无进程绑定"，不是死进程，不改写。
            const recordedPid = Number(state.lease.pid);
            const stalePid = Number.isInteger(recordedPid)
                && recordedPid > 0
                && recordedPid !== process.pid
                && isPidAlive(recordedPid) === false;
            const refreshedLease = {
                ...buildLease({ expertName, ownerJobId: normalizedOwner, mode, detached }),
                acquiredAt: state.lease.acquiredAt,
                pid: stalePid ? process.pid : (Number.isInteger(recordedPid) ? recordedPid : process.pid),
                superseded: stalePid
                    ? { ownerJobId: state.lease.ownerJobId, mode: state.lease.mode, reason: 'pid-dead-resume', at: new Date(now()).toISOString() }
                    : (state.lease.superseded || null)
            };
            writeJsonAtomic(file, refreshedLease);
            return register(expertName, normalizedOwner, refreshedLease);
        }
        if (!state.active && !state.corrupted) {
            // 过期或持约进程已死 → 接管，留审计痕迹。
            const takeover = buildLease({
                expertName,
                ownerJobId: normalizedOwner,
                mode,
                detached,
                superseded: {
                    ownerJobId: state.lease.ownerJobId || null,
                    mode: state.lease.mode,
                    reason: state.expired ? 'expired' : 'pid-dead',
                    at: new Date(now()).toISOString()
                }
            });
            writeJsonAtomic(file, takeover);
            return register(expertName, normalizedOwner, takeover);
        }
        if (state.corrupted && force) {
            // 人工恢复：损坏租约显式接管，被顶替内容留痕（能读多少记多少）。
            const takeover = buildLease({
                expertName,
                ownerJobId: normalizedOwner,
                mode,
                detached,
                superseded: {
                    ownerJobId: state.lease?.ownerJobId || null,
                    mode: state.lease?.mode || 'corrupted',
                    reason: 'force-corrupted',
                    at: new Date(now()).toISOString()
                }
            });
            writeJsonAtomic(file, takeover);
            return register(expertName, normalizedOwner, takeover);
        }
        throw new ForgeWritePausedError(
            expertName,
            state.lease,
            state.corrupted ? '租约文件损坏（人工清理文件或 lock --force 接管后重试）' : null
        );
    }

    function register(expertName, ownerJobId, lease) {
        const file = leasePath(baseDir, expertName);
        const handle = {
            expertName,
            ownerJobId,
            lease,
            path: file,
            heartbeat() {
                const current = inspectLease(baseDir, expertName, now());
                if (!current || current.lease.ownerJobId !== ownerJobId || current.corrupted) {
                    const error = new ForgeWritePausedError(expertName, current?.lease || { mode: 'missing', ownerJobId: null }, '租约已被接管或丢失');
                    handle.lost = true;
                    throw error;
                }
                const refreshed = {
                    ...current.lease,
                    heartbeatAt: new Date(now()).toISOString(),
                    expiresAt: now() + ttlMs
                };
                writeJsonAtomic(file, refreshed);
                handle.lease = refreshed;
            },
            release() {
                held.delete(ownerJobId);
                if (held.size === 0 && heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                try {
                    const current = inspectLease(baseDir, expertName, now());
                    if (current && !current.corrupted && current.lease.ownerJobId === ownerJobId) {
                        fs.unlinkSync(file);
                        return true;
                    }
                    return false; // 已被接管，不删别人的租约
                } catch {
                    return false;
                }
            }
        };
        held.set(ownerJobId, handle);
        ensureHeartbeatTimer();
        return handle;
    }

    /** 步骤执行前二次检查：租约仍归本 job 且可续期，否则抛 FORGE_EXPERT_WRITE_PAUSED。 */
    function ensureStepLease(jobId, expertName) {
        const handle = held.get(String(jobId));
        if (!handle) {
            // 进程重启后 driveJob 不持有句柄（resume 场景应在入口重新 acquire）。
            throw new ForgeWritePausedError(expertName, { mode: 'missing', ownerJobId: String(jobId) }, '本进程不持有该 job 的租约');
        }
        handle.heartbeat(); // 丢失/被接管时抛 ForgeWritePausedError
        return true;
    }

    function releaseAll() {
        for (const handle of [...held.values()]) handle.release();
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    }

    function status() {
        return {
            baseDir,
            ttlMs,
            heartbeatMs,
            held: [...held.values()].map((handle) => ({
                expertName: handle.expertName,
                ownerJobId: handle.ownerJobId,
                mode: handle.lease.mode,
                expiresAt: handle.lease.expiresAt
            }))
        };
    }

    return { acquire, assertExpertWritable, ensureStepLease, releaseAll, status, leasePath: (expertName) => leasePath(baseDir, expertName) };
}

module.exports = {
    LEASE_FILE,
    LEASE_MODES,
    DEFAULT_LEASE_TTL_MS,
    ForgeWritePausedError,
    leasePath,
    inspectLease,
    readActiveLease,
    assertExpertWritable,
    createExpertLeaseManager
};
