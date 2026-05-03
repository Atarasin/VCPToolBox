# WorkflowKernel API Reference

Complete public API reference for the VCP WorkflowKernel and all exported components.

---

## Table of Contents

- [WorkflowKernel](#workflowkernel)
- [StateMachine](#statemachine)
- [StepRegistry](#stepregistry)
- [RetryPolicy](#retrypolicy)
- [WorkflowStateRepository](#workflowstaterepository)
- [WorkflowDefinitionSchema](#workflowdefinitionschema)
- [ExpressionEngine](#expressionengine)
- [CheckpointManager](#checkpointmanager)
- [EventBus](#eventbus)
- [RecoveryManager](#recoverymanager)
- [HotReloadManager](#hotreloadmanager)
- [WorkflowValidator](#workflowvalidator)
- [StoryEventAdapter](#storyeventadapter)
- [Built-in Steps](#built-in-steps)
- [Error Types](#error-types)

---

## WorkflowKernel

Main orchestrator entry point. Manages workflow execution, state transitions, and step dispatch.

**File:** `core/WorkflowKernel.js`

### Constructor

```javascript
new WorkflowKernel({ agentDispatcher, stateRepository, webSocketPusher, config })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentDispatcher` | `Object` | Yes | Must implement `delegate(agentId, prompt, options)` |
| `stateRepository` | `WorkflowStateRepository` | No | Persistence adapter for workflow state |
| `webSocketPusher` | `Object` | No | Must implement `push(workflowId, event)` for real-time events |
| `config` | `Object` | No | Kernel configuration (see below) |

**Config options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultTimeoutMs` | `number` | `86400000` | Default checkpoint timeout (24h) |
| `maxConcurrentWorkflows` | `number` | `100` | Max active workflows in memory |
| `globalRetryPolicy` | `Object` | `{ maxAttempts: 3, backoffDelays: [0, 250, 1000] }` | Default retry configuration |
| `shouldContinue` | `function` | `undefined` | Loop continuation callback: `(context) => boolean` |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `stepRegistry` | `StepRegistry` | Runtime step type registry |
| `retryPolicy` | `RetryPolicy` | Retry policy resolver |
| `eventBus` | `EventBus` | Generic event bus instance |
| `activeWorkflows` | `Map<string, ActiveWorkflow>` | In-memory active workflow instances |
| `config` | `Object` | Resolved configuration |

### Methods

#### `registerStepType(name, handler)`

Registers a custom step type handler.

```javascript
kernel.registerStepType('translate', async (step, stepContext) => {
  return { status: 'completed', output: { result: 'translated' } };
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Unique step type identifier |
| `handler` | `function` | `async (step, stepContext) => StepResult` |

---

#### `execute(workflowId, definition, initialContext)`

Starts a new workflow execution.

```javascript
const record = await kernel.execute('wf-001', definition, { genre: 'sci-fi' });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowId` | `string` | Unique workflow identifier |
| `definition` | `WorkflowDefinition` | Workflow definition object |
| `initialContext` | `Object` | Initial input data available as `ctx.inputs` |

**Returns:** `Promise<WorkflowRecord>`

```javascript
{
  workflowId: 'wf-001',
  definitionRef: 'my-workflow',
  status: 'running',
  executionCursor: [{ phase: 0 }, { step: 1 }],
  context: {
    inputs: { genre: 'sci-fi' },
    outputs: { worldSetting: '...' },
    steps: {
      genWorld: { status: 'completed', outputs: '...', error: null }
    }
  },
  checkpointState: null,
  retryContext: {},
  history: [],
  runToken: '1234567890_abcdefgh',
  createdAt: '2026-04-30T12:00:00.000Z',
  updatedAt: '2026-04-30T12:00:00.000Z'
}
```

**Throws:**
- `Error` — If `workflowId` is already active

---

#### `resume(workflowId, checkpointResponse)`

Resumes a workflow paused at a checkpoint.

```javascript
await kernel.resume('wf-001', {
  checkpointId: 'cp-123',
  action: 'approve',
  feedback: 'Proceed with current draft'
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowId` | `string` | Active workflow identifier |
| `checkpointResponse` | `CheckpointResponse` | Human response to checkpoint |

**Throws:**
- `Error` — If workflow is not active or not in `waiting_checkpoint` state

---

#### `getStatus(workflowId)`

Retrieves current workflow status from memory or persistence.

```javascript
const status = await kernel.getStatus('wf-001');
// { workflowId, state, executionCursor, context, checkpointState }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowId` | `string` | Workflow identifier |

**Returns:** `Promise<Object|null>` — Status object or `null` if not found

---

#### `onEvent(eventType, handler)`

Subscribes to kernel events. Returns an unsubscribe function.

```javascript
const unsubscribe = kernel.onEvent('workflow.completed', (event) => {
  console.log('Workflow done:', event.payload.outputs);
});

// Later: unsubscribe();
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type or `'*'` for all events |
| `handler` | `function` | `(event: KernelEvent) => void` |

**Returns:** `function` — Call to unsubscribe

---

## StateMachine

Execution-state machine. Manages execution-state transitions only; business-state (phase1/2/3) is plugin-owned.

**File:** `core/StateMachine.js`

### States

```javascript
const { EXECUTION_STATES } = require('./modules/workflowKernel');

// IDLE → RUNNING → WAITING_CHECKPOINT → COMPLETED
//                         ↓
//                   RETRYING → FAILED
//                         ↓
//                   RECOVERING → RUNNING
```

| State | Description |
|-------|-------------|
| `idle` | Initial state before execution |
| `running` | Actively executing steps |
| `waiting_checkpoint` | Paused for human checkpoint approval |
| `retrying` | Retry in progress after step failure |
| `recovering` | Crash recovery in progress |
| `completed` | Terminal: all steps succeeded |
| `failed` | Terminal: step failure or unrecoverable error |

### Constructor

```javascript
new StateMachine(initialState)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `initialState` | `string` | `EXECUTION_STATES.IDLE` | Starting state |

### Methods

#### `getState()`

Returns current state string.

**Returns:** `string`

---

#### `canTransition(toState)`

Checks if a transition is valid from current state.

```javascript
if (sm.canTransition(EXECUTION_STATES.RUNNING)) {
  sm.transition(EXECUTION_STATES.RUNNING, 'resume');
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `toState` | `string` | Target state |

**Returns:** `boolean`

---

#### `transition(toState, reason)`

Performs a state transition. Throws `StateTransitionError` if invalid.

```javascript
sm.transition(EXECUTION_STATES.RUNNING, 'checkpoint_resumed');
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `toState` | `string` | Target state |
| `reason` | `string` | Human-readable transition reason |

**Returns:** `TransitionRecord` — `{ from, to, reason, timestamp }`

**Throws:** `StateTransitionError`

---

#### `isTerminal()`

Checks if current state is terminal (`completed` or `failed`).

**Returns:** `boolean`

---

#### `isActive()`

Checks if current state is active (not idle and not terminal).

**Returns:** `boolean`

---

#### `getHistory()`

Returns immutable copy of transition history.

**Returns:** `Array<TransitionRecord>`

---

## StepRegistry

Extensible step type registry. Plugins register custom step handlers at runtime.

**File:** `core/StepRegistry.js`

### Constructor

```javascript
new StepRegistry()
```

### Methods

#### `register(name, handler)`

Registers a step type handler.

```javascript
registry.register('agentCall', agentCallStep);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | `string` | Step type name (non-empty) |
| `handler` | `function` | `async (step, stepContext) => StepResult` |

**Throws:** `Error` — If name is empty or handler is not a function

---

#### `get(name)`

Retrieves a registered handler.

**Returns:** `function|undefined`

---

#### `has(name)`

Checks if a step type is registered.

**Returns:** `boolean`

---

#### `list()`

Returns all registered step type names.

**Returns:** `Array<string>`

---

#### `unregister(name)`

Removes a registered step type.

**Returns:** `boolean` — `true` if removed, `false` if not found

---

## RetryPolicy

Retry policy with global defaults and step-level override.

**File:** `core/RetryPolicy.js`

### Constructor

```javascript
new RetryPolicy(globalConfig)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `globalConfig.maxAttempts` | `number` | `3` | Default max retry attempts |
| `globalConfig.backoffDelays` | `Array<number>` | `[0, 250, 1000]` | Delay in ms between attempts |

### Methods

#### `resolve(stepConfig)`

Resolves effective retry policy for a step, merging step-level override with global defaults.

```javascript
const policy = retryPolicy.resolve({ retryPolicy: { maxAttempts: 5 } });
// { maxAttempts: 5, backoffDelays: [0, 250, 1000] }
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `stepConfig` | `Object` | Step definition (may contain `retryPolicy` override) |

**Returns:** `{ maxAttempts: number, backoffDelays: number[] }`

---

#### `shouldRetry(attempt, error, policy)`

Determines if another retry should be attempted.

| Parameter | Type | Description |
|-----------|------|-------------|
| `attempt` | `number` | Current attempt number (0-based) |
| `error` | `Error` | The error that caused failure |
| `policy` | `Object` | Resolved policy from `resolve()` |

**Returns:** `{ shouldRetry: boolean, reason: string }`

---

#### `getDelay(attempt, policy)`

Returns delay in ms before the next retry attempt.

| Parameter | Type | Description |
|-----------|------|-------------|
| `attempt` | `number` | Current attempt number |
| `policy` | `Object` | Resolved policy |

**Returns:** `number` — Milliseconds to wait

---

## WorkflowStateRepository

Abstract interface for workflow state persistence. Implement this to add custom backends.

**File:** `persistence/WorkflowStateRepository.js`

### Interface Methods

All methods are `async` and must be implemented by subclasses.

#### `create(workflowId, definitionRef, initialContext)`

Creates a new workflow record.

**Returns:** `Promise<WorkflowRecord>`

---

#### `get(workflowId)`

Retrieves a workflow record by ID.

**Returns:** `Promise<Object|null>`

---

#### `update(workflowId, patch)`

Partially updates a workflow record using deep-merge semantics.

| Parameter | Type | Description |
|-----------|------|-------------|
| `patch` | `Object` | Fields to update: `status`, `executionCursor`, `context`, `checkpointState`, `retryContext`, `runToken` |

**Returns:** `Promise<void>`

---

#### `appendHistory(workflowId, event)`

Appends an event to workflow history.

**Returns:** `Promise<void>`

---

#### `listActive()`

Lists all active (non-terminal) workflows.

**Returns:** `Promise<Array<WorkflowRecord>>`

---

### Built-in Adapters

| Adapter | Description | File |
|---------|-------------|------|
| `StoryStateRepositoryAdapter` | Bridges to existing StoryOrchestrator SQLite tables | `persistence/StoryStateRepositoryAdapter.js` |

---

## WorkflowDefinitionSchema

Minimal schema validator for workflow definitions.

**File:** `types/WorkflowDefinition.js`

### Static Methods

#### `WorkflowDefinitionSchema.validate(definition)`

Validates a workflow definition. Throws on validation failure.

```javascript
try {
  WorkflowDefinitionSchema.validate(definition);
} catch (err) {
  console.error(err.validationErrors);
  // ['Step must have a non-empty string id', ...]
}
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `definition` | `WorkflowDefinition` | Workflow definition to validate |

**Returns:** `true` — On success

**Throws:** `Error` — With `.validationErrors` array on failure

---

## ExpressionEngine

Minimal safe expression evaluator. Supports fixed field access and explicit comparison operators. No `eval()`, no function calls, no arithmetic.

**File:** `core/ExpressionEngine.js`

### Supported Syntax

```
ctx.steps.stepId.outputs.field >= 90
ctx.inputs.genre == "sci-fi"
ctx.steps.review.outputs.score != null
ctx.outputs.result == true
```

**Operators:** `>=`, `<=`, `==`, `!=`, `>`, `<`

**Literals:** numbers, quoted strings, `null`, `undefined`, `true`, `false`

### Constructor

```javascript
new ExpressionEngine()
```

### Methods

#### `evaluate(expression, context)`

Evaluates an expression against a context object.

```javascript
const engine = new ExpressionEngine();
const context = {
  steps: { review: { outputs: { score: 92 } } }
};
engine.evaluate('ctx.steps.review.outputs.score >= 90', context); // true
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `expression` | `string` | Expression string |
| `context` | `Object` | Context object (must contain paths referenced) |

**Returns:** `boolean`

**Throws:** `ExpressionError`

---

## CheckpointManager

Manages checkpoint lifecycle: creation, resolution, timeout, and auto-approval.

**File:** `core/CheckpointManager.js`

### Constructor

```javascript
new CheckpointManager(config)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.defaultTimeoutMs` | `number` | `86400000` | Default checkpoint timeout |
| `config.checkpointPollIntervalMs` | `number` | `60000` | Poll interval for timeout checks |

### Methods

#### `create(workflowId, checkpointConfig)`

Creates a new checkpoint.

```javascript
const checkpoint = await cpManager.create('wf-001', {
  id: 'reviewDraft',
  type: 'human_review',
  promptTemplate: 'Please review the draft',
  timeoutMs: 3600000,
  autoContinueOnTimeout: true,
  onCheckpointReject: 'retry'
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowId` | `string` | Owning workflow |
| `checkpointConfig` | `Object` | Checkpoint configuration |

**Returns:** `Promise<Checkpoint>`

```javascript
{
  checkpointId: 'cp-1234567890-abcdef',
  workflowId: 'wf-001',
  type: 'human_review',
  promptTemplate: 'Please review the draft',
  status: 'pending',
  createdAt: '2026-04-30T12:00:00.000Z',
  expiresAt: '2026-04-30T13:00:00.000Z',
  autoContinueOnTimeout: true,
  onCheckpointReject: 'retry',
  metadata: { /* ... */ }
}
```

---

#### `resolve(checkpointId, action, response)`

Resolves a pending checkpoint.

```javascript
await cpManager.resolve('cp-123', 'approve', { feedback: 'Looks good' });
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `checkpointId` | `string` | Checkpoint identifier |
| `action` | `string` | `'approve'`, `'reject'`, `'skip'`, or `'modify'` |
| `response` | `Object` | Optional `{ feedback, modifiedData }` |

**Returns:** `Promise<Checkpoint>` — Resolved checkpoint

**Throws:** `Error` — If checkpoint not found or already resolved

---

#### `get(checkpointId)`

Retrieves a pending checkpoint.

**Returns:** `Checkpoint|null`

---

#### `listPending()`

Lists all pending checkpoints.

**Returns:** `Array<Checkpoint>`

---

#### `destroy()`

Cleans up polling timer and active checkpoints. Call on shutdown.

---

## EventBus

Generic publish/subscribe for kernel events.

**File:** `core/EventBus.js`

### Constructor

```javascript
new EventBus()
```

### Methods

#### `subscribe(eventType, handler)`

Subscribes to an event type. Returns unsubscribe function.

```javascript
const unsub = eventBus.subscribe('workflow.completed', (event) => {
  console.log('Done:', event.workflowId);
});
unsub(); // Unsubscribe
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type or `'*'` for wildcard |
| `handler` | `function` | `(payload: Object) => void` |

**Returns:** `function` — Unsubscribe function

---

#### `unsubscribe(eventType, handler)`

Removes a specific handler.

---

#### `publish(eventType, payload)`

Publishes an event to all subscribers. Wildcard (`*`) subscribers receive all events.

```javascript
eventBus.publish('workflow.started', {
  workflowId: 'wf-001',
  timestamp: new Date().toISOString(),
  payload: { definitionRef: 'my-workflow' }
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type |
| `payload` | `Object` | Event payload |

---

#### `clear()`

Removes all subscribers.

---

## RecoveryManager

Handles startup crash recovery for workflows.

**File:** `core/RecoveryManager.js`

### Constructor

```javascript
new RecoveryManager(workflowKernel, stateRepository)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `workflowKernel` | `WorkflowKernel` | Kernel instance |
| `stateRepository` | `WorkflowStateRepository` | State repository |

### Methods

#### `startupRecovery()`

Scans all active workflows and attempts recovery.

```javascript
const { recovered, failed } = await recoveryManager.startupRecovery();
console.log(`Recovered: ${recovered.length}, Failed: ${failed.length}`);
```

**Returns:** `Promise<{ recovered: Array, failed: Array }>`

**Recovery actions:**

| Action | Description |
|--------|-------------|
| `resume_from_cursor` | Safe to resume from current position |
| `resume_from_safe_boundary` | Rolled back to last safe (idempotent) step |
| `marked_idle` | No execution cursor — marked idle |
| `marked_failed` | No safe boundary found — marked failed |

**Safe-to-resume step types:** `checkpoint`, `guard`, `noop`
**Non-idempotent step types:** `agentCall`

---

## HotReloadManager

Watches workflow definition files for changes in development mode.

**File:** `core/HotReloadManager.js`

### Constructor

```javascript
new HotReloadManager(config)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.hotReload` | `boolean` | `false` | Enable hot reload |
| `config.watchPaths` | `Array<string>` | `[]` | Paths to watch |
| `config.validator` | `WorkflowValidator` | `null` | Validator for reloaded files |

### Methods

#### `start()`

Starts file watchers. Only effective if `hotReload` is enabled.

---

#### `stop()`

Stops all file watchers.

---

#### `onReload(callback)`

Registers a callback for reload events.

```javascript
hotReloadManager.onReload((filePath, definition) => {
  console.log('Reloaded:', filePath);
});
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `callback` | `function` | `(filePath: string, definition: Object) => void` |

---

## WorkflowValidator

Validates workflow definitions beyond basic schema checks.

**File:** `validators/WorkflowValidator.js`

### Constructor

```javascript
new WorkflowValidator(stepRegistry)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `stepRegistry` | `StepRegistry` | Registry to check step type registration against |

### Methods

#### `validate(definition)`

Performs comprehensive validation.

```javascript
const validator = new WorkflowValidator(kernel.stepRegistry);
const result = validator.validate(definition);
if (!result.valid) {
  console.error(result.errors);
}
```

**Validations performed:**

1. Schema validation (id, phases, steps)
2. Step ID format (valid JavaScript identifiers)
3. OutputKey format
4. Step type registration (if `stepRegistry` provided)
5. `$ref` path syntax and reachability

**Returns:** `{ valid: boolean, errors: string[] }`

---

## StoryEventAdapter

Maps kernel generic events to StoryOrchestrator legacy events.

**File:** `adapters/StoryEventAdapter.js`

### Constructor

```javascript
new StoryEventAdapter(eventSink)
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `eventSink` | `Object` | Must implement `push(workflowId, event)` |

### Methods

#### `registerWorkflow(workflowId, definition)`

Registers a workflow for phase metadata tracking.

```javascript
adapter.registerWorkflow('wf-001', definition);
```

---

#### `onKernelEvent(workflowId, event)`

Maps and emits a kernel event in legacy format.

```javascript
kernel.onEvent('*', (event) => {
  adapter.onKernelEvent(event.workflowId, event);
});
```

**Legacy event mappings:**

| Kernel Event | Legacy Events |
|--------------|---------------|
| `workflow.started` | `workflow_started` |
| `workflow.step_completed` | `phase_completed` (if last step) |
| `workflow.checkpoint_pending` | `checkpoint_created`, `checkpoint_pending` |
| `workflow.checkpoint_approved` | `checkpoint_approved` |
| `workflow.completed` | `workflow_completed`, `final_acceptance` |
| `workflow.failed` | `phase_failed` |

---

## Built-in Steps

### `agentCallStep`

Delegates to an agent via `AgentDispatcher`.

**File:** `steps/AgentCallStep.js`

```javascript
const { agentCallStep } = require('./modules/workflowKernel');

// Step definition:
{
  id: 'callWriter',
  type: 'agentCall',
  agent: 'creativeWriter',
  input: {
    topic: 'Space',
    style: { $ref: 'ctx.inputs.style' }
  },
  outputKey: 'draft',
  options: { timeoutMs: 120000 }
}
```

**Exported utilities:**

| Export | Description |
|--------|-------------|
| `agentCallStep` | Step handler function |
| `resolveRef(refPath, context)` | Resolves a `ctx.*` path against context |
| `resolveInput(input, context)` | Recursively resolves `$ref` objects |

---

### `checkpointStep`

Pauses workflow for human intervention.

**File:** `steps/CheckpointStep.js`

```javascript
{
  id: 'humanReview',
  type: 'checkpoint',
  promptTemplate: 'Please review before continuing',
  timeoutMs: 3600000,
  autoContinueOnTimeout: true,
  onCheckpointReject: 'retry'
}
```

---

### `guardStep`

Conditional checkpoint with failure action.

**File:** `steps/GuardStep.js`

```javascript
{
  id: 'qualityGate',
  type: 'guard',
  condition: 'ctx.steps.review.outputs.score >= 90',
  onFailure: 'checkpoint'     // 'retry' | 'fail' | 'checkpoint'
}
```

---

### `loopStep`

Executes sub-steps repeatedly.

**File:** `steps/LoopStep.js`

```javascript
{
  id: 'refinement',
  type: 'loop',
  maxIterations: 5,
  onMaxIterationsExceeded: 'fail',
  steps: [
    { id: 'critique', type: 'agentCall', agent: 'critic' },
    { id: 'rewrite', type: 'agentCall', agent: 'writer' }
  ]
}
```

---

### `parallelGroupStep`

Executes sub-steps in parallel.

**File:** `steps/ParallelGroupStep.js`

```javascript
{
  id: 'research',
  type: 'parallelGroup',
  failurePolicy: 'waitForRest',   // 'waitForRest' | 'cancelAll' | 'ignore'
  steps: [
    { id: 'sciResearch', type: 'agentCall', agent: 'scienceBot' },
    { id: 'histResearch', type: 'agentCall', agent: 'historyBot' }
  ]
}
```

---

## Error Types

### `CheckpointPauseError`

Thrown when a checkpoint step pauses execution. This is an **expected** error, not a failure.

**File:** `core/WorkflowKernel.js`

```javascript
try {
  await kernel.execute('wf-001', definition);
} catch (error) {
  if (error instanceof CheckpointPauseError) {
    console.log('Waiting for checkpoint:', error.checkpoint.checkpointId);
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `'CheckpointPauseError'` |
| `checkpoint` | `Object` | Checkpoint that caused pause |

---

### `StateTransitionError`

Thrown on invalid state machine transitions.

**File:** `core/StateMachine.js`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `'StateTransitionError'` |
| `context` | `Object` | `{ from, to, reason }` |

---

### `ExpressionError`

Thrown on invalid expression syntax or evaluation failure.

**File:** `core/ExpressionEngine.js`

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | `'ExpressionError'` |
| `context` | `Object` | `{ expression, path, operator }` |

---

## Type Definitions

### WorkflowDefinition

```javascript
{
  id: string,                    // Required
  version: string,               // Optional
  phases: PhaseDefinition[],     // Required
  globalRetryPolicy: Object,     // Optional
  onFailure: string              // Optional
}
```

### PhaseDefinition

```javascript
{
  id: string,                    // Required
  name: string,                  // Optional
  steps: StepDefinition[]        // Required
}
```

### StepDefinition

```javascript
{
  id: string,                    // Required
  type: string,                  // Required
  outputKey: string,             // Optional
  input: Object,                 // Optional
  config: Object,                // Optional
  retryPolicy: Object            // Optional
}
```

### StepResult

```javascript
{
  status: 'completed' | 'waiting_checkpoint' | 'failed' | 'skipped',
  output: any,                   // Optional
  checkpoint: Object,            // Optional (if waiting_checkpoint)
  error: Error                   // Optional (if failed)
}
```

### CheckpointResponse

```javascript
{
  checkpointId: string,          // Required
  action: 'approve' | 'reject' | 'skip' | 'modify',
  feedback: string,              // Optional
  modifiedData: Object           // Optional
}
```

### KernelEvent

```javascript
{
  type: string,                  // Event type
  workflowId: string,            // Source workflow
  timestamp: string,             // ISO 8601
  payload: Object                // Event-specific data
}
```

---

## Complete Export List

```javascript
const {
  WorkflowKernel,           // Main orchestrator
  CheckpointPauseError,     // Expected pause error
  StateMachine,             // Execution state machine
  StateTransitionError,     // Invalid transition error
  EXECUTION_STATES,         // State constants
  StepRegistry,             // Step type registry
  RetryPolicy,              // Retry/backoff policy
  WorkflowStateRepository,  // Persistence interface
  WorkflowDefinitionSchema, // Schema validator
  ExpressionEngine,         // Safe expression evaluator
  ExpressionError,          // Expression evaluation error
  CheckpointManager,        // Checkpoint lifecycle
  EventBus,                 // Generic event bus
  agentCallStep,            // Agent delegation step
  checkpointStep,           // Human checkpoint step
  guardStep,                // Conditional guard step
  loopStep,                 // Iteration step
  parallelGroupStep,        // Parallel execution step
  StoryEventAdapter         // Legacy event adapter
} = require('./modules/workflowKernel');
```
