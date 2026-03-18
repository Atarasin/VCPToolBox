/**
 * 质量门禁管理器：负责策略解析、ACK 改写与人工触发信号判定。
 */

/**
 * 解析项目级质量策略，优先级为 project.qualityPolicy > config > 默认值。
 *
 * @param {object} project 项目状态
 * @param {object} config 运行配置
 * @returns {object} 生效的质量策略
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
 * 关键算法：逐项校验覆盖率、字数比、关键冲突数并累计失败原因。
 *
 * @param {object|null} ack 当前 ACK
 * @param {object} policy 质量策略
 * @returns {{passed: boolean, failures: string[]}} 评估结果
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
 * @returns {{passed: boolean, score: number}} 评估结果
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
 * - CH_REVIEW 不达标时改写为 review_failed；
 * - SETUP_* 不达标时改写 ackStatus=waiting，阻止状态推进。
 *
 * @param {object} project 项目状态
 * @param {object|null} ack 当前 ACK
 * @param {object} policy 生效策略
 * @returns {{ack: object|null, quality: object|null}} 改写后的 ACK 与评估结果
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
    if (!setupQuality.passed) {
      return {
        ack: {
          ...ack,
          ackStatus: 'waiting',
          resultType: 'setup_score_not_passed',
          qualityGate: setupQuality
        },
        quality: setupQuality
      };
    }
    return {
      ack: {
        ...ack,
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
 *
 * @param {object} project 项目状态
 * @param {object} counters 计数器快照
 * @param {object} policy 生效策略
 * @returns {{triggered: boolean, reason: string|null}} 触发信号
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
