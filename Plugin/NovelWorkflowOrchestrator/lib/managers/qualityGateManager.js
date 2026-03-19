/**
 * 质量门禁管理器模块：负责策略解析、ACK 质量评估与人工触发信号判定。
 * 核心职责：
 * 1. 解析项目级与全局级质量策略
 * 2. 对章节创作和设定阶段进行质量评估
 * 3. 判定是否需要人工介入（轮次超限、迭代超限等）
 *
 * @module managers/qualityGateManager
 */

/**
 * 解析项目级质量策略。
 * 优先级：project.qualityPolicy > config > 默认值
 *
 * @param {object} project 项目状态
 * @param {object} config 运行配置
 * @returns {object} 生效的质量策略
 * @property {number} setupPassThreshold 设定阶段通过分数阈值，默认85
 * @property {number} setupMaxDebateRounds 设定阶段最大辩论轮次，默认3
 * @property {number} chapterMaxIterations 章节最大迭代次数，默认3
 * @property {number} outlineCoverageMin 大纲覆盖率最低值，默认0.9
 * @property {number} pointCoverageMin 要点覆盖率最低值，默认0.95
 * @property {number} wordcountMinRatio 字数下限比例，默认0.9
 * @property {number} wordcountMaxRatio 字数上限比例，默认1.1
 * @property {boolean} criticalZeroTolerance 关键冲突零容忍，默认true
 *
 * @example
 * const policy = resolvePolicy(project, config);
 * // policy.setupPassThreshold 可从 project.qualityPolicy.setupPassThreshold 获取
 * // 或 fallback 到 config.setupPassThreshold
 * // 最终使用默认值 85
 */
function resolvePolicy(project, config) {
  const qualityPolicy = project.qualityPolicy || {};
  return {
    setupPassThreshold: qualityPolicy.setupPassThreshold ?? config.setupPassThreshold ?? 85,
    setupMaxDebateRounds: qualityPolicy.setupMaxDebateRounds ?? config.setupMaxDebateRounds ?? 3,
    chapterMaxIterations: qualityPolicy.chapterMaxIterations ?? config.chapterMaxIterations ?? 3,
    outlineCoverageMin: config.chapterOutlineCoverageMin ?? 0.9,
    pointCoverageMin: config.chapterPointCoverageMin ?? 0.95,
    wordcountMinRatio: config.chapterWordcountMinRatio ?? 0.9,
    wordcountMaxRatio: config.chapterWordcountMaxRatio ?? 1.1,
    criticalZeroTolerance: config.criticalInconsistencyZeroTolerance !== false
  };
}

/**
 * 评估章节质量指标。
 * 逐项校验以下指标：
 * 1. 大纲覆盖率（outlineCoverage）：需 >= outlineCoverageMin
 * 2. 要点覆盖率（pointCoverage）：需 >= pointCoverageMin
 * 3. 字数比例下限（wordcountRatio）：需 >= wordcountMinRatio
 * 4. 字数比例上限（wordcountRatio）：需 <= wordcountMaxRatio
 * 5. 关键冲突数（criticalInconsistencyCount）：零容忍模式下必须为 0
 *
 * @param {object|null} ack 当前 ACK
 * @param {object} policy 质量策略
 * @returns {object} 评估结果
 * @property {boolean} passed 是否全部通过
 * @property {string[]} failures 失败原因列表
 *
 * @example
 * const result = evaluateChapterQuality(ack, policy);
 * if (!result.passed) {
 *   console.log('质量不达标原因:', result.failures);
 * }
 */
function evaluateChapterQuality(ack, policy) {
  const metrics = ack?.metrics || {};
  const failures = [];

  if (Number(metrics.outlineCoverage ?? 0) < policy.outlineCoverageMin) {
    failures.push('outline_coverage_low');
  }
  if (Number(metrics.pointCoverage ?? 0) < policy.pointCoverageMin) {
    failures.push('point_coverage_low');
  }
  if (Number(metrics.wordcountRatio ?? 0) < policy.wordcountMinRatio) {
    failures.push('wordcount_ratio_low');
  }
  if (Number(metrics.wordcountRatio ?? 0) > policy.wordcountMaxRatio) {
    failures.push('wordcount_ratio_high');
  }
  if (policy.criticalZeroTolerance && Number(metrics.criticalInconsistencyCount ?? 0) > 0) {
    failures.push('critical_inconsistency_detected');
  }

  return {
    passed: failures.length === 0,
    failures
  };
}

/**
 * 评估设定阶段质量分数。
 *
 * @param {object|null} ack 当前 ACK
 * @param {object} policy 质量策略
 * @returns {object} 评估结果
 * @property {boolean} passed 是否通过（分数 >= 阈值）
 * @property {number} score 评估分数
 */
function evaluateSetupQuality(ack, policy) {
  const score = Number(ack?.metrics?.setupScore ?? ack?.metrics?.passScore ?? ack?.score ?? 100);
  return {
    passed: score >= policy.setupPassThreshold,
    score
  };
}

/**
 * 应用质量门禁到 ACK。
 * 业务规则：
 * - 非 acted 状态的 ACK 不进行质量评估
 * - CHAPTER_CREATION + CH_REVIEW：质量不达标时改写 resultType 为 'review_failed'
 * - SETUP_* 阶段：质量不达标时改写 resultType 为 'setup_score_not_passed'
 *
 * @param {object} project 项目状态
 * @param {object|null} ack 当前 ACK
 * @param {object} policy 生效策略
 * @returns {object} 改写结果
 * @property {object|null} ack 改写后的 ACK（可能新增 qualityGate 字段）
 * @property {object|null} quality 质量评估结果
 */
function applyQualityGateToAck(project, ack, policy) {
  if (!ack || String(ack.ackStatus || '').toLowerCase() !== 'acted') {
    return {
      ack,
      quality: null
    };
  }

  if (String(project.state || '') === 'CHAPTER_CREATION' && String(project.substate || '') === 'CH_REVIEW') {
    const chapterQuality = evaluateChapterQuality(ack, policy);
    if (!chapterQuality.passed) {
      return {
        ack: {
          ...ack,
          resultType: 'review_failed',
          issueSeverity: ack.issueSeverity || 'major',
          qualityGate: chapterQuality
        },
        quality: chapterQuality
      };
    }
    return {
      ack: {
        ...ack,
        resultType: ack.resultType || 'review_passed',
        qualityGate: chapterQuality
      },
      quality: chapterQuality
    };
  }

  if (String(project.state || '').startsWith('SETUP_')) {
    const setupQuality = evaluateSetupQuality(ack, policy);
    return {
      ack: {
        ...ack,
        resultType: setupQuality.passed ? (ack.resultType || 'setup_score_passed') : 'setup_score_not_passed',
        qualityGate: setupQuality
      },
      quality: setupQuality
    };
  }

  return {
    ack,
    quality: null
  };
}

/**
 * 判定是否因轮次/迭代超限触发人工介入。
 * 检测场景：
 * 1. 设定阶段辩论轮次达到上限
 * 2. 章节迭代次数达到上限
 *
 * @param {object} project 项目状态
 * @param {object} counters 计数器快照
 * @param {object} policy 生效策略
 * @returns {object} 触发信号
 * @property {boolean} triggered 是否触发
 * @property {string|null} reason 触发原因
 *
 * @example
 * const signal = shouldTriggerManualByLimits(project, counters, policy);
 * if (signal.triggered) {
 *   console.log('需要人工介入:', signal.reason);
 * }
 */
function shouldTriggerManualByLimits(project, counters, policy) {
  const setupMap = {
    SETUP_WORLD: 'world',
    SETUP_CHARACTER: 'character',
    SETUP_VOLUME: 'volume',
    SETUP_CHAPTER: 'chapter'
  };

  const setupKey = setupMap[project.state];
  if (setupKey) {
    const debateRound = Number(project?.debate?.round ?? 0);
    if (debateRound >= policy.setupMaxDebateRounds) {
      return {
        triggered: true,
        reason: 'setup_debate_rounds_exceeded'
      };
    }
    const rounds = Number(counters?.setupDebateRounds?.[setupKey] ?? 0);
    if (rounds >= policy.setupMaxDebateRounds) {
      return {
        triggered: true,
        reason: 'setup_debate_rounds_exceeded'
      };
    }
  }

  const iteration = Number(counters?.chapterIterations?.default_chapter ?? 0);
  if (iteration >= policy.chapterMaxIterations) {
    return {
      triggered: true,
      reason: 'chapter_iterations_exceeded'
    };
  }

  return {
    triggered: false,
    reason: null
  };
}

module.exports = {
  resolvePolicy,
  applyQualityGateToAck,
  shouldTriggerManualByLimits
};
