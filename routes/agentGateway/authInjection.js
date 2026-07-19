'use strict';

const {
    AGW_ERROR_CODES,
    AGENT_GATEWAY_HEADERS,
    createNativeRequestContext,
    resolveDedicatedGatewayAuth,
    sendNativeError,
    buildNativeResponseMeta
} = require('./shared');
const { ADMIN_SESSION_COOKIE, CSRF_HEADER, parseCookies } = require('./authSessionRoutes');

/**
 * 单一认证注入点（§3.3 / M1.S3.T7）。
 *
 * 收编原 `req.agentGatewayAuth`（server.js adminAuth 写入）与
 * `req.agentGatewayDedicatedAuth`（原 systemRoutes registrar 写入）的命名
 * 裂缝：本中间件在 createAgentGatewayRoutes 中显式最先挂载（不再依赖
 * ROUTE_REGISTRARS 注册顺序），产出唯一的 `req.agentGatewayAuth`。
 *
 * 注入内容：
 * - dedicated gateway key 认证结果（保持既有 401 行为）
 * - outerAuthenticated 标记（既有 adminAuth Basic/cookie 兜底，仅供
 *   pre-credential bridge 使用）
 * - admin session cookie 的 opaque id 与 CSRF header（供 builtin credential
 *   解析与 bridge DELETE 使用；此处不做 session 校验）
 */
function createAuthInjectionMiddleware(context) {
    const { protocolConfig } = context;

    return function authInjection(req, res, next) {
        const outerAuth = req.agentGatewayAuth && typeof req.agentGatewayAuth === 'object'
            ? req.agentGatewayAuth
            : null;
        const outerAuthenticated = outerAuth?.outerAuthenticated === true;

        // outer 层若已完成 dedicated key 认证则复用其结果，否则统一在此解析
        const dedicatedAuth = outerAuth && !outerAuthenticated
            ? outerAuth
            : resolveDedicatedGatewayAuth({ headers: req.headers, config: protocolConfig });

        const cookies = parseCookies(req);
        const unifiedAuth = {
            ...dedicatedAuth,
            outerAuthenticated,
            adminSessionId: cookies[ADMIN_SESSION_COOKIE] || '',
            csrfToken: typeof req.headers[CSRF_HEADER] === 'string' ? req.headers[CSRF_HEADER] : ''
        };
        req.agentGatewayAuth = unifiedAuth;
        // 过渡期兼容别名：与 canonical 对象同引用，禁止在新代码中使用
        req.agentGatewayDedicatedAuth = unifiedAuth;

        if (dedicatedAuth.provided && !dedicatedAuth.authenticated) {
            const requestContext = createNativeRequestContext(
                req,
                req.body?.requestContext || req.query,
                'agent-gateway-auth'
            );
            return sendNativeError(res, {
                status: 401,
                requestId: requestContext.requestId,
                startedAt: Date.now(),
                code: AGW_ERROR_CODES.UNAUTHORIZED,
                error: 'Invalid agent gateway credentials',
                details: { authSource: dedicatedAuth.authSource },
                extraHeaders: { [AGENT_GATEWAY_HEADERS.TRACE_ID]: requestContext.traceId },
                extraMeta: buildNativeResponseMeta(dedicatedAuth, { traceId: requestContext.traceId })
            });
        }

        return next();
    };
}

module.exports = { createAuthInjectionMiddleware };
