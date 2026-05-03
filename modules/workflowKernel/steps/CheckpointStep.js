/**
 * CheckpointStep — pauses workflow for human intervention.
 *
 * Config:
 *   promptTemplate: string — description shown to human reviewer
 *   timeoutMs: number — auto-approve timeout (default from kernel config)
 *   autoContinueOnTimeout: boolean — auto-approve when timeout expires
 *   onCheckpointReject: 'retry' | 'rollback' — action on rejection
 */

async function checkpointStep(step, stepContext) {
  const { kernel, workflowId, context } = stepContext;

  // Reuse the kernel-scoped manager so timeout continuation and manual
  // resolution share the same checkpoint state.
  const cpManager = kernel.checkpointManager;

  const checkpoint = await cpManager.create(workflowId, {
    id: step.id,
    type: step.checkpointType || 'generic',
    promptTemplate: step.promptTemplate || `Checkpoint: ${step.id}`,
    timeoutMs: step.timeoutMs,
    autoContinueOnTimeout: step.autoContinueOnTimeout,
    onCheckpointReject: step.onCheckpointReject,
    metadata: {
      stepId: step.id,
      phaseId: step.phaseId,
      contextSnapshot: context
    }
  });

  return {
    status: 'waiting_checkpoint',
    checkpoint: {
      checkpointId: checkpoint.checkpointId,
      type: checkpoint.type,
      promptTemplate: checkpoint.promptTemplate,
      expiresAt: checkpoint.expiresAt,
      autoContinueOnTimeout: checkpoint.autoContinueOnTimeout,
      onCheckpointReject: checkpoint.onCheckpointReject,
      metadata: checkpoint.metadata
    }
  };
}

module.exports = { checkpointStep };
