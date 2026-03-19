const crypto = require('crypto');
const path = require('path');
const { createStateStore } = require('../storage/stateStore');
const { applyStateTransition, TOP_LEVEL_STATES } = require('./workflowStateMachine');
const { resolveAgentsForProject } = require('../managers/agentMappingResolver');
const { assembleWakeupContext } = require('../managers/contextAssembler');
const { dispatchWakeups } = require('../managers/wakeupDispatcher');
const { resolvePolicy, applyQualityGateToAck, shouldTriggerManualByLimits } = require('../managers/qualityGateManager');
const {
  updateStagnation,
  isManualPending,
  shouldOpenManualByStagnation,
  openManualReview,
  applyManualReply
} = require('../managers/manualInterventionManager');
const { toLocalIsoString, toLocalCompactTimestamp } = require('../utils/time');

/**
 * Tick 运行器：负责一次完整轮询中的状态推进、质量治理、任务派发与审计落盘。
 */

/**
 * 生成本轮 tick 的唯一标识。
 *
 * @param {Date} now 当前时间
 * @returns {string} 时间片+随机后缀的 tickId
 */
function createTickId(now) {
  const base = toLocalCompactTimestamp(now);
  return `${base}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * 归一化并按项目去重 ACK。
 * 业务规则：同一项目多条 ACK 时，优先级为 acted > blocked > waiting。
 *
 * @param {object} input 输入载荷
 * @returns {Map<string, object>} projectId 到 ACK 的映射
 */
function groupAcksByProject(input) {
  const list = Array.isArray(input?.acks) ? input.acks : [];
  const priority = { acted: 3, blocked: 2, waiting: 1 };
  const map = new Map();
  for (const ack of list) {
    if (!ack || !ack.projectId) {
      continue;
    }
    const status = String(ack.ackStatus || '').toLowerCase();
    const score = priority[status] || 0;
    const existing = map.get(ack.projectId) || [];
    existing.push({ ack, score });
    map.set(ack.projectId, existing);
  }
  return new Map(
    Array.from(map.entries()).map(([projectId, items]) => [
      projectId,
      items.sort((a, b) => b.score - a.score).map(item => item.ack)
    ])
  );
}

function selectAckForProject(project, ackList) {
  const activeWakeupId = project?.activeWakeupId || null;
  if (!activeWakeupId) {
    return {
      matchedAck: null,
      staleAcks: Array.isArray(ackList) ? ackList : []
    };
  }
  const list = Array.isArray(ackList) ? ackList : [];
  const matchedAck = list.find(item => item?.wakeupId && item.wakeupId === activeWakeupId) || null;
  if (!matchedAck) {
    return {
      matchedAck: null,
      staleAcks: list
    };
  }
  return {
    matchedAck,
    staleAcks: list.filter(item => item !== matchedAck)
  };
}

/**
 * 映射设定阶段到对应的辩论计数器键名。
 *
 * @param {string} state 顶层状态
 * @returns {string|null} 计数器键名
 */
function getSetupCounterKey(state) {
  if (state === 'SETUP_WORLD') return 'world';
  if (state === 'SETUP_CHARACTER') return 'character';
  if (state === 'SETUP_VOLUME') return 'volume';
  if (state === 'SETUP_CHAPTER') return 'chapter';
  return null;
}

/**
 * 克隆并归一化计数器，避免空值或非数字导致统计异常。
 *
 * @param {object} counters 当前计数器
 * @param {string} projectId 项目 ID
 * @returns {object} 标准化后的计数器对象
 */
function cloneCounters(counters, projectId) {
  return {
    projectId,
    setupDebateRounds: {
      world: Number(counters?.setupDebateRounds?.world ?? 0),
      character: Number(counters?.setupDebateRounds?.character ?? 0),
      volume: Number(counters?.setupDebateRounds?.volume ?? 0),
      chapter: Number(counters?.setupDebateRounds?.chapter ?? 0)
    },
    chapterIterations: {
      default_chapter: Number(counters?.chapterIterations?.default_chapter ?? 0)
    }
  };
}

/**
 * 按回执与迁移原因更新双计数器。
 * - 设定阶段 acted：累计对应辩论轮次；
 * - review_failed：章节迭代数 +1；
 * - review_passed / chapter_archived_completed：章节迭代归零。
 *
 * @param {object} counters 当前计数器
 * @param {string} stateBeforeTransition 迁移前状态
 * @param {object|null} ack 当前 ACK
 * @param {string} transitionReason 迁移原因
 * @returns {object} 更新后的计数器
 */
function applyCounterUpdates(counters, stateBeforeTransition, ack, transitionReason) {
  const next = cloneCounters(counters, counters.projectId);
  if (
    String(ack?.ackStatus || '').toLowerCase() === 'acted' &&
    (
      transitionReason === 'setup_critic_passed' ||
      transitionReason === 'setup_critic_not_passed_retry' ||
      transitionReason === 'setup_critic_not_passed_max_rounds'
    )
  ) {
    const setupKey = getSetupCounterKey(stateBeforeTransition);
    if (setupKey) {
      next.setupDebateRounds[setupKey] += 1;
    }
  }

  if (transitionReason === 'review_failed') {
    next.chapterIterations.default_chapter += 1;
  }
  if (transitionReason === 'review_passed' || transitionReason === 'chapter_archived_completed') {
    next.chapterIterations.default_chapter = 0;
  }
  return next;
}

function buildManualReviewEntry(project, storagePaths) {
  if (String(project?.manualReview?.status || '') !== 'waiting_human_reply') {
    return null;
  }
  const resumeStage = project?.manualReview?.resumeStage || 'CHAPTER_CREATION';
  const resumeSubstate = project?.manualReview?.resumeSubstate ?? null;
  return {
    projectId: project.projectId,
    status: 'waiting_human_reply',
    triggerReason: project?.manualReview?.triggerReason || 'manual_review_pending',
    requestedAt: project?.manualReview?.requestedAt || null,
    resumeStage,
    resumeSubstate,
    manualRecordPath: path.join(storagePaths.manualReview, `${project.projectId}.json`),
    replyTemplate: {
      manualReplies: [
        {
          projectId: project.projectId,
          decision: 'resume',
          resumeStage,
          resumeSubstate
        }
      ]
    }
  };
}

/**
 * 执行一次 tick。
 * 异常处理：本函数不吞并存储/锁/IO 异常，统一向上抛出以便上层重试与告警。
 *
 * @param {object} options 运行参数
 * @param {string} options.pluginRoot 插件根目录
 * @param {object} options.config 运行配置
 * @param {object} options.input 输入回执与人工回复
 * @returns {Promise<object>} 本轮执行结果摘要
 */
async function runTick(options) {
  const now = new Date();
  const config = options.config || {};
  const tickId = createTickId(now);
  const store = createStateStore({
    pluginRoot: options.pluginRoot,
    storageRoot: config.storageDir || 'storage'
  });

  await store.ensureStorageLayout();
  const bootstrap = await store.bootstrapProjectIfNeeded(config.bootstrapProjectId, {
    stagnantTickThreshold: config.defaultStagnantTickThreshold
  });

  const projects = await store.loadProjects(config.tickMaxProjects ?? 5);
  const acksByProject = groupAcksByProject(options.input || {});
  const checkpoints = [];
  const wakeupSummary = [];
  let remainingWakeupBudget = config.tickMaxWakeups ?? 20;
  let projectsAdvanced = 0;
  let projectsBlocked = 0;
  let wakeupsDispatched = 0;
  let wakeupsAcked = 0;
  let manualInterventionsOpened = 0;
  let manualInterventionsResolved = 0;
  const manualReviewPending = [];

  // 项目级串行处理：确保单项目状态快照与任务派发顺序一致。
  for (const originalProject of projects) {
    let project = originalProject;
    let counters = await store.bootstrapCountersIfNeeded(project.projectId);
    let policy = resolvePolicy(project, config);
    project.debate = {
      role: String(project?.debate?.role || 'designer').toLowerCase() === 'critic' ? 'critic' : 'designer',
      round: Number(project?.debate?.round ?? 0),
      maxRounds: Number(project?.debate?.maxRounds ?? policy.setupMaxDebateRounds ?? 3),
      lastDesignerWakeupId: project?.debate?.lastDesignerWakeupId ?? null,
      lastCriticWakeupId: project?.debate?.lastCriticWakeupId ?? null
    };
    const ackSelection = selectAckForProject(project, acksByProject.get(project.projectId));
    const ack = ackSelection.matchedAck;
    let transitionReason = ackSelection.staleAcks.length > 0 ? 'stale_or_out_of_turn_ack' : 'no_ack';
    let dispatchedTasks = [];
    let decision = 'skipped';
    let shouldSkipDispatch = false;
    let gatedAck = ack;

    // 人工介入优先：若项目处于等待人工状态，先尝试消费人工回复。
    if (isManualPending(project)) {
      const manualReplyResult = await applyManualReply(store, project, options.input || {}, now);
      if (manualReplyResult.consumed && manualReplyResult.resolved) {
        project = manualReplyResult.project;
        manualInterventionsResolved += 1;
        transitionReason = 'manual_reply_resolved';
        decision = `manual_${manualReplyResult.decision || 'resume'}`;
      } else if (config.pauseWakeupWhenManualPending !== false) {
        transitionReason = 'manual_pending';
        decision = 'manual_review_pending';
        shouldSkipDispatch = true;
        projectsBlocked += 1;
      }
    }

    const stateBeforeTransition = project.state;
    let transition = {
      project,
      advanced: false,
      blocked: false,
      reason: transitionReason
    };

    if (!shouldSkipDispatch) {
      for (const staleAck of ackSelection.staleAcks) {
        await store.applyAckToWakeup(staleAck, now);
      }

      // 将回执回写到唤醒任务，保证任务生命周期可追踪。
      if (ack) {
        await store.applyAckToWakeup(ack, now);
        if (String(ack.ackStatus || '').toLowerCase() === 'acted') {
          wakeupsAcked += 1;
        }
      }

      // 质量门禁可能改写 ACK（例如将评审结果标记为 review_failed）。
      const qualityApplied = applyQualityGateToAck(project, ack, policy);
      gatedAck = qualityApplied.ack;
      if (qualityApplied.quality && project.state === 'CHAPTER_CREATION' && project.substate === 'CH_REVIEW') {
        await store.writeQualityReport(project.projectId, 'default_chapter', {
          tickId,
          projectId: project.projectId,
          stage: project.state,
          substate: project.substate,
          quality: qualityApplied.quality,
          ack: gatedAck,
          createdAt: toLocalIsoString(now)
        }, now);
      }

      // 状态迁移在无 ACK 场景也会执行（用于 INIT 自举等规则）。
      transition = applyStateTransition(project, gatedAck, now);
      project = transition.project;
      transitionReason = transition.reason;
      if (!ack && ackSelection.staleAcks.length > 0 && transitionReason === 'no_ack') {
        transitionReason = 'stale_or_out_of_turn_ack';
      }
      counters = applyCounterUpdates(counters, stateBeforeTransition, gatedAck, transitionReason);
      if (ack) {
        project.activeWakeupId = null;
      }
      project = updateStagnation(project, transition.advanced, config);
      policy = resolvePolicy(project, config);
      project.debate = {
        role: String(project?.debate?.role || 'designer').toLowerCase() === 'critic' ? 'critic' : 'designer',
        round: Number(project?.debate?.round ?? 0),
        maxRounds: Number(project?.debate?.maxRounds ?? policy.setupMaxDebateRounds ?? 3),
        lastDesignerWakeupId: project?.debate?.lastDesignerWakeupId ?? null,
        lastCriticWakeupId: project?.debate?.lastCriticWakeupId ?? null
      };

      if (transition.advanced) {
        projectsAdvanced += 1;
      }
      if (transition.blocked) {
        projectsBlocked += 1;
      }

      // 人工触发信号：计数超限、停滞超阈值、关键冲突三类治理规则。
      const limitSignal = shouldTriggerManualByLimits(project, counters, policy);
      const shouldPauseByStagnation = shouldOpenManualByStagnation(project);
      const shouldPauseBySeverity = String(gatedAck?.issueSeverity || '').toLowerCase() === 'critical';
      if (limitSignal.triggered || shouldPauseByStagnation || shouldPauseBySeverity) {
        const reason = limitSignal.triggered
          ? limitSignal.reason
          : shouldPauseByStagnation
            ? 'stagnant_ticks_exceeded'
            : 'critical_conflict_detected';
        const opened = await openManualReview(store, project, {
          triggerReason: reason,
          resumeStage: project.state,
          resumeSubstate: project.substate,
          lastWakeups: project?.lastProgress?.lastWakeupIds || []
        }, now);
        project = opened.project;
        transitionReason = reason;
        decision = 'manual_review_opened';
        shouldSkipDispatch = true;
        manualInterventionsOpened += 1;
        projectsBlocked += 1;
      }
    }

    project.lastProgress = project.lastProgress || {};
    project.lastProgress.lastTickId = tickId;
    project.lastProgress.lastTransitionReason = transitionReason;
    project.lastProgress.lastStaleAckCount = ackSelection.staleAcks.length;
    project.lastProgress.lastAck = ack
      ? {
        wakeupId: ack.wakeupId || null,
        ackStatus: ack.ackStatus || null,
        receivedAt: toLocalIsoString(now)
      }
      : null;

    const terminalState =
      project.state === TOP_LEVEL_STATES.COMPLETED ||
      project.state === TOP_LEVEL_STATES.FAILED ||
      project.state === TOP_LEVEL_STATES.PAUSED_MANUAL_REVIEW;

    // 非终态且未冻结时才允许派发；预算不足时会降级为跳过，不抛错。
    if (!terminalState && !shouldSkipDispatch && config.enableAutonomousTick !== false) {
      const resolution = resolveAgentsForProject(project, config.stageAgents || {});
      if (resolution.agents.length === 0) {
        projectsBlocked += 1;
        decision = 'blocked_missing_agents';
      } else {
        const context = assembleWakeupContext(project, resolution, config, tickId, {
          counters,
          qualityPolicy: policy
        });
        const dispatched = await dispatchWakeups(project, resolution.agents, context, {
          tickId,
          stateStore: store,
          remainingBudget: remainingWakeupBudget
        });
        dispatchedTasks = dispatched.tasks;
        wakeupsDispatched += dispatchedTasks.length;
        remainingWakeupBudget = Math.max(0, remainingWakeupBudget - dispatchedTasks.length);
        project.activeWakeupId = dispatchedTasks.length > 0
          ? dispatchedTasks[0].wakeupId
          : project.activeWakeupId;
        if (dispatchedTasks.length > 0 && String(project.state || '').startsWith('SETUP_')) {
          if (project.debate.role === 'designer') {
            project.debate.lastDesignerWakeupId = dispatchedTasks[0].wakeupId;
          } else if (project.debate.role === 'critic') {
            project.debate.lastCriticWakeupId = dispatchedTasks[0].wakeupId;
          }
        }
        if (resolution.escalatedToSupervisor) {
          projectsBlocked += 1;
          decision = 'escalated_to_supervisor';
        } else if (dispatchedTasks.length === 0 && resolution.agents.length > 0) {
          decision = 'skipped_budget_exhausted';
        } else {
          decision = 'wakeup_sent';
        }
      }
    } else if (shouldSkipDispatch) {
      if (decision === 'skipped') {
        decision = 'dispatch_skipped';
      }
    } else if (terminalState) {
      decision = 'terminal_state';
    } else {
      decision = 'autonomous_disabled';
    }

    project.lastProgress.lastWakeupIds = dispatchedTasks.map(item => item.wakeupId);
    project.lastProgress.lastWakeupCount = dispatchedTasks.length;
    project.lastProgress.counterSnapshot = counters;
    project.updatedAt = toLocalIsoString(now);
    await store.putProjectState(project);
    await store.putCounters(project.projectId, counters);
    const manualReviewEntry = buildManualReviewEntry(project, store.paths);
    if (manualReviewEntry) {
      manualReviewPending.push(manualReviewEntry);
    }

    const snapshot = {
      tickId,
      projectId: project.projectId,
      state: project.state,
      substate: project.substate,
      transitionReason,
      decision,
      ackStatus: gatedAck?.ackStatus || null,
      dispatchedWakeupIds: dispatchedTasks.map(item => item.wakeupId),
      counters,
      manualReviewEntry,
      updatedAt: toLocalIsoString(now)
    };
    checkpoints.push(await store.writeCheckpoint(project.projectId, snapshot, now));
    wakeupSummary.push({
      projectId: project.projectId,
      stage: project.state,
      substate: project.substate || null,
      targetAgents: dispatchedTasks.map(item => item.targetAgent),
      decision
    });
  }

  const result = {
    status: 'success',
    mode: config.enableAutonomousTick === false ? 'autonomous_disabled' : 'active',
    tickId,
    triggeredAt: now.getTime(),
    projectsScanned: projects.length,
    projectsAdvanced,
    projectsBlocked,
    wakeupsDispatched,
    wakeupsTimedOut: 0,
    wakeupsAcked,
    manualInterventionsOpened,
    manualInterventionsResolved,
    bootstrapProjectCreated: Boolean(bootstrap && bootstrap.created),
    storage: {
      root: store.paths.root,
      checkpointsWritten: checkpoints.length
    },
    manualReviewPending,
    wakeupSummary
  };

  // 审计记录用于离线回放和问题定位。
  const auditPath = await store.writeAudit(tickId, {
    tickId,
    triggeredAt: toLocalIsoString(now),
    input: options.input || {},
    config: {
      enableAutonomousTick: Boolean(config.enableAutonomousTick),
      tickMaxProjects: config.tickMaxProjects ?? 5,
      tickMaxWakeups: config.tickMaxWakeups ?? 20
    },
    result
  });

  return {
    ...result,
    auditPath,
    checkpointPaths: checkpoints
  };
}

module.exports = {
  runTick
};
