const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RecoveryManager, SAFE_TO_RESUME_STEP_TYPES } = require('../../../modules/workflowKernel/core/RecoveryManager');

describe('RecoveryManager', () => {
  function makeMockRepo(activeRecords) {
    return {
      listActive: async () => activeRecords,
      update: async () => {}
    };
  }

  it('recovers workflows from safe step types', async () => {
    const records = [{
      workflowId: 'wf-1',
      current_step: JSON.stringify([{ phase: 0 }, { step: 1 }]),
      workflow_state: JSON.stringify({ steps: { s0: { type: 'guard' }, s1: { type: 'checkpoint' } } })
    }];
    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered, failed } = await mgr.startupRecovery();
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].action, 'resume_from_cursor');
    assert.strictEqual(failed.length, 0);
  });

  it('finds last safe boundary for non-idempotent steps', async () => {
    const records = [{
      workflowId: 'wf-2',
      current_step: JSON.stringify([{ phase: 0 }, { step: 2 }]),
      workflow_state: JSON.stringify({ steps: { s0: { type: 'guard' }, s1: { type: 'agentCall' }, s2: { type: 'agentCall' } } })
    }];
    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'resume_from_safe_boundary');
    assert.deepStrictEqual(recovered[0].cursor, [{ phase: 0 }, { step: 0 }]);
  });

  it('prefers explicit recovery cursor when the interrupted step is safe to resume', async () => {
    const records = [{
      workflowId: 'wf-explicit-cursor',
      current_step: JSON.stringify([{ phase: 0 }, { step: 1 }]),
      workflow_state: JSON.stringify({
        steps: {
          s0: { type: 'guard' },
          s1: {
            type: 'customResumable',
            recovery: {
              isIdempotent: true,
              safeResumeBoundary: 'custom_step_boundary',
              boundaryType: 'custom_step_boundary',
              resumeFromCursor: true,
              rollbackBoundaries: ['custom_step_boundary', 'phase_boundary']
            }
          }
        }
      }),
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's1',
            stepIndex: 1,
            boundaryType: 'custom_step_boundary',
            runToken: 'rt-1',
            resumeAction: 'resume_step',
            rollbackSafe: false,
            stepType: 'customResumable',
            executionCursor: [{ phase: 0 }, { step: 1 }]
          },
          rollbackBoundaries: [{
            key: 'phase_boundary:0:-1:',
            boundaryType: 'phase_boundary',
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: null,
            stepIndex: -1,
            runToken: 'rt-1',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 0 }, { step: -1 }]
          }]
        }
      }
    }];

    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'resume_from_cursor');
    assert.strictEqual(recovered[0].recoveryCursor.stepId, 's1');
  });

  it('uses explicit rollback boundaries when the current recovery cursor is unsafe', async () => {
    const records = [{
      workflowId: 'wf-unsafe-cursor',
      current_step: JSON.stringify([{ phase: 0 }, { step: 1 }]),
      workflow_state: JSON.stringify({
        steps: {
          s0: { type: 'guard' },
          s1: { type: 'agentCall' }
        }
      }),
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's1',
            stepIndex: 1,
            boundaryType: 'step_boundary',
            runToken: 'rt-2',
            resumeAction: 'resume_next',
            rollbackSafe: false,
            stepType: 'agentCall',
            executionCursor: [{ phase: 0 }, { step: 1 }]
          },
          rollbackBoundaries: [{
            key: 'phase_boundary:0:-1:',
            boundaryType: 'phase_boundary',
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: null,
            stepIndex: -1,
            runToken: 'rt-2',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 0 }, { step: -1 }]
          }]
        }
      }
    }];

    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'resume_from_safe_boundary');
    assert.deepStrictEqual(recovered[0].cursor, [{ phase: 0 }, { step: -1 }]);
    assert.strictEqual(recovered[0].safeBoundary.boundaryType, 'phase_boundary');
  });

  it('rolls loop steps back to the persisted loop boundary when the loop is not resumable in place', async () => {
    const records = [{
      workflowId: 'wf-loop-boundary',
      current_step: JSON.stringify([{ phase: 0 }, { step: 1 }]),
      workflow_state: JSON.stringify({
        steps: {
          s0: { type: 'guard' },
          s1: { type: 'loop' }
        }
      }),
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's1',
            stepIndex: 1,
            boundaryType: 'loop_boundary',
            runToken: 'rt-loop',
            resumeAction: 'resume_next',
            rollbackSafe: false,
            stepType: 'loop',
            executionCursor: [{ phase: 0 }, { step: 1 }]
          },
          rollbackBoundaries: [{
            key: 'loop_boundary:0:1:',
            boundaryType: 'loop_boundary',
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's1',
            stepIndex: 1,
            runToken: 'rt-loop',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 0 }, { step: 0 }]
          }]
        }
      }
    }];

    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'resume_from_safe_boundary');
    assert.deepStrictEqual(recovered[0].cursor, [{ phase: 0 }, { step: 0 }]);
    assert.strictEqual(recovered[0].safeBoundary.boundaryType, 'loop_boundary');
  });

  it('rolls parallel groups back to the persisted parallel boundary when a branch is unsafe', async () => {
    const records = [{
      workflowId: 'wf-parallel-boundary',
      current_step: JSON.stringify([{ phase: 0 }, { step: 2 }]),
      workflow_state: JSON.stringify({
        steps: {
          s0: { type: 'guard' },
          s1: { type: 'noop' },
          s2: { type: 'parallelGroup' }
        }
      }),
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's2',
            stepIndex: 2,
            boundaryType: 'parallel_group_boundary',
            runToken: 'rt-parallel',
            resumeAction: 'resume_next',
            rollbackSafe: false,
            stepType: 'parallelGroup',
            executionCursor: [{ phase: 0 }, { step: 2 }]
          },
          rollbackBoundaries: [{
            key: 'parallel_group_boundary:0:2:',
            boundaryType: 'parallel_group_boundary',
            phaseId: 'p1',
            phaseIndex: 0,
            stepId: 's2',
            stepIndex: 2,
            runToken: 'rt-parallel',
            resumeAction: 'resume_next',
            rollbackSafe: true,
            executionCursor: [{ phase: 0 }, { step: 1 }]
          }]
        }
      }
    }];

    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'resume_from_safe_boundary');
    assert.deepStrictEqual(recovered[0].cursor, [{ phase: 0 }, { step: 1 }]);
    assert.strictEqual(recovered[0].safeBoundary.boundaryType, 'parallel_group_boundary');
  });

  it('marks failed when no safe boundary exists', async () => {
    const records = [{
      workflowId: 'wf-3',
      current_step: JSON.stringify([{ phase: 0 }, { step: 0 }]),
      workflow_state: JSON.stringify({ steps: { s0: { type: 'agentCall' } } })
    }];
    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'marked_failed');
  });

  it('marks idle when no execution cursor', async () => {
    const records = [{
      workflowId: 'wf-4',
      current_step: null,
      workflow_state: JSON.stringify({ steps: {} })
    }];
    const mgr = new RecoveryManager({}, makeMockRepo(records));
    const { recovered } = await mgr.startupRecovery();
    assert.strictEqual(recovered[0].action, 'marked_idle');
  });

  it('reports failure when _recoverWorkflow throws', async () => {
    const repo = {
      listActive: async () => [{
        workflowId: 'wf-5',
        current_step: JSON.stringify([{ phase: 0 }, { step: 0 }]),
        workflow_state: JSON.stringify({ steps: { s0: { type: 'agentCall' } } })
      }],
      update: async () => { throw new Error('DB write failed'); }
    };
    const mgr = new RecoveryManager({}, repo);
    const { failed } = await mgr.startupRecovery();
    assert.strictEqual(failed.length, 1);
    assert.match(failed[0].error, /DB write failed/);
  });

  it('throws when listActive itself fails', async () => {
    const badRepo = {
      listActive: async () => { throw new Error('DB down'); }
    };
    const mgr = new RecoveryManager({}, badRepo);
    await assert.rejects(mgr.startupRecovery(), /DB down/);
  });

  it('SAFE_TO_RESUME_STEP_TYPES includes checkpoint and guard', () => {
    assert.ok(SAFE_TO_RESUME_STEP_TYPES.includes('checkpoint'));
    assert.ok(SAFE_TO_RESUME_STEP_TYPES.includes('guard'));
  });
});
