# WorkflowKernel — VCP Multi-Agent Workflow Kernel

WorkflowKernel is the configuration-driven workflow orchestration engine for VCP ToolBox. It replaces the 5,600+ lines of hardcoded phase classes in `StoryOrchestrator` with declarative configuration (~200 lines), enabling flexible, maintainable, and extensible multi-agent workflows.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Built-in Step Types](#built-in-step-types)
- [Plugin Development Guide](#plugin-development-guide)
- [Configuration Reference](#configuration-reference)
- [Migration Guide](#migration-guide-from-storyorchestrator)
- [API Documentation](#api-documentation)
- [Event Reference](#event-reference)

---

## Features

- **Declarative Workflow Definitions** — Phases and steps described via JSON configuration, not code
- **Extensible Step Registry** — Built-in `agentCall`, `checkpoint`, `guard`, `loop`, `parallelGroup`; custom step types register at runtime
- **State Machine-Driven Execution** — Unified execution states: `idle → running → waiting_checkpoint → completed | failed`
- **Persistence & Crash Recovery** — Execution cursor persists to repository; automatic startup recovery for non-terminal workflows
- **Hot Reload** — Workflow definition files auto-reload in development mode
- **Event Bus** — Generic publish/subscribe for observability, adapters, and external integrations
- **Expression Engine** — Safe condition evaluation without `eval()` for guard steps and conditional logic
- **Retry Policy** — Global and per-step configurable retry with backoff
- **Backward Compatibility** — `StoryEventAdapter` maps kernel events to legacy StoryOrchestrator event schema

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
  agentDispatcher: myAgentDispatcher,    // Required: delegates to AI agents
  stateRepository: myStateRepository,    // Optional: persistence (SQLite, etc.)
  webSocketPusher: myWebSocketPusher,    // Optional: real-time event push
  config: {
    defaultTimeoutMs: 86400000,          // 24h default checkpoint timeout
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
    },
    {
      id: 'plotting',
      name: 'Plot Generation',
      steps: [
        {
          id: 'generatePlot',
          type: 'agentCall',
          agent: 'plotWriter',
          input: {
            world: { $ref: 'ctx.outputs.worldSetting' }
          },
          outputKey: 'plotOutline'
        },
        {
          id: 'qualityGuard',
          type: 'guard',
          condition: 'ctx.steps.generatePlot.outputs.score >= 80',
          onFailure: 'checkpoint'
        }
      ]
    }
  ]
};

// 4. Execute
const result = await kernel.execute('wf-001', definition, { genre: 'sci-fi' });

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

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     WorkflowKernel                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ StateMachine│  │ StepRegistry│  │   RetryPolicy       │  │
│  │             │  │             │  │                     │  │
│  │ idle → run  │  │ agentCall   │  │  maxAttempts: 3     │  │
│  │  → wait_cp  │  │ checkpoint  │  │  backoff: [0,250,1s]│  │
│  │  → completed│  │ guard       │  │                     │  │
│  │  → failed   │  │ loop        │  │                     │  │
│  └─────────────┘  │ parallelGp  │  └─────────────────────┘  │
│                   └─────────────┘                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  EventBus   │  │CheckpointMgr│  │  ExpressionEngine   │  │
│  │             │  │             │  │                     │  │
│  │ publish()   │  │ create()    │  │  ctx.steps.x >= 90  │  │
│  │ subscribe() │  │ resolve()   │  │  safe, no eval()    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│  Persistence  │   │  WebSocketPush  │   │  StoryEventAdpt │
│  (SQLite)     │   │  (real-time)    │   │  (legacy compat)│
└───────────────┘   └─────────────────┘   └─────────────────┘
```

### Core Components

| Component | Responsibility | File |
|-----------|--------------|------|
| `WorkflowKernel` | Main orchestrator: executes workflows, manages active instances, dispatches steps | `core/WorkflowKernel.js` |
| `StateMachine` | Execution-state transitions only (not business-state) | `core/StateMachine.js` |
| `StepRegistry` | Runtime registry of step type handlers | `core/StepRegistry.js` |
| `RetryPolicy` | Global + per-step retry with configurable backoff | `core/RetryPolicy.js` |
| `EventBus` | Generic pub/sub for all kernel events | `core/EventBus.js` |
| `CheckpointManager` | Checkpoint lifecycle: create, resolve, timeout, auto-approve | `core/CheckpointManager.js` |
| `ExpressionEngine` | Safe expression evaluator for guard conditions | `core/ExpressionEngine.js` |
| `RecoveryManager` | Startup crash recovery for non-terminal workflows | `core/RecoveryManager.js` |
| `HotReloadManager` | Dev-mode file watching for workflow definitions | `core/HotReloadManager.js` |
| `WorkflowValidator` | Validates definitions: schema, IDs, $ref paths, registered types | `validators/WorkflowValidator.js` |

### Persistence Layer

| Component | Responsibility | File |
|-----------|--------------|------|
| `WorkflowStateRepository` | Abstract interface for state persistence | `persistence/WorkflowStateRepository.js` |
| `StoryStateRepositoryAdapter` | Bridges kernel to existing StoryOrchestrator tables | `persistence/StoryStateRepositoryAdapter.js` |

### Built-in Steps

| Step | Responsibility | File |
|------|--------------|------|
| `agentCallStep` | Delegates to AI agent via AgentDispatcher | `steps/AgentCallStep.js` |
| `checkpointStep` | Pauses workflow for human approval | `steps/CheckpointStep.js` |
| `guardStep` | Conditional evaluation with failure actions | `steps/GuardStep.js` |
| `loopStep` | Repeats sub-steps until condition met | `steps/LoopStep.js` |
| `parallelGroupStep` | Executes sub-steps in parallel | `steps/ParallelGroupStep.js` |

---

## Built-in Step Types

### `agentCall`

Delegates to an AI agent via the configured `AgentDispatcher`.

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
  }
}
```

### `checkpoint`

Pauses workflow execution pending human approval.

```javascript
{
  id: 'reviewDraft',
  type: 'checkpoint',
  promptTemplate: 'Please review the draft and approve to continue.',
  timeoutMs: 86400000,               // Auto-approve after 24h
  autoContinueOnTimeout: true,       // true = auto-approve, false = fail
  onCheckpointReject: 'retry'        // 'retry' | 'rollback'
}
```

### `guard`

Evaluates a condition expression; fails or creates checkpoint on violation.

```javascript
{
  id: 'qualityCheck',
  type: 'guard',
  condition: 'ctx.steps.review.outputs.score >= 80',
  onFailure: 'checkpoint'            // 'retry' | 'fail' | 'checkpoint'
}
```

### `loop`

Repeatedly executes sub-steps until `shouldContinue` returns false or `maxIterations` is reached.

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

> **Note:** `shouldContinue` is injected via `kernel.config.shouldContinue` or `step.shouldContinue`.

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

---

## Plugin Development Guide

### Registering a Custom Step Type

Any module can register a custom step handler with the kernel:

```javascript
// myPlugin/steps/TranslateStep.js
async function translateStep(step, stepContext) {
  const { kernel, context } = stepContext;

  // Access resolved inputs
  const text = step.input?.text || '';
  const targetLang = step.input?.targetLang || 'en';

  // Call external service or internal utility
  const result = await kernel.agentDispatcher.delegate('translator', `Translate to ${targetLang}: ${text}`);

  // Return standard StepResult shape
  return {
    status: 'completed',           // 'completed' | 'waiting_checkpoint' | 'failed' | 'skipped'
    output: { translated: result.content }
  };
}

module.exports = { translateStep };
```

```javascript
// myPlugin/index.js
const { translateStep } = require('./steps/TranslateStep');

function register(kernel) {
  kernel.registerStepType('translate', translateStep);
}

module.exports = { register };
```

### Step Handler Contract

A step handler is an `async function(step, stepContext)` that returns a `StepResult`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `string` | Yes | `'completed'`, `'waiting_checkpoint'`, `'failed'`, or `'skipped'` |
| `output` | `any` | No | Result data stored at `context.outputs[step.outputKey]` |
| `checkpoint` | `Object` | No | Required when `status === 'waiting_checkpoint'` |
| `error` | `Error` | No | Required when `status === 'failed'` |

### StepContext Shape

```javascript
{
  workflowId: 'wf-001',            // Current workflow ID
  step: { /* step definition */ }, // The step being executed
  context: {
    inputs: { /* initialContext */ },
    outputs: { /* accumulated outputs */ },
    steps: { /* step execution records */ }
  },
  kernel: {/* WorkflowKernel instance */}  // Access registry, config, events
}
```

### Using $ref for Input Resolution

The kernel provides `resolveInput()` in `AgentCallStep` for dereferencing:

```javascript
const { resolveInput } = require('./modules/workflowKernel/steps/AgentCallStep');

// In your custom step:
const resolved = resolveInput(step.input, context);
// { $ref: 'ctx.outputs.worldSetting' } → actual value from context
```

### Publishing Events from Custom Steps

```javascript
kernel.eventBus.publish('myPlugin.custom_event', {
  workflowId,
  stepId: step.id,
  payload: { customData: true }
});
```

### Best Practices

1. **Idempotency**: Design steps to be safe to replay on crash recovery
2. **Error Handling**: Always return `{ status: 'failed', error }` rather than throwing uncaught exceptions
3. **Output Keys**: Use `outputKey` in the step definition so downstream steps can reference your output via `$ref`
4. **Timeouts**: Respect `kernel.config.defaultTimeoutMs` for long-running operations
5. **Validation**: Validate your step's `config` object early and return clear errors

---

## Configuration Reference

### Kernel Constructor Config

```javascript
{
  defaultTimeoutMs: 86400000,       // Default checkpoint timeout (24h)
  maxConcurrentWorkflows: 100,      // Max active workflows in memory
  globalRetryPolicy: {
    maxAttempts: 3,                 // Default retry attempts
    backoffDelays: [0, 250, 1000]   // Delays in ms between attempts
  },
  shouldContinue: (context) => boolean  // Loop continuation callback
}
```

### Environment Variables

Set in `config.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_WORKFLOW_KERNEL` | `false` | Feature flag to route StoryOrchestrator traffic through kernel |
| `WORKFLOW_HOT_RELOAD` | `false` | Enable dev-mode file watching for workflow definitions |

### Workflow Definition Schema

```javascript
{
  id: 'my-workflow',                // Required: unique identifier
  version: '1.0.0',                 // Optional: semantic version
  phases: [                         // Required: at least one phase
    {
      id: 'phase1',                 // Required: phase identifier
      name: 'Phase One',            // Optional: human-readable name
      steps: [                      // Required: ordered steps
        {
          id: 'step1',              // Required: unique step ID
          type: 'agentCall',        // Required: registered step type
          outputKey: 'result',      // Optional: key for context.outputs
          input: { /* ... */ },     // Optional: input mapping
          config: { /* ... */ },    // Optional: step-specific config
          retryPolicy: {            // Optional: per-step override
            maxAttempts: 5,
            backoffDelays: [0, 500, 2000]
          }
        }
      ]
    }
  ],
  globalRetryPolicy: { /* ... */ }, // Optional: global retry defaults
  onFailure: 'checkpoint'           // Optional: global failure strategy
}
```

### Checkpoint Config

```javascript
{
  type: 'generic',                  // Checkpoint classification
  promptTemplate: 'Review...',      // Human-facing prompt
  timeoutMs: 3600000,               // Auto-approve timeout
  autoContinueOnTimeout: true,      // Auto-approve on timeout?
  onCheckpointReject: 'retry',      // Action on rejection
  metadata: { /* ... */ }           // Arbitrary metadata
}
```

---

## Migration Guide (from StoryOrchestrator)

### Concept Mapping

| StoryOrchestrator | WorkflowKernel |
|-------------------|----------------|
| `Phase1WorldBuilder` | Phase with `agentCall` steps |
| `Phase2PlotEngine` | Phase with `agentCall` + `guard` steps |
| `Phase3ChapterWriter` | Phase with `loop` of `agentCall` steps |
| `checkpoint()` hardcoded call | `checkpoint` step in definition |
| `story.workflow` state object | `context` passed through steps |
| `story.workflow.worldSetting` | `context.outputs.worldSetting` |
| Direct function calls | `StepRegistry` dispatched handlers |

### Step-by-Step Migration

#### 1. Extract Phase Logic to Configuration

**Before (StoryOrchestrator):**
```javascript
class Phase1WorldBuilder {
  async execute(story) {
    const world = await this.agentDispatcher.delegate('worldBuilder', story.prompt);
    story.workflow.worldSetting = world;
    await this.checkpoint('Review world setting');
    // ... more logic
  }
}
```

**After (WorkflowKernel):**
```javascript
const definition = {
  id: 'story-workflow',
  phases: [
    {
      id: 'worldbuilding',
      steps: [
        { id: 'genWorld', type: 'agentCall', agent: 'worldBuilder', outputKey: 'worldSetting' },
        { id: 'cpWorld', type: 'checkpoint', promptTemplate: 'Review world setting' }
      ]
    }
  ]
};
```

#### 2. Replace State Access with $ref

**Before:**
```javascript
const plot = await plotEngine.generate(story.workflow.worldSetting);
```

**After:**
```javascript
{ id: 'genPlot', type: 'agentCall', agent: 'plotEngine',
  input: { world: { $ref: 'ctx.outputs.worldSetting' } } }
```

#### 3. Replace Conditionals with Guard Steps

**Before:**
```javascript
if (story.workflow.qualityScore < 80) {
  await this.retryPhase();
}
```

**After:**
```javascript
{ id: 'qualityGuard', type: 'guard',
  condition: 'ctx.steps.genPlot.outputs.score >= 80',
  onFailure: 'checkpoint' }
```

#### 4. Enable the Feature Flag

In `config.env`:
```
USE_WORKFLOW_KERNEL=true
```

The `StoryEventAdapter` ensures existing frontend consumers continue receiving events in the legacy format during migration.

#### 5. Gradual Rollout

1. Keep `USE_WORKFLOW_KERNEL=false` (default)
2. Test new workflows in isolation with the kernel
3. Enable flag for a subset of stories
4. Monitor metrics via `kernel.onEvent('workflow.*', handler)`
5. Full cutover when validation passes

---

## API Documentation

See [docs/API.md](./docs/API.md) for complete public API reference including:

- `WorkflowKernel` — constructor, `execute()`, `resume()`, `getStatus()`, `onEvent()`, `registerStepType()`
- `StateMachine` — transitions, history, terminal states
- `StepRegistry` — runtime registration
- `RetryPolicy` — global and per-step resolution
- `WorkflowStateRepository` — persistence interface
- `WorkflowDefinitionSchema` — validation
- `ExpressionEngine` — safe expression evaluation
- `CheckpointManager` — checkpoint lifecycle
- `EventBus` — pub/sub
- `RecoveryManager` — crash recovery
- `HotReloadManager` — dev-mode reloading

---

## Event Reference

### Lifecycle Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.started` | `{ definitionRef, initialContext }` | Workflow begins execution |
| `workflow.completed` | `{ outputs }` | All steps completed successfully |
| `workflow.failed` | `{ error, failedStepId }` | Step failure or invalid transition |

### Step Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.step_started` | `{ stepId, stepType, phaseId }` | Before step handler invoked |
| `workflow.step_completed` | `{ stepId, stepType, outputKey }` | Step returns `completed` |
| `workflow.step_failed` | `{ stepId, stepType, error }` | Step returns `failed` |

### Checkpoint Events

| Event | Payload | When |
|-------|---------|------|
| `workflow.checkpoint_pending` | `{ checkpointId, checkpointType, promptTemplate }` | Checkpoint created, waiting human |
| `workflow.checkpoint_approved` | `{ checkpointId, action, feedback }` | Human approved or auto-approved |
| `workflow.checkpoint_rejected` | `{ checkpointId, action }` | Human rejected |
| `workflow.checkpoint_auto_approved` | `{ checkpointId }` | Timeout auto-approval |

### Agent Events

| Event | Payload | When |
|-------|---------|------|
| `agent.request` | `{ agentId, prompt }` | Before agent delegation |
| `agent.response` | `{ agentId, content, markers }` | After agent responds |

### Subscribing to All Events

```javascript
kernel.onEvent('*', (event) => {
  console.log(`[${event.type}]`, event.payload);
});
```

---

## Files

```
modules/workflowKernel/
├── README.md                          # This file
├── index.js                           # Public exports
├── core/
│   ├── WorkflowKernel.js              # Main orchestrator
│   ├── StateMachine.js                # Execution state transitions
│   ├── StepRegistry.js                # Extensible step type registry
│   ├── RetryPolicy.js                 # Retry/backoff policy
│   ├── EventBus.js                    # Generic pub/sub
│   ├── CheckpointManager.js           # Checkpoint lifecycle
│   ├── ExpressionEngine.js            # Safe expression evaluator
│   ├── RecoveryManager.js             # Crash recovery
│   └── HotReloadManager.js            # Dev-mode file watching
├── steps/
│   ├── AgentCallStep.js               # Agent delegation step
│   ├── CheckpointStep.js              # Human checkpoint step
│   ├── GuardStep.js                   # Conditional guard step
│   ├── LoopStep.js                    # Iteration step
│   └── ParallelGroupStep.js          # Parallel execution step
├── persistence/
│   ├── WorkflowStateRepository.js     # Abstract persistence interface
│   └── StoryStateRepositoryAdapter.js # Legacy table adapter
├── types/
│   └── WorkflowDefinition.js          # Schema + type definitions
├── validators/
│   └── WorkflowValidator.js           # Definition validation
├── adapters/
│   └── StoryEventAdapter.js           # Legacy event compatibility
└── docs/
    ├── API.md                         # Complete API reference
    ├── agent-dispatcher-contract.md   # AgentDispatcher interface
    ├── event-compatibility-strategy.md # Event mapping details
    ├── novel-workflow-orchestrator-pitfalls.md # Design notes
    └── orchestration-asset-ruling.md  # Asset governance
```
