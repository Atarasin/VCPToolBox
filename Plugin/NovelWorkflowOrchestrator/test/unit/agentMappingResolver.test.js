const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAgentsForProject } = require('../../lib/managers/agentMappingResolver');

test('映射解析在设定阶段按辩论角色返回单Agent', () => {
  const resolved = resolveAgentsForProject(
    {
      projectId: 'p1',
      state: 'SETUP_WORLD',
      substate: null,
      debate: {
        role: 'critic'
      }
    },
    {
      SETUP_WORLD_CRITIC: 'agent_c,agent_d',
      SUPERVISOR: 'supervisor'
    }
  );
  assert.equal(resolved.key, 'SETUP_WORLD_CRITIC');
  assert.deepEqual(resolved.agents, ['agent_c']);
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
