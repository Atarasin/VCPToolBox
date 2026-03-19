/**
 * Agent 映射解析器模块：将项目当前阶段映射为可执行的 Agent 列表。
 * 核心职责：
 * 1. 根据项目状态和辩论角色确定应唤醒的 Agent
 * 2. 处理 Agent 配置的多种输入格式
 * 3. 当指定 Agent 缺失时自动升级（escalate）到 SUPERVISOR
 *
 * @module managers/agentMappingResolver
 * @requires ../core/workflowStateMachine
 * @requires ../core/stateRouter
 */

const { TOP_LEVEL_STATES } = require('../core/workflowStateMachine');
const { CHAPTER_SUBSTATES } = require('../core/stateRouter');

/**
 * 归一化 Agent 配置。
 * 支持两种输入格式：
 * 1. 数组格式：['Agent1', 'Agent2']
 * 2. 逗号分隔字符串格式：'Agent1, Agent2'
 *
 * @param {string|string[]|undefined|null} value 原始配置值
 * @returns {string[]} 过滤空值后的 Agent 名称列表
 *
 * @example
 * normalizeAgentList(['DESIGNER', 'CRITIC']) // 返回 ['DESIGNER', 'CRITIC']
 * normalizeAgentList('DESIGNER, CRITIC')      // 返回 ['DESIGNER', 'CRITIC']
 * normalizeAgentList(null)                    // 返回 []
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
 * 从配置中选取第一个 Agent（单 Agent 模式）。
 *
 * @param {string|string[]|undefined|null} value 原始配置值
 * @returns {string[]} 至多包含一个 Agent 的数组
 */
function pickSingleAgent(value) {
  const normalized = normalizeAgentList(value);
  return normalized.length > 0 ? [normalized[0]] : [];
}

/**
 * 解析设定阶段的 Agent。
 * 阶段与 Agent 映射键格式：{STATE}_{ROLE}
 * 例如：SETUP_WORLD_DESIGNER、SETUP_CHARACTER_CRITIC
 *
 * @param {object} project 项目状态
 * @param {object} stageAgents 阶段 Agent 映射配置
 * @returns {object} 解析结果
 * @property {string} key 映射键
 * @property {string[]} agents 解析出的 Agent 列表
 * @property {boolean} blocked 是否被阻塞（无 Agent 可用）
 * @property {boolean} escalatedToSupervisor 是否升级到 SUPERVISOR
 * @property {string} reason 解析结果原因
 */
function resolveSetupRoleAgent(project, stageAgents) {
  const role = String(project?.debate?.role || 'designer').toLowerCase() === 'critic' ? 'CRITIC' : 'DESIGNER';
  const stage = project.state;
  const key = `${stage}_${role}`;
  const agents = pickSingleAgent(stageAgents[key]);

  if (agents.length > 0) {
    return {
      key,
      agents,
      blocked: false,
      escalatedToSupervisor: false,
      reason: 'resolved'
    };
  }

  const supervisor = pickSingleAgent(stageAgents.SUPERVISOR);
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

/**
 * 解析章节创作阶段的 Agent。
 * 映射键为子状态（substate），例如 CH_PRECHECK、CH_GENERATE、CH_REVIEW 等
 *
 * @param {object} project 项目状态
 * @param {object} stageAgents 阶段 Agent 映射配置
 * @returns {object} 解析结果（同 resolveSetupRoleAgent）
 */
function resolveChapterAgent(project, stageAgents) {
  const key = project.substate || CHAPTER_SUBSTATES.PRECHECK;
  const agents = pickSingleAgent(stageAgents[key]);

  if (agents.length > 0) {
    return {
      key,
      agents,
      blocked: false,
      escalatedToSupervisor: false,
      reason: 'resolved'
    };
  }

  const supervisor = pickSingleAgent(stageAgents.SUPERVISOR);
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

/**
 * 解析项目当前应唤醒的 Agent 列表。
 * 核心业务规则：
 * - CHAPTER_CREATION 阶段使用子状态路由解析
 * - 设定阶段根据 debate.role 区分 DESIGNER/CRITIC
 * - 配置缺失时自动升级到 SUPERVISOR
 *
 * @param {object} project 项目状态
 * @param {Record<string, string|string[]>} stageAgents 阶段到 Agent 的映射配置
 * @returns {object} 解析结果
 * @property {string} key 匹配的映射键
 * @property {string[]} agents 目标 Agent 列表
 * @property {boolean} blocked 是否阻塞（无 Agent 可用）
 * @property {boolean} escalatedToSupervisor 是否升级到 SUPERVISOR
 * @property {string} reason 解析原因
 *
 * @example
 * // 配置示例
 * const stageAgents = {
 *   'SETUP_WORLD_DESIGNER': 'WorldDesigner',
 *   'SETUP_WORLD_CRITIC': 'WorldCritic',
 *   'CHAPTER_CREATION_CH_PRECHECK': 'ChapterPrechecker',
 *   'SUPERVISOR': 'SupervisorAgent'
 * };
 */
function resolveAgentsForProject(project, stageAgents) {
  if (project.state === TOP_LEVEL_STATES.CHAPTER_CREATION) {
    return resolveChapterAgent(project, stageAgents);
  }
  return resolveSetupRoleAgent(project, stageAgents);
}

module.exports = {
  resolveAgentsForProject
};
