const { TOP_LEVEL_STATES } = require('../core/workflowStateMachine');
const { CHAPTER_SUBSTATES } = require('../core/stateRouter');

/**
 * Agent 映射解析器：将阶段映射配置转换为可派发的 Agent 列表。
 */

/**
 * 归一化 Agent 配置。
 * 支持数组或逗号分隔字符串两种输入格式。
 *
 * @param {string|string[]|undefined|null} value 原始配置值
 * @returns {string[]} 过滤空值后的 Agent 名称列表
 */
function normalizeAgentList(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * 计算阶段映射键。
 * 业务规则：顶层为 CHAPTER_CREATION 时，按子状态键路由 Agent。
 *
 * @param {object} project 项目状态
 * @returns {string} 映射键
 */
function resolveMappingKey(project) {
  if (project.state === TOP_LEVEL_STATES.CHAPTER_CREATION) {
    const substate = project.substate || CHAPTER_SUBSTATES.PRECHECK;
    return substate;
  }
  return project.state;
}

/**
 * 解析项目当前应唤醒的 Agent 列表。
 * 关键业务规则：
 * - 当前阶段有映射时直接返回；
 * - 无映射则尝试升级至 SUPERVISOR；
 * - 若仍无可用 Agent，则返回 blocked。
 *
 * @param {object} project 项目状态
 * @param {Record<string, string|string[]>} stageAgents 阶段到 Agent 的映射配置
 * @returns {{key: string, agents: string[], blocked: boolean, escalatedToSupervisor: boolean, reason: string}} 解析结果
 */
function resolveAgentsForProject(project, stageAgents) {
  const key = resolveMappingKey(project);
  const resolvedAgents = normalizeAgentList(stageAgents[key]);
  if (resolvedAgents.length > 0) {
    return {
      key,
      agents: resolvedAgents,
      blocked: false,
      escalatedToSupervisor: false,
      reason: 'resolved'
    };
  }

  const supervisor = normalizeAgentList(stageAgents.SUPERVISOR);
  if (supervisor.length > 0) {
    return {
      key,
      agents: supervisor,
      blocked: true,
      escalatedToSupervisor: true,
      reason: 'missing_stage_agent_escalated'
    };
  }

  return {
    key,
    agents: [],
    blocked: true,
    escalatedToSupervisor: false,
    reason: 'missing_stage_agent_no_supervisor'
  };
}

module.exports = {
  resolveAgentsForProject
};
