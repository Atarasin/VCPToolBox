# StoryOrchestrator → WorkflowKernel Migration Guide

> **Location:** `docs/workflow-migration-guide.md`  
> **Scope:** Guide for migrating StoryOrchestrator from hardcoded phase classes to declarative workflow definitions.  
> **See also:** `docs/workflow-kernel-api.md` (kernel API reference), `Plugin/StoryOrchestrator/config/workflow-definition.js` (reference definition)

---

## Table of Contents

- [Overview](#overview)
- [Feature Switch](#feature-switch)
- [Concept Mapping](#concept-mapping)
  - [Phase 1 → WorkflowKernel](#phase-1--workflowkernel)
  - [Phase 2 → WorkflowKernel](#phase-2--workflowkernel)
  - [Phase 3 → WorkflowKernel](#phase-3--workflowkernel)
- [Before / After Examples](#before--after-examples)
- [Custom Step Types](#custom-step-types)
- [Event Compatibility Adapter](#event-compatibility-adapter)
- [Troubleshooting](#troubleshooting)

---

## Overview

StoryOrchestrator historically implements its 3-phase pipeline (world building → outline drafting → refinement) as hardcoded JavaScript classes:

- `Phase1_WorldBuilding.js`
- `Phase2_OutlineDrafting.js`
- `Phase3_Refinement.js`

The **WorkflowKernel** provides a declarative alternative: phases, steps, and transitions are defined in a JSON/YAML-like workflow definition rather than imperative code. This guide shows how to map each legacy concept to its kernel equivalent, how to enable the kernel path, and how to maintain backward compatibility during the transition.

---

## Feature Switch

Migration is opt-in via the plugin config schema. The kernel path only activates when **both** conditions are true:

1. `USE_WORKFLOW_KERNEL` is set to `'true'` in `config.env` (or injected environment).
2. `USE_WORKFLOW_KERNEL` is declared in the plugin's `configSchema` so `PluginManager._getPluginConfig()` injects it.

### plugin-manifest.json

```json
{
  "name": "StoryOrchestrator",
  "configSchema": {
    "USE_WORKFLOW_KERNEL": { "type": "boolean", "default": false },
    "WORKFLOW_HOT_RELOAD": { "type": "boolean", "default": false },
    "SNAPSHOT_GRANULARITY": { "type": "string", "default": "phase_boundary" }
  }
}
```

### config.env

```bash
# Enable the kernel path
USE_WORKFLOW_KERNEL=true

# Optional: reload workflow-definition.js on each execution (dev only)
WORKFLOW_HOT_RELOAD=false

# Optional: snapshot frequency — checkpoint_only | phase_boundary | every_step
SNAPSHOT_GRANULARITY=phase_boundary
```

> ⚠️ **Critical:** If `USE_WORKFLOW_KERNEL` is missing from `configSchema`, `PluginManager` will not inject it and the kernel path will remain silently inactive even if the env var is set. See [Troubleshooting](#troubleshooting).

---

## Concept Mapping

### Phase 1 → WorkflowKernel

| Legacy Concept | Kernel Equivalent | Notes |
|---|---|---|
| `Phase1_WorldBuilding.run()` | `WorkflowKernel.execute()` with phase1 steps | Orchestrated by `StoryOrchestratorKernelAdapter` |
| Parallel agent dispatch (`agentDispatcher.delegateParallel`) | `parallelGroup` step | Two `agentCall` children: `worldBuilder` + `characterDesigner` |
| JSON parse with repair tracking | `parseAgentJson` custom step | Wraps `ExtractionLayer` with fallback parsers |
| Schema validation (`SchemaValidator.validateWorldview/Characters`) | `schemaValidate` custom step | Returns `{valid, errors, warnings}` into `ctx.outputs` |
| Validation gate (fail → retry) | `guard` step | `condition: 'ctx.outputs.worldviewSchema.valid == true'` |
| Business validation (`_validateResults`) | `storyValidate` custom step | Delegates `logicValidator` agent, parses verdict |
| Checkpoint creation (`_createCheckpoint`) | `checkpoint` step | `checkpointType: 'phase1_worldview_confirmation'` |
| Revision loop (max 1 attempt) | Handled by kernel `onFailure: 'retry'` + guard retry | Legacy does one auto-revision; kernel retries at step level |

### Phase 2 → WorkflowKernel

| Legacy Concept | Kernel Equivalent | Notes |
|---|---|---|
| `Phase2_OutlineDrafting._generateOutline()` | `generateOutline` custom step | Delegates `plotArchitect`, runs extraction |
| Outline parsing (`_parseOutline`) | `parseOutline` custom step | Supports `【Chapter N】`, JSON blocks, legacy format |
| Outline schema validation | `schemaValidate` + `guard` | Same pattern as Phase 1 |
| Outline business validation | `storyValidate` with `validationType: 'outline'` | Checks consistency against world/characters |
| Outline checkpoint | `checkpoint` step | `checkpointType: 'phase2_outline_confirmation'` |
| Content production (`_produceContent`) | `produceChapters` custom step | Serial chapter generation with detail-fill, expand, validate |
| Content checkpoint | `checkpoint` step | `checkpointType: 'phase2_content_confirmation'` |
| Chapter retry (`retryChapter`) | Checkpoint rejection → kernel resume with feedback | Adapter maps `checkpoint_rejected` to retry flow |

### Phase 3 → WorkflowKernel

| Legacy Concept | Kernel Equivalent | Notes |
|---|---|---|
| `Phase3_Refinement._runPolishLoop()` | `polishChapters` custom step | Iterates up to `MAX_PHASE_ITERATIONS`, scores quality |
| Quality threshold gate (`QUALITY_THRESHOLD`) | `LoopStep.shouldContinue` callback | Adapter's `shouldContinue()` evaluates `qualityScore >= threshold` |
| Final editor (`_runFinalEditor`) | `finalEdit` custom step | Delegates `finalEditor` agent on full manuscript |
| Final acceptance checkpoint | `checkpoint` step | `checkpointType: 'final_acceptance'` |
| Chapter retry in Phase 3 | Same checkpoint-rejection pattern as Phase 2 | `checkpointType: 'phase3_chapter_retry_confirmation'` |

### Control Flow Summary

```text
Legacy:  PhaseClass.run() → if fail → internal retry/revision → checkpoint → manual continue
Kernel:  execute(definition) → guard onFailure → checkpoint → resume(action) → next steps
```

The kernel externalizes control flow: instead of `if (validation.verdict === 'FAIL') { ... }` inside a class method, you declare a `guard` step with `onFailure: 'fail'` and let the kernel's retry policy handle re-execution.

---

## Before / After Examples

### Example: Phase 1 Parallel Agent Dispatch

**Before (legacy Phase1_WorldBuilding.js)**

```javascript
class Phase1_WorldBuilding {
  async run(storyId) {
    const story = await this.stateManager.getStory(storyId);
    const { storyPrompt, genre, stylePreference, targetWordCount } = story.config;

    // 1. Build prompts imperatively
    const worldviewPrompt = this._buildWorldviewPrompt({ storyPrompt, genre, ... });
    const charactersPrompt = this._buildCharacterPrompt({ storyPrompt, genre, ... });

    // 2. Parallel dispatch
    const results = await this.agentDispatcher.delegateParallel([
      { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: worldviewPrompt, options: { timeoutMs: 300000 } },
      { agentType: AGENT_TYPES.CHARACTER_DESIGNER, prompt: charactersPrompt, options: { timeoutMs: 300000 } }
    ]);

    // 3. Parse with repair tracking
    const worldview = this._parseWorldviewWithRepairTracking(results[0].result.content);
    const characters = this._parseCharactersWithRepairTracking(results[1].result.content);

    // 4. Schema validation
    const worldviewSchema = SchemaValidator.validateWorldview(worldview);
    const charactersSchema = SchemaValidator.validateCharacters(characters);
    if (!worldviewSchema.valid || !charactersSchema.valid) {
      return { status: 'needs_retry', error: 'Schema validation failed' };
    }

    // 5. Business validation
    const validation = await this._validateResults(storyId, worldview, characters);
    if (validation.verdict === 'FAIL') {
      const revised = await this._reviseAndReValidate(storyId, worldview, characters, validation);
      // ... complex retry logic
    }

    // 6. Checkpoint
    const checkpointId = await this._createCheckpoint(storyId);
    return { status: 'waiting_checkpoint', checkpointId };
  }
}
```

**After (declarative workflow-definition.js)**

```javascript
{
  id: 'story-orchestrator-v1',
  phases: [
    {
      id: 'phase1',
      name: '世界观与人设搭建',
      steps: [
        {
          id: 'generateWorldAndCharacters',
          type: 'parallelGroup',
          failurePolicy: 'waitForRest',
          steps: [
            {
              id: 'generateWorldview',
              type: 'agentCall',
              agent: 'worldBuilder',
              input: {
                prompt:   { $ref: 'ctx.inputs.storyPrompt' },
                genre:    { $ref: 'ctx.inputs.genre' },
                stylePreference: { $ref: 'ctx.inputs.stylePreference' },
                targetWords:     { $ref: 'ctx.inputs.targetWords' }
              },
              outputKey: 'worldviewRaw',
              extraction: extWorldview   // two-phase extraction config
            },
            {
              id: 'generateCharacters',
              type: 'agentCall',
              agent: 'characterDesigner',
              input: {
                prompt:   { $ref: 'ctx.inputs.storyPrompt' },
                genre:    { $ref: 'ctx.inputs.genre' },
                stylePreference: { $ref: 'ctx.inputs.stylePreference' },
                targetWords:     { $ref: 'ctx.inputs.targetWords' }
              },
              outputKey: 'charactersRaw',
              extraction: extCharacters
            }
          ]
        },
        {
          id: 'parseWorldview',
          type: 'parseAgentJson',
          input: { raw: { $ref: 'ctx.outputs.worldviewRaw.content' } },
          outputKey: 'worldview'
        },
        {
          id: 'parseCharacters',
          type: 'parseAgentJson',
          input: { raw: { $ref: 'ctx.outputs.charactersRaw.content' } },
          outputKey: 'characters'
        },
        {
          id: 'schemaValidateWorldview',
          type: 'schemaValidate',
          input: { data: { $ref: 'ctx.outputs.worldview' }, schemaType: 'worldview' },
          outputKey: 'worldviewSchema'
        },
        {
          id: 'schemaValidateCharacters',
          type: 'schemaValidate',
          input: { data: { $ref: 'ctx.outputs.characters' }, schemaType: 'characters' },
          outputKey: 'charactersSchema'
        },
        {
          id: 'guardWorldviewSchema',
          type: 'guard',
          condition: 'ctx.outputs.worldviewSchema.valid == true',
          onFailure: 'fail'
        },
        {
          id: 'guardCharactersSchema',
          type: 'guard',
          condition: 'ctx.outputs.charactersSchema.valid == true',
          onFailure: 'fail'
        },
        {
          id: 'validatePhase1',
          type: 'storyValidate',
          input: {
            validationType: 'phase1',
            worldview:  { $ref: 'ctx.outputs.worldview' },
            characters: { $ref: 'ctx.outputs.characters' },
            storyPrompt:{ $ref: 'ctx.inputs.storyPrompt' }
          },
          outputKey: 'phase1Validation'
        },
        {
          id: 'guardPhase1Valid',
          type: 'guard',
          condition: 'ctx.outputs.phase1Validation.verdict != "FAIL"',
          onFailure: 'fail'
        },
        {
          id: 'checkpointPhase1',
          type: 'checkpoint',
          checkpointType: 'phase1_worldview_confirmation',
          promptTemplate: '世界观与人设已生成并通过验证。请审查世界观设定和人物档案的完整性与一致性。确认后继续进入大纲生成阶段。',
          onCheckpointReject: 'retry'
        }
      ]
    }
  ]
}
```

### Key Differences

| Aspect | Legacy | Kernel |
|---|---|---|
| **Prompt building** | Hardcoded in `_buildWorldviewPrompt()` / `_buildCharacterPrompt()` | Registered inside `agentCall` handler in `StoryOrchestratorKernelAdapter` |
| **Parallelism** | `delegateParallel([...])` | `parallelGroup` step with `failurePolicy: 'waitForRest'` |
| **Parsing** | `_extractStructuredJsonWithRepairTracking()` inline | `parseAgentJson` custom step using `ExtractionLayer` |
| **Validation branching** | Nested `if (verdict === 'FAIL') { ... }` | `guard` steps with `onFailure: 'fail'`; kernel retry policy handles re-execution |
| **State persistence** | Direct `stateManager.updatePhase1()` calls | `StoryStateRepositoryAdapter` bridges kernel record ↔ legacy tables |
| **Checkpoint** | `_createCheckpoint()` + manual state updates | `checkpoint` step; kernel manages pending/approved/rejected lifecycle |

---

## Custom Step Types

StoryOrchestrator operations that are too domain-specific for built-in kernel steps are registered as **custom step types** in `StoryOrchestratorKernelAdapter.initialize()`.

### Registration

```javascript
// Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter.js
this.kernel.stepRegistry.register('parseAgentJson', storySteps.createParseAgentJsonStep(this));
this.kernel.stepRegistry.register('schemaValidate', storySteps.createSchemaValidateStep(this));
this.kernel.stepRegistry.register('storyValidate', storySteps.createStoryValidateStep(this));
this.kernel.stepRegistry.register('generateOutline', storySteps.createGenerateOutlineStep(this));
this.kernel.stepRegistry.register('parseOutline', storySteps.createParseOutlineStep(this));
this.kernel.stepRegistry.register('produceChapters', storySteps.createProduceChaptersStep(this));
this.kernel.stepRegistry.register('polishChapters', storySteps.createPolishChaptersStep(this));
this.kernel.stepRegistry.register('finalEdit', storySteps.createFinalEditStep(this));
```

### Factory Pattern

Each custom step is a **factory function** that receives the adapter instance and returns a step handler:

```javascript
// Plugin/StoryOrchestrator/steps/index.js
function createSchemaValidateStep(adapter) {
  return async (step, stepContext) => {
    const { data, schemaType } = resolveInput(step.input, stepContext.context);
    let result;
    switch (schemaType) {
      case 'worldview':  result = SchemaValidator.validateWorldview(data); break;
      case 'characters': result = SchemaValidator.validateCharacters(data); break;
      case 'outline':    result = SchemaValidator.validateOutline(data); break;
      default: return { status: 'failed', error: new Error(`Unknown schema type: ${schemaType}`) };
    }
    return { status: 'completed', output: result };
  };
}
```

### Why Custom Steps Instead of Built-ins?

| Custom Step | Why Not a Built-in? |
|---|---|
| `parseAgentJson` | Requires StoryOrchestrator-specific extraction schemas + repair tracking |
| `schemaValidate` | Delegates to `SchemaValidator` which is internal to the plugin |
| `storyValidate` | Builds prompts via `PromptBuilder` and delegates `logicValidator` agent with plugin-specific prompt templates |
| `generateOutline` | Uses `AGENT_TYPES.PLOT_ARCHITECT` and `PromptBuilder.buildOutlinePrompt()` |
| `parseOutline` | Supports 3 parser strategies (`【Chapter N】`, JSON block, legacy) unique to StoryOrchestrator |
| `produceChapters` | Orchestrates `chapterOperations.createChapterDraft`, `fillDetails`, `_expandChapter`, `reviseChapter` |
| `polishChapters` | Iterative quality-loop with `contentValidator.qualityScore` and `comprehensiveValidation` |
| `finalEdit` | Delegates `AGENT_TYPES.FINAL_EDITOR` with `PromptBuilder.buildFinalEditorPrompt()` |

### Adding a New Custom Step

1. **Implement** the factory in `Plugin/StoryOrchestrator/steps/index.js`:

```javascript
function createMyCustomStep(adapter) {
  return async (step, stepContext) => {
    const input = resolveInput(step.input, stepContext.context);
    // ... domain logic using adapter.agentDispatcher, adapter.chapterOperations, etc.
    return { status: 'completed', output: { ... } };
  };
}
```

2. **Export** it from `steps/index.js`.

3. **Register** it in `StoryOrchestratorKernelAdapter._registerCustomStepTypes()`:

```javascript
this.kernel.stepRegistry.register('myCustomStep', storySteps.createMyCustomStep(this));
```

4. **Use** it in `workflow-definition.js`:

```javascript
{ id: 'doSomething', type: 'myCustomStep', input: { ... }, outputKey: 'somethingResult' }
```

---

## Event Compatibility Adapter

During migration, existing frontend/code that listens to **legacy StoryOrchestrator events** must continue to work. The `StoryEventAdapter` bridges generic kernel events to legacy event shapes.

### Architecture

```
WorkflowKernel → generic event (workflow.checkpoint_pending)
       ↓
StoryEventAdapter._mapToLegacy()
       ↓
legacy event (checkpoint_created, checkpoint_pending)
       ↓
StoryOrchestratorKernelAdapter._emitLegacyEvent()
       ↓
stateManager.appendWorkflowHistory() + stateManager.setActiveCheckpoint()
```

### Legacy → Kernel Event Mapping

| Kernel Event | Legacy Event(s) | Condition |
|---|---|---|
| `workflow.started` | `workflow_started` | — |
| `workflow.state_changed` (to `running`) | `workflow_resuming` | `from === 'waiting_checkpoint'` |
| `workflow.step_completed` | `phase_completed` | Last step of phase |
| `workflow.step_failed` | `phase_failed` | — |
| `workflow.retrying` | `phase_retry`, `phase_restart` | — |
| `workflow.checkpoint_pending` | `checkpoint_created`, `checkpoint_pending` | — |
| `workflow.checkpoint_approved` | `checkpoint_approved` | — |
| `workflow.checkpoint_rejected` | `chapter_checkpoint_rejected` | `checkpointType.includes('chapter')` |
| `workflow.checkpoint_rejected` | `checkpoint_rejected` | Otherwise |
| `workflow.checkpoint_auto_approved` | `checkpoint_auto_approved` | — |
| `workflow.completed` | `final_acceptance`, `workflow_completed` | `isFinalAcceptance` |
| `workflow.completed` | `workflow_completed` | Otherwise |
| `workflow.failed` | `phase_failed` | — |
| `workflow.rollback` | `workflow_rollback`, `rollback` | — |

### Usage in Adapter

```javascript
// Inside StoryOrchestratorKernelAdapter.initialize()
this.eventAdapter = new StoryEventAdapter({
  push: async (workflowId, event) => {
    await this._emitLegacyEvent(workflowId, event);
  }
});

const kernelEventTypes = [
  'workflow.started', 'workflow.state_changed', /* ... */
];
for (const eventType of kernelEventTypes) {
  this.kernel.onEvent(eventType, (event) => {
    this.eventAdapter.onKernelEvent(event.workflowId, event);
    this._onKernelEventForSnapshot(event);  // also trigger business-state snapshots
  });
}
```

### Deprecation Path

1. **Current (migration phase):** Both generic and legacy events are emitted. Frontends may consume either.
2. **Transition:** Frontends update to consume generic kernel events directly (`workflow.checkpoint_pending` instead of `checkpoint_pending`).
3. **Removal:** Once all consumers migrate, `StoryEventAdapter` and `_emitLegacyEvent()` can be removed. The kernel events require no adapter.

> **Tip:** Use `StoryOrchestratorKernelAdapter.getExtractionMetrics()` and kernel event logs to verify that legacy consumers receive events correctly before removing the adapter.

---

## Troubleshooting

### "Kernel path never activates — `USE_WORKFLOW_KERNEL=true` is ignored"

**Cause:** `USE_WORKFLOW_KERNEL` is not declared in the plugin's `configSchema`. `PluginManager._getPluginConfig()` filters env vars by schema keys; undeclared keys are silently dropped.

**Fix:**

```json
// Plugin/StoryOrchestrator/plugin-manifest.json
{
  "configSchema": {
    "USE_WORKFLOW_KERNEL": { "type": "boolean", "default": false },
    "WORKFLOW_HOT_RELOAD": { "type": "boolean", "default": false }
  }
}
```

Verify with:

```javascript
const config = pluginManager._getPluginConfig('StoryOrchestrator');
console.log(config.USE_WORKFLOW_KERNEL); // should be 'true'
```

### "Checkpoint state not visible to legacy polling"

**Cause:** The kernel checkpoint is approved, but `story.workflow.activeCheckpoint` is not synchronized back to the legacy state object.

**Fix:** Ensure `StoryOrchestratorKernelAdapter._emitLegacyEvent()` handles `checkpoint_pending` by calling `stateManager.setActiveCheckpoint()`:

```javascript
if (event.eventType === 'workflow.checkpoint_pending') {
  await this.stateManager.setActiveCheckpoint(storyId, {
    id: event.payload.checkpointId,
    phase: event.payload.phase,
    type: event.payload.checkpointType,
    status: 'pending'
  });
}
```

### "Cross-phase `$ref` resolves to undefined"

**Cause:** When executing `phase2`, the kernel context does not contain `outputs.worldview` or `outputs.characters` from `phase1`.

**Fix:** The adapter restores prior-phase business-state snapshots before execution via `_buildRestoredOutputs()`:

```javascript
const restoredOutputs = this._buildRestoredOutputs(storyId, phaseName);
const result = await this.kernel.execute(storyId, definition, {}, restoredOutputs);
```

Ensure snapshots are created on checkpoint approval:

```javascript
// lifecycle hook 'afterCheckpoint'
this._createBusinessSnapshot(workflowId, phaseName, record.context, 'approved');
```

### "Custom step type not found: `parseAgentJson`"

**Cause:** The step type was not registered before `WorkflowKernel.execute()` or `WorkflowValidator.validate()`.

**Fix:** Confirm registration order in `initialize()`:

```javascript
// 1. Register built-ins
this.kernel.stepRegistry.register('agentCall',   /* ... */);
this.kernel.stepRegistry.register('checkpoint',  /* ... */);
this.kernel.stepRegistry.register('guard',       /* ... */);
this.kernel.stepRegistry.register('loop',        /* ... */);
this.kernel.stepRegistry.register('parallelGroup', /* ... */);

// 2. Register custom steps
this._registerCustomStepTypes();
```

### "Guard condition always fails despite output being valid"

**Cause:** Guard conditions use a simple expression evaluator. Common pitfalls:

- Strings must be quoted: `ctx.outputs.phase1Validation.verdict != "FAIL"`
- Boolean comparisons must use `== true` / `== false`, not truthiness
- `$ref` paths must exist in `context.outputs` before the guard runs

**Fix:** Inspect `context.outputs` at runtime:

```javascript
this.kernel.registerLifecycleHook('beforeStep', async ({ step, record }) => {
  console.log('Outputs before guard:', JSON.stringify(record.context.outputs, null, 2));
});
```

### "Loop step runs forever or stops too early"

**Cause:** `LoopStep` delegates the continue decision to `kernel.config.shouldContinue`, which the adapter implements as `shouldContinue(context)`.

**Fix:** Verify the adapter's `shouldContinue()` logic:

```javascript
shouldContinue(context) {
  const maxIterations = context.inputs.maxIterations || 5;
  const currentIteration = context.outputs.iterationCount || 0;
  if (currentIteration >= maxIterations) return false;

  const qualityThreshold = context.inputs.qualityThreshold || 8.0;
  const qualityScore = context.outputs.averageQualityScore || 0;

  if (qualityScore > 0 && qualityScore < qualityThreshold) return true;
  if (qualityScore >= qualityThreshold) return false;

  return currentIteration < maxIterations;
}
```

Ensure the loop step outputs `iterationCount` and `averageQualityScore` into `context.outputs`.

### "Schema validation fails in production but passes in tests"

**Cause:** Tests may set `RUN_E2E_TESTS=1`, which forces `valid=true` inside `createSchemaValidateStep`. Production does not have this override.

**Fix:** Remove the e2e bypass from production code or gate it explicitly:

```javascript
if (process.env.RUN_E2E_TESTS === '1' && data && typeof data === 'object') {
  result = { ...result, valid: true, e2eRelaxed: true };
}
```

This is intentional for e2e test stability but must not leak into real deployments.

### "Workflow validation fails with `Unknown step type: parseOutline`"

**Cause:** `WorkflowValidator.validate()` is called before custom step types are registered, or the step type name in the definition does not match the registered name.

**Fix:**

```javascript
const validator = new WorkflowValidator(this.kernel.stepRegistry);
const validation = validator.validate(definition);
if (!validation.valid) {
  throw new Error(`Workflow validation failed: ${validation.errors.join('; ')}`);
}
```

Call this **after** `_registerCustomStepTypes()` and ensure names match exactly (`parseOutline` vs `parseOutlineStep`).

---

## Migration Checklist

- [ ] Add `USE_WORKFLOW_KERNEL` and `WORKFLOW_HOT_RELOAD` to `configSchema`
- [ ] Set `USE_WORKFLOW_KERNEL=true` in `config.env`
- [ ] Verify `StoryOrchestratorKernelAdapter.initialize()` registers all custom steps
- [ ] Confirm `workflow-definition.js` passes `WorkflowValidator.validate()`
- [ ] Test Phase 1 end-to-end: parallel agents → parse → validate → checkpoint
- [ ] Test Phase 2: outline generation → checkpoint → content production → checkpoint
- [ ] Test Phase 3: polish loop → final edit → final acceptance checkpoint
- [ ] Verify legacy event consumers still receive events via `StoryEventAdapter`
- [ ] Confirm checkpoint polling (`stateManager.setActiveCheckpoint`) works for legacy UI
- [ ] Test crash recovery: kill process mid-phase, restart, verify `onRecovery` hook restores state
- [ ] Monitor `getExtractionMetrics()` for parser success rates after migration
