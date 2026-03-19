const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveBackoffSeconds, shouldFinalizeFailure, buildNextRetryAt } = require('../../lib/execution/retryPolicy');

test('resolveBackoffSeconds 按尝试次数线性退避', () => {
  assert.equal(resolveBackoffSeconds(1, 30), 30);
  assert.equal(resolveBackoffSeconds(2, 30), 60);
  assert.equal(resolveBackoffSeconds(3, 30), 90);
});

test('shouldFinalizeFailure 在达到最大重试时返回 true', () => {
  assert.equal(shouldFinalizeFailure(1, 3), false);
  assert.equal(shouldFinalizeFailure(2, 3), false);
  assert.equal(shouldFinalizeFailure(3, 3), true);
});

test('buildNextRetryAt 生成晚于当前时间的时间戳', () => {
  const now = new Date('2026-03-20T10:00:00.000Z');
  const next = new Date(buildNextRetryAt(now, 2, 30));
  assert.equal(Number.isNaN(next.getTime()), false);
  assert.equal(next.getTime() > now.getTime(), true);
});
