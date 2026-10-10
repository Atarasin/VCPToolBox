'use strict';

/**
 * 定期进修调度（§3.8 触发 c，D4）。
 *
 * 说明：设计复用清单建议 routes/taskScheduler.js，但该调度器面向
 * VCP 插件 tool_call（VCPTimedContacts 结构），forge 编排在 agentGateway
 * 服务面而非插件面；为保持 forge 闭环（不引入跨面依赖、红线 1），此处
 * 以 node-schedule 自建周任务（与 taskScheduler 同一调度库）。
 *
 * - 默认每周一次（FORGE_LIFELONG_SCHEDULE=weekly|monthly|disabled，可配）；
 * - FORGE_LIFELONG_CRON 可覆盖为任意 5 段 cron（本地时区）；
 * - 每次为每个已上岗专家发起 forge.expert.learn（since=上次学习时间，
 *   采集带时间过滤——只检索上次学习后的新增内容）。
 */

const schedule = require('node-schedule');

const SCHEDULE_PRESETS = Object.freeze({
    weekly: '0 4 * * 1', // 每周一 04:00
    monthly: '0 4 1 * *' // 每月 1 日 04:00
});

function resolveLifelongRule(env = process.env) {
    const explicit = String(env.FORGE_LIFELONG_CRON || '').trim();
    if (explicit) {
        return { mode: 'cron', value: explicit };
    }
    const mode = String(env.FORGE_LIFELONG_SCHEDULE || 'weekly').trim().toLowerCase();
    if (mode === 'disabled') {
        return { mode: 'disabled', value: null };
    }
    const preset = SCHEDULE_PRESETS[mode] || SCHEDULE_PRESETS.weekly;
    return { mode, value: preset };
}

function createLifelongScheduler({ forgeRuntimeService, gapRegistry, listExpertNames, auditLogger = null, env = process.env }) {
    let running = null;

    async function runScheduledLearning(trigger = 'scheduled') {
        const expertNames = listExpertNames();
        const launched = [];
        for (const expertName of expertNames) {
            try {
                const since = await gapRegistry.lastLearningAt(expertName);
                const result = await forgeRuntimeService.startExpertLearnJob({
                    expertName,
                    since,
                    scope: { reason: trigger }
                });
                launched.push({ expertName, jobId: result.jobId, since });
            } catch (error) {
                auditLogger?.logGatewayOperation?.('forge.learn.schedule_failed', {
                    expertName,
                    trigger,
                    message: error.message
                });
            }
        }
        auditLogger?.logGatewayOperation?.('forge.learn.scheduled_batch', { trigger, experts: launched.length });
        return launched;
    }

    function start() {
        if (running) {
            return running;
        }
        // node --test 的子进程带 NODE_TEST_CONTEXT——测试环境一律不自启，
        // 避免调度句柄挂起测试进程（生产常驻进程不受影响）。
        if (env.NODE_TEST_CONTEXT || process.env.NODE_TEST_CONTEXT) {
            return null;
        }
        const rule = resolveLifelongRule(env);
        if (rule.mode === 'disabled') {
            auditLogger?.logGatewayOperation?.('forge.lifelong.disabled', null);
            return null;
        }
        running = schedule.scheduleJob(rule.value, () => {
            runScheduledLearning('scheduled-weekly').catch((error) => {
                console.error('[ForgeLifelong] 定期进修执行失败:', error);
            });
        });
        auditLogger?.logGatewayOperation?.('forge.lifelong.started', { rule: rule.value, mode: rule.mode });
        return running;
    }

    function stop() {
        if (running) {
            running.cancel();
            running = null;
        }
    }

    return { start, stop, runScheduledLearning, resolveRule: () => resolveLifelongRule(env) };
}

module.exports = {
    SCHEDULE_PRESETS,
    resolveLifelongRule,
    createLifelongScheduler
};
