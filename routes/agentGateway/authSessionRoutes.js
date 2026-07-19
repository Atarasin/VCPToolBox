'use strict';

const {
    AGW_ERROR_CODES,
    normalizeNativeString,
    createNativeRequestContext,
    sendNativeError,
    sendNativeSuccess
} = require('./shared');
const { parseBoolean } = require('../../modules/agentGateway/policy/shared/normalize');

/**
 * Gateway admin session bridge（§3.3 / M1.S3.T3-T4）。
 *
 * `POST /agent_gateway/auth/admin-session` 是唯一的 pre-credential bridge
 * surface（auth policy catalog: authMechanism "adminAuthBridge"）：
 * - 前置由既有 adminAuth 验证（server.js 注入 outerAuthenticated 标记）。
 * - Origin 部署形态二选一：(a) 主端口同源反代（AGENT_GATEWAY_ADMIN_SAME_ORIGIN
 *   =true，SameSite=Strict）；(b) `AGENT_GATEWAY_ADMIN_ORIGINS` 显式 allowlist
 *   + 凭据 CORS + SameSite=Lax + Origin/CSRF 双校验。缺配置时 503。
 * - 无生产 session store（未注入共享 backend 且未显式允许 dev store）时 503。
 */

const ADMIN_SESSION_COOKIE = 'agw_admin_session';
const CSRF_HEADER = 'x-agent-gateway-csrf';

function resolveOriginPolicy(env = process.env) {
    const sameOrigin = parseBoolean(env.AGENT_GATEWAY_ADMIN_SAME_ORIGIN, false);
    const allowlist = normalizeNativeString(env.AGENT_GATEWAY_ADMIN_ORIGINS || '')
        .split(',').map((origin) => origin.trim()).filter(Boolean);
    if (sameOrigin) {
        return { mode: 'same-origin', allowlist: [], sameSite: 'Strict' };
    }
    if (allowlist.length > 0) {
        if (allowlist.includes('*')) {
            return { mode: 'unconfigured', reason: 'wildcard origins are not allowed' };
        }
        return { mode: 'allowlist', allowlist, sameSite: 'Lax' };
    }
    return { mode: 'unconfigured', reason: 'set AGENT_GATEWAY_ADMIN_SAME_ORIGIN=true or AGENT_GATEWAY_ADMIN_ORIGINS' };
}

function parseCookies(req) {
    const header = normalizeNativeString(req.headers?.cookie || '');
    const cookies = {};
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key) {
            cookies[key] = decodeURIComponent(rest.join('=') || '');
        }
    }
    return cookies;
}

function checkOrigin(req, originPolicy) {
    const origin = normalizeNativeString(req.headers?.origin || '');
    if (originPolicy.mode === 'same-origin') {
        // 同源反代下浏览器对 same-origin 请求可不发 Origin；发了则必须匹配 Host
        if (!origin) {
            return { ok: true };
        }
        const host = normalizeNativeString(req.headers?.host || '');
        try {
            const parsed = new URL(origin);
            if (parsed.host === host) {
                return { ok: true };
            }
        } catch (_error) { /* fallthrough */ }
        return { ok: false, reason: 'origin does not match host in same-origin mode' };
    }
    if (originPolicy.mode === 'allowlist') {
        if (!origin) {
            return { ok: false, reason: 'Origin header required in allowlist mode' };
        }
        if (!originPolicy.allowlist.includes(origin)) {
            return { ok: false, reason: 'origin not in allowlist' };
        }
        return { ok: true, corsOrigin: origin };
    }
    return { ok: false, reason: originPolicy.reason };
}

function applyCorsHeaders(res, originCheck) {
    if (originCheck.corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', originCheck.corsOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }
}

function buildSessionCookie({ opaqueSessionId, expiresAt, sameSite, secure }) {
    const attributes = [
        `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(opaqueSessionId)}`,
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Path=/agent_gateway',
        `Expires=${new Date(expiresAt).toUTCString()}`
    ];
    if (secure) {
        attributes.push('Secure');
    }
    return attributes.join('; ');
}

function buildClearCookie() {
    return `${ADMIN_SESSION_COOKIE}=; HttpOnly; Path=/agent_gateway; Expires=${new Date(0).toUTCString()}`;
}

function registerAdminSessionRoutes(router, context) {
    const { adminGatewaySessionStore, builtinCredentialSwitches } = context;
    const originPolicy = resolveOriginPolicy();

    router.post('/auth/admin-session', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.query, 'agent-gateway-admin-session');
        const fail = (status, code, error, details) => sendNativeError(res, {
            status, requestId: requestContext.requestId, startedAt, code, error, details
        });

        // pre-credential bridge：必须已通过既有 adminAuth（Basic/admin_auth cookie）
        if (req.agentGatewayAuth?.outerAuthenticated !== true) {
            return fail(401, AGW_ERROR_CODES.UNAUTHORIZED, 'admin authentication required before creating a gateway admin session');
        }
        if (builtinCredentialSwitches?.adminFallbackDisabled) {
            return fail(503, AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'gateway admin sessions are disabled (AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED)');
        }
        if (!adminGatewaySessionStore) {
            return fail(503, AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'no production admin session store configured');
        }
        const originCheck = checkOrigin(req, originPolicy);
        if (!originCheck.ok) {
            return fail(503, AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'admin session origin policy rejected the request', { reason: originCheck.reason });
        }

        const session = await adminGatewaySessionStore.createSession();
        if (!session.ok) {
            return fail(503, AGW_ERROR_CODES.CONFIG_UNAVAILABLE, session.reason || 'admin session store unavailable');
        }

        applyCorsHeaders(res, originCheck);
        res.setHeader('Set-Cookie', buildSessionCookie({
            opaqueSessionId: session.opaqueSessionId,
            expiresAt: session.expiresAt,
            sameSite: originPolicy.sameSite,
            secure: req.secure || req.headers['x-forwarded-proto'] === 'https'
        }));
        res.setHeader('Cache-Control', 'private, no-store');
        return sendNativeSuccess(res, {
            status: 201,
            requestId: requestContext.requestId,
            startedAt,
            data: {
                csrfToken: session.csrfToken,
                expiresAt: new Date(session.expiresAt).toISOString()
            }
        });
    });

    router.delete('/auth/admin-session', async (req, res) => {
        const startedAt = Date.now();
        const requestContext = createNativeRequestContext(req, req.query, 'agent-gateway-admin-session');
        const fail = (status, code, error, details) => sendNativeError(res, {
            status, requestId: requestContext.requestId, startedAt, code, error, details
        });

        if (!adminGatewaySessionStore) {
            return fail(503, AGW_ERROR_CODES.CONFIG_UNAVAILABLE, 'no production admin session store configured');
        }
        const originCheck = checkOrigin(req, originPolicy);
        if (!originCheck.ok) {
            return fail(403, AGW_ERROR_CODES.FORBIDDEN, 'origin check failed', { reason: originCheck.reason });
        }

        const cookies = parseCookies(req);
        const opaqueSessionId = cookies[ADMIN_SESSION_COOKIE] || '';
        const csrfToken = normalizeNativeString(req.headers[CSRF_HEADER] || '');
        const verification = await adminGatewaySessionStore.verifySession(opaqueSessionId, {
            csrfToken,
            requireCsrf: true
        });
        if (!verification.ok) {
            const status = verification.code === 'AGW_FORBIDDEN' ? 403 : 401;
            return fail(status, verification.code || AGW_ERROR_CODES.UNAUTHORIZED, 'admin session verification failed', { reason: verification.reason });
        }

        await adminGatewaySessionStore.revokeSession(opaqueSessionId);
        applyCorsHeaders(res, originCheck);
        res.setHeader('Set-Cookie', buildClearCookie());
        res.setHeader('Cache-Control', 'private, no-store');
        return sendNativeSuccess(res, {
            status: 200,
            requestId: requestContext.requestId,
            startedAt,
            data: { revoked: true }
        });
    });
}

module.exports = {
    ADMIN_SESSION_COOKIE,
    CSRF_HEADER,
    checkOrigin,
    parseCookies,
    registerAdminSessionRoutes,
    resolveOriginPolicy
};
