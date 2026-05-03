/**
 * GuardStep — conditional checkpoint with onFailure action.
 *
 * Config:
 *   condition: string — expression to evaluate (e.g., 'ctx.steps.review.outputs.score >= 90')
 *   onFailure: 'retry' | 'fail' | 'checkpoint' — action when condition fails
 */

const { ExpressionEngine, ExpressionError } = require('../core/ExpressionEngine');

const engine = new ExpressionEngine();

async function guardStep(step, stepContext) {
  const { context } = stepContext;

  if (!step.condition) {
    return {
      status: 'completed',
      output: { skipped: true, reason: 'no_condition' }
    };
  }

  try {
    const passed = engine.evaluate(step.condition, context);

    if (passed) {
      return {
        status: 'completed',
        output: { passed: true, condition: step.condition }
      };
    }

    // Condition failed — apply onFailure action
    const onFailure = step.onFailure || 'fail';

    if (onFailure === 'checkpoint') {
      return {
        status: 'waiting_checkpoint',
        checkpoint: {
          checkpointId: `guard-${step.id}`,
          type: 'guard_failure',
          promptTemplate: `Guard condition failed: ${step.condition}. Approve to continue or reject to ${step.onCheckpointReject || 'retry'}.`,
          autoContinueOnTimeout: false
        }
      };
    }

    return {
      status: 'failed',
      error: new ExpressionError(`Guard condition failed: ${step.condition}`, {
        condition: step.condition,
        onFailure
      })
    };
  } catch (err) {
    if (err instanceof ExpressionError) {
      return {
        status: 'failed',
        error: err
      };
    }
    return {
      status: 'failed',
      error: new Error(`Guard evaluation error: ${err.message}`)
    };
  }
}

module.exports = { guardStep };
