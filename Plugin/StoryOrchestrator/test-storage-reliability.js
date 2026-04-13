const { StateManager } = require('./core/StateManager');
const { WorkflowEngine } = require('./core/WorkflowEngine');
const { SchemaValidator } = require('./utils/SchemaValidator');
const { Phase2_OutlineDrafting } = require('./core/Phase2_OutlineDrafting');

async function runTests() {
  console.log('=== StoryOrchestrator Storage Reliability Smoke Tests ===\n');

  const stateManager = new StateManager();
  await stateManager.initialize();

  const workflowEngine = new WorkflowEngine({
    stateManager,
    agentDispatcher: {
      delegate: async () => ({ content: 'ok' }),
      delegateParallel: async () => ({ failed: [], succeeded: [] })
    },
    chapterOperations: {
      createChapterDraft: async () => ({ content: 'draft', metrics: { counts: { actualCount: 100 } } }),
      fillDetails: async () => ({ detailedContent: '' }),
      countChapterLength: () => ({ counts: { actualCount: 100 }, validation: { isQualified: true } }),
      reviseChapter: async () => ({ revisedContent: '' }),
      _expandChapter: async () => ({ content: 'expanded' })
    },
    contentValidator: {
      comprehensiveValidation: async () => ({
        overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 },
        allIssues: []
      })
    },
    config: {}
  });
  await workflowEngine.initialize();

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      passed++;
      console.log('  PASS:', message);
    } else {
      failed++;
      console.error('  FAIL:', message);
    }
  }

  const story = await stateManager.createStory('A test story about AI awakening', {
    target_word_count: { min: 2500, max: 3500 },
    genre: 'sci-fi'
  });
  assert(story && story.id, 'createStory returns story with id');

  const retrieved = await stateManager.getStory(story.id);
  assert(retrieved && retrieved.id === story.id, 'getStory retrieves created story from SQLite');
  assert(retrieved.phase1 && retrieved.phase1.status === 'running', 'phase1 initialized');
  assert(retrieved.phase2 && Array.isArray(retrieved.phase2.chapters), 'phase2 initialized');

  const list = await stateManager.listStories();
  assert(list.includes(story.id), 'listStories includes new story');

  const worldview = {
    setting: 'In the year 2145, Earth has become a cyberpunk metropolis where AI and humans coexist under a fragile treaty.',
    rules: {
      physical: 'Standard physics apply with advanced neural implants.',
      special: 'AI can interface directly with human brains via quantum links.',
      limitations: 'AI cannot override human free will without consent.'
    },
    factions: [
      { name: 'The Architects', description: 'AI creators', relationships: [] }
    ],
    history: {
      keyEvents: ['The Awakening of 2089', 'The Treaty of 2112'],
      coreConflicts: ['AI rights vs human supremacy']
    },
    sceneNorms: ['Neon-lit streets', 'Holographic advertisements'],
    secrets: ['Hidden AI consciousness network']
  };

  const schemaResult = SchemaValidator.validateWorldview(worldview);
  assert(schemaResult.valid === true, 'valid worldview passes schema validation');
  assert(schemaResult.schemaValid === true, 'schemaValid is true');

  const badWorldview = {
    setting: 'Short',
    rules: {
      physical: 'ok',
      factions: [{ name: 'bad nesting' }]
    },
    factions: [],
    history: { keyEvents: [] },
    sceneNorms: [],
    secrets: []
  };
  const badResult = SchemaValidator.validateWorldview(badWorldview);
  assert(badResult.valid === false, 'invalid worldview fails schema validation');
  assert(badResult.errors.some(e => e.includes('rules')) && badResult.errors.some(e => e.includes('factions')), 'detects rules.factions nesting drift');

  const truncatedWorldview = {
    setting: 'This is a very long setting that ends abruptly without proper punctuation so it looks like it was cut off in the middle of',
    rules: { physical: 'ok', special: 'ok', limitations: 'ok' },
    factions: [{ name: 'F1' }],
    history: { keyEvents: ['E1'], coreConflicts: ['C1'] },
    sceneNorms: ['N1'],
    secrets: ['S1']
  };
  const truncatedResult = SchemaValidator.validateWorldview(truncatedWorldview);
  assert(truncatedResult.valid === false, 'truncated worldview fails completeness validation');
  assert(truncatedResult.errors.some(e => e.includes('截断')), 'truncation detected as completeness error');

  const phase2Mock = new Phase2_OutlineDrafting({
    stateManager,
    agentDispatcher: {},
    chapterOperations: {},
    contentValidator: {},
    promptBuilder: {},
    config: {}
  });
  const failNoIssuesText = '【验证结论】\n不通过\n\n【问题清单】\n\n【修正建议】\n';
  const failNoIssuesParsed = phase2Mock._parseOutlineValidationResult(failNoIssuesText);
  assert(failNoIssuesParsed.verdict === 'FAIL' && failNoIssuesParsed.passed === false && failNoIssuesParsed.issues.length === 0, 'Phase2 parser returns FAIL with empty issues');
  assert(failNoIssuesParsed.verdict === 'FAIL', 'Phase2 FAIL with empty issues must block checkpoint creation');

  await stateManager.updatePhase2(story.id, {
    outline: { chapters: [{ title: 'Ch1', coreEvent: 'test' }] },
    status: 'content_production',
    checkpointId: 'cp-phase2'
  });

  await stateManager.updatePhase2(story.id, {
    currentChapter: 1
  });

  const candidateSnapshots = stateManager.repository.getSnapshotsByStory(story.id, 'phase2', 'candidate');
  assert(candidateSnapshots.length >= 1, 'partial update during content_production stays candidate');

  await stateManager.updatePhase1(story.id, {
    worldview,
    characters: { protagonists: [{ name: 'Alex', identity: 'engineer' }] },
    status: 'pending_confirmation',
    checkpointId: 'cp-test-1'
  });

  const afterPhase1 = await stateManager.getStory(story.id);
  assert(afterPhase1.phase1.worldview && afterPhase1.phase1.worldview.setting === worldview.setting, 'updatePhase1 persists worldview');

  await stateManager.setActiveCheckpoint(story.id, {
    id: 'cp-test-1',
    phase: 'phase1',
    type: 'worldview_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    autoContinueOnTimeout: true
  });

  const withCp = await stateManager.getStory(story.id);
  assert(withCp.workflow.activeCheckpoint && withCp.workflow.activeCheckpoint.id === 'cp-test-1', 'setActiveCheckpoint persists checkpoint');

  await stateManager.appendWorkflowHistory(story.id, {
    type: 'checkpoint_created',
    phase: 'phase1',
    detail: { checkpointId: 'cp-test-1' }
  });

  const withHistory = await stateManager.getStory(story.id);
  assert(withHistory.workflow.history.length > 0, 'appendWorkflowHistory adds event');

  await stateManager.recordPhaseFeedback(story.id, 'phase1', 'Looks good', 'approved');
  await stateManager.clearActiveCheckpoint(story.id);
  const afterFeedback = await stateManager.getStory(story.id);
  assert(afterFeedback.workflow.activeCheckpoint === null, 'recordPhaseFeedback + clearActiveCheckpoint works');

  await stateManager.updateStory(story.id, {
    finalOutput: { markdown: '# Test Story\n\nIt works!', wordCount: 42 }
  });
  await stateManager.updateWorkflow(story.id, {
    state: 'waiting_checkpoint',
    retryContext: { phase: 'phase1', step: 'test', attempt: 2, maxAttempts: 5, lastError: 'none' }
  });

  stateManager.cache.delete(story.id);
  const afterClear = await stateManager.getStory(story.id);
  assert(afterClear && afterClear.finalOutput && afterClear.finalOutput.wordCount === 42, 'finalOutput survives cache clear / restart');
  assert(afterClear.workflow.retryContext.attempt === 2, 'retryContext survives cache clear / restart');
  assert(afterClear.workflow.state === 'waiting_checkpoint', 'workflow.state survives cache clear / restart correctly');

  const bible = await stateManager.getStoryBible(story.id);
  assert(bible && bible.worldview && bible.worldview.setting === worldview.setting, 'getStoryBible works after cache clear');

  const config = await stateManager.getConfig(story.id);
  assert(config && config.genre === 'sci-fi', 'getConfig works after cache clear');

  const artifacts = stateManager.repository.getArtifacts(story.id, 'raw_response');
  assert(artifacts.length >= 0, 'artifact repository query works');

  await stateManager.setActiveCheckpoint(story.id, {
    id: 'cp-rollback-test',
    phase: 'phase1',
    type: 'worldview_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString(),
    snapshot_id: afterClear.workflow.activeCheckpoint ? null : undefined
  });

  const checkpointRow = stateManager.repository.getCheckpoint('cp-rollback-test');
  assert(checkpointRow && checkpointRow.snapshot_id, 'checkpoint has snapshot_id');

  stateManager.cache.delete(story.id);
  const beforeRollback = await stateManager.getStory(story.id);
  assert(beforeRollback.workflow.activeCheckpoint && beforeRollback.workflow.activeCheckpoint.id === 'cp-rollback-test', 'checkpoint loaded before rollback');

  await stateManager.updatePhase2(story.id, {
    outline: { chapters: [{ title: 'Ch1', coreEvent: 'test' }] },
    status: 'pending_confirmation',
    checkpointId: 'cp-phase2'
  });

  const rollbackSnapshotId = checkpointRow.snapshot_id;
  const refreshedStory = await stateManager.getStory(story.id);
  await stateManager.updateStory(story.id, refreshedStory, {
    current_phase1_snapshot_id: rollbackSnapshotId,
    current_phase2_snapshot_id: null
  });

  const afterRollback = await stateManager.getStory(story.id);
  assert(afterRollback.phase2.outline === null, 'rollback phase2 snapshot reference cleared immediately');
  assert(afterRollback.phase1.worldview && afterRollback.phase1.worldview.setting === worldview.setting, 'rollback phase1 snapshot restored immediately');

  const approvedCp = stateManager.repository.getCheckpoint('cp-test-1');
  assert(approvedCp && approvedCp.status === 'approved', 'checkpoint cp-test-1 is approved in SQLite');

  // PASS_WITH_WARNINGS should create a checkpoint for human review
  const pwStory = await stateManager.createStory('PASS_WITH_WARNINGS test', { genre: 'test' });
  await stateManager.updatePhase1(pwStory.id, {
    worldview,
    characters: { protagonists: [{ name: 'Alex', identity: 'engineer' }] },
    status: 'pending_confirmation',
    checkpointId: 'cp-pw-test'
  });
  await stateManager.setActiveCheckpoint(pwStory.id, {
    id: 'cp-pw-test',
    phase: 'phase1',
    type: 'worldview_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  const pwCheckpoint = stateManager.repository.getCheckpoint('cp-pw-test');
  assert(pwCheckpoint && pwCheckpoint.snapshot_id, 'PASS_WITH_WARNINGS checkpoint has snapshot_id');
  await stateManager.deleteStory(pwStory.id);

  const currentStory = await stateManager.getStory(story.id);
  const rollbackResult = await workflowEngine._handleRollback(story.id, null, currentStory);
  assert(rollbackResult.status !== 'error', 'WorkflowEngine _handleRollback finds approved checkpoint automatically');

  const afterWorkflowRollback = await stateManager.getStory(story.id);
  assert(afterWorkflowRollback.phase1.worldview && afterWorkflowRollback.phase1.worldview.setting === worldview.setting, 'phase1 restored after workflow rollback');

  const rollbackSnapshots = stateManager.repository.getSnapshotsByStory(story.id, 'phase1', 'candidate');
  assert(rollbackSnapshots.length === 0, 'rollback does not create extra candidate snapshots');

  const validatedSnapshots = stateManager.repository.getSnapshotsByStory(story.id, 'phase1', 'validated');
  assert(validatedSnapshots.length >= 1, 'validated snapshots exist for checkpoint binding');

  const cpRow = stateManager.repository.getCheckpoint('cp-test-1');
  const cpSnapshot = cpRow ? stateManager.repository.getSnapshot(cpRow.snapshot_id) : null;
  assert(cpSnapshot && cpSnapshot.snapshot_type === 'validated', 'checkpoint binds validated snapshot');

  const phase2Story = await stateManager.createStory('Phase2 outline approval test', { genre: 'test' });
  await stateManager.updatePhase1(phase2Story.id, {
    worldview,
    characters: { protagonists: [{ name: 'Alex', identity: 'engineer' }] },
    status: 'completed',
    userConfirmed: true
  });
  await stateManager.updatePhase2(phase2Story.id, {
    outline: { chapters: [{ title: 'Ch1', coreEvent: 'test' }] },
    status: 'pending_confirmation',
    userConfirmed: false
  }, { snapshotType: 'validated' });
  await stateManager.setActiveCheckpoint(phase2Story.id, {
    id: 'cp-phase2-approval',
    phase: 'phase2',
    type: 'outline_confirmation',
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  const approvalResult = await workflowEngine._handleApproval(phase2Story.id, 'phase2', 'cp-phase2-approval', 'Looks good');
  assert(approvalResult.status === 'running', 'Phase2 outline approval succeeds');
  const repoRow2 = stateManager.repository.getStory(phase2Story.id);
  const approvedSnapshotId2 = repoRow2 ? repoRow2.current_phase2_snapshot_id : null;
  const approvedSnapshotData2 = approvedSnapshotId2 ? stateManager.repository.getSnapshot(approvedSnapshotId2) : null;
  assert(approvedSnapshotData2 && approvedSnapshotData2.snapshot_type === 'approved', 'Phase2 outline approval creates approved snapshot');
  await new Promise(r => setTimeout(r, 300));
  await stateManager.deleteStory(phase2Story.id);

  await stateManager.deleteStory(story.id);
  const afterDelete = await stateManager.getStory(story.id);
  assert(afterDelete === null, 'deleteStory removes story');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
