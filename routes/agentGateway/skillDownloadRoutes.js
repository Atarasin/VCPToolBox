'use strict';

const { AGW_ERROR_CODES, normalizeNativeString, createNativeRequestContext, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, buildNativeAuthContext } = require('./shared');
const { SKILL_FORMATS, generateSkillArtifact, validatePublicBaseUrl } = require('../../modules/agentGateway/services/skillGeneratorService');

/**
 * L3 签名下载 endpoint（§6 / M4.S2）。
 *
 * mint：GET .../integration/skill/download-url — 按 gateway:read 授权后签发
 *       一次性下载 URL token；不含原 credential。format 在 mint 时即校验，
 *       不签发必然无法兑换的 token。
 * redeem：GET .../integration/skill/download — 无需原 credential（签名 URL
 *         本身是 bearer capability，authInjection 对该 surface 放行）；服务端
 *         重读 owner，校验 subject/revision，先完成 artifact 生成再原子消费
 *         nonce，最后输出 artifact 文件。format/revision 以签名载荷的
 *         artifactId 为准，query 仅作一致性断言。
 *
 * 响应头：no-store 全套 + Vary 身份通道（mint）；no-store + no-referrer +
 *         Content-Disposition: attachment（redeem）。
 * redeem 的 query 含 bearer token：本文件不把 query/token 写入日志、审计或
 * operability payload；反向代理/CDN/APM/access log 的脱敏与缓存旁路配置见
 * modules/agentGateway/docs/agent-integration/deployment-notes.md。
 */

function setPrivateNoStore(res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization, x-agent-gateway-key, Cookie');
}

function setRedeemHeaders(res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Disposition', 'attachment');
}

function resolvePublicBaseUrlOrError() {
    return validatePublicBaseUrl(process.env.AGENT_GATEWAY_PUBLIC_BASE_URL, {
        allowInsecure: process.env.AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE === 'true'
    });
}

function registerSkillDownloadMintRoute(router, context) {
    const { authContextResolver, operabilityService, agentGuidanceService, skillDownloadSigningService } = context;
    router.get('/agents/:agentId/integration/skill/download-url', async (req, res) => {
        const startedAt = Date.now();
        setPrivateNoStore(res);
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-skill-download-mint');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.integration.skill.download.mint',
            requestContext,
            authContext,
            payload: { ...req.query, agentId: req.params.agentId }
        });
        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }

        if (!skillDownloadSigningService || !skillDownloadSigningService.isConfigured()) {
            return sendNativeErrorWithOperation(res, {
                status: 503,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE,
                error: 'Skill download signing is not configured (production nonce store and signing key required)',
                authContext,
                operationControl
            });
        }

        try {
            const format = normalizeNativeString(req.query.format);
            if (!SKILL_FORMATS.includes(format)) {
                // §6：mint 即校验 format——不签发必然烧掉 nonce 的 token
                return sendNativeErrorWithOperation(res, {
                    status: 400,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.INVALID_REQUEST,
                    error: `format must be one of: ${SKILL_FORMATS.join(', ')}`,
                    authContext,
                    operationControl
                });
            }

            const baseUrl = resolvePublicBaseUrlOrError();
            if (!baseUrl.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: 503,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE,
                    error: baseUrl.reason,
                    authContext,
                    operationControl
                });
            }

            if (!agentGuidanceService) {
                return sendNativeErrorWithOperation(res, {
                    status: 503,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE,
                    error: 'Agent guidance service is not configured',
                    authContext,
                    operationControl
                });
            }

            const guidanceResult = await agentGuidanceService.getAgentGuidance(req.params.agentId);
            if (!guidanceResult.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: guidanceResult.httpStatus || 500,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: guidanceResult.code || AGW_ERROR_CODES.INTERNAL_ERROR,
                    error: guidanceResult.reason || 'Failed to resolve agent guidance',
                    authContext,
                    operationControl
                });
            }

            const artifactId = `skill:${req.params.agentId}:${format}:${guidanceResult.guidance.revision}`;

            const mintResult = skillDownloadSigningService.mintDownloadToken({
                authContext,
                agentId: req.params.agentId,
                artifactId,
                ttlMs: undefined
            });
            if (!mintResult.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: mintResult.httpStatus || 503,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: mintResult.code || AGW_ERROR_CODES.CONFIG_UNAVAILABLE,
                    error: mintResult.reason,
                    authContext,
                    operationControl
                });
            }

            // mint 响应中的一次性 URL 不进入审计 payload
            const downloadUrl = `${baseUrl.baseUrl}/agent_gateway/agents/${encodeURIComponent(req.params.agentId)}/integration/skill/download?token=${mintResult.token}`;
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: { downloadUrl, expiresAt: mintResult.expiresAt, artifactId },
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to mint download token',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function parseArtifactIdFormat(artifactId) {
    // artifactId 形如 skill:<agentId>:<format>:<revision>；agentId 不含冒号
    //（agent alias 规则），format 取第三段
    const parts = String(artifactId || '').split(':');
    return parts.length >= 4 && parts[0] === 'skill' ? parts[2] : '';
}

function registerSkillDownloadRedeemRoute(router, context) {
    const { agentGuidanceService, skillDownloadSigningService } = context;
    router.get('/agents/:agentId/integration/skill/download', async (req, res) => {
        setRedeemHeaders(res);
        // redeem：只接受完整 GET；不支持 HEAD（router.get 同时匹配 HEAD，
        // 显式拒绝以免消费 nonce 而不传 body）、Range 与 redirect
        if (req.method !== 'GET') {
            return res.status(405).json({ error: 'Only full GET requests are supported for skill downloads' });
        }
        if (req.headers.range) {
            return res.status(400).json({ error: 'Range requests are not supported for skill downloads' });
        }

        if (!skillDownloadSigningService || !skillDownloadSigningService.isConfigured()) {
            return res.status(503).json({ error: 'Skill download signing is not configured' });
        }

        const token = normalizeNativeString(req.query.token);
        if (!token) {
            return res.status(401).json({ error: 'Missing download token' });
        }

        try {
            // §6 全序：签名/expiry/owner 校验 → artifact 生成（存在性校验）→
            // 原子消费 nonce → 输出 body。artifact 失败不消费 nonce。
            const redeemResult = await skillDownloadSigningService.redeemDownloadToken({
                token,
                agentId: req.params.agentId,
                ensureArtifact: async (payload) => {
                    const baseUrl = resolvePublicBaseUrlOrError();
                    if (!baseUrl.ok) {
                        return { ok: false, httpStatus: 503, reason: baseUrl.reason };
                    }
                    if (!agentGuidanceService) {
                        return { ok: false, httpStatus: 503, reason: 'Agent guidance service is not configured' };
                    }
                    const guidanceResult = await agentGuidanceService.getAgentGuidance(payload.agentId);
                    if (!guidanceResult.ok) {
                        return { ok: false, httpStatus: guidanceResult.httpStatus || 500, reason: guidanceResult.reason || 'Failed to resolve agent guidance' };
                    }
                    // §6：签名只授予载荷中 artifactId 对应 artifact 的下载权。
                    // format 从 artifactId 解析；guidance revision 变化后旧
                    // token 指向的 artifact 不复存在，拒绝而非兑换新内容。
                    const format = parseArtifactIdFormat(payload.artifactId);
                    const artifact = generateSkillArtifact({
                        guidance: guidanceResult.guidance,
                        format,
                        baseUrl: baseUrl.baseUrl
                    });
                    if (!artifact.ok) {
                        return { ok: false, httpStatus: artifact.httpStatus || 500, reason: artifact.reason };
                    }
                    if (artifact.artifactId !== payload.artifactId) {
                        return { ok: false, httpStatus: 410, reason: 'artifact no longer available (guidance revision changed since mint)' };
                    }
                    return { ok: true, artifact };
                }
            });
            if (!redeemResult.ok) {
                return res.status(redeemResult.httpStatus || 403).json({ error: redeemResult.reason });
            }

            // 输出 JSON artifact（nonce 已原子消费；此后传输失败不恢复）
            const artifact = redeemResult.artifact;
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).json({
                artifactId: artifact.artifactId,
                manifest: artifact.manifest,
                files: artifact.files
            });
        } catch (error) {
            // 不把 error 细节（可能引用 query/token）写入响应或日志
            return res.status(500).json({ error: 'Failed to redeem download token' });
        }
    });
}

module.exports = { registerSkillDownloadMintRoute, registerSkillDownloadRedeemRoute };
