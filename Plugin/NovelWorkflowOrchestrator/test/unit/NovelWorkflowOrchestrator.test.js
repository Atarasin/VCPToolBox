const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTopLevelHealth } = require('../../NovelWorkflowOrchestrator');

test('resolveTopLevelHealth 在执行器关闭时返回 not_available', () => {
  const health = resolveTopLevelHealth(
    {},
    {
      executorEnabled: false,
      executorType: 'agent_assistant'
    }
  );
  assert.equal(health.status, 'not_available');
  assert.equal(health.score, null);
  assert.equal(health.source, 'executor_disabled');
});

test('resolveTopLevelHealth 在执行器开启且有执行健康时返回桥接健康', () => {
  const health = resolveTopLevelHealth(
    {
      execution: {
        health: {
          status: 'yellow',
          score: 72
        },
        backlogAlert: {
          triggered: true
        }
      }
    },
    {
      executorEnabled: true,
      executorType: 'agent_assistant'
    }
  );
  assert.equal(health.status, 'yellow');
  assert.equal(health.score, 72);
  assert.equal(health.source, 'execution_bridge');
  assert.equal(health.backlogAlertTriggered, true);
});

test('resolveTopLevelHealth 在执行器开启但无执行健康时返回 unknown', () => {
  const health = resolveTopLevelHealth(
    {},
    {
      executorEnabled: true,
      executorType: 'agent_assistant'
    }
  );
  assert.equal(health.status, 'unknown');
  assert.equal(health.score, null);
  assert.equal(health.source, 'execution_missing');
});
