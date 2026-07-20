'use strict';

const crypto = require('crypto');

/**
 * L3 签名下载服务（§6 / M4.S2）。
 *
 * mint：按 gateway:read 授权后签发短时一次性 URL；载荷含 artifactId、agentId、
 *       ownerKind/id/subject/revision、expiresAt、nonce；不含原 token/cookie。
 * redeem：无需原 credential；服务端从 resolver/sessionStore 重读 owner，
 *         校验 subject/revision 仍可用且仍可访问该 agent，再原子消费 nonce。
 *
 * 签名密钥独立（AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET），支持 kid 轮换
 * （当前与前一把）。admin-session 签发的 URL 最长不超过 session 剩余 TTL。
 */

const SIGNING_SECRET_ENV = 'AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;
const MIN_SECRET_BYTES = 32;

function loadSigningKeys(rawEnv) {
    if (!rawEnv) return null;
    // 支持 JSON array [{"kid":"k1","secret":"base64"},{"kid":"k0","secret":"base64"}]
    // 或单个 base64 字符串（kid 默认 "default"）
    try {
        const parsed = JSON.parse(rawEnv);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((entry) => ({
                kid: String(entry.kid),
                secret: Buffer.from(entry.secret, 'base64')
            })).filter((k) => k.secret.length >= MIN_SECRET_BYTES);
        }
    } catch (_) { /* not JSON */ }
    const buf = Buffer.from(rawEnv, 'base64');
    if (buf.length >= MIN_SECRET_BYTES) {
        return [{ kid: 'default', secret: buf }];
    }
    return null;
}

function hmacSign(secret, payload) {
    return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

function buildSignedToken({ keys, payload }) {
    const current = keys[0];
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const sig = hmacSign(current.secret, `${current.kid}.${body}`);
    return `${current.kid}.${body}.${sig}`;
}

function verifySignedToken({ keys, token }) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [kid, body, sig] = parts;
    const key = keys.find((k) => k.kid === kid);
    if (!key) return null;
    const expected = hmacSign(key.secret, `${kid}.${body}`);
    // 恒时比较
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (_) { return null; }
}

function createSkillDownloadSigningService({
    signingSecretEnv = process.env[SIGNING_SECRET_ENV],
    downloadNonceStore = null,
    credentialResolver = null,
    adminGatewaySessionStore = null,
    now = () => Date.now()
} = {}) {
    const keys = loadSigningKeys(signingSecretEnv);

    function isConfigured() {
        return Boolean(keys && keys.length > 0 && downloadNonceStore);
    }

    /**
     * mint：从 authContext 提取 owner 快照，签发一次性下载 URL token。
     * 调用方已完成 gateway:read 授权。
     */
    function mintDownloadToken({ authContext, agentId, artifactId, ttlMs }) {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing not configured (no production nonce store or signing key)' };
        }
        if (!downloadNonceStore.production) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing requires a production nonce store' };
        }
        const timestamp = now();
        // admin-session 签发的 URL 最长不超过 session 剩余 TTL
        let maxTtl = ttlMs || DEFAULT_TTL_MS;
        if (authContext.credentialId === 'admin-session' && authContext.sessionExpiresAt) {
            const sessionRemaining = authContext.sessionExpiresAt - timestamp;
            if (sessionRemaining <= 0) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session expired' };
            }
            maxTtl = Math.min(maxTtl, sessionRemaining, MAX_ADMIN_SESSION_TTL_MS);
        }
        const expiresAt = timestamp + maxTtl;
        const nonce = crypto.randomBytes(32).toString('base64url');
        const payload = {
            artifactId,
            agentId,
            ownerKind: authContext.credentialId === 'admin-session' ? 'admin-session' : 'credential',
            ownerId: authContext.credentialId,
            ownerSubject: authContext.credentialSubject,
            ownerRevision: authContext.credentialRevision,
            expiresAt,
            nonce
        };
        const token = buildSignedToken({ keys, payload });
        return { ok: true, token, expiresAt, nonce };
    }

    /**
     * redeem：校验签名 → 检查 expiry → 重读 owner → 校验 subject/revision →
     *         原子消费 nonce（在输出任何 body 前）。
     */
    async function redeemDownloadToken({ token, agentId }) {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing not configured' };
        }
        if (!keys) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'no signing keys available' };
        }
        const payload = verifySignedToken({ keys, token });
        if (!payload) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'invalid or tampered download token' };
        }
        const timestamp = now();
        if (payload.expiresAt <= timestamp) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'download token expired' };
        }
        if (agentId && payload.agentId !== agentId) {
            return { ok: false, code: 'AGW_FORBIDDEN', httpStatus: 403, reason: 'token agent mismatch' };
        }

        // 重读 owner，校验 subject/revision 仍可用
        const ownerCheck = await revalidateOwner(payload);
        if (!ownerCheck.ok) return ownerCheck;

        // 原子消费 nonce（在输出任何 body 前）
        const consumed = await downloadNonceStore.consumeOnce(payload.nonce, payload.expiresAt);
        if (!consumed) {
            return { ok: false, code: 'AGW_FORBIDDEN', httpStatus: 403, reason: 'nonce already consumed or expired' };
        }

        return { ok: true, payload };
    }

    async function revalidateOwner(payload) {
        if (payload.ownerKind === 'admin-session') {
            if (!adminGatewaySessionStore) {
                return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'admin session store not available' };
            }
            // admin-session: 只需 session 仍存活（不需要 CSRF，redeem 是 GET）
            const result = await adminGatewaySessionStore.verifySession(payload.ownerId, { requireCsrf: false });
            if (!result.ok) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session revoked or expired' };
            }
            if (result.credentialSubject !== payload.ownerSubject) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'owner subject mismatch' };
            }
            return { ok: true };
        }
        // credential owner
        if (!credentialResolver) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'credential resolver not available' };
        }
        const status = await credentialResolver.checkCredentialStatus(payload.ownerId);
        if (!status.ok) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'owner credential revoked or expired' };
        }
        // revision 必须仍匹配（防止 token 换 credential 继承）
        const currentRevision = `sha256:${crypto.createHash('sha256').update(Buffer.from(JSON.stringify({
            credentialId: status.record.credentialId,
            tokenDigest: status.record.tokenDigest,
            boundAgentId: status.record.boundAgentId,
            allowedAgents: status.record.allowedAgents || null,
            scopes: status.record.scopes,
            status: status.record.status,
            expiresAt: status.record.expiresAt
        }), 'utf8')).digest('hex')}`;
        if (currentRevision !== payload.ownerRevision) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'owner credential revision changed' };
        }
        return { ok: true };
    }

    return Object.freeze({
        isConfigured,
        mintDownloadToken,
        redeemDownloadToken,
        // 仅供测试
        _buildSignedToken: buildSignedToken,
        _verifySignedToken: verifySignedToken,
        _loadSigningKeys: loadSigningKeys
    });
}

module.exports = {
    SIGNING_SECRET_ENV,
    DEFAULT_TTL_MS,
    createSkillDownloadSigningService,
    loadSigningKeys
};
