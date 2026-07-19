const crypto = require('crypto');

const { normalizeString } = require('./shared/normalize');

/**
 * Gateway 专用 admin session 子系统（§3.3 / M1.S3）。
 *
 * - 服务端只保存 session id digest、状态、创建/到期时间、CSRF digest 与
 *   revision；opaque id 与 CSRF token 只在创建响应中出现一次。
 * - subject 派生使用独立 `AGENT_GATEWAY_ADMIN_SUBJECT_KEY`（≥256 bit）；
 *   轮换该 key 时原子撤销全部旧 session。
 * - 多 worker 部署必须注入共享、原子、支持按 expiry 清理的 backend；
 *   仓库内置 in-memory backend 仅供单进程开发/测试（非生产）。
 *   没有生产 store 时 session 创建方返回 503（由调用方依据
 *   `store.production` 判定）。
 */

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const MIN_SUBJECT_KEY_BYTES = 32;

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function decodeSubjectKey(rawKey) {
    const normalized = normalizeString(rawKey);
    if (!normalized) {
        return null;
    }
    // 支持 base64 或足够长的原始字符串；解码后必须 ≥256 bit
    let decoded = Buffer.from(normalized, 'base64');
    if (decoded.length < MIN_SUBJECT_KEY_BYTES) {
        decoded = Buffer.from(normalized, 'utf8');
    }
    if (decoded.length < MIN_SUBJECT_KEY_BYTES) {
        return null;
    }
    return decoded;
}

/**
 * 仅供单进程开发/测试的内存 backend（非生产）。
 */
function createInMemoryAdminSessionBackend() {
    const records = new Map();
    return {
        production: false,
        async put(idDigest, record) {
            records.set(idDigest, record);
        },
        async get(idDigest) {
            return records.get(idDigest) || null;
        },
        async delete(idDigest) {
            return records.delete(idDigest);
        },
        async deleteAll() {
            records.clear();
        },
        async cleanupExpired(nowTimestamp) {
            for (const [idDigest, record] of records.entries()) {
                if (record.expiresAt <= nowTimestamp) {
                    records.delete(idDigest);
                }
            }
        }
    };
}

function createAdminGatewaySessionStore({
    backend = null,
    subjectKey = process.env.AGENT_GATEWAY_ADMIN_SUBJECT_KEY,
    sessionTtlMs = DEFAULT_SESSION_TTL_MS,
    now = () => Date.now()
} = {}) {
    const decodedSubjectKey = decodeSubjectKey(subjectKey);
    const subjectKeyFingerprint = decodedSubjectKey
        ? sha256Hex(decodedSubjectKey.toString('base64')).slice(0, 16)
        : null;
    const sessionBackend = backend || createInMemoryAdminSessionBackend();

    function isConfigured() {
        return Boolean(decodedSubjectKey);
    }

    function deriveSubject(opaqueSessionId) {
        return `admin-session:${crypto.createHmac('sha256', decodedSubjectKey).update(opaqueSessionId, 'utf8').digest('hex')}`;
    }

    /**
     * 创建 session。返回 opaque id 与 CSRF token（仅此一次）。
     */
    async function createSession() {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', reason: 'AGENT_GATEWAY_ADMIN_SUBJECT_KEY is not configured (>=256 bit required)' };
        }
        const timestamp = now();
        const opaqueSessionId = crypto.randomBytes(32).toString('base64url');
        const csrfToken = crypto.randomBytes(32).toString('base64url');
        const record = {
            idDigest: sha256Hex(opaqueSessionId),
            csrfDigest: sha256Hex(csrfToken),
            status: 'active',
            createdAt: timestamp,
            expiresAt: timestamp + sessionTtlMs,
            revision: crypto.randomBytes(8).toString('hex'),
            subjectKeyFingerprint
        };
        await sessionBackend.put(record.idDigest, record);
        return {
            ok: true,
            opaqueSessionId,
            csrfToken,
            expiresAt: record.expiresAt,
            revision: record.revision,
            credentialSubject: deriveSubject(opaqueSessionId)
        };
    }

    /**
     * 校验 session（可选校验 CSRF）。subject key 轮换后旧 session 全部失效。
     */
    async function verifySession(opaqueSessionId, { csrfToken = null, requireCsrf = false } = {}) {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE' };
        }
        const normalizedId = normalizeString(opaqueSessionId);
        if (!normalizedId) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'no session presented' };
        }
        const timestamp = now();
        await sessionBackend.cleanupExpired(timestamp);
        const record = await sessionBackend.get(sha256Hex(normalizedId));
        if (!record || record.status !== 'active') {
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'session not found or inactive' };
        }
        if (record.expiresAt <= timestamp) {
            await sessionBackend.delete(record.idDigest);
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'session expired' };
        }
        if (record.subjectKeyFingerprint !== subjectKeyFingerprint) {
            // subject key 已轮换：原子撤销旧 session
            await sessionBackend.delete(record.idDigest);
            return { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'subject key rotated; session revoked' };
        }
        if (requireCsrf) {
            const normalizedCsrf = normalizeString(csrfToken);
            if (!normalizedCsrf || sha256Hex(normalizedCsrf) !== record.csrfDigest) {
                return { ok: false, code: 'AGW_FORBIDDEN', reason: 'missing or mismatched CSRF token' };
            }
        }
        return {
            ok: true,
            record,
            credentialSubject: deriveSubject(normalizedId),
            revision: record.revision,
            expiresAt: record.expiresAt
        };
    }

    async function revokeSession(opaqueSessionId) {
        const normalizedId = normalizeString(opaqueSessionId);
        if (!normalizedId) {
            return false;
        }
        return sessionBackend.delete(sha256Hex(normalizedId));
    }

    async function revokeAllSessions() {
        await sessionBackend.deleteAll();
    }

    return Object.freeze({
        production: Boolean(backend && backend.production),
        isConfigured,
        createSession,
        verifySession,
        revokeSession,
        revokeAllSessions
    });
}

module.exports = {
    DEFAULT_SESSION_TTL_MS,
    MIN_SUBJECT_KEY_BYTES,
    createAdminGatewaySessionStore,
    createInMemoryAdminSessionBackend
};
