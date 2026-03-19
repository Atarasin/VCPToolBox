const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { runTick } = require('../../lib/core/tickRunner');
const { createStateStore } = require('../../lib/storage/stateStore');

async function findLatestWakeupId(pluginRoot, projectId) {
  const wakeupDir = path.join(pluginRoot, 'storage', 'wakeups');
  const files = await fs.readdir(wakeupDir);
  const jsonFiles = files.filter(name => name.endsWith('.json'));
  const tasks = await Promise.all(
    jsonFiles.map(async name => {
      const filePath = path.join(wakeupDir, name);
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw);
    })
  );
  const matched = tasks
    .filter(item => item.projectId === projectId)
    .sort((a, b) => String(b.dispatchedAt || '').localeCompare(String(a.dispatchedAt || '')));
  return matched.length > 0 ? matched[0].wakeupId : null;
}

test('全生命周期端到端：初始化到整书完成', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-e2e-lifecycle-'));
  const projectId = 'novel_e2e_lifecycle';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    defaultStagnantTickThreshold: 3,
    stagnantTickThreshold: 3,
    pauseWakeupWhenManualPending: true,
    setupPassThreshold: 85,
    setupMaxDebateRounds: 3,
    chapterMaxIterations: 3,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_designer',
      SETUP_WORLD_CRITIC: 'world_critic',
      SETUP_CHARACTER_DESIGNER: 'character_designer',
      SETUP_CHARACTER_CRITIC: 'character_critic',
      SETUP_VOLUME_DESIGNER: 'volume_designer',
      SETUP_VOLUME_CRITIC: 'volume_critic',
      SETUP_CHAPTER_DESIGNER: 'chapter_designer',
      SETUP_CHAPTER_CRITIC: 'chapter_critic',
      CH_PRECHECK: 'chapter_precheck',
      CH_GENERATE: 'chapter_generate',
      CH_REVIEW: 'chapter_review',
      CH_REFLOW: 'chapter_reflow',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const stateTrace = [];
  let tick = await runTick({ pluginRoot, input: {}, config });
  stateTrace.push(`${tick.wakeupSummary[0].stage}:${tick.wakeupSummary[0].substate || '-'}`);
  assert.equal(tick.wakeupSummary[0].stage, 'SETUP_WORLD');
  assert.equal(tick.wakeupSummary[0].targetAgents[0], 'world_designer');

  const ackPlan = [
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 92 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 90 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 93 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 91 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted' },
    {
      ackStatus: 'acted',
      metrics: {
        outlineCoverage: 0.96,
        pointCoverage: 0.97,
        wordcountRatio: 1.0,
        criticalInconsistencyCount: 0
      }
    }
  ];

  for (const ackInput of ackPlan) {
    const wakeupId = await findLatestWakeupId(pluginRoot, projectId);
    assert.equal(Boolean(wakeupId), true);
    tick = await runTick({
      pluginRoot,
      input: {
        acks: [
          {
            projectId,
            wakeupId,
            ...ackInput
          }
        ]
      },
      config
    });
    stateTrace.push(`${tick.wakeupSummary[0].stage}:${tick.wakeupSummary[0].substate || '-'}`);
  }

  const expectedTrace = [
    'SETUP_WORLD:-',
    'SETUP_WORLD:-',
    'SETUP_CHARACTER:-',
    'SETUP_CHARACTER:-',
    'SETUP_VOLUME:-',
    'SETUP_VOLUME:-',
    'SETUP_CHAPTER:-',
    'SETUP_CHAPTER:-',
    'CHAPTER_CREATION:CH_PRECHECK',
    'CHAPTER_CREATION:CH_GENERATE',
    'CHAPTER_CREATION:CH_REVIEW',
    'COMPLETED:CH_ARCHIVE'
  ];
  assert.deepEqual(stateTrace, expectedTrace);

  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  const project = await store.getProjectState(projectId);
  assert.equal(project.state, 'COMPLETED');
  assert.equal(project.substate, 'CH_ARCHIVE');
  assert.equal(project.activeWakeupId, null);

  const counters = await store.getCounters(projectId);
  assert.equal(counters.setupDebateRounds.world, 1);
  assert.equal(counters.setupDebateRounds.character, 1);
  assert.equal(counters.setupDebateRounds.volume, 1);
  assert.equal(counters.setupDebateRounds.chapter, 1);
  assert.equal(counters.chapterIterations.default_chapter, 0);

  const wakeups = await store.listWakeupsByProject(projectId, 50);
  assert.equal(wakeups.length >= 11, true);
  assert.equal(wakeups.every(item => Boolean(item.context?.stageMappingKey)), true);
  assert.equal(wakeups.every(item => Boolean(item.context?.objective)), true);
  assert.equal(wakeups.every(item => item.ackStatus !== 'pending'), true);

  assert.equal(tick.wakeupSummary[0].decision, 'terminal_state');
  assert.equal(tick.wakeupsDispatched, 0);
  assert.equal(tick.manualInterventionsOpened, 0);
});
