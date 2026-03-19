const { CHAPTER_SUBSTATES, routeChapterSubstate } = require('./stateRouter');
const { toLocalIsoString } = require('../utils/time');

/**
 * 顶层工作流状态机定义。
 * 业务规则：章节创作完成并进入归档后收敛到 COMPLETED。
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
 *
 * @param {string} state 当前状态
 * @returns {string} 下一个状态；无匹配时返回原状态
 */
function getNextSetupState(state) {
  if (state === TOP_LEVEL_STATES.INIT) return TOP_LEVEL_STATES.SETUP_WORLD;
  if (state === TOP_LEVEL_STATES.SETUP_WORLD) return TOP_LEVEL_STATES.SETUP_CHARACTER;
  if (state === TOP_LEVEL_STATES.SETUP_CHARACTER) return TOP_LEVEL_STATES.SETUP_VOLUME;
  if (state === TOP_LEVEL_STATES.SETUP_VOLUME) return TOP_LEVEL_STATES.SETUP_CHAPTER;
  if (state === TOP_LEVEL_STATES.SETUP_CHAPTER) return TOP_LEVEL_STATES.CHAPTER_CREATION;
  return state;
}

function isSetupState(state) {
  return (
    state === TOP_LEVEL_STATES.SETUP_WORLD ||
    state === TOP_LEVEL_STATES.SETUP_CHARACTER ||
    state === TOP_LEVEL_STATES.SETUP_VOLUME ||
    state === TOP_LEVEL_STATES.SETUP_CHAPTER
  );
}

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
 * 关键逻辑：
 * - INIT 在无 ACK 时自举到 SETUP_WORLD；
 * - blocked/waiting ACK 不推进状态；
 * - CHAPTER_CREATION 交由子状态路由器处理；
 * - 章节归档（CH_ARCHIVE）收敛为顶层 COMPLETED。
 *
 * @param {object} project 项目状态
 * @param {object|null} ack 当前 ACK
 * @param {Date} [now] 当前时间
 * @returns {{project: object, advanced: boolean, blocked: boolean, reason: string}} 迁移结果
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

  if (isSetupState(currentState)) {
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
