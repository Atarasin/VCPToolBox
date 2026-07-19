const crypto = require('crypto');

const { computeTokenDigest } = require('./credentialResolver');
const { normalizeString, parseBoolean } = require('./shared/normalize');

/**
 * 内置 credential 归一化（§3.3 / M1.S3）。
 *
 * - `AGENT_GATEWAY_KEY` 合成 `legacy-gateway-key`（unbound、admin scope）。
 *   阶段 A 保留全量跨 agent 权限是有意为之，与现状单一 gateway key 等价。
 * - 有效 Gateway admin session 合成 `admin-session`（unbound、admin），
 *   surface 限制：仅 Native 业务入口；`/mcp` 三 transport 拒绝。
 * - 三个独立开关：`AGENT_GATEWAY_LEGACY_KEY_DISABLED`、
 *   `AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED`、
 *   `AGENT_GATEWAY_LEGACY_SCOPE_NAMES_DISABLED`（后者由 credential schema
 *   loader 消费）。
 * - `authMigration` 指标分别观测 legacy 与 admin-session 使用量。
 * - 内置 legacy credential 与文件 credential token 相同属配置错误：
 *   `detectLegacyTokenCollision` 供 snapshot 校验调用，冲突时拒绝发布。
 */

const LEGACY_CREDENTIAL_ID = 'legacy-gateway-key';
const ADMIN_SESSION_CREDENTIAL_ID = 'admin-session';

function timingSafeStringEqual(left, right) {
    const leftDigest = crypto.createHash('sha256').update(String(left), 'utf8').digest();
    const rightDigest = crypto.createHash('sha256').update(String(right), 'utf8').digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function readMigrationSwitches(env = process.env) {
    return Object.freeze({
        legacyKeyDisabled: parseBoolean(env.AGENT_GATEWAY_LEGACY_KEY_DISABLED, false),
        adminFallbackDisabled: parseBoolean(env.AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED, false),
        legacyScopeNamesDisabled: parseBoolean(env.AGENT_GATEWAY_LEGACY_SCOPE_NAMES_DISABLED, false)
    });
}

function createBuiltinCredentialResolver({
    gatewayKey = process.env.AGENT_GATEWAY_KEY,
    adminSessionStore = null,
    switches = readMigrationSwitches(),
    authMigrationMetrics = null
} = {}) {
    const normalizedGatewayKey = normalizeString(gatewayKey);

    function buildLegacyResult() {
        const record = {
            credentialId: LEGACY_CREDENTIAL_ID,
            boundAgentId: null,
            scopes: ['admin'],
            status: 'active',
            expiresAt: null,
            builtin: 'legacy-gateway-key'
        };
        return {
            ok: true,
            record,
            credentialId: LEGACY_CREDENTIAL_ID,
            credentialSubject: LEGACY_CREDENTIAL_ID,
            credentialRevision: `sha256:${crypto.createHash('sha256')
                .update(`legacy|${normalizedGatewayKey}`, 'utf8').digest('hex')}`
        };
    }

    /**
     * buildGatewayRequestContext 的 resolveBuiltinCredential hook。
     * @param {object} input.token presented token
     * @param {string} input.surface 'native' | 'mcp'（admin-session 仅 native）
     * @param {string} input.adminSessionId 从 cookie 提取的 opaque session id
     * @param {string} input.csrfToken mutation 时呈现的 CSRF token
     * @param {boolean} input.requireCsrf 是否为 cookie-authenticated mutation
     */
    async function resolveBuiltinCredential({
        token = '',
        surface = 'native',
        adminSessionId = '',
        csrfToken = null,
        requireCsrf = false
    } = {}) {
        const normalizedToken = normalizeString(token);

        // 1) legacy gateway key
        if (normalizedToken && normalizedGatewayKey && timingSafeStringEqual(normalizedToken, normalizedGatewayKey)) {
            if (switches.legacyKeyDisabled) {
                authMigrationMetrics?.record?.({ credentialId: LEGACY_CREDENTIAL_ID, outcome: 'rejected-disabled' });
                return {
                    matched: true,
                    result: { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'legacy gateway key disabled', credentialId: LEGACY_CREDENTIAL_ID }
                };
            }
            authMigrationMetrics?.record?.({ credentialId: LEGACY_CREDENTIAL_ID, outcome: 'accepted' });
            return { matched: true, result: buildLegacyResult() };
        }

        // 2) admin session（仅 Native 业务入口；不接受 token 呈现）
        const normalizedSessionId = normalizeString(adminSessionId);
        if (!normalizedToken && normalizedSessionId) {
            if (surface !== 'native') {
                authMigrationMetrics?.record?.({ credentialId: ADMIN_SESSION_CREDENTIAL_ID, outcome: 'rejected-surface' });
                return {
                    matched: true,
                    result: { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'admin session not accepted on this transport', credentialId: ADMIN_SESSION_CREDENTIAL_ID }
                };
            }
            if (switches.adminFallbackDisabled || !adminSessionStore) {
                authMigrationMetrics?.record?.({ credentialId: ADMIN_SESSION_CREDENTIAL_ID, outcome: 'rejected-disabled' });
                return {
                    matched: true,
                    result: { ok: false, code: 'AGW_UNAUTHORIZED', reason: 'admin session fallback disabled', credentialId: ADMIN_SESSION_CREDENTIAL_ID }
                };
            }
            const verification = await adminSessionStore.verifySession(normalizedSessionId, { csrfToken, requireCsrf });
            if (!verification.ok) {
                authMigrationMetrics?.record?.({ credentialId: ADMIN_SESSION_CREDENTIAL_ID, outcome: 'rejected-invalid' });
                return {
                    matched: true,
                    result: {
                        ok: false,
                        code: verification.code || 'AGW_UNAUTHORIZED',
                        reason: verification.reason || 'admin session invalid',
                        credentialId: ADMIN_SESSION_CREDENTIAL_ID
                    }
                };
            }
            authMigrationMetrics?.record?.({ credentialId: ADMIN_SESSION_CREDENTIAL_ID, outcome: 'accepted' });
            return {
                matched: true,
                result: {
                    ok: true,
                    record: {
                        credentialId: ADMIN_SESSION_CREDENTIAL_ID,
                        boundAgentId: null,
                        scopes: ['admin'],
                        status: 'active',
                        expiresAt: new Date(verification.expiresAt).toISOString(),
                        builtin: 'admin-session',
                        trustedSessionId: normalizedSessionId
                    },
                    credentialId: ADMIN_SESSION_CREDENTIAL_ID,
                    credentialSubject: verification.credentialSubject,
                    credentialRevision: `admin-session:${verification.revision}`
                }
            };
        }

        return { matched: false };
    }

    /**
     * 内置 legacy token 与文件 credential 冲突检测（§3.3）：
     * 冲突属配置错误，调用方必须拒绝发布 security snapshot。
     */
    function detectLegacyTokenCollision(fileSnapshot) {
        if (!normalizedGatewayKey || !fileSnapshot?.available) {
            return { collision: false };
        }
        for (const record of fileSnapshot.records || []) {
            const pepperSecret = fileSnapshot.pepperKeys?.[record.pepperKid];
            if (!pepperSecret) {
                continue;
            }
            const digest = computeTokenDigest(pepperSecret, normalizedGatewayKey);
            if (record.tokenDigest === `hmac-sha256:${digest}`) {
                return { collision: true, credentialId: record.credentialId };
            }
        }
        return { collision: false };
    }

    return Object.freeze({
        LEGACY_CREDENTIAL_ID,
        ADMIN_SESSION_CREDENTIAL_ID,
        switches,
        resolveBuiltinCredential,
        detectLegacyTokenCollision,
        hasLegacyKey: Boolean(normalizedGatewayKey)
    });
}

function createAuthMigrationMetrics() {
    const counters = new Map();
    return {
        record({ credentialId, outcome }) {
            const key = `${credentialId}|${outcome}`;
            counters.set(key, (counters.get(key) || 0) + 1);
        },
        snapshot() {
            const result = {};
            for (const [key, count] of counters.entries()) {
                const [credentialId, outcome] = key.split('|');
                result[credentialId] = result[credentialId] || {};
                result[credentialId][outcome] = count;
            }
            return result;
        }
    };
}

module.exports = {
    ADMIN_SESSION_CREDENTIAL_ID,
    LEGACY_CREDENTIAL_ID,
    createAuthMigrationMetrics,
    createBuiltinCredentialResolver,
    readMigrationSwitches
};
