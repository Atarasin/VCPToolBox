const { describe, it } = require('node:test');
const assert = require('node:assert');
const { guardStep } = require('../../../modules/workflowKernel/steps/GuardStep');

describe('GuardStep', () => {
  describe('basic conditions', () => {
    it('passes when condition is true', async () => {
      const step = { id: 'g1', condition: 'ctx.score >= 90' };
      const context = { score: 95 };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('fails when condition is false and onFailure=fail', async () => {
      const step = { id: 'g2', condition: 'ctx.score >= 90', onFailure: 'fail' };
      const context = { score: 80 };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Guard condition failed/);
    });

    it('returns checkpoint when condition fails and onFailure=checkpoint', async () => {
      const step = { id: 'g3', condition: 'ctx.score >= 90', onFailure: 'checkpoint' };
      const context = { score: 80 };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'waiting_checkpoint');
      assert.ok(result.checkpoint.checkpointId.startsWith('guard-'));
    });

    it('skips when no condition provided', async () => {
      const result = await guardStep({ id: 'g4' }, { context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.skipped, true);
    });

    it('handles expression errors gracefully', async () => {
      const step = { id: 'g5', condition: 'ctx.missing.prop > 0' };
      const result = await guardStep(step, { context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.message.includes("Property 'missing' does not exist"));
    });
  });

  describe('operator coverage', () => {
    it('evaluates == operator (equal)', async () => {
      const step = { id: 'g-eq', condition: 'ctx.status == "approved"' };
      const result = await guardStep(step, { context: { status: 'approved' } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates == operator (not equal)', async () => {
      const step = { id: 'g-neq', condition: 'ctx.status == "approved"' };
      const result = await guardStep(step, { context: { status: 'rejected' } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates != operator (not equal)', async () => {
      const step = { id: 'g-ne', condition: 'ctx.status != "blocked"' };
      const result = await guardStep(step, { context: { status: 'active' } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates != operator (equal)', async () => {
      const step = { id: 'g-ne2', condition: 'ctx.status != "blocked"' };
      const result = await guardStep(step, { context: { status: 'blocked' } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates < operator (less than true)', async () => {
      const step = { id: 'g-lt', condition: 'ctx.score < 100' };
      const result = await guardStep(step, { context: { score: 50 } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates < operator (less than false)', async () => {
      const step = { id: 'g-lt2', condition: 'ctx.score < 100' };
      const result = await guardStep(step, { context: { score: 150 } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates > operator (greater than true)', async () => {
      const step = { id: 'g-gt', condition: 'ctx.score > 10' };
      const result = await guardStep(step, { context: { score: 20 } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates > operator (greater than false)', async () => {
      const step = { id: 'g-gt2', condition: 'ctx.score > 10' };
      const result = await guardStep(step, { context: { score: 5 } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates <= operator (less or equal true)', async () => {
      const step = { id: 'g-le', condition: 'ctx.score <= 100' };
      const result = await guardStep(step, { context: { score: 100 } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates <= operator (less or equal false)', async () => {
      const step = { id: 'g-le2', condition: 'ctx.score <= 100' };
      const result = await guardStep(step, { context: { score: 101 } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates >= operator (greater or equal true)', async () => {
      const step = { id: 'g-ge', condition: 'ctx.score >= 0' };
      const result = await guardStep(step, { context: { score: 0 } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('evaluates >= operator (greater or equal false)', async () => {
      const step = { id: 'g-ge2', condition: 'ctx.score >= 0' };
      const result = await guardStep(step, { context: { score: -1 } });
      assert.strictEqual(result.status, 'failed');
    });
  });

  describe('invalid expression syntax', () => {
    it('fails on invalid operator', async () => {
      const step = { id: 'g-inv', condition: 'ctx.score === 100' };
      const result = await guardStep(step, { context: { score: 100 } });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.message.includes('Unexpected character'));
    });

    it('fails on unterminated string', async () => {
      const step = { id: 'g-str', condition: 'ctx.status == "open' };
      const result = await guardStep(step, { context: { status: 'open' } });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.message.includes('Unterminated string'));
    });

    it('fails on malformed path', async () => {
      const step = { id: 'g-path', condition: 'score >= 0' };
      const result = await guardStep(step, { context: { score: 5 } });
      assert.strictEqual(result.status, 'failed');
      assert.ok(result.error.message.includes("Path must start with 'ctx'"));
    });

    it('skips on empty expression (treated as no condition)', async () => {
      const step = { id: 'g-empty', condition: '' };
      const result = await guardStep(step, { context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.skipped, true);
      assert.strictEqual(result.output.reason, 'no_condition');
    });
  });

  describe('onFailure variations', () => {
    it('defaults to fail when onFailure is omitted', async () => {
      const step = { id: 'g-default', condition: 'ctx.ok == true' };
      const result = await guardStep(step, { context: { ok: false } });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Guard condition failed/);
    });

    it('treats unknown onFailure as fail', async () => {
      const step = { id: 'g-unknown', condition: 'ctx.ok == true', onFailure: 'retry' };
      const result = await guardStep(step, { context: { ok: false } });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Guard condition failed/);
    });

    it('treats "skip" as fail (not a recognized action)', async () => {
      const step = { id: 'g-skip', condition: 'ctx.ok == true', onFailure: 'skip' };
      const result = await guardStep(step, { context: { ok: false } });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Guard condition failed/);
    });
  });

  describe('parallelGroup output references', () => {
    it('references outputs from previous parallelGroup steps', async () => {
      const step = { id: 'g-par', condition: 'ctx.steps.parallel_1.outputs.review.score >= 90' };
      const context = {
        steps: {
          parallel_1: {
            outputs: {
              review: { score: 95 }
            }
          }
        }
      };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('fails when parallelGroup output does not meet condition', async () => {
      const step = { id: 'g-par-fail', condition: 'ctx.steps.parallel_1.outputs.review.score >= 90' };
      const context = {
        steps: {
          parallel_1: {
            outputs: {
              review: { score: 70 }
            }
          }
        }
      };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'failed');
    });

    it('handles nested parallelGroup output paths', async () => {
      const step = { id: 'g-par-nest', condition: 'ctx.steps.pg.outputs.branch_a.valid == true' };
      const context = {
        steps: {
          pg: {
            outputs: {
              branch_a: { valid: true }
            }
          }
        }
      };
      const result = await guardStep(step, { context });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });
  });

  describe('boolean combinations', () => {
    it('evaluates && (AND) expressions', async () => {
      const step = { id: 'g-and', condition: 'ctx.score >= 90 && ctx.approved == true' };
      const result = await guardStep(step, { context: { score: 95, approved: true } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('fails && when left side is false', async () => {
      const step = { id: 'g-and-f', condition: 'ctx.score >= 90 && ctx.approved == true' };
      const result = await guardStep(step, { context: { score: 80, approved: true } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates || (OR) expressions', async () => {
      const step = { id: 'g-or', condition: 'ctx.score >= 90 || ctx.override == true' };
      const result = await guardStep(step, { context: { score: 80, override: true } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });

    it('fails || when both sides are false', async () => {
      const step = { id: 'g-or-f', condition: 'ctx.score >= 90 || ctx.override == true' };
      const result = await guardStep(step, { context: { score: 80, override: false } });
      assert.strictEqual(result.status, 'failed');
    });

    it('evaluates parenthesized grouped expressions', async () => {
      const step = { id: 'g-paren', condition: '(ctx.a == 1 && ctx.b == 2) || ctx.c == 3' };
      const result = await guardStep(step, { context: { a: 0, b: 0, c: 3 } });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.passed, true);
    });
  });
});
