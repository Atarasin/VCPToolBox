const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  resolveStepRecoveryMetadata,
  normalizeRecoveryState,
  applyRecoveryState
} = require('../../../modules/workflowKernel/core/RecoveryContract');

describe('RecoveryContract', () => {
  it('assigns loop steps a loop boundary that resumes from the enclosing boundary', () => {
    const metadata = resolveStepRecoveryMetadata({ type: 'loop' });

    assert.strictEqual(metadata.isIdempotent, false);
    assert.strictEqual(metadata.boundaryType, 'loop_boundary');
    assert.strictEqual(metadata.safeResumeBoundary, 'loop_boundary');
    assert.strictEqual(metadata.resumeFromCursor, false);
    assert.deepStrictEqual(metadata.rollbackBoundaries, ['loop_boundary', 'phase_boundary']);
  });

  it('assigns parallel groups a composite rollback boundary', () => {
    const metadata = resolveStepRecoveryMetadata({ type: 'parallelGroup' });

    assert.strictEqual(metadata.isIdempotent, false);
    assert.strictEqual(metadata.boundaryType, 'parallel_group_boundary');
    assert.strictEqual(metadata.safeResumeBoundary, 'parallel_group_boundary');
    assert.strictEqual(metadata.resumeFromCursor, false);
    assert.deepStrictEqual(metadata.rollbackBoundaries, ['parallel_group_boundary', 'phase_boundary']);
  });

  it('honors explicit custom recovery metadata for resumable custom steps', () => {
    const metadata = resolveStepRecoveryMetadata({
      type: 'customResumable',
      recovery: {
        isIdempotent: true,
        safeResumeBoundary: 'custom_step_boundary',
        boundaryType: 'custom_step_boundary',
        resumeFromCursor: true,
        rollbackBoundaries: ['custom_step_boundary', 'phase_boundary']
      }
    });

    assert.strictEqual(metadata.isIdempotent, true);
    assert.strictEqual(metadata.boundaryType, 'custom_step_boundary');
    assert.strictEqual(metadata.safeResumeBoundary, 'custom_step_boundary');
    assert.strictEqual(metadata.resumeFromCursor, true);
    assert.deepStrictEqual(metadata.rollbackBoundaries, ['custom_step_boundary', 'phase_boundary']);
  });

  it('treats unknown custom steps as unsafe unless metadata says otherwise', () => {
    const metadata = resolveStepRecoveryMetadata({ type: 'customUnknown' });

    assert.strictEqual(metadata.isIdempotent, false);
    assert.strictEqual(metadata.boundaryType, 'custom_step_boundary');
    assert.strictEqual(metadata.safeResumeBoundary, 'phase_boundary');
    assert.strictEqual(metadata.resumeFromCursor, false);
    assert.deepStrictEqual(metadata.rollbackBoundaries, ['phase_boundary']);
  });

  it('hydrates and reapplies persisted recovery cursor state via retryContext', () => {
    const record = {
      retryContext: {
        __recovery: {
          currentCursor: {
            phaseId: 'p1',
            stepId: 's1',
            executionCursor: [{ phase: 0 }, { step: 0 }]
          },
          rollbackBoundaries: [{ boundaryType: 'phase_boundary' }]
        }
      }
    };

    const normalized = normalizeRecoveryState(record);
    assert.strictEqual(normalized.currentCursor.stepId, 's1');
    assert.strictEqual(normalized.rollbackBoundaries[0].boundaryType, 'phase_boundary');

    const target = { retryContext: {} };
    applyRecoveryState(target, normalized);
    assert.strictEqual(target.recoveryCursor.stepId, 's1');
    assert.strictEqual(target.retryContext.__recovery.currentCursor.phaseId, 'p1');
  });
});
