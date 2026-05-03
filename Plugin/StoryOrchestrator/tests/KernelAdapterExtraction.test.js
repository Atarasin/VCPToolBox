'use strict';

/**
 * StoryOrchestratorKernelAdapter extraction integration tests.
 *
 * Verifies the two-phase pipeline (LLM markdown → ExtractionLayer → structured data)
 * handles variability without JSON parse failures.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { StoryOrchestratorKernelAdapter } = require('../adapters/StoryOrchestratorKernelAdapter');

/* ------------------------------------------------------------------ */
/*  helpers                                                           */
/* ------------------------------------------------------------------ */

function createAdapter() {
  return new StoryOrchestratorKernelAdapter({
    stateManager: { repository: { getStory: () => null, updateStory: () => {}, createSnapshot: () => 'snap-1', getLatestApprovedSnapshot: () => null } },
    agentDispatcher: { delegate: async () => ({ content: '', markers: [], raw: {} }) },
    chapterOperations: {},
    contentValidator: {},
    config: { USE_WORKFLOW_KERNEL: 'true' }
  });
}

function mockAgentResult(content) {
  return { content, markers: [], raw: {} };
}

/* ------------------------------------------------------------------ */
/*  test suite                                                        */
/* ------------------------------------------------------------------ */

describe('StoryOrchestratorKernelAdapter — two-phase extraction', () => {
  describe('_runExtraction', () => {
    it('extracts JSON block from markdown-wrapped output', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`Some intro text\n\n\`\`\`json\n{"setting":"Mars colony","rules":{}}\n\`\`\`\n\nSome outro`);

      const step = {
        id: 'testStep',
        extraction: { parserOrder: ['jsonBlock', 'jsonObject'], maxAttempts: 1 }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.deepStrictEqual(output.output.data, { setting: 'Mars colony', rules: {} });
      assert.strictEqual(output.output.meta.usedParser, 'jsonBlock');
    });

    it('extracts inline JSON object when no code block', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`Here is the data: {"protagonists":[{"name":"Alice"}],"supportingCharacters":[]}`);

      const step = {
        id: 'testStep',
        extraction: { parserOrder: ['jsonBlock', 'jsonObject'], maxAttempts: 1 }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.deepStrictEqual(output.output.data.protagonists, [{ name: 'Alice' }]);
      assert.strictEqual(output.output.meta.usedParser, 'jsonObject');
    });

    it('repairs truncated JSON object', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`{"chapters":[{"title":"Ch1","scenes":["scene1"]`);

      const step = {
        id: 'testStep',
        extraction: { parserOrder: ['jsonBlock', 'jsonObject'], maxAttempts: 1 }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.ok(Array.isArray(output.output.data.chapters));
      assert.strictEqual(output.output.data.chapters[0].title, 'Ch1');
    });

    it('falls back to raw on total failure when throwOnFailure is false', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`No structured data here at all`);

      const step = {
        id: 'testStep',
        extraction: { parserOrder: ['jsonBlock', 'jsonObject'], maxAttempts: 1, throwOnFailure: false, defaultValue: { fallback: true } }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.deepStrictEqual(output.output.data, { fallback: true });
    });

    it('retries extraction up to maxAttempts', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`always fails`);

      const step = {
        id: 'testStep',
        extraction: { parserOrder: ['jsonBlock'], maxAttempts: 3, throwOnFailure: false, defaultValue: null }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.strictEqual(output.output.data, null);
    });

    it('validates schema when configured', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`{"unexpected":"value"}`);

      const step = {
        id: 'testStep',
        extraction: {
          parserOrder: ['jsonObject'],
          maxAttempts: 1,
          throwOnFailure: false,
          defaultValue: null,
          schema: {
            type: 'object',
            required: ['setting']
          }
        }
      };

      const output = adapter._runExtraction(result, step);

      assert.strictEqual(output.status, 'completed');
      assert.strictEqual(output.output.data, null);
    });

    it('records extraction metrics', () => {
      const adapter = createAdapter();
      const result = mockAgentResult(`{"setting":"test"}`);

      const step = {
        id: 'metricStep',
        extraction: { parserOrder: ['jsonObject'], maxAttempts: 1 }
      };

      adapter._runExtraction(result, step);

      const metrics = adapter.getExtractionMetrics();
      assert.strictEqual(metrics.totalAttempts, 1);
      assert.strictEqual(metrics.totalSuccesses, 1);
      assert.ok(metrics.byParser.jsonObject);
      assert.strictEqual(metrics.byStep.metricStep.attempts, 1);
      assert.strictEqual(metrics.byStep.metricStep.successes, 1);
    });
  });

  describe('_extractWithLayer', () => {
    it('wraps ExtractionLayer and tracks metrics', () => {
      const adapter = createAdapter();
      const raw = `\`\`\`json\n{"factions":[]}\n\`\`\``;

      const extracted = adapter._extractWithLayer(raw, {
        parserOrder: ['jsonBlock', 'jsonObject'],
        throwOnFailure: false
      }, 'parseTest');

      assert.deepStrictEqual(extracted.data, { factions: [] });
      assert.strictEqual(extracted.meta.usedParser, 'jsonBlock');

      const metrics = adapter.getExtractionMetrics();
      assert.ok(metrics.byStep.parseTest);
    });
  });

  describe('parseAgentJson step', () => {
    it('returns structured data via ExtractionLayer', async () => {
      const adapter = createAdapter();
      await adapter.initialize();

      const handler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');
      assert.ok(handler, 'parseAgentJson should be registered');

      const step = { id: 'parseWorldview', input: { raw: { $ref: 'ctx.outputs.rawContent' } } };
      const stepContext = {
        context: { outputs: { rawContent: `{"setting":"Mars","rules":{}}` } }
      };

      const result = await handler(step, stepContext);

      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.output.data, { setting: 'Mars', rules: {} });
    });

    it('returns defaultValue on failure when throwOnFailure is false', async () => {
      const adapter = createAdapter();
      await adapter.initialize();

      const handler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');
      const step = {
        id: 'parseFail',
        input: { raw: { $ref: 'ctx.outputs.rawContent' } },
        extraction: { parserOrder: ['jsonBlock'], throwOnFailure: false, defaultValue: { fallback: true } }
      };
      const stepContext = {
        context: { outputs: { rawContent: 'not json' } }
      };

      const result = await handler(step, stepContext);

      assert.strictEqual(result.status, 'completed');
      assert.deepStrictEqual(result.output.data, { fallback: true });
    });

    it('works with schemaValidate when workflow passes business data', async () => {
      const adapter = createAdapter();
      await adapter.initialize();

      const parseHandler = adapter.kernel.stepRegistry.handlers.get('parseAgentJson');
      const schemaHandler = adapter.kernel.stepRegistry.handlers.get('schemaValidate');

      const parseResult = await parseHandler(
        { id: 'parseWorldview', input: { raw: { $ref: 'ctx.outputs.rawContent' } } },
        {
          context: {
            outputs: {
              rawContent: `{"setting":"Mars","rules":{},"factions":[],"history":{},"sceneNorms":[],"secrets":[]}`
            }
          }
        }
      );

      const schemaResult = await schemaHandler(
        {
          id: 'schemaValidateWorldview',
          input: {
            data: { $ref: 'ctx.outputs.worldview.data' },
            schemaType: 'worldview'
          }
        },
        {
          context: {
            outputs: {
              worldview: parseResult.output
            }
          }
        }
      );

      assert.strictEqual(parseResult.status, 'completed');
      assert.strictEqual(schemaResult.status, 'completed');
      assert.strictEqual(schemaResult.output.valid, true);
    });
  });

  describe('parseOutline step', () => {
    it('extracts JSON outline with chapters via ExtractionLayer', async () => {
      const adapter = createAdapter();
      await adapter.initialize();

      const handler = adapter.kernel.stepRegistry.handlers.get('parseOutline');
      const raw = `\`\`\`json\n{"chapters":[{"title":"Ch1","scenes":["s1"]}]}\n\`\`\``;
      const step = { id: 'parseOutline', input: { raw: { $ref: 'ctx.outputs.rawContent' } } };
      const stepContext = { context: { outputs: { rawContent: raw } } };

      const result = await handler(step, stepContext);

      assert.strictEqual(result.status, 'completed');
      assert.ok(Array.isArray(result.output.chapters));
      assert.strictEqual(result.output.chapters[0].title, 'Ch1');
    });

    it('falls back to text parser for non-JSON outline format', async () => {
      const adapter = createAdapter();
      await adapter.initialize();

      const handler = adapter.kernel.stepRegistry.handlers.get('parseOutline');
      const raw = `【Chapter 1】\n标题: 启程\n核心事件: 主角出发\n场景:\n1. 家中\n2. 车站\n出场人物:\n1. 主角\n故事功能: setup`;
      const step = { id: 'parseOutlineText', input: { raw: { $ref: 'ctx.outputs.rawContent' } } };
      const stepContext = { context: { outputs: { rawContent: raw } } };

      const result = await handler(step, stepContext);

      assert.strictEqual(result.status, 'completed');
      assert.ok(Array.isArray(result.output.chapters));
      assert.strictEqual(result.output.chapters.length, 1);
      assert.strictEqual(result.output.chapters[0].title, '启程');
    });
  });

  describe('workflow-definition extraction config', () => {
    it('passes parseAgentJson business data into phase1 schema validation', () => {
      const definition = require('../config/workflow-definition.js');
      const phase1 = definition.phases[0];
      const worldviewSchemaStep = phase1.steps.find(s => s.id === 'schemaValidateWorldview');
      const charactersSchemaStep = phase1.steps.find(s => s.id === 'schemaValidateCharacters');

      assert.strictEqual(worldviewSchemaStep.input.data.$ref, 'ctx.outputs.worldview.data');
      assert.strictEqual(charactersSchemaStep.input.data.$ref, 'ctx.outputs.characters.data');
    });

    it('exposes pluginSdk contracts and macros on the workflow definition', () => {
      const definition = require('../config/workflow-definition.js');

      assert.ok(definition.pluginSdk, 'workflow definition should expose pluginSdk metadata');
      assert.ok(definition.pluginSdk.phaseOutputs.phase1, 'phase output contract should exist');
      assert.ok(definition.pluginSdk.checkpoints.phase2_outline_confirmation, 'checkpoint contract should exist');
      assert.ok(definition.pluginSdk.snapshots.phase3, 'snapshot contract should exist');
      assert.ok(definition.pluginSdk.artifacts.chapters, 'artifact contract should exist');
      assert.ok(definition.pluginSdk.macros.phase1RevisionMacro, 'macro metadata should exist');
    });

    it('attaches checkpoint contracts to review steps', () => {
      const definition = require('../config/workflow-definition.js');
      const phase2 = definition.phases[1];
      const checkpointOutline = phase2.steps.find(s => s.id === 'checkpointOutline');

      assert.strictEqual(checkpointOutline.contract.checkpointType, 'phase2_outline_confirmation');
      assert.strictEqual(checkpointOutline.contract.phaseId, 'phase2');
    });

    it('has extraction config on generateWorldview', () => {
      const definition = require('../config/workflow-definition.js');
      const phase1 = definition.phases[0];
      const parallel = phase1.steps.find(s => s.id === 'generateWorldAndCharacters');
      const worldviewStep = parallel.steps.find(s => s.id === 'generateWorldview');

      assert.ok(worldviewStep.extraction, 'generateWorldview should have extraction config');
      assert.ok(worldviewStep.extraction.schema, 'should have schema');
      assert.deepStrictEqual(worldviewStep.extraction.parserOrder, ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw']);
      assert.strictEqual(worldviewStep.extraction.maxAttempts, 2);
    });

    it('has extraction config on generateCharacters', () => {
      const definition = require('../config/workflow-definition.js');
      const phase1 = definition.phases[0];
      const parallel = phase1.steps.find(s => s.id === 'generateWorldAndCharacters');
      const charsStep = parallel.steps.find(s => s.id === 'generateCharacters');

      assert.ok(charsStep.extraction, 'generateCharacters should have extraction config');
      assert.ok(charsStep.extraction.schema, 'should have schema');
    });

    it('has extraction config on generateOutline', () => {
      const definition = require('../config/workflow-definition.js');
      const phase2 = definition.phases[1];
      const outlineStep = phase2.steps.find(s => s.id === 'generateOutline');

      assert.ok(outlineStep.extraction, 'generateOutline should have extraction config');
      assert.ok(outlineStep.extraction.schema, 'should have schema');
      assert.strictEqual(outlineStep.extraction.maxAttempts, 2);
    });
  });
});
