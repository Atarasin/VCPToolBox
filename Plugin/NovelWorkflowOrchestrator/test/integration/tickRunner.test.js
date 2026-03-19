const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs/promises');
const { runTick } = require('../../lib/core/tickRunner');
const { createStateStore, createDefaultProjectState } = require('../../lib/storage/stateStore');

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

test('tickRunner 在无角色映射时进入阻塞并完成持久化', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-'));
  const result = await runTick({
    pluginRoot,
    input: { source: 'test' },
    config: {
      enableAutonomousTick: true,
      tickMaxProjects: 5,
      tickMaxWakeups: 20,
      storageDir: 'storage',
      bootstrapProjectId: 'novel_week1',
      defaultStagnantTickThreshold: 3
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.mode, 'active');
  assert.equal(result.projectsScanned >= 1, true);
  assert.equal(typeof result.tickId, 'string');
  assert.equal(result.wakeupsDispatched, 0);
  assert.equal(result.projectsBlocked >= 1, true);
  assert.equal(Array.isArray(result.checkpointPaths), true);
  assert.equal(result.checkpointPaths.length >= 1, true);

  const auditExists = await fs.stat(result.auditPath).then(() => true).catch(() => false);
  assert.equal(auditExists, true);
});

test('tickRunner 支持角色映射分发与回执推进', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w2-'));
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: 'novel_week2',
    defaultStagnantTickThreshold: 3,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent_a,world_agent_b',
      SETUP_WORLD_CRITIC: 'world_critic_agent',
      SETUP_CHARACTER_DESIGNER: 'character_agent',
      SETUP_CHARACTER_CRITIC: 'character_critic_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const firstTick = await runTick({
    pluginRoot,
    input: {},
    config
  });
  assert.equal(firstTick.wakeupsDispatched, 1);
  assert.equal(firstTick.wakeupSummary[0].decision, 'wakeup_sent');
  const wakeupFiles = await fs.readdir(path.join(pluginRoot, 'storage', 'wakeups'));
  const firstWakeupFile = wakeupFiles.find(name => name.endsWith('.json'));
  assert.equal(Boolean(firstWakeupFile), true);
  const firstWakeupId = firstWakeupFile.replace(/\.json$/, '');
  const firstProjectRaw = await fs.readFile(path.join(pluginRoot, 'storage', 'projects', 'novel_week2.json'), 'utf8');
  const firstProjectState = JSON.parse(firstProjectRaw);
  assert.equal(firstProjectState.activeWakeupId, firstWakeupId);

  const secondTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId: 'novel_week2',
          wakeupId: firstWakeupId,
          ackStatus: 'acted'
        }
      ]
    },
    config
  });

  assert.equal(secondTick.wakeupSummary[0].stage, 'SETUP_WORLD');
  assert.equal(secondTick.wakeupSummary[0].decision, 'wakeup_sent');
  const criticWakeupId = await findLatestWakeupId(pluginRoot, 'novel_week2');
  const thirdTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId: 'novel_week2',
          wakeupId: criticWakeupId,
          ackStatus: 'acted',
          metrics: {
            setupScore: 90
          }
        }
      ]
    },
    config
  });
  assert.equal(thirdTick.projectsAdvanced >= 1, true);
  assert.equal(thirdTick.wakeupsDispatched >= 1, true);
  assert.equal(thirdTick.wakeupSummary[0].stage, 'SETUP_CHARACTER');
  const countersRaw = await fs.readFile(path.join(pluginRoot, 'storage', 'counters', 'novel_week2.json'), 'utf8');
  const counters = JSON.parse(countersRaw);
  assert.equal(counters.setupDebateRounds.world >= 1, true);
});

test('tickRunner 仅消费 activeWakeupId 匹配的ACK', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w2-active-'));
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: 'novel_week2_active',
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent',
      SETUP_CHARACTER_DESIGNER: 'character_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  await runTick({ pluginRoot, input: {}, config });
  const staleTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId: 'novel_week2_active',
          wakeupId: 'wk_stale_ack',
          ackStatus: 'acted'
        }
      ]
    },
    config
  });
  assert.equal(staleTick.wakeupSummary[0].stage, 'SETUP_WORLD');
  const activeWakeupId = await findLatestWakeupId(pluginRoot, 'novel_week2_active');

  const effectiveDesignerTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId: 'novel_week2_active',
          wakeupId: activeWakeupId,
          ackStatus: 'acted'
        }
      ]
    },
    config
  });
  assert.equal(effectiveDesignerTick.wakeupSummary[0].stage, 'SETUP_WORLD');
  const criticWakeupId = await findLatestWakeupId(pluginRoot, 'novel_week2_active');
  const effectiveCriticTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId: 'novel_week2_active',
          wakeupId: criticWakeupId,
          ackStatus: 'acted',
          metrics: {
            setupScore: 90
          }
        }
      ]
    },
    config
  });
  assert.equal(effectiveCriticTick.wakeupSummary[0].stage, 'SETUP_CHARACTER');
});

test('tickRunner 在设定回合达到最大轮次时触发人工介入', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-setup-max-round-'));
  const projectId = 'novel_week4_setup_max_round';
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState(projectId, new Date());
  project.state = 'SETUP_WORLD';
  project.activeWakeupId = 'wk_seed_setup_max_round';
  project.debate = {
    role: 'critic',
    round: 2,
    maxRounds: 3,
    lastDesignerWakeupId: null,
    lastCriticWakeupId: 'wk_seed_setup_max_round'
  };
  await store.putProjectState(project);
  await store.bootstrapCountersIfNeeded(projectId);

  const tick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId: 'wk_seed_setup_max_round',
          ackStatus: 'acted',
          metrics: {
            setupScore: 70
          }
        }
      ]
    },
    config: {
      enableAutonomousTick: true,
      tickMaxProjects: 5,
      tickMaxWakeups: 20,
      storageDir: 'storage',
      bootstrapProjectId: '',
      setupPassThreshold: 85,
      setupMaxDebateRounds: 3,
      pauseWakeupWhenManualPending: true,
      stageAgents: {
        SETUP_WORLD_DESIGNER: 'world_designer_agent',
        SETUP_WORLD_CRITIC: 'world_critic_agent',
        SUPERVISOR: 'supervisor_agent'
      }
    }
  });

  assert.equal(tick.manualInterventionsOpened >= 1, true);
  assert.equal(tick.wakeupSummary[0].decision, 'manual_review_opened');
  const updatedProject = await store.getProjectState(projectId);
  assert.equal(updatedProject.state, 'PAUSED_MANUAL_REVIEW');
});

test('tickRunner 连续停滞可触发人工介入并冻结唤醒', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w3-'));
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: 'novel_week3_manual',
    defaultStagnantTickThreshold: 3,
    stagnantTickThreshold: 3,
    pauseWakeupWhenManualPending: true,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent_a',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  await runTick({ pluginRoot, input: {}, config });
  await runTick({ pluginRoot, input: {}, config });
  await runTick({ pluginRoot, input: {}, config });
  const fourthTick = await runTick({ pluginRoot, input: {}, config });

  assert.equal(fourthTick.manualInterventionsOpened >= 1, true);
  assert.equal(fourthTick.wakeupSummary[0].decision, 'manual_review_opened');

  const frozenTick = await runTick({ pluginRoot, input: {}, config });
  assert.equal(frozenTick.wakeupSummary[0].decision, 'manual_review_pending');
  assert.equal(frozenTick.wakeupsDispatched, 0);
});

test('tickRunner 接收人工回复后可恢复调度', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w3-resume-'));
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: 'novel_week3_resume',
    defaultStagnantTickThreshold: 2,
    stagnantTickThreshold: 2,
    pauseWakeupWhenManualPending: true,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent_a',
      SETUP_CHARACTER_DESIGNER: 'character_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  await runTick({ pluginRoot, input: {}, config });
  await runTick({ pluginRoot, input: {}, config });
  await runTick({ pluginRoot, input: {}, config });

  const resumeTick = await runTick({
    pluginRoot,
    input: {
      manualReplies: [
        {
          projectId: 'novel_week3_resume',
          decision: 'resume',
          resumeStage: 'SETUP_WORLD',
          resumeSubstate: null
        }
      ]
    },
    config
  });

  assert.equal(resumeTick.manualInterventionsResolved >= 1, true);
  assert.equal(resumeTick.wakeupsDispatched >= 1, true);
  assert.equal(resumeTick.wakeupSummary[0].decision, 'wakeup_sent');
});

test('tickRunner 可完成 INIT 到 COMPLETED 的端到端 happy path', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-happy-'));
  const projectId = 'novel_week4_happy';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    defaultStagnantTickThreshold: 3,
    stagnantTickThreshold: 3,
    pauseWakeupWhenManualPending: true,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent',
      SETUP_CHARACTER_DESIGNER: 'character_agent',
      SETUP_VOLUME_DESIGNER: 'volume_agent',
      SETUP_CHAPTER_DESIGNER: 'chapter_outline_agent',
      CH_PRECHECK: 'chapter_precheck_agent',
      CH_GENERATE: 'chapter_writer_agent',
      CH_REVIEW: 'chapter_reviewer_agent',
      CH_REFLOW: 'chapter_reflow_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  let tick = await runTick({ pluginRoot, input: {}, config });
  assert.equal(tick.wakeupSummary[0].stage, 'SETUP_WORLD');
  const ackInputs = [
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 90 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 90 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 90 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted', metrics: { setupScore: 90 } },
    { ackStatus: 'acted' },
    { ackStatus: 'acted' },
    {
      ackStatus: 'acted',
      metrics: {
        outlineCoverage: 0.95,
        pointCoverage: 0.98,
        wordcountRatio: 1.0,
        criticalInconsistencyCount: 0
      }
    }
  ];

  for (const ackInput of ackInputs) {
    const wakeupId = await findLatestWakeupId(pluginRoot, projectId);
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
  }

  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  const project = await store.getProjectState(projectId);
  assert.equal(project.state, 'COMPLETED');
  assert.equal(tick.wakeupsDispatched, 0);
  assert.equal(tick.wakeupSummary[0].decision, 'terminal_state');
});

test('tickRunner 支持 CH_REVIEW -> CH_REFLOW -> CH_GENERATE 回流路径', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-reflow-'));
  const projectId = 'novel_week4_reflow';
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const project = createDefaultProjectState(projectId, new Date());
  project.state = 'CHAPTER_CREATION';
  project.substate = 'CH_REVIEW';
  project.activeWakeupId = 'wk_seed_reflow';
  await store.putProjectState(project);
  await store.bootstrapCountersIfNeeded(projectId);

  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 20,
    storageDir: 'storage',
    bootstrapProjectId: '',
    stageAgents: {
      CH_REFLOW: 'chapter_reflow_agent',
      CH_GENERATE: 'chapter_writer_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };

  const reviewFailedTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId: 'wk_seed_reflow',
          ackStatus: 'acted',
          issueSeverity: 'major',
          metrics: {
            outlineCoverage: 0.8,
            pointCoverage: 0.85,
            wordcountRatio: 0.9,
            criticalInconsistencyCount: 0
          }
        }
      ]
    },
    config
  });
  assert.equal(reviewFailedTick.wakeupSummary[0].substate, 'CH_REFLOW');
  assert.equal(reviewFailedTick.wakeupSummary[0].targetAgents[0], 'chapter_reflow_agent');

  const reflowWakeupId = await findLatestWakeupId(pluginRoot, projectId);
  const reflowTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId: reflowWakeupId,
          ackStatus: 'acted'
        }
      ]
    },
    config
  });
  assert.equal(reflowTick.wakeupSummary[0].substate, 'CH_GENERATE');
  assert.equal(reflowTick.wakeupSummary[0].targetAgents[0], 'chapter_writer_agent');
});

test('tickRunner 在多项目场景下保持状态隔离', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-multi-'));
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const p1 = createDefaultProjectState('novel_p1', new Date());
  p1.state = 'SETUP_WORLD';
  const p2 = createDefaultProjectState('novel_p2', new Date());
  p2.state = 'SETUP_CHARACTER';
  await store.putProjectState(p1);
  await store.putProjectState(p2);
  await store.bootstrapCountersIfNeeded('novel_p1');
  await store.bootstrapCountersIfNeeded('novel_p2');

  const tick = await runTick({
    pluginRoot,
    input: {},
    config: {
      enableAutonomousTick: true,
      tickMaxProjects: 10,
      tickMaxWakeups: 10,
      storageDir: 'storage',
      bootstrapProjectId: '',
      stageAgents: {
        SETUP_WORLD_DESIGNER: 'world_agent',
        SETUP_CHARACTER_DESIGNER: 'character_agent',
        SUPERVISOR: 'supervisor_agent'
      }
    }
  });

  assert.equal(tick.projectsScanned, 2);
  assert.equal(tick.wakeupSummary.length, 2);
  const agentMatrix = tick.wakeupSummary.map(item => item.targetAgents[0]).sort();
  assert.deepEqual(agentMatrix, ['character_agent', 'world_agent']);
});

test('tickRunner 在配置变更后门禁行为符合预期', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-config-'));
  const projectId = 'novel_week4_config';
  const store = createStateStore({ pluginRoot, storageRoot: 'storage' });
  await store.ensureStorageLayout();
  const baseProject = createDefaultProjectState(projectId, new Date());
  baseProject.state = 'CHAPTER_CREATION';
  baseProject.substate = 'CH_REVIEW';
  baseProject.activeWakeupId = 'wk_seed_config_strict';
  await store.putProjectState(baseProject);
  await store.bootstrapCountersIfNeeded(projectId);

  const strictConfig = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 10,
    storageDir: 'storage',
    bootstrapProjectId: '',
    chapterPointCoverageMin: 0.95,
    chapterOutlineCoverageMin: 0.9,
    chapterWordcountMinRatio: 0.9,
    chapterWordcountMaxRatio: 1.1,
    criticalInconsistencyZeroTolerance: true,
    stageAgents: {
      CH_REFLOW: 'reflow_agent',
      CH_GENERATE: 'writer_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };
  const strictTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId: 'wk_seed_config_strict',
          ackStatus: 'acted',
          metrics: {
            outlineCoverage: 0.92,
            pointCoverage: 0.9,
            wordcountRatio: 1.0,
            criticalInconsistencyCount: 0
          }
        }
      ]
    },
    config: strictConfig
  });
  assert.equal(strictTick.wakeupSummary[0].substate, 'CH_REFLOW');

  const resetProject = createDefaultProjectState(projectId, new Date());
  resetProject.state = 'CHAPTER_CREATION';
  resetProject.substate = 'CH_REVIEW';
  resetProject.activeWakeupId = 'wk_seed_config_loose';
  await store.putProjectState(resetProject);
  await store.bootstrapCountersIfNeeded(projectId);

  const looseTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId: 'wk_seed_config_loose',
          ackStatus: 'acted',
          metrics: {
            outlineCoverage: 0.92,
            pointCoverage: 0.9,
            wordcountRatio: 1.0,
            criticalInconsistencyCount: 0
          }
        }
      ]
    },
    config: {
      ...strictConfig,
      chapterPointCoverageMin: 0.85,
      stageAgents: {
        CH_REFLOW: 'reflow_agent',
        CH_GENERATE: 'writer_agent',
        CH_REVIEW: 'review_agent',
        SUPERVISOR: 'supervisor_agent'
      }
    }
  });
  assert.equal(looseTick.wakeupSummary[0].stage, 'COMPLETED');
});

test('tickRunner 审计日志结构完整且可回放关键结果', async () => {
  const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nwo-tick-w4-audit-'));
  const projectId = 'novel_week4_audit';
  const config = {
    enableAutonomousTick: true,
    tickMaxProjects: 5,
    tickMaxWakeups: 10,
    storageDir: 'storage',
    bootstrapProjectId: projectId,
    stageAgents: {
      SETUP_WORLD_DESIGNER: 'world_agent',
      SETUP_CHARACTER_DESIGNER: 'character_agent',
      SUPERVISOR: 'supervisor_agent'
    }
  };
  const firstTick = await runTick({ pluginRoot, input: {}, config });
  const wakeupId = await findLatestWakeupId(pluginRoot, projectId);
  const secondTick = await runTick({
    pluginRoot,
    input: {
      acks: [
        {
          projectId,
          wakeupId,
          ackStatus: 'acted'
        }
      ]
    },
    config
  });

  const firstAudit = JSON.parse(await fs.readFile(firstTick.auditPath, 'utf8'));
  const secondAudit = JSON.parse(await fs.readFile(secondTick.auditPath, 'utf8'));
  assert.equal(firstAudit.result.status, 'success');
  assert.equal(Array.isArray(firstAudit.result.wakeupSummary), true);
  assert.equal(secondAudit.result.wakeupsDispatched >= 1, true);
  assert.equal(secondAudit.result.wakeupsAcked >= 1, true);
});
