'use strict';

const express = require('express');
const { getGatewayServiceBundle } = require('../../modules/agentGateway/createGatewayServiceBundle');
const {
    CREDENTIAL_ID_PATTERN,
    createCredentialAdminService,
    suggestCredentialId
} = require('../../modules/agentGateway/services/credentialAdminService');

/**
 * Agent Gateway 凭据管理管理面路由（/admin_api/agent-gateway/*）。
 * 设计：modules/agentGateway/docs/agent-integration/08-adminpanel-agent-credential-manager.md §4.3。
 *
 * - 鉴权由 /admin_api 挂载层的既有 adminAuth 承担，本模块不重复实现；
 * - 模块只在主进程加载（adminServer 的 localModules 不含本模块），
 *   面板请求经独立管理进程的兜底反代到达这里，天然单写者；
 * - gateway service bundle 按请求惰性解析，规避启动顺序依赖
 *   （模式同 modules/agentGateway/composition/lazyGatewayCredentialService.js）。
 */

const LOG_PREFIX = '[AdminAPI][AgentGateway]';

module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options?.pluginManager;

    let cachedService = null;
    let cachedRegistry = null;

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

    // 可绑定 agent 清单（agent_map.json 权威源，经 agentRegistryService）
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
                .sort((a, b) => a.agentId.localeCompare(b.agentId))
                .map((agent) => ({ ...agent, suggestedCredentialId: suggestCredentialId(agent.agentId) }));
            res.json({ agents: payload });
        } catch (error) {
            sendServiceError(res, error, '加载 agent 清单失败');
        }
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
