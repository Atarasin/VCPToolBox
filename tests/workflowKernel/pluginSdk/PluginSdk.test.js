const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSchemaValidationStepHandler,
  defineCheckpointPayloadContract,
  defineBusinessSnapshotContract,
  createSchemaValidationStepDefinition,
  createHumanReviewCheckpointStep,
  createPromptRevisionMacro,
  projectContractFields
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
