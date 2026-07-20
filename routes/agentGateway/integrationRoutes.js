'use strict';

const { AGW_ERROR_CODES, normalizeNativeString, createNativeRequestContext, beginNativeOperation, sendNativeOperationRejection, sendNativeSuccessWithOperation, sendNativeErrorWithOperation, buildNativeAuthContext } = require('./shared');
const {
    buildIntegrationSummary,
    generateSkillArtifact,
    validatePublicBaseUrl
} = require('../../modules/agentGateway/services/skillGeneratorService');

/**
 * L3 integration / skill endpoint（§6 / M4.S1）。
 *
 * 授权走 §3.2 同一决议表（单一认证注入点提取 path candidate，绑定不一致
 * 403；restOperations.json 登记 credentialAction: read）。响应按 owner 渲染：
 * `Cache-Control: private, no-store` + `Vary` 全部身份通道。
 */

function setPrivateNoStore(res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization, x-agent-gateway-key, Cookie');
}

async function resolveGuidanceOrError({ agentGuidanceService, agentId }) {
    if (!agentGuidanceService) {
        return { ok: false, httpStatus: 503, code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE, reason: 'Agent guidance service is not configured' };
    }
    return agentGuidanceService.getAgentGuidance(agentId);
}

function resolvePublicBaseUrlOrError() {
    const validation = validatePublicBaseUrl(process.env.AGENT_GATEWAY_PUBLIC_BASE_URL, {
        allowInsecure: process.env.AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE === 'true'
    });
    if (!validation.ok) {
        return { ok: false, httpStatus: 503, code: AGW_ERROR_CODES.CONFIG_UNAVAILABLE, reason: validation.reason };
    }
    return validation;
}

function registerIntegrationRoute(router, context) {
    const { authContextResolver, operabilityService, agentGuidanceService } = context;
    router.get('/agents/:agentId/integration', async (req, res) => {
        const startedAt = Date.now();
        setPrivateNoStore(res);
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-integration');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.integration',
            requestContext,
            authContext,
            payload: { ...req.query, agentId: req.params.agentId }
        });
        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }

        try {
            const baseUrl = resolvePublicBaseUrlOrError();
            if (!baseUrl.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: baseUrl.httpStatus,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: baseUrl.code,
                    error: baseUrl.reason,
                    authContext,
                    operationControl
                });
            }
            const result = await resolveGuidanceOrError({ agentGuidanceService, agentId: req.params.agentId });
            if (!result.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: result.httpStatus || 500,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: result.code || AGW_ERROR_CODES.INTERNAL_ERROR,
                    error: result.reason || 'Failed to resolve agent integration',
                    authContext,
                    operationControl
                });
            }
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: buildIntegrationSummary({ guidance: result.guidance, baseUrl: baseUrl.baseUrl }),
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to resolve agent integration',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

function registerIntegrationSkillRoute(router, context) {
    const { authContextResolver, operabilityService, agentGuidanceService } = context;
    router.get('/agents/:agentId/integration/skill', async (req, res) => {
        const startedAt = Date.now();
        setPrivateNoStore(res);
        const requestContext = createNativeRequestContext(req, {
            requestId: req.query.requestId,
            source: req.query.source,
            runtime: req.query.runtime
        }, 'agent-gateway-integration-skill');
        const authContext = buildNativeAuthContext({
            authContextResolver,
            requestContext,
            dedicatedAuth: req.agentGatewayAuth
        });
        const operationControl = beginNativeOperation(operabilityService, {
            operationName: 'agents.integration.skill',
            requestContext,
            authContext,
            payload: { ...req.query, agentId: req.params.agentId }
        });
        if (operationControl && !operationControl.allowed) {
            return sendNativeOperationRejection(res, { startedAt, requestContext, authContext, operationControl });
        }

        try {
            const baseUrl = resolvePublicBaseUrlOrError();
            if (!baseUrl.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: baseUrl.httpStatus,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: baseUrl.code,
                    error: baseUrl.reason,
                    authContext,
                    operationControl
                });
            }
            const guidanceResult = await resolveGuidanceOrError({ agentGuidanceService, agentId: req.params.agentId });
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
            const artifact = generateSkillArtifact({
                guidance: guidanceResult.guidance,
                format: normalizeNativeString(req.query.format),
                baseUrl: baseUrl.baseUrl
            });
            if (!artifact.ok) {
                return sendNativeErrorWithOperation(res, {
                    status: artifact.httpStatus || 500,
                    requestId: requestContext.requestId,
                    startedAt,
                    code: artifact.code || AGW_ERROR_CODES.INTERNAL_ERROR,
                    error: artifact.reason || 'Failed to generate skill artifact',
                    authContext,
                    operationControl
                });
            }
            return sendNativeSuccessWithOperation(res, {
                requestId: requestContext.requestId,
                startedAt,
                data: {
                    artifactId: artifact.artifactId,
                    manifest: artifact.manifest,
                    files: artifact.files
                },
                authContext,
                operationControl
            });
        } catch (error) {
            return sendNativeErrorWithOperation(res, {
                status: 500,
                requestId: requestContext.requestId,
                startedAt,
                code: AGW_ERROR_CODES.INTERNAL_ERROR,
                error: 'Failed to generate skill artifact',
                details: { message: error.message },
                authContext,
                operationControl
            });
        }
    });
}

module.exports = { registerIntegrationRoute, registerIntegrationSkillRoute };
