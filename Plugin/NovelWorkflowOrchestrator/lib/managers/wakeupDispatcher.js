const crypto = require('crypto');
const { toLocalIsoString } = require('../utils/time');

/**
 * 唤醒派发器：负责构建任务并持久化落盘。
 */

/**
 * 构造幂等键，避免同一 tick 重复派发时产生歧义任务。
 *
 * @param {object} project 项目状态
 * @param {string} targetAgent 目标 Agent
 * @param {string} tickId 本轮 tick 标识
 * @returns {string} SHA1 幂等键
 */
function buildIdempotencyKey(project, targetAgent, tickId) {
  const raw = `${project.projectId}|${project.state}|${project.substate || '-'}|${targetAgent}|${tickId}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * 创建单条唤醒任务对象。
 *
 * @param {object} project 项目状态
 * @param {string} targetAgent 目标 Agent
 * @param {object} context 唤醒上下文
 * @param {string} tickId 本轮 tick 标识
 * @returns {object} 待持久化的任务实体
 */
function createWakeupTask(project, targetAgent, context, tickId) {
  const wakeupId = `wk_${tickId}_${crypto.randomUUID().slice(0, 8)}`;
  return {
    wakeupId,
    tickId,
    projectId: project.projectId,
    stage: project.state,
    substate: project.substate || null,
    targetAgent,
    context,
    idempotencyKey: buildIdempotencyKey(project, targetAgent, tickId),
    status: 'dispatched',
    ackStatus: 'pending',
    retryMeta: {
      retryCount: 0,
      nextRetryAt: null
    },
    dispatchedAt: toLocalIsoString(new Date())
  };
}

/**
 * 按预算批量派发唤醒任务。
 * 业务规则：当预算不足时仅截取前 N 个 Agent，并返回 skippedCount。
 *
 * @param {object} project 项目状态
 * @param {string[]} agents 目标 Agent 列表
 * @param {object} context 唤醒上下文
 * @param {object} options 派发选项
 * @param {string} options.tickId 本轮 tick 标识
 * @param {object} options.stateStore 状态存储实例
 * @param {number} [options.remainingBudget] 剩余预算
 * @returns {Promise<{tasks: object[], skippedCount: number}>} 派发结果
 */
async function dispatchWakeups(project, agents, context, options) {
  const tickId = options.tickId;
  const stateStore = options.stateStore;
  const remainingBudget = Math.max(0, options.remainingBudget ?? 1);
  const selectedAgents = remainingBudget > 0 ? agents.slice(0, 1) : [];
  const tasks = [];

  for (const agent of selectedAgents) {
    const task = createWakeupTask(project, agent, context, tickId);
    await stateStore.putWakeupTask(task);
    tasks.push(task);
  }

  return {
    tasks,
    skippedCount: Math.max(0, agents.length - selectedAgents.length)
  };
}

module.exports = {
  dispatchWakeups
};
