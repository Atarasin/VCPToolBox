const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePolicy,
  applyQualityGateToAck,
  shouldTriggerManualByLimits
} = require('../../lib/managers/qualityGateManager');

test('质量门禁在章节审核不达标时标记 review_failed', () => {
  const policy = resolvePolicy(
    {
      qualityPolicy: {}
    },
    {
      chapterOutlineCoverageMin: 0.9,
      chapterPointCoverageMin: 0.95,
      chapterWordcountMinRatio: 0.9,
      chapterWordcountMaxRatio: 1.1,
      criticalInconsistencyZeroTolerance: true
    }
  );
  const result = applyQualityGateToAck(
    {
      state: 'CHAPTER_CREATION',
      substate: 'CH_REVIEW'
    },
    {
      ackStatus: 'acted',
      metrics: {
        outlineCoverage: 0.8,
        pointCoverage: 0.9,
        wordcountRatio: 0.8,
        criticalInconsistencyCount: 1
      }
    },
    policy
  );
  assert.equal(result.ack.resultType, 'review_failed');
  assert.equal(result.quality.passed, false);
});

test('质量门禁在设定评分不足时保留 acted 并标记未通过', () => {
  const policy = resolvePolicy(
    {
      qualityPolicy: {
        setupPassThreshold: 90
      }
    },
    {}
  );
  const result = applyQualityGateToAck(
    {
      state: 'SETUP_WORLD',
      substate: null
    },
    {
      ackStatus: 'acted',
      metrics: {
        setupScore: 85
      }
    },
    policy
  );
  assert.equal(result.ack.ackStatus, 'acted');
  assert.equal(result.ack.resultType, 'setup_score_not_passed');
  assert.equal(result.ack.qualityGate.passed, false);
});

test('计数器超限可触发人工介入信号', () => {
  const signal = shouldTriggerManualByLimits(
    {
      state: 'SETUP_WORLD'
    },
    {
      setupDebateRounds: {
        world: 3
      },
      chapterIterations: {
        default_chapter: 0
      }
    },
    {
      setupMaxDebateRounds: 3,
      chapterMaxIterations: 3
    }
  );
  assert.equal(signal.triggered, true);
  assert.equal(signal.reason, 'setup_debate_rounds_exceeded');
});
