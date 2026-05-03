const SAFE_TO_RESUME_STEP_TYPES = [
  'checkpoint',
  'guard',
  'noop'
];

const NON_IDEMPOTENT_STEP_TYPES = [
  'agentCall'
];

function normalizeExecutionCursor(cursorLike) {
  if (!cursorLike) {
    return null;
  }

  if (Array.isArray(cursorLike)) {
    return cursorLike;
  }

  if (typeof cursorLike === 'string') {
    try {
      const parsed = JSON.parse(cursorLike);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  return null;
}

function getCursorIndices(cursorLike) {
  const cursor = normalizeExecutionCursor(cursorLike);
  if (!cursor) {
    return {
      cursor: null,
      phaseIndex: null,
      stepIndex: null
    };
  }

  const phaseCursor = cursor.find((entry) => entry && entry.phase !== undefined);
  const stepCursor = cursor.find((entry) => entry && entry.step !== undefined);

  return {
    cursor,
    phaseIndex: Number.isInteger(phaseCursor?.phase) ? phaseCursor.phase : null,
    stepIndex: Number.isInteger(stepCursor?.step) ? stepCursor.step : null
  };
}

function getDefaultRecoveryMetadata(stepType, hasExplicitMetadata) {
  if (stepType === 'checkpoint') {
    return {
      isIdempotent: true,
      safeResumeBoundary: 'checkpoint_boundary',
      boundaryType: 'checkpoint_boundary',
      resumeFromCursor: true,
      rollbackBoundaries: ['checkpoint_boundary', 'phase_boundary']
    };
  }

  if (stepType === 'loop') {
    return {
      isIdempotent: false,
      safeResumeBoundary: 'loop_boundary',
      boundaryType: 'loop_boundary',
      resumeFromCursor: false,
      rollbackBoundaries: ['loop_boundary', 'phase_boundary']
    };
  }

  if (stepType === 'parallelGroup') {
    return {
      isIdempotent: false,
      safeResumeBoundary: 'parallel_group_boundary',
      boundaryType: 'parallel_group_boundary',
      resumeFromCursor: false,
      rollbackBoundaries: ['parallel_group_boundary', 'phase_boundary']
    };
  }

  if (SAFE_TO_RESUME_STEP_TYPES.includes(stepType)) {
    return {
      isIdempotent: true,
      safeResumeBoundary: 'step_boundary',
      boundaryType: 'step_boundary',
      resumeFromCursor: true,
      rollbackBoundaries: ['step_boundary', 'phase_boundary']
    };
  }

  if (NON_IDEMPOTENT_STEP_TYPES.includes(stepType)) {
    return {
      isIdempotent: false,
      safeResumeBoundary: 'phase_boundary',
      boundaryType: 'step_boundary',
      resumeFromCursor: false,
      rollbackBoundaries: ['phase_boundary']
    };
  }

  if (hasExplicitMetadata) {
    return {
      isIdempotent: true,
      safeResumeBoundary: 'step_boundary',
      boundaryType: 'custom_step_boundary',
      resumeFromCursor: true,
      rollbackBoundaries: ['step_boundary', 'phase_boundary']
    };
  }

  return {
    isIdempotent: false,
    safeResumeBoundary: 'phase_boundary',
    boundaryType: 'custom_step_boundary',
    resumeFromCursor: false,
    rollbackBoundaries: ['phase_boundary']
  };
}

function resolveStepRecoveryMetadata(step = {}, persistedStep = {}) {
  const explicitRecovery = {
    ...(persistedStep.recovery || {}),
    ...(step.recovery || {})
  };
  const hasExplicitMetadata = Object.keys(explicitRecovery).length > 0
    || step.isIdempotent !== undefined
    || step.safeResumeBoundary !== undefined
    || persistedStep.isIdempotent !== undefined
    || persistedStep.safeResumeBoundary !== undefined;
  const stepType = step.type || persistedStep.type || null;
  const defaults = getDefaultRecoveryMetadata(stepType, hasExplicitMetadata);
  const explicitIsIdempotent = step.isIdempotent ?? persistedStep.isIdempotent ?? explicitRecovery.isIdempotent;
  const safeResumeBoundary = step.safeResumeBoundary
    || persistedStep.safeResumeBoundary
    || explicitRecovery.safeResumeBoundary
    || defaults.safeResumeBoundary;
  const boundaryType = explicitRecovery.boundaryType || defaults.boundaryType;
  const rollbackBoundaries = Array.isArray(explicitRecovery.rollbackBoundaries) && explicitRecovery.rollbackBoundaries.length > 0
    ? explicitRecovery.rollbackBoundaries
    : defaults.rollbackBoundaries;
  const resumeFromCursor = explicitRecovery.resumeFromCursor ?? defaults.resumeFromCursor;

  return {
    stepType,
    isIdempotent: explicitIsIdempotent ?? defaults.isIdempotent,
    safeResumeBoundary,
    boundaryType,
    resumeFromCursor,
    rollbackBoundaries
  };
}

function normalizeRecoveryState(record = {}) {
  const nested = record.recoveryState
    || record.recovery_state
    || record.retryContext?.__recovery
    || record.retry_context?.__recovery
    || null;
  const currentCursor = nested?.currentCursor || record.recoveryCursor || record.recovery_cursor || null;

  return {
    currentCursor: currentCursor || null,
    rollbackBoundaries: Array.isArray(nested?.rollbackBoundaries) ? nested.rollbackBoundaries : [],
    lastRecoveryAction: nested?.lastRecoveryAction || null,
    lastUpdatedAt: nested?.lastUpdatedAt || null
  };
}

function applyRecoveryState(record, recoveryState) {
  const mergedRetryContext = {
    ...(record.retryContext || record.retry_context || {})
  };

  mergedRetryContext.__recovery = recoveryState;
  record.retryContext = mergedRetryContext;
  record.recoveryState = recoveryState;
  record.recoveryCursor = recoveryState.currentCursor || null;
  return recoveryState;
}

function toBoundaryCursor(phaseIndex, stepIndex) {
  return [
    { phase: phaseIndex },
    { step: stepIndex }
  ];
}

module.exports = {
  SAFE_TO_RESUME_STEP_TYPES,
  NON_IDEMPOTENT_STEP_TYPES,
  normalizeExecutionCursor,
  getCursorIndices,
  resolveStepRecoveryMetadata,
  normalizeRecoveryState,
  applyRecoveryState,
  toBoundaryCursor
};
