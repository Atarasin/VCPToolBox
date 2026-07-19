const {
    ACTION_SCOPES
} = require('../contracts/authPolicyCatalog');
const { AGW_ERROR_CODES } = require('../contracts/errorCodes');
const {
    createSlidingWindowRateLimit,
    checkSlidingWindowRateLimit
} = require('../transport/shared/slidingWindowRateLimit');
const { normalizeString } = require('./shared/normalize');

/**
 * 统一决议入口 `buildGatewayRequestContext()`（§3.2 / M1.S2）。
 *
 * 所有入口在 schema 校验、ensureAgentId 和 service 调用之前先经过这里：
 * - 凭据呈现双通道（Bearer / x-agent-gateway-key）不一致 → 401（§3.3）。
 * - path/query/body/URI 多来源 target candidate 规范化后必须相等，
 *   冲突 → AGW_INVALID_REQUEST，不做静默选边（§3.2）。
 * - 决议树：bound / unbound / admin(unbound-only)，见 §3.2。
 * - 客户端 body 中与身份同名的字段一律丢弃，不能覆盖认证结果。
 * - 认证失败按 client IP 滑动窗口限速（只计失败），429 + Retry-After，
 *   输出结构化审计与 authFailure 指标（§3.3）。
 */

const DEFAULT_AUTH_FAILURE_LIMIT = 10;
const DEFAULT_AUTH_FAILURE_WINDOW_MS = 60_000;

const IDENTITY_FIELDS = Object.freeze([
    'credentialId',
    'credentialRevision',
    'credentialSubject',
    'boundAgentId',
    'targetAgentId',
    'effectiveAgentId'
]);

function failure(code, reason, extra = {}) {
    return { ok: false, code, reason, ...extra };
}

/**
 * 提取 presented token（§3.3）：两通道同时呈现且不一致 → 冲突。
 */
function extractPresentedCredential(headers = {}) {
    const normalizedHeaders = {};
    for (const [key, value] of Object.entries(headers || {})) {
        normalizedHeaders[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
    }
    const gatewayKey = normalizeString(normalizedHeaders['x-agent-gateway-key']);
    const authorization = normalizeString(normalizedHeaders.authorization);
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    const bearerToken = bearerMatch ? normalizeString(bearerMatch[1]) : '';

    if (gatewayKey && bearerToken) {
        if (gatewayKey !== bearerToken) {
            return { conflict: true, token: '', source: '' };
        }
        return { conflict: false, token: gatewayKey, source: 'both' };
    }
    if (gatewayKey) {
        return { conflict: false, token: gatewayKey, source: 'x-agent-gateway-key' };
    }
    if (bearerToken) {
        return { conflict: false, token: bearerToken, source: 'authorization-bearer' };
    }
    return { conflict: false, token: '', source: '' };
}

/**
 * 多来源 target candidate 冲突检测（§3.2 / M1.S2.T2）。
 * @returns {{ ok: true, target: string|null } | { ok: false }}
 */
function resolveTargetCandidates(candidates = {}) {
    const normalized = [];
    for (const [source, value] of Object.entries(candidates)) {
        const candidate = normalizeString(value);
        if (candidate) {
            normalized.push({ source, candidate });
        }
    }
    if (normalized.length === 0) {
        return { ok: true, target: null, sources: [] };
    }
    const first = normalized[0].candidate;
    for (const entry of normalized) {
        if (entry.candidate !== first) {
            return {
                ok: false,
                conflict: {
                    sources: normalized.map(({ source, candidate }) => ({ source, candidate }))
                }
            };
        }
    }
    return { ok: true, target: first, sources: normalized.map((entry) => entry.source) };
}

function createGatewayRequestContextBuilder({
    credentialResolver,
    resolveBuiltinCredential = null,
    authFailureLimit = DEFAULT_AUTH_FAILURE_LIMIT,
    authFailureWindowMs = DEFAULT_AUTH_FAILURE_WINDOW_MS,
    auditLogger = null,
    metrics = null,
    now = () => Date.now()
} = {}) {
    if (!credentialResolver || typeof credentialResolver.authenticate !== 'function') {
        throw new TypeError('createGatewayRequestContextBuilder requires a credentialResolver');
    }

    const failureWindows = new Map();

    function recordAuthFailure({ clientIp, entry, category, credentialId }) {
        metrics?.recordAuthFailure?.({ entry, category });
        // logGatewayOperation(event, payload)：event 为字符串，最终产出
        // `gateway.auth.failure` 结构化事件。
        auditLogger?.logGatewayOperation?.('auth.failure', {
            entry,
            category,
            clientIp: normalizeString(clientIp) || 'unknown',
            ...(credentialId ? { credentialId } : {})
        });
    }

    function checkFailureRateLimit(clientIp) {
        const key = normalizeString(clientIp) || 'unknown';
        let window = failureWindows.get(key);
        if (!window) {
            window = createSlidingWindowRateLimit({ limit: authFailureLimit, windowMs: authFailureWindowMs });
            failureWindows.set(key, window);
        }
        // 只查看不计数：计数在失败发生时进行
        const cutoff = now() - window.windowMs;
        window.timestamps = window.timestamps.filter((timestamp) => timestamp > cutoff);
        if (window.timestamps.length >= window.limit) {
            const retryAfterMs = Math.max(1, window.timestamps[0] + window.windowMs - now());
            return { limited: true, retryAfterMs };
        }
        return { limited: false };
    }

    function countFailure(clientIp) {
        const key = normalizeString(clientIp) || 'unknown';
        let window = failureWindows.get(key);
        if (!window) {
            window = createSlidingWindowRateLimit({ limit: authFailureLimit, windowMs: authFailureWindowMs });
            failureWindows.set(key, window);
        }
        checkSlidingWindowRateLimit(window, now());
    }

    /**
     * @param {object} input
     * @param {object} input.headers 请求 headers（凭据呈现通道）
     * @param {string} input.clientIp 认证失败限速主体
     * @param {object} input.targetCandidates 各来源 target（path/query/body/uri…）
     * @param {boolean} input.requiresAgent 该操作是否需要 agent 作用域
     * @param {string} input.entry 审计入口标识（http/ws/admin-bridge…）
     * @param {object} input.requestContext 既有请求上下文（body 同名身份字段被丢弃）
     */
    async function buildGatewayRequestContext({
        headers = {},
        presentedToken = undefined,
        clientIp = '',
        targetCandidates = {},
        requiresAgent = true,
        entry = 'unknown',
        requestContext = {},
        authContext = {},
        requireCsrf = false
    } = {}) {
        const rateLimitState = checkFailureRateLimit(clientIp);
        if (rateLimitState.limited) {
            return failure(AGW_ERROR_CODES.RATE_LIMITED, 'authentication failure rate limit exceeded', {
                httpStatus: 429,
                retryAfterMs: rateLimitState.retryAfterMs
            });
        }

        let token = '';
        if (presentedToken !== undefined) {
            token = normalizeString(presentedToken);
        } else {
            const extracted = extractPresentedCredential(headers);
            if (extracted.conflict) {
                countFailure(clientIp);
                recordAuthFailure({ clientIp, entry, category: 'dual-channel-mismatch' });
                return failure(AGW_ERROR_CODES.UNAUTHORIZED, 'conflicting credentials presented on both channels', { httpStatus: 401 });
            }
            token = extracted.token;
        }

        // 内置 credential（legacy gateway key / admin session）优先于文件 credential 解析；
        // 两者 token 冲突在 snapshot 校验层拒绝（M1.S3）。
        let authResult = null;
        if (resolveBuiltinCredential) {
            const builtin = await resolveBuiltinCredential({ token, headers, requestContext, entry, requireCsrf });
            if (builtin?.matched) {
                authResult = builtin.result;
            }
        }
        if (!authResult) {
            authResult = await credentialResolver.authenticate(token);
        }

        if (!authResult.ok) {
            if (authResult.code === 'AGW_CONFIG_UNAVAILABLE') {
                return failure(AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'security configuration unavailable', { httpStatus: 503 });
            }
            countFailure(clientIp);
            recordAuthFailure({
                clientIp,
                entry,
                category: authResult.reason || 'invalid-token',
                credentialId: authResult.credentialId
            });
            return failure(AGW_ERROR_CODES.UNAUTHORIZED, authResult.reason || 'authentication failed', { httpStatus: 401 });
        }

        const record = authResult.record;
        const boundAgentId = normalizeString(record.boundAgentId) || null;
        const scopes = Array.isArray(record.scopes) ? record.scopes : [];
        const isAdmin = scopes.includes('admin');

        const targetResolution = resolveTargetCandidates(targetCandidates);
        if (!targetResolution.ok) {
            return failure(AGW_ERROR_CODES.INVALID_REQUEST, 'conflicting target agent candidates', {
                httpStatus: 400,
                conflict: targetResolution.conflict
            });
        }
        const targetAgentId = targetResolution.target;

        let effectiveAgentId = null;
        if (boundAgentId) {
            // 绑定 credential：决议树无 admin 分支（admin 仅 unbound，配置层已强制）
            if (!targetAgentId || targetAgentId === boundAgentId) {
                effectiveAgentId = boundAgentId;
            } else {
                return failure(AGW_ERROR_CODES.FORBIDDEN, 'target agent differs from bound agent', { httpStatus: 403 });
            }
        } else {
            if (!targetAgentId) {
                if (requiresAgent) {
                    return failure(AGW_ERROR_CODES.INVALID_REQUEST, 'agent-scoped operation requires a target agent', { httpStatus: 400 });
                }
                effectiveAgentId = null;
            } else if (isAdmin) {
                effectiveAgentId = targetAgentId;
            } else {
                const allowedAgents = Array.isArray(record.allowedAgents) ? record.allowedAgents : [];
                if (!allowedAgents.includes(targetAgentId)) {
                    return failure(AGW_ERROR_CODES.FORBIDDEN, 'target agent outside credential scope', { httpStatus: 403 });
                }
                effectiveAgentId = targetAgentId;
            }
        }

        // 写回身份字段；来自客户端 body/context 的同名字段一律丢弃。
        const identity = {
            credentialId: authResult.credentialId,
            credentialRevision: authResult.credentialRevision,
            credentialSubject: authResult.credentialSubject,
            boundAgentId,
            targetAgentId,
            effectiveAgentId
        };
        const sanitizedRequestContext = { ...requestContext };
        const sanitizedAuthContext = { ...authContext };
        for (const field of IDENTITY_FIELDS) {
            delete sanitizedRequestContext[field];
            delete sanitizedAuthContext[field];
        }
        Object.assign(sanitizedRequestContext, identity, { agentId: effectiveAgentId });
        Object.assign(sanitizedAuthContext, identity, { agentId: effectiveAgentId });

        return {
            ok: true,
            credential: record,
            scopes,
            isAdmin,
            ...identity,
            requestContext: sanitizedRequestContext,
            authContext: sanitizedAuthContext,
            snapshotRevision: authResult.snapshotRevision || null
        };
    }

    /**
     * 两层授权（§3.5 / M1.S2.T3）：凭据层 scope 检查 + 既有 agent 策略层。
     * 任一层拒绝即整体拒绝；scope 不足统一 AGW_FORBIDDEN。
     */
    function authorizeTarget(context, {
        credentialAction,
        agentPolicyCheck = null
    } = {}) {
        if (!context?.ok) {
            return failure(AGW_ERROR_CODES.UNAUTHORIZED, 'context is not authenticated', { httpStatus: 401 });
        }
        const action = normalizeString(credentialAction);
        if (!action || !Object.prototype.hasOwnProperty.call(ACTION_SCOPES, action)) {
            return failure(AGW_ERROR_CODES.INTERNAL_ERROR, `unknown credentialAction "${action}"`, { httpStatus: 500 });
        }
        if (action !== 'authenticated') {
            const requiredScopes = ACTION_SCOPES[action];
            const granted = context.scopes.some((scope) => requiredScopes.includes(scope));
            if (!granted) {
                return failure(AGW_ERROR_CODES.FORBIDDEN, `credential lacks scope for "${action}"`, { httpStatus: 403 });
            }
        }
        if (typeof agentPolicyCheck === 'function') {
            const policyResult = agentPolicyCheck(context);
            if (policyResult && policyResult.ok === false) {
                return failure(AGW_ERROR_CODES.FORBIDDEN, policyResult.reason || 'agent policy denied', { httpStatus: 403 });
            }
        }
        return { ok: true };
    }

    return Object.freeze({
        buildGatewayRequestContext,
        authorizeTarget
    });
}

module.exports = {
    DEFAULT_AUTH_FAILURE_LIMIT,
    DEFAULT_AUTH_FAILURE_WINDOW_MS,
    createGatewayRequestContextBuilder,
    extractPresentedCredential,
    resolveTargetCandidates
};
