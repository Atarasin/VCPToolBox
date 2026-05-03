const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WorkflowKernel,
  checkpointStep,
  guardStep,
  pluginSdk
} = require('../../../modules/workflowKernel');

test('minimal reference consumer reuses pluginSdk helpers without a StoryOrchestrator-scale adapter', async () => {
  const events = [];
  const kernel = new WorkflowKernel({});
  kernel.onEvent('*', (event) => events.push(event));

  kernel.registerStepType('seedDraft', async () => ({
    status: 'completed',
    output: {
      title: 'Kernel-native draft',
      outline: ['opening', 'conflict', 'resolution']
    }
  }));
  kernel.registerStepType('schemaValidate', pluginSdk.createSchemaValidationStepHandler({
    validators: {
      draft: (value) => ({
        valid: Boolean(value?.title) && Array.isArray(value?.outline),
        schemaValid: Boolean(value?.title) && Array.isArray(value?.outline),
        completenessValid: Array.isArray(value?.outline) && value.outline.length >= 3,
        errors: [],
        warnings: []
      })
    }
  }));
  kernel.registerStepType('checkpoint', checkpointStep);
  kernel.registerStepType('guard', guardStep);
  kernel.registerStepType('publishDraft', async () => ({
    status: 'completed',
    output: {
      published: true
    }
  }));

  const phaseOutputContract = pluginSdk.definePhaseOutputContract({
    phaseId: 'phase1',
    outputs: {
      draft: 'draft',
      validation: 'draftValidation'
    }
  });
  const checkpointContract = pluginSdk.defineCheckpointPayloadContract({
    checkpointType: 'draft_review',
    phaseId: 'phase1',
    title: 'Draft Review',
    reviewFields: {
      title: 'draft.title',
      sectionCount: (outputs) => outputs?.draft?.outline?.length || 0
    },
    response: {
      actions: ['approve', 'modify']
    }
  });
  const macro = pluginSdk.createPromptRevisionMacro({
    idPrefix: 'draft_revision',
    generatorStep: 'seedDraft',
    parserStep: 'seedDraft',
    validationStep: 'schemaValidateDraft',
    guardStep: 'guardDraftValid'
  });

  const definition = {
    id: 'minimal-reference-consumer',
    pluginSdk: {
      phaseOutputs: {
        phase1: phaseOutputContract
      },
      checkpoints: {
        draft_review: checkpointContract
      },
      macros: {
        draftRevision: macro
      }
    },
    phases: [{
      id: 'phase1',
      steps: [
        { id: 'seedDraft', type: 'seedDraft', outputKey: 'draft' },
        pluginSdk.createSchemaValidationStepDefinition({
          id: 'schemaValidateDraft',
          dataRef: 'ctx.outputs.draft',
          schemaType: 'draft',
          outputKey: 'draftValidation'
        }),
        {
          id: 'guardDraftValid',
          type: 'guard',
          condition: 'ctx.outputs.draftValidation.valid == true',
          onFailure: 'fail'
        },
        pluginSdk.createHumanReviewCheckpointStep({
          id: 'checkpointDraft',
          checkpointType: 'draft_review',
          promptTemplate: 'Review the generated draft before publication.',
          contract: checkpointContract
        }),
        { id: 'publishDraft', type: 'publishDraft', outputKey: 'publication' }
      ]
    }]
  };

  try {
    const initialRecord = await kernel.execute('wf-minimal-reference-consumer', definition);
    assert.equal(initialRecord.status, 'waiting_checkpoint');
    assert.equal(initialRecord.checkpointState.checkpointId, 'checkpointDraft');
    assert.equal(definition.pluginSdk.phaseOutputs.phase1.outputs.validation, 'draftValidation');
    assert.deepEqual(definition.pluginSdk.macros.draftRevision.steps, [
      'seedDraft',
      'seedDraft',
      'schemaValidateDraft',
      'guardDraftValid'
    ]);

    const finalRecord = await kernel.resume('wf-minimal-reference-consumer', {
      checkpointId: initialRecord.checkpointState.checkpointId,
      action: 'modify',
      feedback: 'Looks good after a light revision',
      modifiedData: { preferredTone: 'concise' }
    });

    assert.equal(finalRecord.status, 'completed');
    assert.deepEqual(finalRecord.context.outputs.publication, { published: true });

    const modifiedEvent = events.find((event) => event.type === 'workflow.checkpoint_modified');
    assert.ok(modifiedEvent, 'expected checkpoint_modified event to be emitted');
    assert.equal(modifiedEvent.payload.action, 'modify');
    assert.equal(modifiedEvent.payload.modifiedData.preferredTone, 'concise');
  } finally {
    kernel.checkpointManager.destroy();
  }
});
