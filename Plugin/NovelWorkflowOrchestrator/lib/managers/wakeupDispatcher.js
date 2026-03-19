/**
 * 唤醒派发器模块：负责构建唤醒任务并持久化落盘。
 * 核心职责：
 * 1. 为每个 Agent 生成唯一幂等的唤醒任务
 * 2. 将任务写入状态存储
 * 3. 按预算控制派发数量
 *
 * @module managers/wakeupDispatcher
 * @requires crypto
 * @requires ../utils/time
 */

const crypto = require('crypto');
const { toLocalIsoString } = require('../utils/time');

/**
 * 构造幂等键，用于避免同一 tick 内重复派发相同任务。
 * 算法：对 projectId + state + substate + targetAgent + tickId 取 SHA1 哈希
 *
 * @param {object} project 项目状态
 * @param {string} targetAgent 目标 Agent
 * @param {string} tickId 本轮 tick 标识
 * @returns {string} 40位十六进制哈希字符串
 *
 * @example
 * buildIdempotencyKey(project, 'DESIGNER', '20240101_abc123')
 * // 返回类似 'a1b2c3d4e5f6...' 的40位哈希
 */
function buildIdempotencyKey(project, targetAgent, tickId) {
  const raw = `${project.projectId}|${project.state}|${project.substate || '-'}|${targetAgent}|${tickId}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * 创建单条唤醒任务对象。
 * 任务包含完整上下文和生命周期管理字段
 *
 * @param {object} project 项目状态
 * @param {string} targetAgent 目标 Agent 名称
 * @param {object} context 唤醒上下文（由 contextAssembler 组装）
 * @param {string} tickId 本轮 tick 标识
 * @returns {object} 待持久化的任务实体
 *
 * @example
 * const task = createWakeupTask(project, 'DESIGNER', context, '20240101_abc');
 * // task.wakeupId 形如 'wk_20240101_abc_xxxxxxxx'
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
    executionStatus: 'queued',
    executionAttempt: 0,
    nextRetryAt: null,
    lastError: null,
    executor: 'AgentAssistant',
    sessionId: wakeupId,
    retryMeta: {
      retryCount: 0,
      nextRetryAt: null
    },
    dispatchedAt: toLocalIsoString(new Date())
  };
}

/**
 * 按预算批量派发唤醒任务。
 * 业务规则：
 * 1. 单项目仅派发给一个 Agent（selectedAgents 取第一个）
 * 2. 当 remainingBudget 为0时跳过派发
 * 3. 每条任务独立写入状态存储
 *
 * @param {object} project 项目状态
 * @param {string[]} agents 目标 Agent 列表
 * @param {object} context 唤醒上下文
 * @param {object} options 派发选项
 * @param {string} options.tickId 本轮 tick 标识
 * @param {object} options.stateStore 状态存储实例
 * @param {number} [options.remainingBudget] 剩余预算，默认1
 * @returns {Promise<{tasks: object[], skippedCount: number}>} 派发结果
 * @property {object[]} tasks 成功派发的任务列表
 * @property {number} skippedCount 被跳过的 Agent 数量
 *
 * @example
 * const result = await dispatchWakeups(project, ['DESIGNER', 'CRITIC'], context, {
 *   tickId: '20240101_abc',
 *   stateStore: store,
 *   remainingBudget: 5
 * });
 * // result.tasks 包含至多1个任务（因为单项目单Agent）
 * // result.skippedCount = agents.length - tasks.length
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
