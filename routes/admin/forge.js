'use strict';

const express = require('express');
const { getGatewayServiceBundle } = require('../../modules/agentGateway/createGatewayServiceBundle');

/**
 * 专家铸造炉只读进度路由（/admin_api/forge/*）。
 * 设计：docs/design/2026-10-10_专家铸造炉.md §3.10（R5 增补）。
 *
 * - 只读观察窗口：看得到进度、费用、历史；不提供发起铸造、确认画像、
 *   重试、取消等任何写操作入口（发起与控制唯一走铸造师对话，D1 不变）；
 * - 鉴权由 /admin_api 挂载层的既有 adminAuth 承担，本模块不重复实现；
 * - 数据与 gateway_job_get 同源（主进程 agentGateway bundle 的
 *   forgeRuntimeService + job 运行时事件），不新建状态存储；
 * - 模块只在主进程加载，面板请求经独立管理进程兜底反代到达。
 */

const LOG_PREFIX = '[AdminAPI][Forge]';

module.exports = function (options) {
    const router = express.Router();
    const pluginManager = options?.pluginManager;

    let cachedForgeService = null;

    function resolveForgeService() {
        if (!cachedForgeService) {
            if (!pluginManager) {
                const error = new Error('pluginManager unavailable');
                error.status = 503;
                throw error;
            }
            const services = getGatewayServiceBundle(pluginManager);
            cachedForgeService = services.forgeRuntimeService || null;
            if (!cachedForgeService) {
                const error = new Error('forge runtime service unavailable（主进程未完成 Gateway 初始化）');
                error.status = 503;
                throw error;
            }
        }
        return cachedForgeService;
    }

    function sendServiceError(res, error, fallback) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
            ? error.status
            : 500;
        if (status >= 500) {
            console.error(`${LOG_PREFIX} ${error?.code || 'INTERNAL_ERROR'}:`, error?.message, error?.details || '');
        }
        const body = { status: 'error', error: error?.message || fallback || '读取铸造任务失败' };
        if (error?.code) body.code = error.code;
        return res.status(status).json(body);
    }

    // 铸造任务列表（进行中/历史）：jobId、类型、专家名、状态、当前步骤、费用、起止时间
    router.get('/forge/jobs', async (req, res) => {
        try {
            const jobs = await resolveForgeService().listJobs();
            res.json({ status: 'success', jobs });
        } catch (error) {
            sendServiceError(res, error, '读取铸造任务列表失败');
        }
    });

    // 单任务详情：五步状态、产物路径、费用明细、审计事件时间线
    router.get('/forge/jobs/:jobId', async (req, res) => {
        try {
            const detail = await resolveForgeService().getJobDetail(String(req.params.jobId || '').trim());
            res.json({ status: 'success', ...detail });
        } catch (error) {
            sendServiceError(res, error, '读取铸造任务详情失败');
        }
    });

    return router;
};
