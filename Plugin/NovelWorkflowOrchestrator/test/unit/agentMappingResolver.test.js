const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAgentsForProject } = require('../../lib/managers/agentMappingResolver');

test('映射解析可按阶段返回多Agent', () => {
  const resolved = resolveAgentsForProject(
    {
      projectId: 'p1',
      state: 'SETUP_WORLD',
      substate: null
    },
    {
      SETUP_WORLD: 'agent_a,agent_b',
      SUPERVISOR: 'supervisor'
    }
  );
  assert.deepEqual(resolved.agents, ['agent_a', 'agent_b']);
  assert.equal(resolved.escalatedToSupervisor, false);
  assert.equal(resolved.blocked, false);
});

test('缺失阶段Agent时可升级到 SUPERVISOR', () => {
  const resolved = resolveAgentsForProject(
    {
      projectId: 'p2',
      state: 'SETUP_CHARACTER',
      substate: null
    },
    {
      SUPERVISOR: 'supervisor'
    }
  );
  assert.deepEqual(resolved.agents, ['supervisor']);
  assert.equal(resolved.escalatedToSupervisor, true);
  assert.equal(resolved.blocked, true);
});
