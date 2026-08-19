'use strict';

const express = require('express');
const { getGatewayServiceBundle } = require('../../modules/agentGateway/createGatewayServiceBundle');
const {
    CREDENTIAL_ID_PATTERN,
    createCredentialAdminService,
    suggestCredentialId
} = require('../../modules/agentGateway/services/credentialAdminService');
const {
    SKILL_FORMATS,
    generateSkillArtifact,
    resolveSkillName,
    validatePublicBaseUrl
} = require('../../modules/agentGateway/services/skillGeneratorService');
const { buildZipArchive } = require('../../modules/agentGateway/infra/zipArchiveWriter');

/**
 * Agent Gateway 凭据管理管理面路由（/admin_api/agent-gateway/*）。
 * 设计：modules/agentGateway/docs/agent-integration/08-adminpanel-agent-credential-manager.md §4.3。
 *
 * - 鉴权由 /admin_api 挂载层的既有 adminAuth 承担，本模块不重复实现；
 * - 模块只在主进程加载（adminServer 的 localModules 不含本模块），
 *   面板请求经独立管理进程的兜底反代到达这里，天然单写者；
 * - gateway service bundle 按请求惰性解析，规避启动顺序依赖
 *   （模式同 modules/agentGateway/composition/lazyGatewayCredentialService.js）。
 * - skill 导出复用网关侧 skillGeneratorService（同一 guidance 单源、同一
 *   secret scan 防线），产物为 zip 附件；生成物零 secret，令牌仍只在
 *   铸造/轮换响应中出现，导出链路不接触令牌。
 */

const LOG_PREFIX = '[AdminAPI][AgentGateway]';

module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options?.pluginManager;

    let cachedService = null;
    let cachedRegistry = null;
    let cachedGuidanceService = null;

    function resolveAgentRegistry() {
        if (!cachedRegistry) {
            if (!pluginManager) {
                const error = new Error('pluginManager unavailable');
                error.status = 503;
                throw error;
            }
            const services = getGatewayServiceBundle(pluginManager);
            cachedRegistry = services.agentRegistryService || null;
        }
        return cachedRegistry;
    }

    function resolveGuidanceService() {
        if (!cachedGuidanceService) {
            if (!pluginManager) {
                const error = new Error('pluginManager unavailable');
                error.status = 503;
                throw error;
            }
            const services = getGatewayServiceBundle(pluginManager);
            cachedGuidanceService = services.agentGuidanceService || null;
        }
        return cachedGuidanceService;
    }

    function resolveCredentialService() {
        if (!cachedService) {
            cachedService = createCredentialAdminService({
                credentialsPath: process.env.AGENT_GATEWAY_CREDENTIALS_PATH,
                pepperKeyringPath: process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH,
                activePepperKid: process.env.AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID,
                listAgentIds: async () => {
                    const registry = resolveAgentRegistry();
                    if (!registry) {
                        const error = new Error('agent registry service unavailable');
                        error.status = 503;
                        throw error;
                    }
                    const agents = await registry.listAgents();
                    return agents.map((agent) => agent.agentId || agent.alias).filter(Boolean);
                }
            });
        }
        return cachedService;
    }

    function sendServiceError(res, error, fallback) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 500;
        if (status >= 500) {
            console.error(`${LOG_PREFIX} ${error?.code || 'INTERNAL_ERROR'}:`, error?.message, error?.details || '');
        }
        const body = { error: error?.message || fallback || '操作失败' };
        if (error?.code) body.code = error.code;
        if (error?.details) body.details = error.details;
        return res.status(status).json(body);
    }

    // 子系统状态（只读，供页面状态横幅与操作引导）
    router.get('/agent-gateway/status', async (req, res) => {
        try {
            res.json({ status: await resolveCredentialService().getStatus() });
        } catch (error) {
            sendServiceError(res, error, '读取网关凭据状态失败');
        }
    });

    // 可绑定 agent 清单（agent_map.json 权威源，经 agentRegistryService）。
    // skillName 附带 guidance 解析结果（配置了 skill.name 用配置值，否则按
    // vcp-<agentId slug> 派生）；guidance 未发布的 agent 为 null，导出按钮
    // 仍可点击，具体原因由导出端点返回。
    router.get('/agent-gateway/agents', async (req, res) => {
        try {
            const registry = resolveAgentRegistry();
            if (!registry || typeof registry.listAgents !== 'function') {
                return res.status(503).json({ error: 'agent registry 不可用（主进程未完成 Gateway 初始化）' });
            }
            const agents = await registry.listAgents();
            const payload = agents
                .map((agent) => ({
                    agentId: String(agent.agentId || agent.alias || ''),
                    alias: String(agent.alias || agent.agentId || ''),
                    summary: typeof agent.summary === 'string' ? agent.summary : ''
                }))
                .filter((agent) => agent.agentId)
                .sort((a, b) => a.agentId.localeCompare(b.agentId));
            let guidanceService = null;
            try {
                guidanceService = resolveGuidanceService();
            } catch (_error) {
                guidanceService = null;
            }
            const enriched = await Promise.all(payload.map(async (agent) => {
                if (!guidanceService || typeof guidanceService.getAgentGuidance !== 'function') {
                    return { ...agent, skillName: null };
                }
                try {
                    const result = await guidanceService.getAgentGuidance(agent.agentId);
                    return result.ok
                        ? { ...agent, skillName: resolveSkillName(result.guidance) }
                        : { ...agent, skillName: null };
                } catch (_error) {
                    return { ...agent, skillName: null };
                }
            }));
            res.json({
                agents: enriched.map((agent) => ({ ...agent, suggestedCredentialId: suggestCredentialId(agent.agentId) }))
            });
        } catch (error) {
            sendServiceError(res, error, '加载 agent 清单失败');
        }
    });

    // 导出 agent 接入 skill（zip 附件：SKILL.md / INSTALL.md / manifest.json，
    // 解压即得 vcp-<agent>/ 目录）。产物零 secret；令牌不经过本链路。
    router.get('/agent-gateway/agents/:agentId/skill', async (req, res) => {
        const { agentId } = req.params;
        const format = typeof req.query.format === 'string' && req.query.format ? req.query.format : 'claude';
        if (!SKILL_FORMATS.includes(format)) {
            return res.status(400).json({ error: `format 必须是 ${SKILL_FORMATS.join(' / ')} 之一` });
        }
        let guidanceService;
        try {
            guidanceService = resolveGuidanceService();
        } catch (error) {
            return sendServiceError(res, error, '网关服务不可用');
        }
        if (!guidanceService || typeof guidanceService.getAgentGuidance !== 'function') {
            return res.status(503).json({ error: 'agent guidance 服务不可用（主进程未完成 Gateway 初始化）' });
        }
        let guidanceResult;
        try {
            guidanceResult = await guidanceService.getAgentGuidance(agentId);
        } catch (error) {
            return sendServiceError(res, error, '解析 agent guidance 失败');
        }
        if (!guidanceResult.ok) {
            const status = guidanceResult.httpStatus === 404 ? 404 : (guidanceResult.httpStatus || 500);
            if (status >= 500) {
                console.error(`${LOG_PREFIX} skill export guidance error:`, guidanceResult.reason);
            }
            return res.status(status).json({
                error: status === 404
                    ? `agent "${agentId}" 未发布接入 guidance（需先在 agent_guidance.json 配置）`
                    : (guidanceResult.reason || '解析 agent guidance 失败'),
                code: guidanceResult.code
            });
        }
        const baseUrl = validatePublicBaseUrl(process.env.AGENT_GATEWAY_PUBLIC_BASE_URL, {
            allowInsecure: process.env.AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE === 'true'
        });
        if (!baseUrl.ok) {
            return res.status(503).json({ error: `无法生成 skill：${baseUrl.reason}` });
        }
        let artifact;
        try {
            artifact = generateSkillArtifact({
                guidance: guidanceResult.guidance,
                format,
                baseUrl: baseUrl.baseUrl
            });
        } catch (error) {
            return sendServiceError(res, error, '生成 skill 失败');
        }
        if (!artifact.ok) {
            // 生成物含 secret 形态等内部错误：不输出任何 body 细节
            console.error(`${LOG_PREFIX} skill generation failed for ${agentId}:`, artifact.reason);
            return res.status(artifact.httpStatus || 500).json({ error: '生成 skill 失败（生成器拒绝了产物）' });
        }
        const skillName = resolveSkillName(guidanceResult.guidance);
        const zipBuffer = buildZipArchive(
            artifact.files.map((file) => ({ path: `${skillName}/${file.path}`, content: file.content }))
        );
        console.log(`${LOG_PREFIX} skill exported: agentId=${agentId} skill=${skillName} format=${format}`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${skillName}.zip"`);
        return res.status(200).send(zipBuffer);
    });

    // 凭据列表（无 token、无 digest）
    router.get('/agent-gateway/credentials', async (req, res) => {
        try {
            const credentials = await resolveCredentialService().listCredentials({
                status: typeof req.query.status === 'string' ? req.query.status : undefined,
                boundAgentId: typeof req.query.boundAgentId === 'string' ? req.query.boundAgentId : undefined
            });
            res.json({ credentials });
        } catch (error) {
            sendServiceError(res, error, '读取凭据列表失败');
        }
    });

    // 铸造（token 仅本次响应出现一次）
    router.post('/agent-gateway/credentials', async (req, res) => {
        try {
            const body = req.body || {};
            const result = await resolveCredentialService().createCredential({
                boundAgentId: body.boundAgentId,
                scopes: body.scopes,
                expiresAt: body.expiresAt,
                credentialId: body.credentialId
            });
            res.status(201).json(result);
        } catch (error) {
            sendServiceError(res, error, '铸造凭据失败');
        }
    });

    // 轮换（旧记录转 rotating + 新 credentialId 新 token）
    router.post('/agent-gateway/credentials/:credentialId/rotate', async (req, res) => {
        const { credentialId } = req.params;
        if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
            return res.status(400).json({ error: `credentialId "${credentialId}" 格式非法` });
        }
        try {
            const body = req.body || {};
            const result = await resolveCredentialService().rotateCredential({
                credentialId,
                newCredentialId: body.newCredentialId,
                oldExpiresAt: body.oldExpiresAt,
                expiresAt: body.expiresAt
            });
            res.json(result);
        } catch (error) {
            sendServiceError(res, error, '轮换凭据失败');
        }
    });

    // 吊销（幂等）
    router.post('/agent-gateway/credentials/:credentialId/revoke', async (req, res) => {
        const { credentialId } = req.params;
        if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
            return res.status(400).json({ error: `credentialId "${credentialId}" 格式非法` });
        }
        try {
            const result = await resolveCredentialService().revokeCredential({ credentialId });
            res.json(result);
        } catch (error) {
            sendServiceError(res, error, '吊销凭据失败');
        }
    });

    return router;
};
