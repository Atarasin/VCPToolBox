/**
 * 章节创作子状态定义。
 */
const CHAPTER_SUBSTATES = {
  PRECHECK: 'CH_PRECHECK',
  GENERATE: 'CH_GENERATE',
  REVIEW: 'CH_REVIEW',
  REFLOW: 'CH_REFLOW',
  ARCHIVE: 'CH_ARCHIVE'
};

/**
 * 归一化问题严重级别。
 * 业务规则：critical/major 统一视为“重大及以上”。
 *
 * @param {object|null} ack ACK 载荷
 * @returns {'major_or_above'|'minor_or_none'} 严重级别分组
 */
function resolveIssueSeverity(ack) {
  const severity = String(ack?.issueSeverity || '').toLowerCase();
  if (severity === 'critical' || severity === 'major') {
    return 'major_or_above';
  }
  return 'minor_or_none';
}

/**
 * 章节子状态路由。
 * 关键算法：
 * - PRECHECK -> GENERATE -> REVIEW；
 * - REVIEW 依据 issueSeverity/resultType 决定 ARCHIVE 或 REFLOW；
 * - REFLOW -> GENERATE 构成闭环迭代；
 * - 非 acted ACK 不推进。
 *
 * @param {string|null} currentSubstate 当前子状态
 * @param {object|null} ack 当前 ACK
 * @returns {{nextSubstate: string, advanced: boolean, reason: string}} 路由结果
 */
function routeChapterSubstate(currentSubstate, ack) {
  const ackStatus = String(ack?.ackStatus || '').toLowerCase();
  if (ackStatus !== 'acted') {
    return {
      nextSubstate: currentSubstate || CHAPTER_SUBSTATES.PRECHECK,
      advanced: false,
      reason: `ack_${ackStatus || 'none'}`
    };
  }

  const substate = currentSubstate || CHAPTER_SUBSTATES.PRECHECK;
  if (substate === CHAPTER_SUBSTATES.PRECHECK) {
    return {
      nextSubstate: CHAPTER_SUBSTATES.GENERATE,
      advanced: true,
      reason: 'precheck_passed'
    };
  }
  if (substate === CHAPTER_SUBSTATES.GENERATE) {
    return {
      nextSubstate: CHAPTER_SUBSTATES.REVIEW,
      advanced: true,
      reason: 'chapter_generated'
    };
  }
  if (substate === CHAPTER_SUBSTATES.REVIEW) {
    const severity = resolveIssueSeverity(ack);
    if (severity === 'major_or_above' || String(ack?.resultType || '').toLowerCase() === 'review_failed') {
      return {
        nextSubstate: CHAPTER_SUBSTATES.REFLOW,
        advanced: true,
        reason: 'review_failed'
      };
    }
    return {
      nextSubstate: CHAPTER_SUBSTATES.ARCHIVE,
      advanced: true,
      reason: 'review_passed'
    };
  }
  if (substate === CHAPTER_SUBSTATES.REFLOW) {
    return {
      nextSubstate: CHAPTER_SUBSTATES.GENERATE,
      advanced: true,
      reason: 'reflow_planned'
    };
  }
  if (substate === CHAPTER_SUBSTATES.ARCHIVE) {
    return {
      nextSubstate: CHAPTER_SUBSTATES.ARCHIVE,
      advanced: false,
      reason: 'already_archived'
    };
  }

  return {
    nextSubstate: CHAPTER_SUBSTATES.PRECHECK,
    advanced: false,
    reason: 'unknown_substate_reset'
  };
}

module.exports = {
  CHAPTER_SUBSTATES,
  routeChapterSubstate
};
