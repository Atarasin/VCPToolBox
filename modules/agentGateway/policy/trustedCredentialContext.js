const { normalizeString } = require('./shared/normalize');

/**
 * 可信凭据上下文与 transport 私有凭据通道（§3.3 / §5.1 / M1.S4）。
 *
 * - presented token 只能经 Symbol 私有通道在 transport → executor →
 *   backend client 之间流动：Symbol 属性不参与 JSON 序列化，天然不进
 *   params、日志与审计；销毁时调用 clearPresentedCredential 清引用。
 * - in-process adapter 只接受组装根注入、由同一 resolver 产生的
 *   trustedCredentialContext；来自 MCP params 的 authContext 一律经
 *   sanitizeUntrustedAuthContext 剥离身份与 trusted 标记。
 */

const TRANSPORT_PRESENTED_CREDENTIAL = Symbol('agentGateway.presentedCredential');
const TRUSTED_CONTEXT_MARKER = Symbol('agentGateway.trustedCredentialContext');

const UNTRUSTED_STRIP_FIELDS = Object.freeze([
    'trusted',
    'credentialId',
    'credentialRevision',
    'credentialSubject',
    'boundAgentId',
    'effectiveAgentId',
    'scopes',
    'isAdmin'
]);

function attachPresentedCredential(target, token) {
    if (target && typeof target === 'object') {
        target[TRANSPORT_PRESENTED_CREDENTIAL] = normalizeString(token);
    }
    return target;
}

function getPresentedCredential(source) {
    if (!source || typeof source !== 'object') {
        return '';
    }
    return normalizeString(source[TRANSPORT_PRESENTED_CREDENTIAL]);
}

function clearPresentedCredential(target) {
    if (target && typeof target === 'object' && TRANSPORT_PRESENTED_CREDENTIAL in target) {
        delete target[TRANSPORT_PRESENTED_CREDENTIAL];
    }
}

/**
 * 组装根用同一 resolver 的产物构建可信上下文；其余来源不可标记 trusted。
 */
function createTrustedCredentialContext(authContext) {
    if (!authContext || typeof authContext !== 'object') {
        throw new TypeError('createTrustedCredentialContext requires a resolver-produced authContext');
    }
    const wrapped = { ...authContext, trusted: true };
    Object.defineProperty(wrapped, TRUSTED_CONTEXT_MARKER, { value: true, enumerable: false });
    return Object.freeze(wrapped);
}

function isTrustedCredentialContext(value) {
    return Boolean(value) && typeof value === 'object' && value[TRUSTED_CONTEXT_MARKER] === true;
}

/**
 * 剥离客户端可伪造的身份与信任字段（§3.2：body 同名字段一律丢弃）。
 */
function sanitizeUntrustedAuthContext(authContext) {
    if (!authContext || typeof authContext !== 'object') {
        return authContext;
    }
    const sanitized = { ...authContext };
    for (const field of UNTRUSTED_STRIP_FIELDS) {
        delete sanitized[field];
    }
    return sanitized;
}

/**
 * backend 双侧解析一致性（§5.1 / M1.S4.T4）：
 * credentialId / credentialSubject / effectiveAgentId 必须一致；
 * revision 差异交由 isSessionCredentialCompatible 判定。
 */
function verifyBackendIdentityConsistency(edgeIdentity, backendIdentity) {
    const mismatches = [];
    for (const field of ['credentialId', 'credentialSubject', 'effectiveAgentId']) {
        const edgeValue = normalizeString(edgeIdentity?.[field]);
        const backendValue = normalizeString(backendIdentity?.[field]);
        if (edgeValue !== backendValue) {
            mismatches.push(field);
        }
    }
    return { consistent: mismatches.length === 0, mismatches };
}

module.exports = {
    TRANSPORT_PRESENTED_CREDENTIAL,
    attachPresentedCredential,
    clearPresentedCredential,
    createTrustedCredentialContext,
    getPresentedCredential,
    isTrustedCredentialContext,
    sanitizeUntrustedAuthContext,
    verifyBackendIdentityConsistency
};
