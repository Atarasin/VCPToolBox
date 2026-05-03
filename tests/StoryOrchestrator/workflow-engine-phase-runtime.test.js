const assert = require('node:assert/strict');
const test = require('node:test');

const { WorkflowEngine } = require('../../Plugin/StoryOrchestrator/core/WorkflowEngine');

function createWorkflowEngine() {
  return new WorkflowEngine({
    stateManager: {
      listStories: async () => [],
      getStory: async () => null,
      updateWorkflow: async () => {},
      updateStory: async () => {},
      appendWorkflowHistory: async () => {},
      clearActiveCheckpoint: async () => {}
    },
    agentDispatcher: {},
    chapterOperations: {},
    contentValidator: {},
    config: {}
  });
}

test('_loadPhaseDefinition derives phase1 from the full workflow definition', () => {
  const engine = createWorkflowEngine();

  const resolution = engine._loadPhaseDefinition('phase1');

  assert.equal(resolution.status, 'success');
  assert.equal(resolution.source, 'full_workflow_definition');
  assert.equal(resolution.definition.id, 'story-orchestrator-v1-phase1');
  assert.equal(resolution.definition.phases.length, 1);
  assert.equal(resolution.definition.phases[0].id, 'phase1');
  assert.equal(resolution.definition.phases[0].steps[0].id, 'generateWorldAndCharacters');
});

test('_loadPhaseDefinition derives phase2 and phase3 from the full workflow definition', () => {
  const engine = createWorkflowEngine();

  const phase2 = engine._loadPhaseDefinition('phase2');
  const phase3 = engine._loadPhaseDefinition('phase3');

  assert.equal(phase2.status, 'success');
  assert.equal(phase2.definition.phases[0].id, 'phase2');
  assert.equal(phase2.definition.phases[0].steps[0].id, 'generateOutline');

  assert.equal(phase3.status, 'success');
  assert.equal(phase3.definition.phases[0].id, 'phase3');
  assert.equal(phase3.definition.phases[0].steps[0].id, 'polishChapters');
});

test('_loadPhaseDefinition returns explicit missing result for unsupported phases', () => {
  const engine = createWorkflowEngine();

  const resolution = engine._loadPhaseDefinition('phaseX');

  assert.equal(resolution.status, 'missing');
  assert.equal(resolution.code, 'unsupported_phase');
  assert.match(resolution.message, /Unsupported phase definition requested/);
});

test('_loadPhaseDefinition returns invalid result when full workflow definition is malformed', () => {
  const engine = createWorkflowEngine();
  engine._loadFullWorkflowDefinitionModule = () => ({ id: 'broken-definition' });

  const resolution = engine._loadPhaseDefinition('phase1');

  assert.equal(resolution.status, 'invalid');
  assert.equal(resolution.code, 'invalid_full_workflow_definition');
});

test('_loadPhaseDefinition returns deprecated result when legacy phase module is explicitly deprecated', () => {
  const engine = createWorkflowEngine();
  engine._loadLegacyPhaseDefinitionModule = () => ({ deprecated: true });

  const resolution = engine._loadPhaseDefinition('phase1');

  assert.equal(resolution.status, 'deprecated');
  assert.equal(resolution.code, 'deprecated_phase_definition');
});

test('_runPhaseWithKernel surfaces explicit unsupported-phase failures', async () => {
  const engine = createWorkflowEngine();
  engine.kernelAdapter = {
    executePhase: async () => {
      throw new Error('executePhase should not be called for unsupported phases');
    }
  };

  const result = await engine._runPhaseWithKernel('story-test', 'phaseX');

  assert.equal(result.status, 'error');
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'unsupported_phase');
  assert.equal(result.currentPhase, 'phaseX');
  assert.equal(result.phaseDefinitionStatus, 'missing');
});

test('_runPhaseWithKernel returns normalized runtime state for phase execution', async () => {
  const engine = createWorkflowEngine();
  engine.kernelAdapter = {
    executePhase: async (storyId, phaseName, definition) => ({
      workflowId: storyId,
      status: 'waiting_checkpoint',
      executionCursor: [{ phase: 0 }, { step: 2 }],
      checkpointState: { checkpointId: 'cp-phase2', type: 'phase2_outline_confirmation' },
      context: { inputs: { storyId }, outputs: {}, steps: {} },
      definitionRef: definition.id
    })
  };

  const result = await engine._runPhaseWithKernel('story-phase2', 'phase2');

  assert.equal(result.status, 'waiting_checkpoint');
  assert.equal(result.state, 'waiting_checkpoint');
  assert.equal(result.currentPhase, 'phase2');
  assert.equal(result.currentStep, 'schemaValidateOutline');
  assert.deepEqual(result.activeCheckpoint, { checkpointId: 'cp-phase2', type: 'phase2_outline_confirmation' });
  assert.equal(result.phaseDefinitionSource, 'full_workflow_definition');
  assert.equal(result.phaseDefinitionStatus, 'success');
});
