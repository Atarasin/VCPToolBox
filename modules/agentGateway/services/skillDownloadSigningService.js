'use strict';

const crypto = require('crypto');

/**
 * L3 签名下载服务（§6 / M4.S2）。
 *
 * mint：按 gateway:read 授权后签发短时一次性 URL；载荷含 artifactId、agentId、
 *       ownerKind/id/subject/revision、expiresAt、nonce；不含原 token、cookie
 *       或 opaque admin session id（admin-session owner 只携带 session id 的
 *       sha256 digest，即 session store 的存储键）。
 * redeem：无需原 credential；服务端从 resolver/sessionStore/内置 legacy 状态
 *         重读 owner，校验 subject/revision 仍可用且仍可访问该 agent，再完成
 *         artifact 存在性校验，最后在输出任何响应 body 前原子消费 nonce；
 *         消费后传输失败不恢复。
 *
 * 签名密钥独立（AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET），支持 kid 轮换
 * （当前与前一把）。admin-session 签发的 URL 最长不超过 session 剩余 TTL。
 */

const SIGNING_SECRET_ENV = 'AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET';
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_ADMIN_SESSION_TTL_MS = 30 * 60 * 1000;
const MIN_SECRET_BYTES = 32;

const ADMIN_SESSION_OWNER_KIND = 'admin-session';
const LEGACY_OWNER_KIND = 'legacy';
const CREDENTIAL_OWNER_KIND = 'credential';
const LEGACY_CREDENTIAL_ID = 'legacy-gateway-key';
const ADMIN_SESSION_CREDENTIAL_ID = 'admin-session';

function sha256Hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

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
    // 恒时比较；两侧先 sha256 归一为定长，长度不符的伪造签名不抛异常
    const sigDigest = crypto.createHash('sha256').update(sig, 'utf8').digest();
    const expectedDigest = crypto.createHash('sha256').update(expected, 'utf8').digest();
    if (!crypto.timingSafeEqual(sigDigest, expectedDigest)) return null;
    try {
        return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch (_) { return null; }
}

function createSkillDownloadSigningService({
    signingSecretEnv = process.env[SIGNING_SECRET_ENV],
    downloadNonceStore = null,
    credentialResolver = null,
    adminGatewaySessionStore = null,
    checkLegacyCredentialStatus = null,
    now = () => Date.now()
} = {}) {
    const keys = loadSigningKeys(signingSecretEnv);

    function isConfigured() {
        return Boolean(keys && keys.length > 0 && downloadNonceStore);
    }

    /**
     * mint：从 authContext 提取 owner 快照，签发一次性下载 URL token。
     * 调用方已完成 gateway:read 授权与 format/artifact 校验。
     */
    function mintDownloadToken({ authContext, agentId, artifactId, ttlMs }) {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing not configured (no production nonce store or signing key)' };
        }
        if (!downloadNonceStore.production) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing requires a production nonce store' };
        }
        if (!authContext?.credentialId) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'mint requires an authenticated credential owner' };
        }
        const timestamp = now();
        let maxTtl = ttlMs || DEFAULT_TTL_MS;
        let ownerKind = CREDENTIAL_OWNER_KIND;
        let ownerId = authContext.credentialId;
        if (authContext.credentialId === ADMIN_SESSION_CREDENTIAL_ID) {
            ownerKind = ADMIN_SESSION_OWNER_KIND;
            // §6：载荷不得含 opaque session id——只携带其 sha256 digest
            //（session store 的存储键），redeem 按 digest 重读 owner。
            const trustedSessionId = authContext.trustedSessionId;
            if (!trustedSessionId) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session identity unavailable for mint' };
            }
            ownerId = sha256Hex(trustedSessionId);
            // admin-session 签发的 URL 最长不超过该 session 剩余 TTL
            const sessionExpiresAt = Date.parse(authContext.credentialRecord?.expiresAt || '');
            if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= timestamp) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session expired' };
            }
            maxTtl = Math.min(maxTtl, sessionExpiresAt - timestamp, MAX_ADMIN_SESSION_TTL_MS);
        } else if (authContext.credentialId === LEGACY_CREDENTIAL_ID) {
            ownerKind = LEGACY_OWNER_KIND;
        }
        const expiresAt = timestamp + maxTtl;
        const nonce = crypto.randomBytes(32).toString('base64url');
        const payload = {
            artifactId,
            agentId,
            ownerKind,
            ownerId,
            ownerSubject: authContext.credentialSubject,
            ownerRevision: authContext.credentialRevision,
            expiresAt,
            nonce
        };
        const token = buildSignedToken({ keys, payload });
        return { ok: true, token, expiresAt, nonce };
    }

    /**
     * 校验签名 → expiry → agent → 重读 owner（不消费 nonce）。
     */
    async function verifyDownloadToken({ token, agentId }) {
        if (!isConfigured()) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'download signing not configured' };
        }
        const payload = verifySignedToken({ keys, token });
        if (!payload) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'invalid or tampered download token' };
        }
        const timestamp = now();
        if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= timestamp) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'download token expired' };
        }
        if (agentId && payload.agentId !== agentId) {
            return { ok: false, code: 'AGW_FORBIDDEN', httpStatus: 403, reason: 'token agent mismatch' };
        }
        const ownerCheck = await revalidateOwner(payload);
        if (!ownerCheck.ok) return ownerCheck;
        return { ok: true, payload };
    }

    /**
     * redeem 全序（§6）：签名/expiry/owner 校验 → artifact 存在性校验
     *（`ensureArtifact(payload)`）→ 原子消费 nonce。ensureArtifact 失败不
     * 消费 nonce；消费成功后调用方立即输出 body，传输失败不恢复。
     */
    async function redeemDownloadToken({ token, agentId, ensureArtifact = null }) {
        const verified = await verifyDownloadToken({ token, agentId });
        if (!verified.ok) return verified;
        const payload = verified.payload;

        let artifact = null;
        if (typeof ensureArtifact === 'function') {
            const artifactResult = await ensureArtifact(payload);
            if (!artifactResult || artifactResult.ok !== true) {
                return artifactResult && typeof artifactResult === 'object'
                    ? artifactResult
                    : { ok: false, code: 'AGW_INTERNAL_ERROR', httpStatus: 500, reason: 'artifact resolution failed' };
            }
            artifact = artifactResult.artifact ?? null;
        }

        // 原子消费 nonce（在输出任何 body 前；此后传输失败不恢复）
        const consumed = await downloadNonceStore.consumeOnce(payload.nonce, payload.expiresAt);
        if (!consumed) {
            return { ok: false, code: 'AGW_FORBIDDEN', httpStatus: 403, reason: 'nonce already consumed or expired' };
        }

        return { ok: true, payload, artifact };
    }

    async function revalidateOwner(payload) {
        if (payload.ownerKind === ADMIN_SESSION_OWNER_KIND) {
            if (!adminGatewaySessionStore || typeof adminGatewaySessionStore.verifySessionOwnerByDigest !== 'function') {
                return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'admin session store not available' };
            }
            const result = await adminGatewaySessionStore.verifySessionOwnerByDigest(payload.ownerId);
            if (!result.ok) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session revoked or expired' };
            }
            // revision 相同即同一 session record（含 subject key 未轮换）；
            // session 重建或轮换后旧 token 立即失效
            if (`admin-session:${result.revision}` !== payload.ownerRevision) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'admin session revision changed' };
            }
            return { ok: true };
        }
        if (payload.ownerKind === LEGACY_OWNER_KIND) {
            if (typeof checkLegacyCredentialStatus !== 'function') {
                return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'legacy credential status check not available' };
            }
            const status = checkLegacyCredentialStatus();
            if (!status.ok) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'legacy gateway key disabled or rotated' };
            }
            if (status.credentialRevision !== payload.ownerRevision) {
                return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'legacy gateway key rotated' };
            }
            return { ok: true };
        }
        // 文件 credential owner
        if (!credentialResolver) {
            return { ok: false, code: 'AGW_CONFIG_UNAVAILABLE', httpStatus: 503, reason: 'credential resolver not available' };
        }
        const status = await credentialResolver.checkCredentialStatus(payload.ownerId);
        if (!status.ok) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'owner credential revoked or expired' };
        }
        // §3.4 owner revision compatibility：revision 相同，或同 token digest
        // 的 active -> rotating 过渡；其余变化（换 token、改 scope/绑定）拒绝
        const revisionOk = status.credentialRevision === payload.ownerRevision
            || (status.rotationCompatibleRevision && status.rotationCompatibleRevision === payload.ownerRevision);
        if (!revisionOk) {
            return { ok: false, code: 'AGW_UNAUTHORIZED', httpStatus: 401, reason: 'owner credential revision changed' };
        }
        return { ok: true };
    }

    return Object.freeze({
        isConfigured,
        mintDownloadToken,
        verifyDownloadToken,
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
    MAX_ADMIN_SESSION_TTL_MS,
    createSkillDownloadSigningService,
    loadSigningKeys
};
