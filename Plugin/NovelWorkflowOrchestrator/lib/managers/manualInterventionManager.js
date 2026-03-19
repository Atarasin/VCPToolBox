/**
 * 人工介入管理器：处理停滞检测、冻结、人工回复恢复与终止逻辑。
 */
const { toLocalIsoString } = require('../utils/time');

/**
 * 从输入中提取指定项目的人工回复。
 *
 * @param {string} projectId 项目 ID
 * @param {object} input 输入载荷
 * @returns {object|null} 匹配到的人工回复
 */
function findManualReply(projectId, input) {
  const replies = Array.isArray(input?.manualReplies) ? input.manualReplies : [];
  return replies.find(item => item && item.projectId === projectId) || null;
}

/**
 * 更新停滞计数。
 * 业务规则：本轮有推进则归零，否则 unchangedTicks +1。
 *
 * @param {object} project 项目状态
 * @param {boolean} advanced 本轮是否推进
 * @param {object} config 运行配置
 * @returns {object} 更新后的项目状态
 */
function updateStagnation(project, advanced, config) {
  const threshold = Number(project?.stagnation?.threshold ?? config.stagnantTickThreshold ?? 3);
  const unchangedTicks = advanced
    ? 0
    : Number(project?.stagnation?.unchangedTicks ?? 0) + 1;
  return {
    ...project,
    stagnation: {
      unchangedTicks,
      threshold
    }
  };
}

/**
 * 判断项目是否处于“等待人工回复”状态。
 *
 * @param {object} project 项目状态
 * @returns {boolean} 是否等待人工回复
 */
function isManualPending(project) {
  return String(project?.manualReview?.status || '') === 'waiting_human_reply';
}

/**
 * 判定是否因停滞超阈值需要打开人工介入。
 *
 * @param {object} project 项目状态
 * @returns {boolean} 是否触发人工介入
 */
function shouldOpenManualByStagnation(project) {
  const unchangedTicks = Number(project?.stagnation?.unchangedTicks ?? 0);
  const threshold = Number(project?.stagnation?.threshold ?? 3);
  return unchangedTicks >= threshold;
}

/**
 * 打开人工介入并将项目冻结到 PAUSED_MANUAL_REVIEW。
 *
 * @param {object} store 状态存储实例
 * @param {object} project 项目状态
 * @param {object} payload 触发信息
 * @param {string} payload.triggerReason 触发原因
 * @param {string} payload.resumeStage 恢复时顶层状态
 * @param {string|null} payload.resumeSubstate 恢复时子状态
 * @param {string[]} [payload.lastWakeups] 最近唤醒列表
 * @param {Date} [now] 当前时间
 * @returns {Promise<{project: object, manualPayload: object}>} 冻结后的状态与写盘数据
 */
async function openManualReview(store, project, payload, now = new Date()) {
  const manualPayload = {
    projectId: project.projectId,
    status: 'waiting_human_reply',
    triggerReason: payload.triggerReason,
    stagnantTicks: Number(project?.stagnation?.unchangedTicks ?? 0),
    report: {
      state: project.state,
      substate: project.substate || null,
      lastWakeups: payload.lastWakeups || []
    },
    humanReply: null,
    createdAt: toLocalIsoString(now),
    updatedAt: toLocalIsoString(now)
  };
  await store.putManualReview(project.projectId, manualPayload);
  const updatedProject = {
    ...project,
    state: 'PAUSED_MANUAL_REVIEW',
    manualReview: {
      status: 'waiting_human_reply',
      requestedAt: toLocalIsoString(now),
      resumeStage: payload.resumeStage || project.state,
      resumeSubstate: payload.resumeSubstate ?? project.substate ?? null,
      triggerReason: payload.triggerReason
    },
    updatedAt: toLocalIsoString(now)
  };
  return {
    project: updatedProject,
    manualPayload
  };
}

/**
 * 应用人工回复并恢复或终止项目。
 * 业务规则：
 * - decision=abort 时直接收敛为 FAILED；
 * - 其他决策按 resumeStage/resumeSubstate 恢复，并清零停滞计数。
 *
 * @param {object} store 状态存储实例
 * @param {object} project 项目状态
 * @param {object} input 输入载荷
 * @param {Date} [now] 当前时间
 * @returns {Promise<{project: object, consumed: boolean, resolved: boolean, decision: string|null}>} 处理结果
 */
async function applyManualReply(store, project, input, now = new Date()) {
  const reply = findManualReply(project.projectId, input);
  if (!reply) {
    return {
      project,
      consumed: false,
      resolved: false,
      decision: null
    };
  }

  const decision = String(reply.decision || '').toLowerCase();
  const resumeStage = reply.resumeStage || project.manualReview?.resumeStage || 'CHAPTER_CREATION';
  const resumeSubstate = reply.resumeSubstate ?? project.manualReview?.resumeSubstate ?? null;
  const manualRecord = (await store.getManualReview(project.projectId)) || {
    projectId: project.projectId
  };
  await store.putManualReview(project.projectId, {
    ...manualRecord,
    status: 'resolved',
    humanReply: reply,
    resolvedAt: toLocalIsoString(now),
    updatedAt: toLocalIsoString(now)
  });

  if (decision === 'abort') {
    return {
      project: {
        ...project,
        state: 'FAILED',
        substate: null,
        manualReview: {
          ...project.manualReview,
          status: 'resolved',
          resolvedAt: toLocalIsoString(now),
          decision: 'abort'
        },
        updatedAt: toLocalIsoString(now)
      },
      consumed: true,
      resolved: true,
      decision: 'abort'
    };
  }

  return {
    project: {
      ...project,
      state: resumeStage,
      substate: resumeSubstate,
      manualReview: {
        ...project.manualReview,
        status: 'resolved',
        resolvedAt: toLocalIsoString(now),
        decision: decision || 'resume'
      },
      stagnation: {
        ...(project.stagnation || {}),
        unchangedTicks: 0
      },
      updatedAt: toLocalIsoString(now)
    },
    consumed: true,
    resolved: true,
    decision: decision || 'resume'
  };
}

module.exports = {
  updateStagnation,
  isManualPending,
  shouldOpenManualByStagnation,
  openManualReview,
  applyManualReply
};
