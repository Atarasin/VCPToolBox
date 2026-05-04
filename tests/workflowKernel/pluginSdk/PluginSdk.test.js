const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchemaValidationStepHandler,
  createParseStructuredDataStepHandler,
  createStructuredValidationStepHandler,
  HELPER_SURFACE_STATES,
  listSharedHelperFamilies,
  getSharedHelperFamily,
  defineCheckpointPayloadContract,
  defineBusinessSnapshotContract,
  createSchemaValidationStepDefinition,
  createHumanReviewCheckpointStep,
  createPromptRevisionMacro,
  projectContractFields,
  parseStructuredValidationResult
} = require('../../../modules/workflowKernel/pluginSdk');

test('createSchemaValidationStepHandler validates known schema types', async () => {
  const handler = createSchemaValidationStepHandler({
    validators: {
      demo: (value) => ({
        valid: value === 'ok',
        schemaValid: value === 'ok',
        completenessValid: true,
        errors: value === 'ok' ? [] : ['bad'],
        warnings: []
      })
    }
  });

  const result = await handler(
    {
      input: {
        data: { $ref: 'ctx.outputs.payload' },
        schemaType: 'demo'
      }
    },
    {
      context: {
        outputs: {
          payload: 'ok'
        }
      }
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.valid, true);
});

test('createSchemaValidationStepHandler rejects unknown schema types', async () => {
  const handler = createSchemaValidationStepHandler({ validators: {} });

  const result = await handler(
    {
      input: {
        data: { $ref: 'ctx.outputs.payload' },
        schemaType: 'missing'
      }
    },
    {
      context: {
        outputs: {
          payload: {}
        }
      }
    }
  );

  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /Unknown schema type/);
});

test('createParseStructuredDataStepHandler extracts structured data with fallback-safe defaults', async () => {
  const metrics = [];
  const handler = createParseStructuredDataStepHandler({
    getExtractionOptions: (input) => ({
      parserOrder: ['jsonObject'],
      throwOnFailure: false,
      defaultValue: { raw: input.raw }
    }),
    onMetrics: (stepId, meta, success) => metrics.push({ stepId, meta, success })
  });

  const result = await handler(
    {
      id: 'parseDemo',
      input: {
        raw: { $ref: 'ctx.outputs.rawPayload' }
      }
    },
    {
      context: {
        outputs: {
          rawPayload: '{"title":"demo"}'
        }
      }
    }
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output.data, { title: 'demo' });
  assert.equal(result.output.meta.usedParser, 'jsonObject');
  assert.equal(metrics.length, 1);
  assert.equal(metrics[0].stepId, 'parseDemo');
  assert.equal(metrics[0].success, true);
});

test('parseStructuredValidationResult keeps blocking/non-blocking issue lists while exposing structured issue objects', () => {
  const result = parseStructuredValidationResult(JSON.stringify({
    verdict: 'PASS_WITH_WARNINGS',
    blockingIssues: ['主线冲突'],
    nonBlockingIssues: ['节奏偏慢'],
    suggestions: ['提前埋设线索'],
    schemaRisk: false,
    completenessRisk: false
  }));

  assert.equal(result.verdict, 'PASS_WITH_WARNINGS');
  assert.deepEqual(result.blockingIssues, ['主线冲突']);
  assert.deepEqual(result.nonBlockingIssues, ['节奏偏慢']);
  assert.deepEqual(result.issues, [
    { description: '主线冲突', severity: 'major' },
    { description: '节奏偏慢', severity: 'minor' }
  ]);
});

test('createStructuredValidationStepHandler delegates prompt construction while keeping domain rules outside the shared contract', async () => {
  const calls = [];
  const handler = createStructuredValidationStepHandler({
    agentDispatcher: {
      delegate: async (agentType, prompt, options) => {
        calls.push({ agentType, prompt, options });
        return {
          content: JSON.stringify({
            verdict: 'PASS',
            blockingIssues: [],
            nonBlockingIssues: [],
            suggestions: []
          })
        };
      }
    },
    buildPrompt: ({ outline }) => `validate outline with ${outline.chapters.length} chapters`
  });

  const result = await handler(
    {
      id: 'validateOutline',
      input: {
        outline: { $ref: 'ctx.outputs.outline' }
      }
    },
    {
      context: {
        outputs: {
          outline: { chapters: [{ title: '启程' }] }
        }
      }
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.output.verdict, 'PASS');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentType, 'logicValidator');
  assert.match(calls[0].prompt, /1 chapters/);
});

test('projectContractFields projects string and function descriptors', () => {
  const projected = projectContractFields(
    {
      outline: { chapters: [{}, {}] },
      chaptersResult: { totalWordCount: 2048 }
    },
    {
      chapterCount: (outputs) => outputs.outline.chapters.length,
      totalWordCount: 'chaptersResult.totalWordCount'
    }
  );

  assert.deepEqual(projected, {
    chapterCount: 2,
    totalWordCount: 2048
  });
});

test('pluginSdk builders return reusable workflow fragments', () => {
  const checkpointContract = defineCheckpointPayloadContract({
    checkpointType: 'review',
    phaseId: 'phase1',
    reviewFields: { outline: 'outline' }
  });
  const snapshotContract = defineBusinessSnapshotContract({
    phaseId: 'phase2',
    snapshotFields: { chapters: 'chaptersResult.chapters' },
    restoreOutputs: { chapters: 'chaptersResult.chapters' }
  });
  const schemaStep = createSchemaValidationStepDefinition({
    id: 'schemaValidateOutline',
    dataRef: 'ctx.outputs.outline',
    schemaType: 'outline',
    outputKey: 'outlineSchema'
  });
  const checkpointStep = createHumanReviewCheckpointStep({
    id: 'checkpointOutline',
    checkpointType: 'review',
    promptTemplate: 'review it',
    contract: checkpointContract
  });
  const macro = createPromptRevisionMacro({
    idPrefix: 'outline_revision',
    generatorStep: 'generateOutline',
    parserStep: 'parseOutline',
    validationStep: 'validateOutline',
    guardStep: 'guardOutline'
  });

  assert.equal(snapshotContract.phaseId, 'phase2');
  assert.equal(schemaStep.input.data.$ref, 'ctx.outputs.outline');
  assert.equal(checkpointStep.contract.checkpointType, 'review');
  assert.deepEqual(macro.steps, ['generateOutline', 'parseOutline', 'validateOutline', 'guardOutline']);
});

test('pluginSdk exposes helper surface inventory with plugin-owned concerns', () => {
  const families = listSharedHelperFamilies();
  const validationFamily = getSharedHelperFamily('structured-validation-orchestration');

  assert.ok(Array.isArray(families));
  assert.ok(families.length >= 4);
  assert.ok(validationFamily);
  assert.equal(validationFamily.state, HELPER_SURFACE_STATES.SHARED_WITH_PLUGIN_SUPPLIED_SEMANTICS);
  assert.deepEqual(validationFamily.pluginOwnedConcerns, [
    'prompt wording',
    'verdict policy',
    'domain-specific issue interpretation'
  ]);
  assert.ok(validationFamily.consumers.includes('story-orchestrator-steps'));
});
