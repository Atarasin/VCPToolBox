const { describe, it } = require('node:test');
const assert = require('node:assert');
const { agentCallStep, resolveRef, resolveInput } = require('../../../modules/workflowKernel/steps/AgentCallStep');

describe('AgentCallStep', () => {
  describe('resolveRef', () => {
    it('resolves simple ctx path', () => {
      const ctx = { steps: { a: { outputs: { b: 42 } } } };
      assert.strictEqual(resolveRef('ctx.steps.a.outputs.b', ctx), 42);
    });

    it('throws on invalid path', () => {
      assert.throws(() => resolveRef('ctx.steps.missing.x', {}), /Cannot resolve/);
    });

    it('throws on non-ctx prefix', () => {
      assert.throws(() => resolveRef('foo.bar', {}), /Must start with 'ctx.'/);
    });

    it('throws when intermediate value is null', () => {
      assert.throws(() => resolveRef('ctx.steps.a.outputs.b', { steps: { a: null } }), /Cannot resolve/);
    });

    it('throws when intermediate value is not an object', () => {
      assert.throws(() => resolveRef('ctx.steps.a.outputs.b', { steps: { a: 'string' } }), /Cannot resolve/);
    });
  });

  describe('resolveInput', () => {
    it('resolves nested $ref objects', () => {
      const ctx = { inputs: { name: 'test' } };
      const input = { greeting: { $ref: 'ctx.inputs.name' } };
      assert.deepStrictEqual(resolveInput(input, ctx), { greeting: 'test' });
    });

    it('returns literals as-is', () => {
      assert.strictEqual(resolveInput(42, {}), 42);
      assert.strictEqual(resolveInput('hello', {}), 'hello');
    });

    it('returns null as-is', () => {
      assert.strictEqual(resolveInput(null, {}), null);
    });

    it('returns undefined as-is', () => {
      assert.strictEqual(resolveInput(undefined, {}), undefined);
    });

    it('resolves deeply nested $ref structures', () => {
      const ctx = { steps: { review: { outputs: { score: 95 } } } };
      const input = {
        nested: {
          deep: {
            value: { $ref: 'ctx.steps.review.outputs.score' }
          }
        }
      };
      assert.deepStrictEqual(resolveInput(input, ctx), { nested: { deep: { value: 95 } } });
    });

    it('resolves multiple sibling $refs', () => {
      const ctx = { inputs: { a: 1, b: 2 } };
      const input = {
        first: { $ref: 'ctx.inputs.a' },
        second: { $ref: 'ctx.inputs.b' },
        literal: 'keep'
      };
      assert.deepStrictEqual(resolveInput(input, ctx), { first: 1, second: 2, literal: 'keep' });
    });
  });

  describe('agentCallStep', () => {
    it('fails when agentDispatcher is missing', async () => {
      const result = await agentCallStep({ agent: 'test' }, { kernel: {}, context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /AgentDispatcher not available/);
    });

    it('fails when agent field is missing', async () => {
      const result = await agentCallStep({}, { kernel: { agentDispatcher: {} }, context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /missing "agent"/);
    });

    it('delegates successfully and returns output', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({
          content: `Result for ${agentId}: ${prompt}`,
          markers: [],
          raw: { agentId, prompt }
        })
      };
      const step = {
        agent: 'writer',
        input: { prompt: 'hello' },
        outputKey: 'result'
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, 'Result for writer: hello');
    });

    it('returns markers and raw in output', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({
          content: `Result for ${agentId}: ${prompt}`,
          raw: { model: 'test-model' },
          markers: { isComplete: true, isFailed: false, hasHeartbeat: false }
        })
      };
      const result = await agentCallStep(
        { agent: 'writer', input: { prompt: 'test' }, outputKey: 'story' },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.markers.isComplete, true);
      assert.strictEqual(result.output.raw.model, 'test-model');
    });

    it('handles delegation errors', async () => {
      const dispatcher = {
        delegate: async () => { throw new Error('API down'); }
      };
      const result = await agentCallStep(
        { agent: 'writer', input: {} },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Agent delegation failed/);
    });

    it('fails on $ref resolution error', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({ content: prompt, markers: [], raw: {} })
      };
      const result = await agentCallStep(
        { agent: 'writer', input: { prompt: { $ref: 'ctx.missing.path' } } },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'failed');
      assert.match(result.error.message, /Input resolution failed/);
    });

    it('handles null input gracefully', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({ content: prompt, markers: [], raw: {} })
      };
      const result = await agentCallStep(
        { agent: 'writer', input: null },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, '{}');
    });

    it('handles undefined input gracefully', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({ content: prompt, markers: [], raw: {} })
      };
      const result = await agentCallStep(
        { agent: 'writer', input: undefined },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, '{}');
    });

    it('handles nested $ref resolution in input', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({ content: prompt, markers: [], raw: {} })
      };
      const context = { steps: { analyze: { outputs: { tone: 'formal' } } } };
      const step = {
        agent: 'writer',
        input: {
          prompt: 'Write something',
          tone: { $ref: 'ctx.steps.analyze.outputs.tone' }
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, 'Write something');
    });

    it('passes options to delegate', async () => {
      const calls = [];
      const dispatcher = {
        delegate: async (agentId, prompt, options) => {
          calls.push({ agentId, prompt, options });
          return { content: 'ok', markers: [], raw: {} };
        }
      };
      const step = {
        agent: 'writer',
        input: { prompt: 'hello' },
        options: { timeoutMs: 5000, taskDelegation: true }
      };
      await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].options, { timeoutMs: 5000, taskDelegation: true });
    });

    it('uses empty object when input is omitted', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({ content: prompt, markers: [], raw: {} })
      };
      const result = await agentCallStep(
        { agent: 'writer' },
        { kernel: { agentDispatcher: dispatcher }, context: {} }
      );
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, '{}');
    });

    it('extracts structured data from markdown when extraction config is present', async () => {
      const dispatcher = {
        delegate: async (agentId, prompt) => ({
          content: '```json\n{"title": "Hello", "score": 42}\n```',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        input: { prompt: 'generate' },
        extraction: {}
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.output.data, { title: 'Hello', score: 42 });
      assert.strictEqual(result.output.meta.usedParser, 'jsonBlock');
    });

    it('returns extracted data, meta, and raw content in output', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: '```json\n{"key": "value"}\n```',
          markers: { done: true },
          raw: { model: 'gpt-4' }
        })
      };
      const step = {
        agent: 'writer',
        extraction: {}
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.output.content, '```json\n{"key": "value"}\n```');
      assert.deepStrictEqual(result.output.data, { key: 'value' });
      assert.ok(Array.isArray(result.output.meta.attempts));
      assert.strictEqual(result.output.meta.usedParser, 'jsonBlock');
      assert.deepStrictEqual(result.output.markers, { done: true });
      assert.deepStrictEqual(result.output.raw, { model: 'gpt-4' });
    });

    it('validates schema and fails when schema mismatch', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: '```json\n{"title": "Hello", "count": "not-a-number"}\n```',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        extraction: {
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              count: { type: 'number' }
            },
            required: ['title', 'count']
          }
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error.name, 'ExtractionError');
      assert.strictEqual(result.error.code, 'SCHEMA_MISMATCH');
    });

    it('fails when required fields are missing', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: '```json\n{"title": "Hello"}\n```',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        extraction: {
          requiredFields: ['title', 'description']
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error.name, 'ExtractionError');
      assert.strictEqual(result.error.code, 'MISSING_FIELDS');
    });

    it('retries extraction up to maxAttempts on failure', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: 'plain text with no structured data',
          markers: [],
          raw: {}
        })
      };
      const logs = [];
      const logger = {
        log: (msg) => logs.push(msg),
        error: (msg) => logs.push(msg),
        warn: () => {}
      };
      const step = {
        agent: 'writer',
        extraction: {
          maxAttempts: 3,
          parserOrder: ['jsonBlock', 'jsonObject']
        }
      };
      const result = await agentCallStep(step, {
        kernel: { agentDispatcher: dispatcher, logger },
        context: {}
      });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error.name, 'ExtractionError');
      // Should have started 3 extraction attempts (log messages, not error messages)
      const attemptStartLogs = logs.filter(l => l.includes('Extraction attempt') && !l.includes('failed'));
      assert.strictEqual(attemptStartLogs.length, 3);
      // Should have 3 failure logs
      const attemptFailLogs = logs.filter(l => l.includes('failed'));
      assert.strictEqual(attemptFailLogs.length, 3);
      // Should have retry log for attempts 1 and 2
      const retryLogs = logs.filter(l => l.includes('Retrying extraction'));
      assert.strictEqual(retryLogs.length, 2);
    });

    it('returns failed status with ExtractionError when all extraction attempts fail', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: 'totally unstructured',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        extraction: {
          parserOrder: ['jsonBlock']
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error.name, 'ExtractionError');
      assert.strictEqual(result.error.code, 'NO_MATCH');
    });

    it('passes parserOrder to extraction layer', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: '<root><name>Test</name></root>',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        extraction: {
          parserOrder: ['xml', 'jsonBlock']
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.output.data, { name: 'Test' });
      assert.strictEqual(result.output.meta.usedParser, 'xml');
    });

    it('uses defaultValue when extraction fails if configured (via throwOnFailure)', async () => {
      const dispatcher = {
        delegate: async () => ({
          content: 'unstructured',
          markers: [],
          raw: {}
        })
      };
      const step = {
        agent: 'writer',
        extraction: {
          parserOrder: ['jsonBlock'],
          defaultValue: { fallback: true }
        }
      };
      const result = await agentCallStep(step, { kernel: { agentDispatcher: dispatcher }, context: {} });
      assert.strictEqual(result.status, 'failed');
      // defaultValue is not used because throwOnFailure is always true in AgentCallStep
      assert.strictEqual(result.error.code, 'NO_MATCH');
    });
  });
});
