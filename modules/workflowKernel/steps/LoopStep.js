/**
 * LoopStep — executes sub-steps repeatedly until shouldContinue returns false.
 *
 * Config:
 *   steps: StepDefinition[] — sub-steps to execute each iteration
 *   maxIterations: number — maximum iterations (default 5)
 *   onMaxIterationsExceeded: 'fail' | 'checkpoint' — action when max reached without stopping
 *
 * The shouldContinue callback is provided by the adapter layer:
 *   shouldContinue(ctx) => boolean
 *   If not provided, loop runs exactly once.
 */

async function loopStep(step, stepContext) {
  const { kernel, context, workflowId } = stepContext;

  const maxIterations = step.maxIterations || 5;
  const onMaxIterationsExceeded = step.onMaxIterationsExceeded || 'fail';
  const subSteps = step.steps || [];

  if (subSteps.length === 0) {
    return {
      status: 'completed',
      output: { iterations: 0, reason: 'no_sub_steps' }
    };
  }

  // Get shouldContinue from kernel config or step config
  const shouldContinue = step.shouldContinue || kernel.config?.shouldContinue;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    // Execute all sub-steps for this iteration
    for (const subStep of subSteps) {
      const handler = kernel.stepRegistry.get(subStep.type);
      if (!handler) {
        return {
          status: 'failed',
          error: new Error(`Loop sub-step type not found: ${subStep.type}`)
        };
      }

      const subContext = {
        workflowId,
        step: subStep,
        context,
        kernel
      };

      const result = await handler(subStep, subContext);

      // Record sub-step output (overwrite previous iteration)
      context.steps[subStep.id] = {
        status: result.status,
        outputs: result.output || null,
        error: result.error || null
      };

      if (result.output && subStep.outputKey) {
        context.outputs[subStep.outputKey] = result.output;
      }

      if (result.status === 'waiting_checkpoint') {
        // Propagate checkpoint from sub-step
        return {
          status: 'waiting_checkpoint',
          checkpoint: result.checkpoint
        };
      }

      if (result.status === 'failed') {
        return {
          status: 'failed',
          error: new Error(`Loop sub-step ${subStep.id} failed: ${result.error?.message}`)
        };
      }
    }

    // Check if loop should continue
    if (!shouldContinue) {
      // No shouldContinue provided — run exactly once
      return {
        status: 'completed',
        output: { iterations: iteration, stopped: true, reason: 'no_shouldContinue' }
      };
    }

    const continueLoop = shouldContinue(context);
    if (!continueLoop) {
      return {
        status: 'completed',
        output: { iterations: iteration, stopped: true, reason: 'shouldContinue_returned_false' }
      };
    }
  }

  // Max iterations reached without stopping
  if (onMaxIterationsExceeded === 'checkpoint') {
    return {
      status: 'waiting_checkpoint',
      checkpoint: {
        checkpointId: `loop-max-${step.id}`,
        type: 'loop_max_iterations',
        promptTemplate: `Loop reached max iterations (${maxIterations}). Approve to accept current result or reject to adjust.`,
        autoContinueOnTimeout: false
      }
    };
  }

  return {
    status: 'failed',
    error: new Error(`Loop exceeded max iterations (${maxIterations}) without meeting stop condition`)
  };
}

module.exports = { loopStep };
