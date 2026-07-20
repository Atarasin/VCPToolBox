'use strict';

const { AGW_ERROR_CODES, normalizeNativeString, createNativeRequestContext, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, buildNativeAuthContext } = require('./shared');
const { generateSkillArtifact, validatePublicBaseUrl } = require('../../modules/agentGateway/services/skillGeneratorService');

/**
 * L3 签名下载 endpoint（§6 / M4.S2）。
 *
 * mint：GET .../integration/skill/download-url — 按 gateway:read 授权后签发
 *       一次性下载 URL token；不含原 credential。
 * redeem：GET .../integration/skill/download — 无需原 credential；服务端重读
 *         owner，校验 subject/revision，原子消费 nonce，输出 artifact 文件。
 *
 * 响应头：no-store 全套 + Vary 身份通道（mint）；no-store + no-referrer +
 *         Content-Disposition: attachment（redeem）。
 * 代理/CDN/APM/access log 必须对 redeem 路径关闭缓存并脱敏完整 query。
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

            const format = normalizeNativeString(req.query.format);
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
            const downloadUrl = `${baseUrl.baseUrl}/agent_gateway/agents/${encodeURIComponent(req.params.agentId)}/integration/skill/download?token=${mintResult.token}&format=${encodeURIComponent(format)}`;
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

function registerSkillDownloadRedeemRoute(router, context) {
    const { agentGuidanceService, skillDownloadSigningService } = context;
    router.get('/agents/:agentId/integration/skill/download', async (req, res) => {
        // redeem：不接受 Range；不接受 redirect；no-store 全套
        if (req.headers.range) {
            setRedeemHeaders(res);
            return res.status(400).json({ error: 'Range requests are not supported for skill downloads' });
        }
        setRedeemHeaders(res);

        if (!skillDownloadSigningService || !skillDownloadSigningService.isConfigured()) {
            return res.status(503).json({ error: 'Skill download signing is not configured' });
        }

        const token = normalizeNativeString(req.query.token);
        if (!token) {
            return res.status(401).json({ error: 'Missing download token' });
        }

        try {
            const redeemResult = await skillDownloadSigningService.redeemDownloadToken({
                token,
                agentId: req.params.agentId
            });
            if (!redeemResult.ok) {
                return res.status(redeemResult.httpStatus || 403).json({ error: redeemResult.reason });
            }

            const baseUrl = resolvePublicBaseUrlOrError();
            if (!baseUrl.ok) {
                return res.status(503).json({ error: baseUrl.reason });
            }

            if (!agentGuidanceService) {
                return res.status(503).json({ error: 'Agent guidance service is not configured' });
            }

            const guidanceResult = await agentGuidanceService.getAgentGuidance(req.params.agentId);
            if (!guidanceResult.ok) {
                return res.status(guidanceResult.httpStatus || 500).json({ error: guidanceResult.reason || 'Failed to resolve agent guidance' });
            }

            const format = normalizeNativeString(req.query.format);
            const artifact = generateSkillArtifact({
                guidance: guidanceResult.guidance,
                format,
                baseUrl: baseUrl.baseUrl
            });
            if (!artifact.ok) {
                return res.status(artifact.httpStatus || 500).json({ error: artifact.reason });
            }

            // 输出 JSON artifact（nonce 已在 redeemDownloadToken 内原子消费）
            res.setHeader('Content-Type', 'application/json');
            return res.status(200).json({
                artifactId: artifact.artifactId,
                manifest: artifact.manifest,
                files: artifact.files
            });
        } catch (error) {
            return res.status(500).json({ error: 'Failed to redeem download token' });
        }
    });
}

module.exports = { registerSkillDownloadMintRoute, registerSkillDownloadRedeemRoute };
