# WorkflowKernel Authoring Guide

> **Location:** `docs/workflow-authoring-guide.md`  
> **Audience:** Plugin authors who want to build multi-agent workflows using the WorkflowKernel.  
> **Prerequisites:** Basic familiarity with VCPToolBox plugin architecture and the agent dispatcher.  
> **See also:** `docs/workflow-kernel-api.md` (complete API reference), `docs/workflow-migration-guide.md` ( migrating from StoryOrchestrator)

---

## Table of Contents

- [What Is the WorkflowKernel?](#what-is-the-workflowkernel)
- [Your First Workflow: A 3-Step Research Pipeline](#your-first-workflow-a-3-step-research-pipeline)
- [Step Types Explained](#step-types-explained)
  - [agentCall](#agentcall)
  - [checkpoint](#checkpoint)
  - [guard](#guard)
  - [loop](#loop)
  - [parallelGroup](#parallelgroup)
- [Wiring Data with `$ref`](#wiring-data-with-ref)
- [Error Handling & Retry Configuration](#error-handling--retry-configuration)
- [Registering Custom Step Types](#registering-custom-step-types)
- [Testing Workflows in Isolation](#testing-workflows-in-isolation)
- [Production Readiness Checklist](#production-readiness-checklist)
- [Common Pitfalls](#common-pitfalls)

---

## What Is the WorkflowKernel?

The **WorkflowKernel** is a declarative execution engine for multi-agent pipelines. Instead of writing imperative JavaScript that orchestrates agents one by one, you describe your workflow as a **definition** — a JSON-like structure of phases and steps — and the kernel handles execution, state transitions, checkpoints, retries, and recovery.

**Key concepts:**

| Concept | Description |
|---------|-------------|
| **Workflow Definition** | A declarative JSON object describing phases, steps, and their configurations. |
| **Phase** | A named grouping of steps. Phases run sequentially. |
| **Step** | The smallest unit of work. Each step has a type, ID, input, and optional output key. |
| **Context** | A shared object (`ctx`) holding `inputs`, `outputs`, and `steps` state, accessible via `$ref`. |
| **Checkpoint** | A human-in-the-loop pause point. The workflow stops until approved, rejected, or timed out. |

---

## Your First Workflow: A 3-Step Research Pipeline

Below is a complete, runnable workflow definition. It models a simple research pipeline:

1. **Research** — call a research agent to gather information.
2. **Review** — pause for human approval of the gathered data.
3. **Summarize** — call a writer agent to produce a final summary.

```javascript
const {
  WorkflowKernel,
  agentCallStep,
  checkpointStep
} = require('./modules/workflowKernel');

// 1. Create and configure the kernel
const kernel = new WorkflowKernel({
  agentDispatcher: {
    delegate: async (agentId, prompt, options) => {
      // In a real plugin, this delegates to your agent system
      return { content: `Result from ${agentId}: ${prompt}`, markers: [], raw: {} };
    }
  }
});

// 2. Register built-in step types
kernel.registerStepType('agentCall', agentCallStep);
kernel.registerStepType('checkpoint', checkpointStep);

// 3. Define the workflow
const researchWorkflow = {
  id: 'research-pipeline-v1',
  version: '1.0.0',
  phases: [
    {
      id: 'gather',
      name: 'Gather Information',
      steps: [
        {
          id: 'researchTopic',
          type: 'agentCall',
          agent: 'researcher',
          input: {
            prompt: { $ref: 'ctx.inputs.topic' },
            depth: { $ref: 'ctx.inputs.depth' }
          },
          outputKey: 'researchNotes'
        }
      ]
    },
    {
      id: 'review',
      name: 'Human Review',
      steps: [
        {
          id: 'reviewCheckpoint',
          type: 'checkpoint',
          promptTemplate: 'Please review the research notes before summarization.',
          timeoutMs: 3600000,        // 1 hour
          autoContinueOnTimeout: false
        }
      ]
    },
    {
      id: 'synthesize',
      name: 'Synthesize Output',
      steps: [
        {
          id: 'writeSummary',
          type: 'agentCall',
          agent: 'writer',
          input: {
            prompt: 'Summarize the following research notes:',
            notes: { $ref: 'ctx.outputs.researchNotes.content' }
          },
          outputKey: 'finalSummary'
        }
      ]
    }
  ]
};

// 4. Execute the workflow
async function run() {
  const record = await kernel.execute('research-001', researchWorkflow, {
    topic: 'Quantum computing advances in 2026',
    depth: 'comprehensive'
  });

  console.log('Workflow status:', record.status);

  // If waiting at checkpoint, resume later:
  // await kernel.resume('research-001', {
  //   checkpointId: record.checkpointState.checkpointId,
  //   action: 'approve'
  // });
}

run().catch(console.error);
```

**What happens:**

1. `researchTopic` runs immediately, delegating to the `researcher` agent.
2. Its output is stored in `ctx.outputs.researchNotes`.
3. `reviewCheckpoint` pauses the workflow, emitting a `workflow.checkpoint_pending` event.
4. After `kernel.resume()` is called with `action: 'approve'`, the kernel continues.
5. `writeSummary` reads the research notes via `$ref` and delegates to the `writer` agent.

---

## Step Types Explained

The kernel ships with five built-in step types. You register the ones you need via `kernel.registerStepType(name, handler)`.

### agentCall

Delegates to an AI agent via the `agentDispatcher`.

```javascript
{
  id: 'generateWorld',
  type: 'agentCall',
  agent: 'worldBuilder',           // Agent type identifier
  input: {
    genre: 'sci-fi',               // Literal value
    tone: { $ref: 'ctx.inputs.tone' }  // Resolved from context
  },
  outputKey: 'worldSetting',       // Stores result in ctx.outputs.worldSetting
  options: {
    timeoutMs: 30000,              // Delegation timeout
    taskDelegation: true
  },
  extraction: {                    // Optional: structured data extraction
    schema: { summary: 'string', confidence: 'number' },
    requiredFields: ['summary'],
    maxAttempts: 2,
    parserOrder: ['jsonBlock', 'jsonObject']
  }
}
```

**Result shape stored in `ctx.outputs.<outputKey>`:**

```javascript
{
  content: '...',      // Raw agent output
  data: { ... },       // Extracted structured data (if extraction configured)
  meta: { ... },       // Extraction metadata
  markers: [],         // VCP markers
  raw: {}              // Raw response object
}
```

### checkpoint

Pauses the workflow for human review.

```javascript
{
  id: 'humanReview',
  type: 'checkpoint',
  promptTemplate: 'Review the generated outline before proceeding to drafting.',
  timeoutMs: 7200000,              // Optional: auto-approve timeout
  autoContinueOnTimeout: true,     // If true, auto-approves when timeout expires
  onCheckpointReject: 'retry'      // 'retry' | 'rollback'
}
```

**Resume via:**

```javascript
await kernel.resume('workflow-id', {
  checkpointId: '...',
  action: 'approve',    // 'approve' | 'reject' | 'skip' | 'modify'
  feedback: 'Looks good'
});
```

### guard

Evaluates a condition expression. If it fails, applies the configured `onFailure` action.

```javascript
{
  id: 'qualityGate',
  type: 'guard',
  condition: 'ctx.steps.review.outputs.score >= 90',
  onFailure: 'checkpoint'          // 'retry' | 'fail' | 'checkpoint'
}
```

**Expression syntax:**

- Field access: `ctx.steps.stepId.outputs.field`
- Comparisons: `>=`, `<=`, `==`, `!=`, `>`, `<`
- Boolean operators: `&&`, `||`
- Parentheses for grouping: `(a && b) || c`
- Literals: numbers, strings (single/double quotes), `true`, `false`, `null`

**Example expressions:**

```
ctx.steps.review.outputs.score >= 90
ctx.inputs.genre == "sci-fi"
(ctx.steps.a.outputs.valid && ctx.steps.b.outputs.score > 80) || ctx.inputs.override == true
```

> ⚠️ **No arithmetic, no function calls, no assignment.** The expression engine is intentionally restricted for safety.

### loop

Executes sub-steps repeatedly until a `shouldContinue` callback returns `false`.

```javascript
{
  id: 'refinementLoop',
  type: 'loop',
  steps: [
    {
      id: 'polishDraft',
      type: 'agentCall',
      agent: 'editor',
      input: {
        draft: { $ref: 'ctx.outputs.draft.content' }
      },
      outputKey: 'draft'
    },
    {
      id: 'selfReview',
      type: 'agentCall',
      agent: 'critic',
      input: {
        draft: { $ref: 'ctx.outputs.draft.content' }
      },
      outputKey: 'review'
    }
  ],
  maxIterations: 5,
  onMaxIterationsExceeded: 'checkpoint'   // 'fail' | 'checkpoint'
}
```

**The `shouldContinue` callback** is supplied at kernel configuration time or as a step property:

```javascript
const kernel = new WorkflowKernel({
  agentDispatcher: dispatcher,
  config: {
    shouldContinue: (context) => {
      const review = context.outputs.review;
      return review && review.score < 90;  // Keep polishing until score >= 90
    }
  }
});
```

If no `shouldContinue` is provided, the loop runs exactly once.

### parallelGroup

Executes sub-steps in parallel via `Promise.all`.

```javascript
{
  id: 'parallelResearch',
  type: 'parallelGroup',
  failurePolicy: 'waitForRest',    // 'waitForRest' | 'cancelAll' | 'ignore'
  steps: [
    {
      id: 'researchTech',
      type: 'agentCall',
      agent: 'techResearcher',
      input: { prompt: 'Research technology trends' },
      outputKey: 'techResults'
    },
    {
      id: 'researchMarket',
      type: 'agentCall',
      agent: 'marketResearcher',
      input: { prompt: 'Research market trends' },
      outputKey: 'marketResults'
    }
  ]
}
```

**Failure policies:**

| Policy | Behavior |
|--------|----------|
| `waitForRest` (default) | Wait for all sub-steps. Fail the group if any failed. |
| `cancelAll` | On first failure, abort remaining sub-steps and fail the group. |
| `ignore` | Return all results, including failures. |

---

## Wiring Data with `$ref`

`$ref` is the mechanism for passing data between steps. It resolves paths against the shared **context object** (`ctx`).

### Context structure

```javascript
ctx = {
  inputs: { /* initial inputs passed to execute() */ },
  outputs: {
    researchNotes: { /* stored via outputKey */ },
    finalSummary: { /* stored via outputKey */ }
  },
  steps: {
    researchTopic: { status: 'completed', outputs: { ... }, error: null },
    reviewCheckpoint: { status: 'waiting_checkpoint', outputs: null, error: null }
  }
}
```

### `$ref` syntax

All `$ref` paths must start with `ctx.` and reference one of three roots:

| Root | Example | Meaning |
|------|---------|---------|
| `ctx.inputs` | `ctx.inputs.topic` | Initial workflow input |
| `ctx.outputs` | `ctx.outputs.researchNotes.content` | Output from a prior step |
| `ctx.steps` | `ctx.steps.researchTopic.outputs.content` | Step execution result |

### Nested objects

`$ref` supports deep path resolution:

```javascript
{
  input: {
    userName: { $ref: 'ctx.inputs.user.name' },
    lastResult: { $ref: 'ctx.outputs.step3.data.items[0]' }
  }
}
```

> **Note:** Array index notation (`items[0]`) is supported in path strings, but use it sparingly — undefined array elements will throw resolution errors.

### Mixing literals and refs

You can combine literal values and `$ref` objects freely:

```javascript
{
  input: {
    prompt: 'Summarize these notes:',
    notes: { $ref: 'ctx.outputs.researchNotes.content' },
    maxLength: 500          // literal
  }
}
```

---

## Error Handling & Retry Configuration

### Global retry policy

Set defaults at kernel creation:

```javascript
const kernel = new WorkflowKernel({
  agentDispatcher: dispatcher,
  config: {
    globalRetryPolicy: {
      maxAttempts: 3,
      backoffDelays: [0, 250, 1000]   // ms delays between attempts
    }
  }
});
```

### Step-level retry override

Override the global policy for individual steps:

```javascript
{
  id: 'fragileStep',
  type: 'agentCall',
  agent: 'unstableAgent',
  retryPolicy: {
    maxAttempts: 5,
    backoffDelays: [0, 500, 2000, 5000]
  }
}
```

### Failure strategies

| Strategy | How to apply | Behavior |
|----------|--------------|----------|
| **Fail workflow** | Default | Mark workflow `FAILED`, emit `workflow.failed`. |
| **Retry step** | `retryPolicy` | Re-run step up to `maxAttempts` with backoff. |
| **Checkpoint on failure** | Guard `onFailure: 'checkpoint'` | Pause for human decision instead of failing. |
| **Ignore failures** | ParallelGroup `failurePolicy: 'ignore'` | Continue despite sub-step failures. |

### Handling checkpoint rejections

When a checkpoint is rejected, the action depends on configuration:

```javascript
{
  id: 'review',
  type: 'checkpoint',
  onCheckpointReject: 'retry'   // Re-run the preceding step
}
```

Currently supported: `retry` (re-run preceding logic) and `rollback` (not yet implemented — falls back to `fail`).

---

## Registering Custom Step Types

If the built-in step types don't cover your use case, you can register custom handlers.

### Step handler contract

A step handler is an async function with this signature:

```javascript
async function myCustomStep(step, stepContext) {
  // step: the step definition object (id, type, input, config, etc.)
  // stepContext: { workflowId, step, context, kernel }

  // ... do work ...

  return {
    status: 'completed',     // 'completed' | 'waiting_checkpoint' | 'failed' | 'skipped'
    output: { ... },         // Optional: data to store in ctx.outputs[outputKey]
    checkpoint: { ... },     // Required if status === 'waiting_checkpoint'
    error: new Error(...)    // Required if status === 'failed'
  };
}
```

### Example: HTTP fetch step

```javascript
async function httpFetchStep(step, stepContext) {
  const { context } = stepContext;

  // Resolve inputs (supports $ref automatically if you use resolveInput)
  const { agentCallStep, resolveInput } = require('./modules/workflowKernel/steps/AgentCallStep');
  const resolved = step.input ? resolveInput(step.input, context) : {};

  const { url, method = 'GET', headers = {} } = resolved;

  try {
    const response = await fetch(url, { method, headers });
    const data = await response.json();

    return {
      status: 'completed',
      output: {
        statusCode: response.status,
        data,
        headers: Object.fromEntries(response.headers)
      }
    };
  } catch (error) {
    return {
      status: 'failed',
      error: new Error(`HTTP fetch failed: ${error.message}`)
    };
  }
}

// Register it
kernel.registerStepType('httpFetch', httpFetchStep);
```

### Using custom steps in definitions

```javascript
{
  id: 'fetchWeather',
  type: 'httpFetch',
  input: {
    url: { $ref: 'ctx.inputs.weatherApiUrl' }
  },
  outputKey: 'weatherData'
}
```

### Validating custom steps

If you use `WorkflowValidator`, it checks that all step types in your definition are registered:

```javascript
const { WorkflowValidator } = require('./modules/workflowKernel/validators/WorkflowValidator');

const validator = new WorkflowValidator(kernel.stepRegistry);
const result = validator.validate(myWorkflowDefinition);

if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

---

## Testing Workflows in Isolation

The kernel is designed for testability. You don't need a running server or real agents to test workflow logic.

### Pattern 1: Mock agent dispatcher

```javascript
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { WorkflowKernel, agentCallStep } = require('./modules/workflowKernel');

describe('Research Workflow', () => {
  it('completes end-to-end with mock agents', async () => {
    const kernel = new WorkflowKernel({
      agentDispatcher: {
        delegate: async (agentId, prompt) => ({
          content: `[Mock ${agentId}] ${prompt}`,
          markers: [],
          raw: {}
        })
      }
    });

    kernel.registerStepType('agentCall', agentCallStep);

    const definition = {
      id: 'test-research',
      phases: [{
        id: 'p1',
        steps: [
          { id: 'research', type: 'agentCall', agent: 'researcher', input: { prompt: 'Test' }, outputKey: 'notes' }
        ]
      }]
    };

    const record = await kernel.execute('wf-test', definition, { topic: 'Test' });
    assert.strictEqual(record.status, 'completed');
    assert.ok(record.context.outputs.notes.content.includes('Mock researcher'));
  });
});
```

### Pattern 2: Test checkpoints explicitly

```javascript
it('pauses at checkpoint and resumes', async () => {
  const kernel = new WorkflowKernel({ agentDispatcher: mockDispatcher });
  kernel.registerStepType('agentCall', agentCallStep);
  kernel.registerStepType('checkpoint', checkpointStep);

  const definition = {
    id: 'cp-test',
    phases: [{
      id: 'p1',
      steps: [
        { id: 'before', type: 'agentCall', agent: 'a', input: { prompt: 'x' }, outputKey: 'o1' },
        { id: 'cp', type: 'checkpoint' },
        { id: 'after', type: 'agentCall', agent: 'b', input: { prompt: 'y' }, outputKey: 'o2' }
      ]
    }]
  };

  await kernel.execute('wf-cp', definition);
  let status = await kernel.getStatus('wf-cp');
  assert.strictEqual(status.state, 'waiting_checkpoint');

  await kernel.resume('wf-cp', { checkpointId: status.checkpointState.checkpointId, action: 'approve' });
  status = await kernel.getStatus('wf-cp');
  assert.strictEqual(status.state, 'completed');
});
```

### Pattern 3: Custom step unit test

```javascript
it('custom step resolves $ref correctly', async () => {
  const { resolveInput } = require('./modules/workflowKernel/steps/AgentCallStep');

  const context = {
    inputs: { name: 'Alice' },
    outputs: { greeting: { text: 'Hello' } },
    steps: {}
  };

  const input = {
    user: { $ref: 'ctx.inputs.name' },
    message: { $ref: 'ctx.outputs.greeting.text' }
  };

  const resolved = resolveInput(input, context);
  assert.deepStrictEqual(resolved, { user: 'Alice', message: 'Hello' });
});
```

### Pattern 4: Event-driven assertions

```javascript
it('emits expected events', async () => {
  const events = [];
  const kernel = new WorkflowKernel({ agentDispatcher: mockDispatcher });
  kernel.onEvent('*', (event) => events.push(event));

  // ... execute workflow ...

  assert.ok(events.some(e => e.type === 'workflow.started'));
  assert.ok(events.some(e => e.type === 'workflow.step_started' && e.payload.stepId === 'research'));
  assert.ok(events.some(e => e.type === 'workflow.completed'));
});
```

---

## Production Readiness Checklist

Before shipping a workflow definition to production, verify:

### Definition structure

- [ ] `id` is set, unique, and uses valid identifier characters (`[a-zA-Z_][a-zA-Z0-9_]*`).
- [ ] `version` follows semantic versioning (`major.minor.patch`).
- [ ] At least one phase exists, and every phase has at least one step.
- [ ] Every step has a unique `id` within the workflow.
- [ ] Every step `type` is registered in the kernel's `StepRegistry` before execution.

### Data wiring

- [ ] All `$ref` paths start with `ctx.` and reference `inputs`, `outputs`, or `steps`.
- [ ] `$ref` paths that read from prior steps actually exist earlier in the execution order.
- [ ] No circular `$ref` dependencies exist within a single phase.

### Error resilience

- [ ] Step-level or global `retryPolicy` is configured for agent calls.
- [ ] Checkpoints have reasonable `timeoutMs` values (not infinite).
- [ ] Guard conditions handle missing data gracefully (check for undefined before comparing).
- [ ] Parallel groups have an explicit `failurePolicy` chosen intentionally.

### Observability

- [ ] Event listeners are attached for `workflow.failed` to log or alert on failures.
- [ ] Checkpoint events (`workflow.checkpoint_pending`) are wired to your UI or notification system.
- [ ] If using `stateRepository`, verify that `create`, `update`, and `get` are implemented and performant.

### Security

- [ ] No sensitive data (API keys, tokens) is hardcoded in workflow definitions.
- [ ] `ExpressionEngine` conditions don't reference external or untrusted data sources.
- [ ] Custom step handlers validate and sanitize inputs before acting on them.

### Testing

- [ ] Workflow executes successfully with a mock agent dispatcher.
- [ ] Checkpoint pause and resume paths are tested.
- [ ] Failure paths (agent error, guard failure, timeout) are tested.
- [ ] Custom step types have unit tests for input resolution and error handling.

---

## Common Pitfalls

| Pitfall | Why It Happens | Solution |
|---------|----------------|----------|
| **Workflow never activates** | `USE_WORKFLOW_KERNEL` missing from `configSchema` | Add it to `plugin-manifest.json` configSchema. See `workflow-migration-guide.md`. |
| **`$ref` resolution fails** | Referencing a step that hasn't run yet, or a missing outputKey | Ensure `$ref` targets exist earlier in the phase/step order. |
| **Guard always fails** | Expression references `undefined` values | Add existence checks or default values in prior steps. |
| **Loop runs forever** | `shouldContinue` always returns true | Set a sensible `maxIterations` cap and test the stop condition. |
| **Checkpoint timeout ignored** | `autoContinueOnTimeout: true` but no `timeoutMs` set | Always set `timeoutMs` when using auto-continue. |
| **Parallel group hangs** | Sub-step handlers don't respect AbortController | Use `cancelAll` only with cooperative handlers; prefer `waitForRest` for simple cases. |
| **Memory leak in tests** | CheckpointManager intervals not cleaned up | Call `kernel.checkpointManager?.destroy()` in `afterEach`. |
| **Validation rejects valid workflow** | `WorkflowValidator` rejects `outputs` as `$ref` root | Ensure your validator version recognizes `ctx.outputs.*` as valid (fixed in S03). |

---

## Next Steps

- **API deep dive:** `docs/workflow-kernel-api.md` — exhaustive reference for every class and method.
- **Migrating legacy code:** `docs/workflow-migration-guide.md` — map StoryOrchestrator phases to WorkflowKernel steps.
- **Real-world example:** `Plugin/StoryOrchestrator/config/workflow-definition.js` — the reference workflow definition used in production.
