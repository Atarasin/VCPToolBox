/**
 * 顶层工作流状态机模块：定义项目从初始化到完成的顶层状态流转逻辑。
 * 状态流转：
 * INIT -> SETUP_WORLD -> SETUP_CHARACTER -> SETUP_VOLUME -> SETUP_CHAPTER -> CHAPTER_CREATION -> COMPLETED
 *                                                      |
 *                                              (评审不通过可回退)
 *
 * @module core/workflowStateMachine
 * @requires ./stateRouter
 * @requires ../utils/time
 */

const { CHAPTER_SUBSTATES, routeChapterSubstate } = require('./stateRouter');
const { toLocalIsoString } = require('../utils/time');

/**
 * 顶层工作流状态常量定义。
 * @property {string} INIT 初始化状态
 * @property {string} SETUP_WORLD 世界观设定阶段
 * @property {string} SETUP_CHARACTER 人物设定阶段
 * @property {string} SETUP_VOLUME 分卷设定阶段
 * @property {string} SETUP_CHAPTER 章节规划阶段
 * @property {string} CHAPTER_CREATION 章节创作阶段
 * @property {string} PAUSED_MANUAL_REVIEW 人工介入暂停状态
 * @property {string} COMPLETED 已完成
 * @property {string} FAILED 已失败
 */
const TOP_LEVEL_STATES = {
  INIT: 'INIT',
  SETUP_WORLD: 'SETUP_WORLD',
  SETUP_CHARACTER: 'SETUP_CHARACTER',
  SETUP_VOLUME: 'SETUP_VOLUME',
  SETUP_CHAPTER: 'SETUP_CHAPTER',
  CHAPTER_CREATION: 'CHAPTER_CREATION',
  PAUSED_MANUAL_REVIEW: 'PAUSED_MANUAL_REVIEW',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED'
};

/**
 * 计算设定链路的下一个顶层状态。
 * 链路顺序：INIT -> SETUP_WORLD -> SETUP_CHARACTER -> SETUP_VOLUME -> SETUP_CHAPTER -> CHAPTER_CREATION
 *
 * @param {string} state 当前状态
 * @returns {string} 下一个状态；若已是最终状态则返回原状态
 *
 * @example
 * getNextSetupState('INIT')           // 返回 'SETUP_WORLD'
 * getNextSetupState('SETUP_CHAPTER')  // 返回 'CHAPTER_CREATION'
 * getNextSetupState('CHAPTER_CREATION') // 返回 'CHAPTER_CREATION'（不再前进）
 */
function getNextSetupState(state) {
  if (state === TOP_LEVEL_STATES.INIT) return TOP_LEVEL_STATES.SETUP_WORLD;
  if (state === TOP_LEVEL_STATES.SETUP_WORLD) return TOP_LEVEL_STATES.SETUP_CHARACTER;
  if (state === TOP_LEVEL_STATES.SETUP_CHARACTER) return TOP_LEVEL_STATES.SETUP_VOLUME;
  if (state === TOP_LEVEL_STATES.SETUP_VOLUME) return TOP_LEVEL_STATES.SETUP_CHAPTER;
  if (state === TOP_LEVEL_STATES.SETUP_CHAPTER) return TOP_LEVEL_STATES.CHAPTER_CREATION;
  return state;
}

/**
 * 判断是否为设定阶段。
 * 设定阶段包括：SETUP_WORLD、SETUP_CHARACTER、SETUP_VOLUME、SETUP_CHAPTER
 *
 * @param {string} state 顶层状态
 * @returns {boolean} 是否为设定阶段
 */
function isSetupState(state) {
  return (
    state === TOP_LEVEL_STATES.SETUP_WORLD ||
    state === TOP_LEVEL_STATES.SETUP_CHARACTER ||
    state === TOP_LEVEL_STATES.SETUP_VOLUME ||
    state === TOP_LEVEL_STATES.SETUP_CHAPTER
  );
}

/**
 * 确保辩论状态结构完整。
 * 用于初始化或修复不完整的 debate 字段
 *
 * @param {object} project 项目状态
 * @returns {object} 完整的辩论状态
 */
function ensureDebateState(project) {
  const qualityPolicy = project.qualityPolicy || {};
  const source = project.debate || {};
  return {
    role: String(source.role || 'designer').toLowerCase() === 'critic' ? 'critic' : 'designer',
    round: Number(source.round ?? 0),
    maxRounds: Number(source.maxRounds ?? qualityPolicy.setupMaxDebateRounds ?? 3),
    lastDesignerWakeupId: source.lastDesignerWakeupId ?? null,
    lastCriticWakeupId: source.lastCriticWakeupId ?? null
  };
}

/**
 * 解析设定阶段是否通过。
 * 判断逻辑：
 * 1. 若 ACK 包含 qualityGate.passed 字段，直接使用
 * 2. 否则根据 setupScore/passScore/score 与阈值比较
 *
 * @param {object|null} ack 当前 ACK
 * @param {object} project 项目状态
 * @returns {boolean} 是否通过
 */
function resolveSetupPass(ack, project) {
  if (!ack) {
    return true;
  }
  if (typeof ack?.qualityGate?.passed === 'boolean') {
    return ack.qualityGate.passed;
  }
  const threshold = Number(project?.qualityPolicy?.setupPassThreshold ?? 85);
  const score = Number(ack?.metrics?.setupScore ?? ack?.metrics?.passScore ?? ack?.score ?? 100);
  return score >= threshold;
}

/**
 * 应用一次状态迁移。
 * 核心状态机逻辑：
 * 1. 无 ACK 时：INIT 自举到 SETUP_WORLD，blocked/waiting 不推进
 * 2. acted ACK 时：
 *    - CHAPTER_CREATION：委托给子状态路由器
 *    - 设定阶段：designer->critic 角色轮转，或根据评审结果推进
 * 3. 章节归档时（CH_ARCHIVE）收敛为顶层 COMPLETED
 *
 * @param {object} project 项目状态
 * @param {object|null} ack 当前 ACK
 * @param {Date} [now] 当前时间
 * @returns {object} 迁移结果
 * @property {object} project 更新后的项目状态
 * @property {boolean} advanced 是否发生状态推进
 * @property {boolean} blocked 是否被阻塞
 * @property {string} reason 迁移原因
 *
 * @example
 * const result = applyStateTransition(project, ack, new Date());
 * if (result.advanced) {
 *   console.log('状态已推进到:', result.project.state);
 * }
 */
function applyStateTransition(project, ack, now = new Date()) {
  const currentState = project.state || TOP_LEVEL_STATES.INIT;
  const ackStatus = String(ack?.ackStatus || '').toLowerCase();
  const debate = ensureDebateState(project);
  const nextProject = {
    ...project,
    debate,
    updatedAt: toLocalIsoString(now)
  };

  if (!ack || !ackStatus) {
    if (currentState === TOP_LEVEL_STATES.INIT) {
      nextProject.state = TOP_LEVEL_STATES.SETUP_WORLD;
      nextProject.debate = {
        ...debate,
        role: 'designer',
        round: 0
      };
      return {
        project: nextProject,
        advanced: true,
        blocked: false,
        reason: 'init_bootstrap'
      };
    }
    return {
      project: nextProject,
      advanced: false,
      blocked: false,
      reason: 'no_ack'
    };
  }

  if (ackStatus === 'blocked') {
    return {
      project: nextProject,
      advanced: false,
      blocked: true,
      reason: 'ack_blocked'
    };
  }

  if (ackStatus === 'waiting') {
    return {
      project: nextProject,
      advanced: false,
      blocked: false,
      reason: 'ack_waiting'
    };
  }

  if (ackStatus !== 'acted') {
    return {
      project: nextProject,
      advanced: false,
      blocked: false,
      reason: `ack_${ackStatus}`
    };
  }

  // 阶段二：章节创作
  if (currentState === TOP_LEVEL_STATES.CHAPTER_CREATION) {
    const routed = routeChapterSubstate(project.substate, ack);
    nextProject.substate = routed.nextSubstate;
    if (routed.nextSubstate === CHAPTER_SUBSTATES.ARCHIVE) {
      nextProject.state = TOP_LEVEL_STATES.COMPLETED;
      nextProject.substate = CHAPTER_SUBSTATES.ARCHIVE;
      return {
        project: nextProject,
        advanced: true,
        blocked: false,
        reason: 'chapter_archived_completed'
      };
    }
    return {
      project: nextProject,
      advanced: routed.advanced,
      blocked: false,
      reason: routed.reason
    };
  }

  // 阶段一：设定创作
  if (isSetupState(currentState)) {
    // designer 角色：转换为 critic
    if (debate.role === 'designer') {
      nextProject.debate = {
        ...debate,
        role: 'critic'
      };
      return {
        project: nextProject,
        advanced: false,
        blocked: false,
        reason: 'setup_designer_to_critic'
      };
    }

    // critic 角色：根据评审结果推进或重试
    const passed = resolveSetupPass(ack, project);
    if (passed) {
      const nextState = getNextSetupState(currentState);
      nextProject.state = nextState;
      nextProject.debate = {
        ...debate,
        role: 'designer',
        round: 0
      };
      if (nextState === TOP_LEVEL_STATES.CHAPTER_CREATION && !nextProject.substate) {
        nextProject.substate = CHAPTER_SUBSTATES.PRECHECK;
      }
      return {
        project: nextProject,
        advanced: nextState !== currentState,
        blocked: false,
        reason: nextState === currentState ? 'state_unchanged' : 'setup_critic_passed'
      };
    }

    const nextRound = Number(debate.round ?? 0) + 1;
    nextProject.debate = {
      ...debate,
      role: 'designer',
      round: nextRound
    };
    if (nextRound >= Number(debate.maxRounds ?? 3)) {
      return {
        project: nextProject,
        advanced: false,
        blocked: true,
        reason: 'setup_critic_not_passed_max_rounds'
      };
    }
    return {
      project: nextProject,
      advanced: false,
      blocked: false,
      reason: 'setup_critic_not_passed_retry'
    };
  }

  const nextState = getNextSetupState(currentState);
  nextProject.state = nextState;
  if (nextState === TOP_LEVEL_STATES.CHAPTER_CREATION && !nextProject.substate) {
    nextProject.substate = CHAPTER_SUBSTATES.PRECHECK;
  }
  return {
    project: nextProject,
    advanced: nextState !== currentState,
    blocked: false,
    reason: nextState === currentState ? 'state_unchanged' : 'setup_advanced'
  };
}

module.exports = {
  TOP_LEVEL_STATES,
  applyStateTransition
};
