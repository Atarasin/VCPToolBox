'use strict';

const {
    AGW_ERROR_CODES,
    AGENT_GATEWAY_HEADERS,
    createNativeRequestContext,
    resolveDedicatedGatewayAuth,
    sendNativeError,
    buildNativeResponseMeta
} = require('./shared');
const { ADMIN_SESSION_COOKIE, CSRF_HEADER, checkOrigin, parseCookies, resolveOriginPolicy } = require('./authSessionRoutes');
const { resolveRestCredentialAction } = require('../../modules/agentGateway/policy/restCredentialActions');

const SAFE_HTTP_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 单一认证注入点（§3.3 / M1.S3.T7 / M1.S5）。
 *
 * 收编原 `req.agentGatewayAuth` / `req.agentGatewayDedicatedAuth` 命名裂缝，
 * 在 createAgentGatewayRoutes 中显式最先挂载（不依赖 registrar 顺序）。
 *
 * 决议顺序：
 * 1. 呈现了 credential（gateway key / bearer / admin session cookie）→ 经
 *    `gatewayCredentialService.buildGatewayRequestContext()` 统一决议
 *    （文件 credential、legacy key、admin session 走同一张决议表）。
 *    认证失败按其错误码返回（401/429/503）。
 * 2. 仅有 adminAuth Basic（outerAuthenticated）而无 Gateway credential →
 *    只允许 pre-credential bridge（POST /auth/admin-session），
 *    其余业务入口 401（§3.3）。
 * 3. 什么都没呈现 → 阶段 A 过渡语义（admin_transition），生产环境由
 *    server.js adminAuth 在外层拦截。
 */
function createAuthInjectionMiddleware(context) {
    const { protocolConfig, gatewayCredentialService } = context;

    return async function authInjection(req, res, next) {
        // allowlist 部署形态的 CORS preflight：JSON POST 必触发 OPTIONS，
        // 无凭据呈现，按 origin allowlist 直接应答（§3.3 T4）。
        if (req.method === 'OPTIONS') {
            const originPolicy = resolveOriginPolicy();
            if (originPolicy.mode === 'allowlist') {
                const originCheck = checkOrigin(req, originPolicy);
                if (originCheck.ok && originCheck.corsOrigin) {
                    res.setHeader('Access-Control-Allow-Origin', originCheck.corsOrigin);
                    res.setHeader('Access-Control-Allow-Credentials', 'true');
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
                    res.setHeader('Access-Control-Allow-Headers',
                        `content-type, authorization, x-agent-gateway-key, ${CSRF_HEADER}`);
                    res.setHeader('Access-Control-Max-Age', '600');
                    res.setHeader('Vary', 'Origin');
                    return res.status(204).end();
                }
            }
            return next();
        }

        const outerAuth = req.agentGatewayAuth && typeof req.agentGatewayAuth === 'object'
            ? req.agentGatewayAuth
            : null;
        const outerAuthenticated = outerAuth?.outerAuthenticated === true;
        const dedicatedAuth = outerAuth && !outerAuthenticated
            ? outerAuth
            : resolveDedicatedGatewayAuth({ headers: req.headers, config: protocolConfig });

        const cookies = parseCookies(req);
        const adminSessionId = cookies[ADMIN_SESSION_COOKIE] || '';
        const csrfToken = typeof req.headers[CSRF_HEADER] === 'string' ? req.headers[CSRF_HEADER] : '';
        const unifiedAuth = {
            ...dedicatedAuth,
            outerAuthenticated,
            adminSessionId,
            csrfToken,
            credentialContext: null
        };
        req.agentGatewayAuth = unifiedAuth;
        // 过渡期兼容别名（同引用）；新代码一律使用 req.agentGatewayAuth
        req.agentGatewayDedicatedAuth = unifiedAuth;

        const sendAuthError = (status, code, error, extra = {}) => {
            const requestContext = createNativeRequestContext(
                req, req.body?.requestContext || req.query, 'agent-gateway-auth'
            );
            return sendNativeError(res, {
                status,
                requestId: requestContext.requestId,
                startedAt: Date.now(),
                code,
                error,
                details: { authSource: dedicatedAuth.authSource, ...extra },
                extraHeaders: {
                    [AGENT_GATEWAY_HEADERS.TRACE_ID]: requestContext.traceId,
                    ...(extra.retryAfterMs ? { 'retry-after': Math.max(1, Math.ceil(extra.retryAfterMs / 1000)) } : {})
                },
                extraMeta: buildNativeResponseMeta(dedicatedAuth, { traceId: requestContext.traceId })
            });
        };

        const isBridgeRequest = req.path === '/auth/admin-session';
        // L3 redeem surface（authMechanism: signedDownloadUrl，§6）：签名 URL
        // 即 bearer capability，不做 credential 决议——顺带呈现的过期 cookie /
        // 静态 header 不得使有效签名 URL 失效；签名/owner/nonce 校验在 route
        // 层执行。server.js adminAuth 对同一唯一路径放行。
        const signedUrlSurface = resolveRestCredentialAction(req.method, req.path);
        if (signedUrlSurface.matched && signedUrlSurface.authMechanism === 'signedDownloadUrl') {
            return next();
        }
        const credentialPresented = Boolean(dedicatedAuth.provided) || Boolean(adminSessionId);
        const isCookieAuthenticated = !dedicatedAuth.provided && Boolean(adminSessionId);
        const isMutation = !SAFE_HTTP_METHODS.has(req.method);

        if (credentialPresented && gatewayCredentialService && !isBridgeRequest) {
            // §3.3：cookie-authenticated 业务 mutation 必须通过 Origin 校验
            //（CSRF token 校验由 requireCsrf 传入 admin session store 执行）。
            if (isCookieAuthenticated && isMutation) {
                const originCheck = checkOrigin(req, resolveOriginPolicy());
                if (!originCheck.ok) {
                    return sendAuthError(403, AGW_ERROR_CODES.FORBIDDEN,
                        'Origin check failed for cookie-authenticated mutation', { reason: originCheck.reason });
                }
            }
            // §3.2：path/query/body 多来源 target candidate 全部提取，
            // 冲突 → AGW_INVALID_REQUEST；绑定不一致 → AGW_FORBIDDEN。
            // router-level 中间件拿不到 req.params，从 URL 提取 path candidate。
            const pathMatch = req.path.match(/^\/agents\/([^/]+)/);
            const targetCandidates = {
                ...(pathMatch ? { path: decodeURIComponent(pathMatch[1]) } : {}),
                ...(typeof req.query?.agentId === 'string' ? { query: req.query.agentId } : {}),
                ...(typeof req.body?.agentId === 'string' ? { body: req.body.agentId } : {}),
                ...(typeof req.body?.target?.agentId === 'string' ? { bodyTarget: req.body.target.agentId } : {})
            };
            const credentialContext = await gatewayCredentialService.buildGatewayRequestContext({
                headers: req.headers,
                clientIp: req.ip || req.socket?.remoteAddress || '',
                targetCandidates,
                requiresAgent: false,
                entry: 'native-rest',
                requireCsrf: isCookieAuthenticated && isMutation
            });
            if (!credentialContext.ok) {
                // legacy 静态 key 校验通过但文件/内置决议失败的组合不应出现——
                // legacy key 即内置 credential；任何失败按统一错误码返回。
                const status = credentialContext.httpStatus || 401;
                return sendAuthError(status, credentialContext.code, 'Agent gateway authentication failed', {
                    ...(credentialContext.retryAfterMs ? { retryAfterMs: credentialContext.retryAfterMs } : {})
                });
            }
            // §3.5 两层授权（M1.S2.T3）：按 canonical REST catalog 决议
            // credentialAction，凭据层 scope 不足统一 AGW_FORBIDDEN。
            // agent 策略层（allowed agents/diaries）继续由 service 层执行。
            const operationAuth = resolveRestCredentialAction(req.method, req.path);
            if (operationAuth.matched && operationAuth.credentialAction && !operationAuth.authExclusion) {
                const authorization = gatewayCredentialService.authorizeTarget(credentialContext, {
                    credentialAction: operationAuth.credentialAction
                });
                if (!authorization.ok) {
                    return sendAuthError(authorization.httpStatus || 403, authorization.code,
                        'Credential lacks required scope for this operation', {
                            operationId: operationAuth.operationId,
                            credentialAction: operationAuth.credentialAction
                        });
                }
            }
            unifiedAuth.credentialContext = credentialContext;
            unifiedAuth.authenticated = true;
            return next();
        }

        if (outerAuthenticated && !credentialPresented && !isBridgeRequest) {
            // pre-credential bridge 只允许 session POST（§3.3）
            return sendAuthError(401, AGW_ERROR_CODES.UNAUTHORIZED,
                'Create a gateway admin session before accessing agent business surfaces');
        }

        if (dedicatedAuth.provided && !dedicatedAuth.authenticated && !gatewayCredentialService) {
            return sendAuthError(401, AGW_ERROR_CODES.UNAUTHORIZED, 'Invalid agent gateway credentials');
        }

        return next();
    };
}

module.exports = { createAuthInjectionMiddleware };
