/**
 * Shared trace model builders used by WorkflowKernel and concrete trace sinks.
 */

function createTraceEvent({
  workflowId,
  runToken,
  sequence,
  type,
  timestamp = new Date().toISOString(),
  phaseId = null,
  stepId = null,
  stepType = null,
  status = null,
  payload = {}
}) {
  return {
    traceId: `trc-${workflowId}-${runToken}-${String(sequence).padStart(6, '0')}`,
    workflowId,
    runToken,
    sequence,
    type,
    timestamp,
    phaseId,
    stepId,
    stepType,
    status,
    payload
  };
}

function createStepTraceRecord({
  workflowId,
  runToken,
  sequence,
  phaseId = null,
  stepId,
  stepType,
  status,
  startedAt = null,
  finishedAt = null,
  durationMs = null,
  attempt = 1,
  inputPreview = null,
  outputPreview = null,
  artifactRefs = null,
  error = null
}) {
  return {
    workflowId,
    runToken,
    sequence,
    phaseId,
    stepId,
    stepType,
    status,
    startedAt,
    finishedAt,
    durationMs,
    attempt,
    inputPreview,
    outputPreview,
    artifactRefs: artifactRefs || {
      input: null,
      output: null,
      error: null
    },
    error
  };
}

function createLastErrorView({
  workflowId,
  runToken,
  failedAt,
  phaseId = null,
  stepId = null,
  stepType = null,
  errorCode = 'STEP_EXECUTION_FAILED',
  errorMessage = 'Step execution failed',
  causeType = 'step_failure',
  attempt = 1,
  inputArtifactRef = null,
  outputArtifactRef = null
}) {
  return {
    workflowId,
    runToken,
    failedAt,
    phaseId,
    stepId,
    stepType,
    errorCode,
    errorMessage,
    causeType,
    attempt,
    inputArtifactRef,
    outputArtifactRef
  };
}

function createRunStatusView({
  workflowId,
  runToken = null,
  state = null,
  currentPhaseId = null,
  currentStepId = null,
  currentStepType = null,
  checkpointState = null,
  recoveryCursor = null,
  lastEventAt = null,
  lastCompletedStep = null,
  lastFailedStep = null,
  lastError = null,
  recentEvents = []
}) {
  return {
    workflowId,
    runToken,
    state,
    currentPhaseId,
    currentStepId,
    currentStepType,
    checkpointState,
    recoveryCursor,
    lastEventAt,
    lastCompletedStep,
    lastFailedStep,
    lastError,
    recentEvents
  };
}

module.exports = {
  createLastErrorView,
  createRunStatusView,
  createStepTraceRecord,
  createTraceEvent
};
