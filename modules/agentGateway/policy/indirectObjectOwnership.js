const { normalizeString } = require('./shared/normalize');
const { isSessionCredentialCompatible } = require('./sessionCredentialCompatibility');

/**
 * 间接对象（job / event stream）所有权与收养（§3.4 / M1.S6）。
 *
 * - 创建时固化 owner snapshot：{ credentialSubject, credentialId,
 *   credentialRevision, effectiveAgentId, trustedSessionId }，另存
 *   credential record 快照供 revision compatibility 判定。
 * - 读取/取消/resource/SSE 入口先按对象查 owner，再以 owner 的
 *   effectiveAgentId 为 target 执行 §3.2；客户端声明仅作一致性断言。
 * - trustedSessionId 两情形：存活不匹配 → 403；正常终止 → 同 subject +
 *   revision 兼容可原子收养（吊销销毁不适用收养）。
 * - 文件 `admin` credential 可跨 owner 运维并记录原 owner；
 *   Native `admin-session` 不能跨另一个 admin session 的 owner，也不能收养。
 */

const SESSION_STATES = Object.freeze({
    ALIVE: 'alive',
    TERMINATED_NORMALLY: 'terminated-normally',
    DESTROYED_REVOKED: 'destroyed-revoked',
    UNKNOWN: 'unknown'
});

function captureOwnerSnapshot(context) {
    if (!context?.ok) {
        throw new TypeError('captureOwnerSnapshot requires an authenticated gateway request context');
    }
    return Object.freeze({
        credentialSubject: normalizeString(context.credentialSubject),
        credentialId: normalizeString(context.credentialId),
        credentialRevision: normalizeString(context.credentialRevision),
        effectiveAgentId: normalizeString(context.effectiveAgentId) || null,
        trustedSessionId: normalizeString(context.trustedSessionId || context.credential?.trustedSessionId) || null,
        // revision compatibility 需要的 record 快照（不含 secret）
        credentialRecord: context.credential ? Object.freeze({
            credentialId: normalizeString(context.credential.credentialId),
            credentialSubject: normalizeString(context.credentialSubject),
            tokenDigest: normalizeString(context.credential.tokenDigest) || null,
            boundAgentId: context.credential.boundAgentId || null,
            allowedAgents: context.credential.allowedAgents,
            scopes: context.credential.scopes,
            status: context.credential.status,
            expiresAt: context.credential.expiresAt || null
        }) : null
    });
}

function isFileAdminCredential(context) {
    return Boolean(context?.isAdmin) &&
        context.credentialId !== 'admin-session' &&
        !context.credential?.builtin?.startsWith?.('admin-session');
}

/**
 * @param {object} input.owner captureOwnerSnapshot 产物
 * @param {object} input.requesterContext buildGatewayRequestContext 产物
 * @param {string} input.requesterSessionId 请求呈现的受信任 session（或 null）
 * @param {string} input.ownerSessionState SESSION_STATES 之一（服务端判定）
 * @returns {{ allowed, adoption?, crossOwnerAdmin?, code?, reason? }}
 */
function authorizeIndirectAccess({
    owner,
    requesterContext,
    requesterSessionId = null,
    ownerSessionState = SESSION_STATES.UNKNOWN,
    now = Date.now()
} = {}) {
    if (!owner) {
        return { allowed: false, code: 'AGW_NOT_FOUND', reason: 'object not found' };
    }
    if (!requesterContext?.ok) {
        return { allowed: false, code: 'AGW_UNAUTHORIZED', reason: 'requester is not authenticated' };
    }

    // 文件 admin credential：跨 owner 运维，记录原 owner。
    if (isFileAdminCredential(requesterContext)) {
        return { allowed: true, crossOwnerAdmin: true, originalOwner: owner };
    }

    const requesterSubject = normalizeString(requesterContext.credentialSubject);
    if (requesterSubject !== owner.credentialSubject) {
        return { allowed: false, code: 'AGW_FORBIDDEN', reason: 'owner subject mismatch' };
    }

    // revision compatibility：仅同 token digest 的 active -> rotating 可继承。
    if (normalizeString(requesterContext.credentialRevision) !== owner.credentialRevision) {
        const requesterRecord = requesterContext.credential || null;
        const compatibility = isSessionCredentialCompatible(owner.credentialRecord, {
            credentialId: requesterRecord?.credentialId,
            credentialSubject: requesterContext.credentialSubject,
            tokenDigest: requesterRecord?.tokenDigest || null,
            boundAgentId: requesterRecord?.boundAgentId || null,
            allowedAgents: requesterRecord?.allowedAgents,
            scopes: requesterRecord?.scopes,
            status: requesterRecord?.status,
            expiresAt: requesterRecord?.expiresAt || null
        }, { now });
        if (!compatibility.compatible) {
            return { allowed: false, code: 'AGW_FORBIDDEN', reason: `owner revision incompatible: ${compatibility.reason}` };
        }
    }

    if (!owner.trustedSessionId) {
        return { allowed: true };
    }

    const presentedSession = normalizeString(requesterSessionId);
    if (presentedSession === owner.trustedSessionId) {
        return { allowed: true };
    }

    if (ownerSessionState === SESSION_STATES.ALIVE || ownerSessionState === SESSION_STATES.UNKNOWN) {
        // 存活（或无法判定）而不匹配 → 403
        return { allowed: false, code: 'AGW_FORBIDDEN', reason: 'trusted session mismatch' };
    }
    if (ownerSessionState === SESSION_STATES.DESTROYED_REVOKED) {
        return { allowed: false, code: 'AGW_FORBIDDEN', reason: 'owner session destroyed by revocation; adoption not applicable' };
    }

    // 正常终止 → 收养。admin-session 不能收养（其 owner 隔离按 subject 已保证
    // 跨 session 不同 subject；同 subject 情形只剩同一 opaque session，不构成收养面）。
    if (requesterContext.credentialId === 'admin-session') {
        return { allowed: false, code: 'AGW_FORBIDDEN', reason: 'admin-session cannot adopt indirect objects' };
    }
    return {
        allowed: true,
        adoption: {
            previousTrustedSessionId: owner.trustedSessionId,
            newTrustedSessionId: presentedSession || null
        }
    };
}

/**
 * 收养后的原子 owner 替换：返回新的冻结 owner snapshot（调用方负责原子写回并
 * 记录 adoption 审计事件）。
 */
function applyAdoption(owner, adoption) {
    return Object.freeze({
        ...owner,
        trustedSessionId: adoption.newTrustedSessionId
    });
}

module.exports = {
    SESSION_STATES,
    applyAdoption,
    authorizeIndirectAccess,
    captureOwnerSnapshot,
    isFileAdminCredential
};
