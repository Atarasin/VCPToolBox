/**
 * 唤醒上下文组装器：为被唤醒 Agent 提供统一且可执行的上下文快照。
 */

/**
 * 根据当前阶段生成目标说明。
 *
 * @param {object} project 项目状态
 * @returns {string} 当前阶段目标
 */
function buildObjective(project) {
  if (project.state === 'SETUP_WORLD') return '完成世界观设定草案并推进评审结论';
  if (project.state === 'SETUP_CHARACTER') return '完善人物设定并给出评审结论';
  if (project.state === 'SETUP_VOLUME') return '产出分卷方案并完成正反评审';
  if (project.state === 'SETUP_CHAPTER') return '形成章节细纲基础并准备进入章节创作';
  if (project.state === 'CHAPTER_CREATION') return '推进章节创作闭环（生成-评审-回流）';
  return '根据当前阶段推进小说创作工作流';
}

/**
 * 基于阶段生成建议动作。
 *
 * @param {object} project 项目状态
 * @returns {string[]} 建议动作列表
 */
function buildSuggestedActions(project) {
  if (project.state === 'CHAPTER_CREATION') {
    return [
      '基于当前子状态推进章节内容或评审结果',
      '必要时更新社区 Wiki 与讨论串',
      '若条件不足则返回 waiting 并说明缺失信息'
    ];
  }
  return [
    '围绕当前阶段产出设定内容与评审意见',
    '可调用社区插件沉淀内容',
    '若暂无可执行动作则返回 waiting'
  ];
}

/**
 * 组装唤醒任务上下文。
 * 关键逻辑：聚合阶段信息、质量策略、计数器快照、停滞信息与调度约束。
 *
 * @param {object} project 项目状态
 * @param {object} resolution Agent 解析结果
 * @param {object} config Tick 配置
 * @param {string} tickId 本轮 tick 标识
 * @param {object} [extras] 可选扩展信息
 * @returns {object} 标准化上下文对象
 */
function assembleWakeupContext(project, resolution, config, tickId, extras = {}) {
  const counters = extras.counters || {};
  const qualityPolicy = extras.qualityPolicy || project.qualityPolicy || {};
  return {
    tickId,
    projectId: project.projectId,
    currentStage: project.state,
    currentSubstate: project.substate || null,
    stageMappingKey: resolution.key,
    objective: buildObjective(project),
    qualityPolicy,
    counterSnapshot: counters,
    stagnation: project.stagnation || {},
    waitCondition: '缺少依赖信息、上下文不足或外部阻塞时可返回 waiting',
    suggestedActions: buildSuggestedActions(project),
    escalatedToSupervisor: resolution.escalatedToSupervisor,
    resolverReason: resolution.reason,
    tickConstraints: {
      tickMaxProjects: config.tickMaxProjects,
      tickMaxWakeups: config.tickMaxWakeups
    }
  };
}

module.exports = {
  assembleWakeupContext
};
