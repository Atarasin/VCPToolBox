# WorkflowKernel API Reference

> **Location:** `modules/workflowKernel/`  
> **Scope:** Public API for plugin authors building workflow-driven features.  
> **See also:** `modules/workflowKernel/README.md` (architecture overview), `modules/workflowKernel/docs/API.md` (complete per-class API)

---

## Table of Contents

- [Quick Start](#quick-start)
- [WorkflowDefinition Schema](#workflowdefinition-schema)
- [Configuration Reference](#configuration-reference)
- [Step Type Catalog](#step-type-catalog)
  - [agentCall](#agentcall)
  - [checkpoint](#checkpoint)
  - [guard](#guard)
  - [loop](#loop)
  - [parallelGroup](#parallelgroup)
- [Checkpoint API](#checkpoint-api)
- [RecoveryManager API & Crash Recovery](#recoverymanager-api--crash-recovery)
- [Event Schema Reference](#event-schema-reference)
- [Error Codes](#error-codes)
- [Lifecycle Hooks](#lifecycle-hooks)

---

## Quick Start

```javascript
const {
  WorkflowKernel,
  agentCallStep,
  checkpointStep,
  guardStep,
  loopStep,
  parallelGroupStep
} = require('./modules/workflowKernel');

// 1. Create kernel
const kernel = new WorkflowKernel({
  agentDispatcher: myAgentDispatcher,
  stateRepository: myStateRepository,    // optional
  webSocketPusher: myWebSocketPusher,    // optional
  config: {
    defaultTimeoutMs: 86400000,
    maxConcurrentWorkflows: 100
  }
});

// 2. Register built-in step types
kernel.registerStepType('agentCall', agentCallStep);
kernel.registerStepType('checkpoint', checkpointStep);
kernel.registerStepType('guard', guardStep);
kernel.registerStepType('loop', loopStep);
kernel.registerStepType('parallelGroup', parallelGroupStep);

// 3. Define a workflow
const definition = {
  id: 'novel-draft-workflow',
  version: '1.0.0',
  phases: [
    {
      id: 'worldbuilding',
      name: 'World Building',
      steps: [
        {
          id: 'generateWorld',
          type: 'agentCall',
          agent: 'worldBuilder',
          input: { genre: 'sci-fi', tone: 'dark' },
          outputKey: 'worldSetting'
        },
        {
          id: 'worldCheckpoint',
          type: 'checkpoint',
          promptTemplate: 'Review the world setting before proceeding.',
          timeoutMs: 3600000
        }
      ]
    }
  ]
};

// 4. Execute
const record = await kernel.execute('wf-001', definition, { genre: 'sci-fi' });

// 5. Subscribe to events
const unsubscribe = kernel.onEvent('workflow.checkpoint_pending', (event) => {
  console.log('Checkpoint waiting:', event.payload.checkpointId);
});

// 6. Resume from checkpoint (e.g., when user approves via UI)
await kernel.resume('wf-001', {
  checkpointId: 'worldCheckpoint',
  action: 'approve',
  feedback: 'Looks good, proceed.'
});
```

---

## WorkflowDefinition Schema

A workflow is a declarative JSON structure composed of **phases** and **steps**.

### Top-Level Schema

```javascript
{
  id: 'string',                // Required. Unique workflow identifier.
  version: 'string',           // Optional. Semantic version.
  phases: [                    // Required. At least one phase.
    PhaseDefinition
  ],
  globalRetryPolicy: {         // Optional. Default retry for all steps.
    maxAttempts: 3,
    backoffDelays: [0, 250, 1000]
  },
  onFailure: 'string'          // Optional. Global failure strategy.
}
```

### PhaseDefinition

```javascript
{
  id: 'string',                // Required. Phase identifier (unique within workflow).
  name: 'string',              // Optional. Human-readable name.
  steps: [                     // Required. Ordered array of steps.
    StepDefinition
  ]
}
```

### StepDefinition

```javascript
{
  id: 'string',                // Required. Step identifier (unique within workflow).
  type: 'string',              // Required. Registered step type name.
  outputKey: 'string',         // Optional. Key to store result in `ctx.outputs`.
  input: Object,               // Optional. Literal values or `{ $ref: 'ctx.outputs.x' }`.
  config: Object,              // Optional. Step-specific configuration.
  onFailure: 'string',         // Optional. Explicit failure action override.
  retryPolicy: {               // Optional. Per-step retry override.
    maxAttempts: 5,
    backoffDelays: [0, 500, 2000]
  }
}
```

### Complete Example

```javascript
const definition = {
  id: 'content-pipeline',
  version: '1.0.0',
  phases: [
    {
      id: 'research',
      name: 'Research Phase',
      steps: [
        {
          id: 'gatherSources',
          type: 'parallelGroup',
          failurePolicy: 'waitForRest',
          steps: [
            { id: 'searchWeb', type: 'agentCall', agent: 'webSearcher', outputKey: 'webResults' },
            { id: 'searchDocs', type: 'agentCall', agent: 'docSearcher', outputKey: 'docResults' }
          ]
        },
        {
          id: 'synthesize',
          type: 'agentCall',
          agent: 'synthesizer',
          input: {
            web: { $ref: 'ctx.outputs.webResults' },
            docs: { $ref: 'ctx.outputs.docResults' }
          },
          outputKey: 'synthesis'
        }
      ]
    },
    {
      id: 'drafting',
      name: 'Draft Generation',
      steps: [
        {
          id: 'writeDraft',
          type: 'agentCall',
          agent: 'writer',
          input: { briefing: { $ref: 'ctx.outputs.synthesis' } },
          outputKey: 'draft'
        },
        {
          id: 'draftReview',
          type: 'checkpoint',
          promptTemplate: 'Please review the generated draft.',
          timeoutMs: 7200000,
          autoContinueOnTimeout: false
        }
      ]
    },
    {
      id: 'polish',
      name: 'Quality Assurance',
      steps: [
        {
          id: 'qualityGuard',
          type: 'guard',
          condition: 'ctx.steps.writeDraft.outputs.qualityScore >= 80',
          onFailure: 'checkpoint'
        },
        {
          id: 'refineLoop',
          type: 'loop',
          maxIterations: 3,
          onMaxIterationsExceeded: 'fail',
          steps: [
            { id: 'edit', type: 'agentCall', agent: 'editor', outputKey: 'editedDraft' }
          ]
        }
      ]
    }
  ],
  globalRetryPolicy: {
    maxAttempts: 2,
    backoffDelays: [0, 1000]
  }
};
```

### `$ref` Input Resolution

Inputs support value references to previous step outputs using the `{ $ref: 'ctx.path' }` syntax:

```javascript
{
  id: 'nextStep',
  type: 'agentCall',
  input: {
    // Reference a direct output
    world: { $ref: 'ctx.outputs.worldSetting' },

    // Reference a step execution record
    score: { $ref: 'ctx.steps.qualityGuard.outputs.score' },

    // Reference initial inputs
    genre: { $ref: 'ctx.inputs.genre' },

    // Nested objects with mixed literals and refs
    config: {
      mode: 'strict',
      threshold: { $ref: 'ctx.inputs.threshold' }
    }
  }
}
```

Valid `$ref` roots: `ctx.inputs`, `ctx.steps`, `ctx.outputs`.

---

## Configuration Reference

### Kernel Constructor Options

```javascript
new WorkflowKernel({
  agentDispatcher: Object,       // Required. Must implement delegate(agentId, prompt, options)
  stateRepository: Object,       // Optional. Must implement WorkflowStateRepository interface
  webSocketPusher: Object,       // Optional. Must implement push(workflowId, event)
  config: {
    defaultTimeoutMs: 86400000,         // Default checkpoint timeout (24h)
    maxConcurrentWorkflows: 100,        // Max active workflows in memory
    globalRetryPolicy: {                // Default retry configuration
      maxAttempts: 3,
      backoffDelays: [0, 250, 1000]
    }
  }
})
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentDispatcher` | `Object` | **Required** | Delegates AI agent calls. Must implement `delegate(agentId, prompt, options)` |
| `stateRepository` | `WorkflowStateRepository` | `null` | Persistence adapter. Enables crash recovery and status queries across restarts |
| `webSocketPusher` | `Object` | `null` | Real-time event push. Must implement `push(workflowId, event)` |
| `config.defaultTimeoutMs` | `number` | `86400000` | Default checkpoint timeout in milliseconds (24 hours) |
| `config.maxConcurrentWorkflows` | `number` | `100` | Maximum number of workflows kept in memory simultaneously |
| `config.globalRetryPolicy` | `Object` | `{ maxAttempts: 3, backoffDelays: [0, 250, 1000] }` | Default retry policy for all steps |

### Environment Variables

Set in `config.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_WORKFLOW_KERNEL` | `false` | Feature flag to route StoryOrchestrator traffic through the kernel |
| `WORKFLOW_HOT_RELOAD` | `false` | Enable dev-mode file watching for workflow definitions |

---

## Step Type Catalog

### `agentCall`

Delegates to an AI agent via the configured `AgentDispatcher`. Supports two-phase structured data extraction.

```javascript
{
  id: 'writeDraft',
  type: 'agentCall',
  agent: 'creativeWriter',           // Agent type identifier
  input: {
    topic: 'Space exploration',
    style: { $ref: 'ctx.inputs.style' }  // Reference previous outputs
  },
  outputKey: 'draft',
  options: {
    timeoutMs: 120000,
    taskDelegation: true
  },
  extraction: {                      // Optional: structured data extraction
    schema: {                        // JSON schema for validation
      title: 'string',
      sections: ['string']
    },
    requiredFields: ['title'],
    defaultValue: { title: 'Untitled' },
    maxAttempts: 2,                  // Retry extraction on failure
    parserOrder: ['json', 'regex']   // Parser priority
  }
}
```

**Handler result shape:**
```javascript
{
  status: 'completed',
  output: {
    content: 'string',               // Raw agent response
    data: Object,                    // Extracted structured data (if extraction configured)
    meta: Object,                    // Extraction metadata
    markers: Array,                  // Agent response markers
    raw: Object                      // Raw dispatcher response
  }
}
```

### `checkpoint`

Pauses workflow execution pending human approval. The workflow enters `waiting_checkpoint` state until `kernel.resume()` is called or the checkpoint times out.

```javascript
{
  id: 'reviewDraft',
  type: 'checkpoint',
  promptTemplate: 'Please review the draft and approve to continue.',
  timeoutMs: 86400000,               // Auto-approve after 24h (default from kernel config)
  autoContinueOnTimeout: true,       // true = auto-approve, false = fail on timeout
  onCheckpointReject: 'retry'        // 'retry' | 'rollback'
}
```

**Handler result shape:**
```javascript
{
  status: 'waiting_checkpoint',
  checkpoint: {
    checkpointId: 'cp-1234567890-abcdef',
    type: 'generic',
    promptTemplate: 'Please review...',
    expiresAt: '2026-05-02T08:36:00.000Z',
    autoContinueOnTimeout: true
  }
}
```

### `guard`

Evaluates a condition expression using the safe `ExpressionEngine`. On failure, can retry, fail the workflow, or create a checkpoint.

```javascript
{
  id: 'qualityCheck',
  type: 'guard',
  condition: 'ctx.steps.review.outputs.score >= 80',
  onFailure: 'checkpoint'            // 'retry' | 'fail' | 'checkpoint'
}
```

**Supported expression syntax:**
- Field access: `ctx.steps.stepId.outputs.field`
- Comparison: `>=`, `<=`, `==`, `!=`, `>`, `<`
- Boolean: `&&` (AND), `||` (OR)
- Grouping: `(a && b) || c`
- Literals: numbers, quoted strings, `null`, `true`, `false`

**Handler result shape (passed):**
```javascript
{ status: 'completed', output: { passed: true, condition: '...' } }
```

**Handler result shape (failed, onFailure='checkpoint'):**
```javascript
{
  status: 'waiting_checkpoint',
  checkpoint: {
    checkpointId: 'guard-qualityCheck',
    type: 'guard_failure',
    promptTemplate: 'Guard condition failed...'
  }
}
```

### Failure Policy Runtime

Failure policy is now part of the main execution chain rather than passive config:

- step-level `retryPolicy` overrides workflow-level `globalRetryPolicy`
- workflow-level `globalRetryPolicy` applies when a step has no local retry config
- retry decisions emit `workflow.retrying` before the next attempt
- checkpoint rejection is routed through the same failure-policy dispatch path used by step failures

Canonical failure actions:

- `fail`: mark the workflow failed
- `retry`: retry the current step according to the resolved retry policy
- `checkpoint`: pause on a failure checkpoint and wait for human input
- `rollbackToSnapshot`: dispatch through the kernel recovery runtime and roll back to the latest declared rollback-safe boundary
- `restartPhase`: rewind to the target phase boundary and re-enter execution through the same kernel recovery dispatch

Composite-step boundaries are explicit:

- `loop` => failure boundary is the loop wrapper step
- `parallelGroup` => failure boundary is the parallel wrapper step
- custom step types => failure boundary is `custom_step`

### `loop`

Repeatedly executes sub-steps until `shouldContinue` returns `false` or `maxIterations` is reached.

```javascript
{
  id: 'refineLoop',
  type: 'loop',
  maxIterations: 5,
  onMaxIterationsExceeded: 'fail',   // 'fail' | 'checkpoint'
  steps: [
    { id: 'critique', type: 'agentCall', agent: 'critic', outputKey: 'critique' },
    { id: 'rewrite', type: 'agentCall', agent: 'writer', input: { $ref: 'ctx.outputs.critique' } }
  ]
}
```

> **Note:** `shouldContinue` is injected via `kernel.config.shouldContinue` or `step.shouldContinue`. It receives the full `context` object and must return a boolean.

**Handler result shape (completed):**
```javascript
{ status: 'completed', output: { iterations: 3, stopped: true, reason: 'shouldContinue_returned_false' } }
```

### `parallelGroup`

Executes sub-steps concurrently with configurable failure policy.

```javascript
{
  id: 'parallelResearch',
  type: 'parallelGroup',
  failurePolicy: 'waitForRest',      // 'waitForRest' | 'cancelAll' | 'ignore'
  steps: [
    { id: 'researchScience', type: 'agentCall', agent: 'scienceBot', outputKey: 'science' },
    { id: 'researchHistory', type: 'agentCall', agent: 'historyBot', outputKey: 'history' }
  ]
}
```

**Failure policies:**

| Policy | Behavior |
|--------|----------|
| `waitForRest` | Wait for all sub-steps to complete. Fail if any failed. (default) |
| `cancelAll` | Fail immediately on first failure. Cancel remaining sub-steps via `AbortController`. |
| `ignore` | Ignore failures. Return all results including failures. |

**Handler result shape (completed):**
```javascript
{
  status: 'completed',
  output: {
    results: [
      { stepId: 'researchScience', status: 'completed', output: {...} },
      { stepId: 'researchHistory', status: 'completed', output: {...} }
    ]
  }
}
```

---

## Checkpoint API

Checkpoints are the human-in-the-loop mechanism of the WorkflowKernel. They pause execution, notify observers, and wait for an explicit response.

### Creating Checkpoints

Checkpoints are created automatically when a `checkpoint` step executes or when a `guard` step fails with `onFailure: 'checkpoint'`.

**Direct creation via CheckpointManager:**
```javascript
const { CheckpointManager } = require('./modules/workflowKernel');
const cpManager = new CheckpointManager({ defaultTimeoutMs: 3600000 });

const checkpoint = await cpManager.create('wf-001', {
  id: 'myCheckpoint',                // Optional. Auto-generated if omitted.
  type: 'human_review',              // Checkpoint classification
  promptTemplate: 'Please review the output.',
  timeoutMs: 7200000,                // Override default timeout
  autoContinueOnTimeout: true,       // Auto-approve on timeout
  onCheckpointReject: 'retry',       // Action on rejection
  metadata: { priority: 'high' }     // Arbitrary metadata
});
```

**Created checkpoint shape:**
```javascript
{
  checkpointId: 'cp-1234567890-abcdef',
  workflowId: 'wf-001',
  type: 'human_review',
  promptTemplate: 'Please review the output.',
  status: 'pending',
  createdAt: '2026-05-01T12:00:00.000Z',
  expiresAt: '2026-05-01T14:00:00.000Z',
  autoContinueOnTimeout: true,
  onCheckpointReject: 'retry',
  metadata: { priority: 'high' }
}
```

### Responding to Checkpoints

Use `kernel.resume()` to respond to a checkpoint:

```javascript
// Approve
await kernel.resume('wf-001', {
  checkpointId: 'cp-1234567890-abcdef',
  action: 'approve',
  feedback: 'Looks good, proceed.'
});

// Reject
await kernel.resume('wf-001', {
  checkpointId: 'cp-1234567890-abcdef',
  action: 'reject',
  feedback: 'Please rewrite the introduction.'
});

// Skip (bypass without executing)
await kernel.resume('wf-001', {
  checkpointId: 'cp-1234567890-abcdef',
  action: 'skip'
});

// Modify (approve with changes)
await kernel.resume('wf-001', {
  checkpointId: 'cp-1234567890-abcdef',
  action: 'modify',
  feedback: 'Approved with minor edits.',
  modifiedData: { title: 'Updated Title' }
});
```

**Resolution contract**

- `approve` continues workflow execution and emits `workflow.checkpoint_approved`
- `reject` follows the configured reject strategy; current canonical behavior is:
  - `onCheckpointReject: 'retry'` rewinds to the preceding business step and emits `workflow.checkpoint_rejected`
  - other reject strategies remain explicit reject outcomes and do not masquerade as approval
- `skip` continues execution and emits `workflow.checkpoint_skipped`
- `modify` persists `modifiedData`, continues execution, and emits `workflow.checkpoint_modified`
- timeout continuation resolves as action `timeout`, emits `workflow.checkpoint_timeout`, and must not reuse an approval event name
- rejection continuations such as `retry` and `restartPhase` are dispatched through the same failure-policy runtime used for step failures

Checkpoint persistence stays aligned with the resolved action:

- `approve` => `approved`
- `reject` => `rejected`
- `skip` => `skipped`
- `modify` => `modified`
- `timeout` => `timed_out`

### Timeout Behavior

The `CheckpointManager` runs a polling timer (default interval: 60s) to detect expired checkpoints:

- If `autoContinueOnTimeout: true`, the checkpoint is resolved with action `timeout` and workflow-level continuation when `expiresAt` is reached.
- If `autoContinueOnTimeout: false`, the workflow remains in `waiting_checkpoint` state indefinitely.

```javascript
// Configure poll interval
const cpManager = new CheckpointManager({
  defaultTimeoutMs: 3600000,
  checkpointPollIntervalMs: 60000   // Check every 60 seconds
});

// Clean up on shutdown
cpManager.destroy();
```

### Listing Pending Checkpoints

```javascript
const pending = cpManager.listPending();
// [ { checkpointId, workflowId, type, status, ... }, ... ]
```

---

## RecoveryManager API & Crash Recovery

The `RecoveryManager` handles startup crash recovery for workflows that were active when the VCP process terminated.

### Usage

```javascript
const { RecoveryManager } = require('./modules/workflowKernel');

const recoveryManager = new RecoveryManager(kernel, stateRepository);
const { recovered, failed } = await recoveryManager.startupRecovery();

console.log(`Recovered: ${recovered.length}, Failed: ${failed.length}`);
```

### Recovery Rules

| Rule | Behavior |
|------|----------|
| **Explicit recovery cursor** | Persisted in `retryContext.__recovery.currentCursor`; includes `phaseId`, `stepId`, `stepIndex`, `boundaryType`, `runToken`, and `resumeAction` |
| **Safe-to-resume steps** | `checkpoint`, `guard`, `noop`, plus custom steps that declare `recovery.resumeFromCursor: true` |
| **Non-idempotent steps** | `agentCall` and composite/custom steps without explicit safe metadata roll back to the latest declared rollback boundary |
| **No cursor** | Mark workflow as `idle` (hasn't started any steps) |
| **No safe boundary** | Mark workflow as `failed` (cannot safely recover) |
| **runToken mismatch** | Skip recovery (another process instance owns this workflow) |

### Recovery Actions

| Action | Description |
|--------|-------------|
| `resume_from_cursor` | Re-enter from the persisted `recoveryCursor` boundary (`resume_step` or `resume_next`) |
| `resume_from_safe_boundary` | Roll back to a declared safe boundary from `retryContext.__recovery.rollbackBoundaries` |
| `marked_idle` | No execution cursor found; workflow marked as idle |
| `marked_failed` | No safe boundary found; workflow marked as failed |
| `skipped` | runToken mismatch; recovery skipped |

### Example: Manual Recovery

```javascript
// After creating a kernel with a state repository:
const kernel = new WorkflowKernel({ agentDispatcher, stateRepository });

// Register step types before recovery
kernel.registerStepType('agentCall', agentCallStep);
kernel.registerStepType('checkpoint', checkpointStep);

// Run startup recovery
const recoveryManager = new RecoveryManager(kernel, stateRepository);
const results = await recoveryManager.startupRecovery();

// Resume recovered workflows
for (const result of results.recovered) {
  if (result.action === 'resume_from_cursor' || result.action === 'resume_from_safe_boundary') {
    await kernel.recover(result.workflowId, { recoveryAction: 'continue', definition });
  }
}
```

### Kernel `recover()` Method

The kernel exposes a higher-level `recover()` method that loads state, calls `onRecovery` hooks, and dispatches `continue`, `restart_phase`, or `rollback` through the same recovery runtime:

```javascript
// Recover from checkpoint
await kernel.recover('wf-001', {
  checkpointResponse: {
    checkpointId: 'cp-123',
    action: 'approve'
  }
});

// Continue from the explicit recovery cursor / safe boundary
await kernel.recover('wf-001', {
  recoveryAction: 'continue',
  definition
});

// Restart the current or target phase
await kernel.recover('wf-001', {
  recoveryAction: 'restart_phase',
  targetPhase: 'phase2',
  definition
});

// Roll back to the latest declared safe boundary
await kernel.recover('wf-001', {
  recoveryAction: 'rollback',
  targetBoundaryType: 'checkpoint_boundary',
  definition
});
```

**Recovery hooks:**
```javascript
kernel.registerLifecycleHook('onRecovery', async ({ workflowId, record, kernel }) => {
  // Restore business state from record.context
  console.log(`Recovering workflow ${workflowId} at cursor`, record.executionCursor);
});
```

---

## Event Schema Reference

All kernel events follow a standard schema:

```javascript
{
  type: 'workflow.step_completed',   // Event type
  workflowId: 'wf-001',              // Source workflow
  timestamp: '2026-05-01T12:00:00.000Z',
  payload: { /* event-specific data */ }
}
```

### Lifecycle Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.started` | `{ definitionRef, initialContext }` | Workflow begins execution |
| `workflow.completed` | `{ outputs }` | All steps completed successfully |
| `workflow.failed` | `{ error, failedStepId, attempt, resolvedFailureAction, failureBoundary }` | Step failure or invalid transition |
| `workflow.recovered` | `{ workflowId, recoveredAt, executionCursor }` | Workflow recovered from crash |

### Step Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.step_started` | `{ stepId, stepType, phaseId, attempt }` | Before step handler invoked |
| `workflow.step_completed` | `{ stepId, stepType, outputKey }` | Step returns `completed` |
| `workflow.step_failed` | `{ stepId, stepType, errorCode, errorMessage, attempt, resolvedFailureAction, failureBoundary }` | Step returns `failed` |
| `workflow.retrying` | `{ stepId, stepType, phaseId, attempt, maxAttempts, delayMs, retryPolicySource, failureBoundary }` | Runtime schedules another attempt |

### Checkpoint Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.checkpoint_pending` | `{ checkpointId, checkpointType, promptTemplate }` | Checkpoint created, waiting human |
| `workflow.checkpoint_approved` | `{ checkpointId, action, feedback }` | Human approved |
| `workflow.checkpoint_rejected` | `{ checkpointId, action, continuation }` | Human rejected and failure policy dispatch selected a reject path |
| `workflow.checkpoint_skipped` | `{ checkpointId, action, continuation }` | Human skipped the checkpoint |
| `workflow.checkpoint_modified` | `{ checkpointId, action, modifiedData }` | Human approved with modifications |
| `workflow.checkpoint_timeout` | `{ checkpointId, action, continuation }` | Timeout continuation fired |

### Agent Events

| Event | Payload | When |
|-------|---------|------|
| `agent.request` | `{ agentId, prompt }` | Before agent delegation |
| `agent.response` | `{ agentId, content, markers }` | After agent responds |

### Subscribing to Events

```javascript
// Subscribe to a specific event
const unsub = kernel.onEvent('workflow.completed', (event) => {
  console.log('Workflow done:', event.payload.outputs);
});

// Subscribe to all events
kernel.onEvent('*', (event) => {
  console.log(`[${event.type}]`, event.payload);
});

// Unsubscribe
unsub();
```

---

## Error Codes

### Kernel Error Types

| Error | Thrown By | Description | Handling |
|-------|-----------|-------------|----------|
| `CheckpointPauseError` | `WorkflowKernel._executeStep` | Expected pause when a checkpoint step is reached. **Not a failure.** | Catch and present checkpoint UI to user. |
| `StateTransitionError` | `StateMachine.transition` | Invalid state machine transition attempted. | Check `error.context.from` and `error.context.to`. |
| `ExpressionError` | `ExpressionEngine.evaluate` | Invalid expression syntax or evaluation failure. | Check `error.context.expression` and `error.context.path`. |
| `CancellationError` | `parallelGroupStep` | Sub-step cancelled due to `cancelAll` failure policy. | Inspect parallel group results for partial completion. |

### Common Runtime Errors

| Error Message | Cause | Resolution |
|---------------|-------|------------|
| `Workflow ${id} is already active` | `execute()` called with duplicate workflowId | Use unique workflow IDs or check `getStatus()` first |
| `Workflow ${id} is not active` | `resume()` called on inactive workflow | Check workflow status before resuming |
| `Workflow ${id} is not waiting for checkpoint` | `resume()` called when workflow is `running` | Wait for `checkpoint_pending` event |
| `Unknown step type: ${type}` | Step type not registered in `StepRegistry` | Register handler with `kernel.registerStepType()` |
| `Step type '${type}' is not registered` | `WorkflowValidator` rejects unregistered type | Register all step types before validation |
| `Invalid $ref path: ${path}` | Malformed `$ref` in step input | Ensure path starts with `ctx.` and references valid roots |
| `Checkpoint not found: ${id}` | `resolve()` called with unknown checkpoint ID | Verify checkpoint ID from `checkpoint_pending` event |

---

## Lifecycle Hooks

Register hooks to intercept workflow execution events:

```javascript
// Before each step executes
kernel.registerLifecycleHook('beforeStep', async ({ workflowId, step, record, kernel }) => {
  console.log(`Executing step ${step.id} in workflow ${workflowId}`);
});

// After a checkpoint is resolved
kernel.registerLifecycleHook('afterCheckpoint', async ({ workflowId, checkpointId, action, record }) => {
  console.log(`Checkpoint ${checkpointId} resolved with action: ${action}`);
});

// During crash recovery (before execution resumes)
kernel.registerLifecycleHook('onRecovery', async ({ workflowId, record, kernel }) => {
  // Restore external business state here
});
```

**Hook execution guarantees:**
- Hooks run sequentially in registration order.
- Hook failures are logged but do not block execution.
- `onRecovery` runs before the workflow is re-hydrated and resumed.

---

*Document version: 1.0.0*  
*Generated for WorkflowKernel module in VCPToolBox*
