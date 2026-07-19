const { normalizeString } = require('./shared/normalize');

/**
 * `isSessionCredentialCompatible(snapshot, current)`（§3.6 / M1.S4 / M1.S6）。
 *
 * session/connection 创建时记录 credential owner snapshot；每请求按
 * content hash 重载后调用本函数：
 * - credentialId、credentialSubject、token digest、boundAgentId、
 *   allowedAgents 与 scopes 必须不变；
 * - 当前状态只能为 active/rotating 且未过期；
 * - 唯一允许的语义变化是同 token digest 的 active -> rotating，
 *   旧 session 最长存活到两个 expiresAt 的较早者（缺省按正无穷）。
 */

function normalizeStringArray(value) {
    return Array.isArray(value) ? value.map((item) => normalizeString(item)).filter(Boolean).sort() : [];
}

function arraysEqual(left, right) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
}

function parseExpiry(value) {
    if (!value) {
        return Number.POSITIVE_INFINITY;
    }
    const timestamp = Date.parse(String(value));
    return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function isSessionCredentialCompatible(snapshotRecord, currentRecord, { now = Date.now() } = {}) {
    if (!snapshotRecord || !currentRecord) {
        return { compatible: false, reason: 'missing credential record' };
    }
    if (normalizeString(snapshotRecord.credentialId) !== normalizeString(currentRecord.credentialId)) {
        return { compatible: false, reason: 'credentialId changed' };
    }
    const snapshotSubject = normalizeString(snapshotRecord.credentialSubject || snapshotRecord.credentialId);
    const currentSubject = normalizeString(currentRecord.credentialSubject || currentRecord.credentialId);
    if (snapshotSubject !== currentSubject) {
        return { compatible: false, reason: 'credentialSubject changed' };
    }
    if (normalizeString(snapshotRecord.tokenDigest) !== normalizeString(currentRecord.tokenDigest)) {
        return { compatible: false, reason: 'token digest changed' };
    }
    if (normalizeString(snapshotRecord.boundAgentId) !== normalizeString(currentRecord.boundAgentId)) {
        return { compatible: false, reason: 'boundAgentId changed' };
    }
    if (!arraysEqual(normalizeStringArray(snapshotRecord.allowedAgents), normalizeStringArray(currentRecord.allowedAgents))) {
        return { compatible: false, reason: 'allowedAgents changed' };
    }
    if (!arraysEqual(normalizeStringArray(snapshotRecord.scopes), normalizeStringArray(currentRecord.scopes))) {
        return { compatible: false, reason: 'scopes changed' };
    }

    const currentStatus = normalizeString(currentRecord.status);
    if (currentStatus !== 'active' && currentStatus !== 'rotating') {
        return { compatible: false, reason: `credential status "${currentStatus}" not usable` };
    }
    const effectiveExpiry = Math.min(parseExpiry(snapshotRecord.expiresAt), parseExpiry(currentRecord.expiresAt));
    if (effectiveExpiry <= now) {
        return { compatible: false, reason: 'credential expired' };
    }

    const snapshotStatus = normalizeString(snapshotRecord.status);
    if (snapshotStatus === currentStatus) {
        return { compatible: true, transition: null, effectiveExpiry };
    }
    if (snapshotStatus === 'active' && currentStatus === 'rotating') {
        // 唯一允许的语义变化
        return { compatible: true, transition: 'active->rotating', effectiveExpiry };
    }
    return { compatible: false, reason: `status transition "${snapshotStatus}->${currentStatus}" not allowed` };
}

module.exports = { isSessionCredentialCompatible };
