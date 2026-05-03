/**
 * ParallelGroupStep — executes sub-steps in parallel with Promise.all.
 *
 * Config:
 *   steps: StepDefinition[] — sub-steps to execute in parallel
 *   failurePolicy: 'waitForRest' | 'cancelAll' | 'ignore' — how to handle failures
 *     - waitForRest: wait for all, fail if any failed (default)
 *     - cancelAll: fail immediately on first failure, cancel remaining
 *     - ignore: ignore failures, return all results including failures
 */

async function parallelGroupStep(step, stepContext) {
  const { kernel, context, workflowId } = stepContext;
  const subSteps = step.steps || [];
  const failurePolicy = step.failurePolicy || 'waitForRest';

  if (subSteps.length === 0) {
    return {
      status: 'completed',
      output: { results: [] }
    };
  }

  // Shared state for cancelAll coordination
  let firstFailure = null;
  const abortControllers = new Map();

  /**
   * Cancel all other sub-steps when cancelAll policy is active.
   * @param {string} exceptStepId - Step that triggered cancellation
   */
  function cancelOthers(exceptStepId) {
    if (failurePolicy !== 'cancelAll') return;
    for (const [stepId, controller] of abortControllers) {
      if (stepId !== exceptStepId && !controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  /**
   * Wrap a handler call with abort support for cancelAll policy.
   * Returns a promise that rejects with CancellationError when aborted.
   */
  function withAbort(handler, subStep, subContext, controller) {
    if (failurePolicy !== 'cancelAll') {
      return handler(subStep, subContext);
    }

    return new Promise((resolve, reject) => {
      // Set up abort listener
      const onAbort = () => {
        reject(new CancellationError(`Sub-step ${subStep.id} cancelled due to another sub-step failure`));
      };

      if (controller.signal.aborted) {
        onAbort();
        return;
      }

      controller.signal.addEventListener('abort', onAbort, { once: true });

      // Execute handler
      handler(subStep, subContext)
        .then((result) => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(result);
        })
        .catch((err) => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        });
    });
  }

  const promises = subSteps.map(async (subStep) => {
    const controller = new AbortController();
    abortControllers.set(subStep.id, controller);

    // Early exit if already cancelled
    if (failurePolicy === 'cancelAll' && firstFailure) {
      return {
        stepId: subStep.id,
        status: 'cancelled',
        error: new Error('Cancelled due to another sub-step failure')
      };
    }

    const handler = kernel.stepRegistry.get(subStep.type);
    if (!handler) {
      const err = new Error(`Unknown sub-step type: ${subStep.type}`);
      if (failurePolicy === 'cancelAll') {
        firstFailure = firstFailure || err;
        cancelOthers(subStep.id);
      }
      return {
        stepId: subStep.id,
        status: 'failed',
        error: err
      };
    }

    const subContext = {
      workflowId,
      step: subStep,
      context,
      kernel
    };

    try {
      const result = await withAbort(handler, subStep, subContext, controller);

      // For cancelAll, trigger cancellation on first failure
      if (failurePolicy === 'cancelAll' && result.status === 'failed') {
        firstFailure = firstFailure || (result.error || new Error(`Sub-step ${subStep.id} failed`));
        cancelOthers(subStep.id);
      }

      // Store result in context
      context.steps[subStep.id] = {
        status: result.status,
        outputs: result.output || null,
        error: result.error || null
      };

      if (result.output && subStep.outputKey) {
        context.outputs[subStep.outputKey] = result.output;
      }

      return {
        stepId: subStep.id,
        status: result.status,
        output: result.output,
        checkpoint: result.checkpoint,
        error: result.error
      };
    } catch (err) {
      if (err instanceof CancellationError) {
        return {
          stepId: subStep.id,
          status: 'cancelled',
          error: err
        };
      }

      if (failurePolicy === 'cancelAll') {
        firstFailure = firstFailure || err;
        cancelOthers(subStep.id);
      }

      return {
        stepId: subStep.id,
        status: 'failed',
        error: err
      };
    }
  });

  const results = await Promise.all(promises);

  // Apply failure policy
  const failedResults = results.filter(r => r.status === 'failed');
  const cancelledResults = results.filter(r => r.status === 'cancelled');
  const checkpointResults = results.filter(r => r.status === 'waiting_checkpoint');

  // Propagate first checkpoint if any
  if (checkpointResults.length > 0) {
    return {
      status: 'waiting_checkpoint',
      checkpoint: checkpointResults[0].output?.checkpoint || checkpointResults[0].checkpoint
    };
  }

  if (failurePolicy === 'ignore') {
    // Return all results regardless of failures
    return {
      status: 'completed',
      output: { results, failures: failedResults.length }
    };
  }

  if (failurePolicy === 'cancelAll' && firstFailure) {
    return {
      status: 'failed',
      error: new Error(`Parallel group cancelled: ${firstFailure.message}`),
      output: { results, cancelled: cancelledResults.length }
    };
  }

  if (failedResults.length > 0) {
    return {
      status: 'failed',
      error: new Error(`Parallel group failed: ${failedResults.length} sub-step(s) failed`)
    };
  }

  return {
    status: 'completed',
    output: { results }
  };
}

class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
  }
}

module.exports = { parallelGroupStep, CancellationError };
