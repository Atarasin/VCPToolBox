# Workflow Kernel Plugin Authoring Guide

## Goal

This guide describes the minimum authoring surface for workflow-based plugins after the third-wave SDK extraction work begins.

A plugin should primarily provide:

- a workflow definition
- a small set of domain-specific steps
- business projection code
- plugin entry and configuration

A plugin should avoid rebuilding:

- a private workflow engine
- adapter-local checkpoint contracts
- ad hoc phase output wiring
- plugin-specific schema validation step plumbing

## Shared SDK Surface

Current shared helpers live under `modules/workflowKernel/pluginSdk/`.

Available helpers in the first extraction slice:

- `createSchemaValidationStepDefinition()`
- `createHumanReviewCheckpointStep()`
- `createPromptRevisionMacro()`
- `definePhaseOutputContract()`
- `defineCheckpointPayloadContract()`
- `defineBusinessSnapshotContract()`
- `defineArtifactProjectionContract()`

## Reference Consumer

`Plugin/StoryOrchestrator/config/workflow-definition.js` is the first reference consumer.

It now demonstrates:

- schema validation steps built through SDK helpers
- human review checkpoints built through SDK helpers
- top-level `pluginSdk` metadata for phase outputs, checkpoints, snapshots, artifacts, and reusable macros

## Minimal Example

```js
const {
  createSchemaValidationStepDefinition,
  createHumanReviewCheckpointStep,
  defineCheckpointPayloadContract
} = require('../../../modules/workflowKernel/pluginSdk');

const outlineReviewContract = defineCheckpointPayloadContract({
  checkpointType: 'outline_review',
  phaseId: 'phase2',
  title: 'Outline Review',
  reviewFields: {
    outline: 'outline',
    validation: 'outlineValidation'
  },
  response: {
    actions: ['approve', 'reject', 'modify'],
    feedbackField: 'feedback'
  }
});

module.exports = {
  id: 'example-workflow',
  phases: [
    {
      id: 'phase2',
      name: 'Outline',
      steps: [
        createSchemaValidationStepDefinition({
          id: 'schemaValidateOutline',
          dataRef: 'ctx.outputs.outline',
          schemaType: 'outline',
          outputKey: 'outlineSchema'
        }),
        createHumanReviewCheckpointStep({
          id: 'checkpointOutline',
          checkpointType: 'outline_review',
          promptTemplate: 'Review the outline before continuing.',
          contract: outlineReviewContract
        })
      ]
    }
  ]
};
```

## Business Contract Guidance

- `phase output contracts` define what later steps and business projections are allowed to consume.
- `checkpoint payload contracts` define what human reviewers see and what response shape the workflow expects.
- `business snapshot contracts` define what state is safe to capture and restore around workflow execution.
- `artifact projection contracts` define how plugin-facing artifacts are surfaced without bespoke adapter wiring.

## Migration Rule

If a pattern is likely to appear in another workflow-based plugin, move it into the shared SDK or contract layer.
If a pattern is story-domain specific, keep it in `StoryOrchestrator`.
