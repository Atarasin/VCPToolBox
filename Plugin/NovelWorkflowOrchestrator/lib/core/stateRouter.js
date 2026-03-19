/**
 * 章节创作子状态路由器模块：定义章节创作的子状态流转逻辑。
 * 子状态流转路径：
 * CH_PRECHECK -> CH_GENERATE -> CH_REVIEW -> (CH_ARCHIVE | CH_REFLOW)
 * 其中 CH_REFLOW -> CH_GENERATE 形成迭代闭环
 *
 * @module core/stateRouter
 */

/**
 * 章节创作子状态常量定义。
 * @property {string} PRECHECK 预检查阶段
 * @property {string} GENERATE 内容生成阶段
 * @property {string} REVIEW 评审阶段
 * @property {string} REFLOW 回流/返工阶段
 * @property {string} ARCHIVE 归档阶段
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
 * 业务规则：critical/major 统一视为"重大及以上"，用于质量判定
 *
 * @param {object|null} ack ACK 载荷
 * @returns {'major_or_above'|'minor_or_none'} 严重级别分组
 *
 * @example
 * resolveIssueSeverity({ issueSeverity: 'critical' }) // 返回 'major_or_above'
 * resolveIssueSeverity({ issueSeverity: 'minor' })   // 返回 'minor_or_none'
 * resolveIssueSeverity(null)                         // 返回 'minor_or_none'
 */
function resolveIssueSeverity(ack) {
  const severity = String(ack?.issueSeverity || '').toLowerCase();
  if (severity === 'critical' || severity === 'major') {
    return 'major_or_above';
  }
  return 'minor_or_none';
}

/**
 * 章节子状态路由函数。
 * 状态机规则：
 * 1. 非 acted ACK 不推进状态
 * 2. PRECHECK -> GENERATE：预检查通过
 * 3. GENERATE -> REVIEW：生成完成
 * 4. REVIEW：
 *    - 评审通过（minor/no severity）-> ARCHIVE
 *    - 评审不通过（major_or_above 或 resultType=review_failed）-> REFLOW
 * 5. REFLOW -> GENERATE：进入下一轮迭代
 * 6. ARCHIVE 保持不变
 *
 * @param {string|null} currentSubstate 当前子状态
 * @param {object|null} ack 当前 ACK
 * @returns {object} 路由结果
 * @property {string} nextSubstate 下一子状态
 * @property {boolean} advanced 是否发生推进
 * @property {string} reason 路由原因/触发条件
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
