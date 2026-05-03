# AgentDispatcher Public API Contract

**Module:** `modules/agentDispatcher/`  
**Scope:** Generic agent delegation — zero dependencies on `Plugin/StoryOrchestrator`.  
**Last verified:** M003/S04

## Module Entry Point

```js
const { AgentDispatcher, COMPLETION_MARKERS } = require('./modules/agentDispatcher');
```

## Constructor

### Legacy Signature (backward-compatible)
```js
new AgentDispatcher(globalConfig, stateManager)
```
- `globalConfig` — flat key/value object; reads `AGENT_ASSISTANT_URL`, `VCP_Key`, `PORT`, and per-agent `AGENT_*` keys.
- `stateManager` — optional state manager (legacy coupling, ignored in decoupled mode).

### Decoupled Signature (preferred)
```js
new AgentDispatcher({ agentAssistantUrl, vcpKey, agentResolver })
```
- `agentAssistantUrl` — base URL of the agent assistant service.
- `vcpKey` — Bearer token for Authorization header.
- `agentResolver(agentType)` → `{ modelId, systemPrompt?, chineseName?, maxOutputTokens?, temperature? }`

## Methods

### `initialize()`
```js
await dispatcher.initialize();
```
Logs initialization marker. Idempotent; no side effects.

### `delegate(agentType, prompt, options?)`
```js
const result = await dispatcher.delegate('genericWorker', 'do some work', {
  timeoutMs: 120000,      // default: 600000
  taskDelegation: false,  // true = async / human-tool delegation
  temporaryContact: true  // async only
});
```
**Returns (sync mode):**
```js
{
  content:   string,   // full response text
  raw:       object,   // raw HTTP response body
  markers:   { isComplete: boolean, isFailed: boolean, hasHeartbeat: boolean }
}
```

**Returns (async mode):**
```js
{
  delegationId: string,
  status:       'delegated',
  poll:         () => Promise<PollResult>
}
```

**Logs:**
- `[AgentDispatcher] delegate called for ${agentType}, timeoutMs=${options.timeoutMs}`
- `[AgentDispatcher] Response for ${model}: len=${len}, finish_reason=${reason}, markers=${markers}, usage=${usage}, preview="..."`
- `[AgentDispatcher] Delegation failed for ${agentType}: ${message}`

### `delegateParallel(agentTasks)`
```js
const { succeeded, failed } = await dispatcher.delegateParallel([
  { agentType: 'genericWorker', prompt: 'task-a' },
  { agentType: 'secondary',     prompt: 'task-b' }
]);
```
Dispatches all tasks concurrently. Returns grouped results.

### `delegateSerial(agentTasks, onProgress?)`
```js
const results = await dispatcher.delegateSerial(tasks, (current, total, agentType) => {
  console.log(`Progress ${current}/${total}: ${agentType}`);
});
```
Dispatches tasks sequentially. Stops on first error unless `task.stopOnError === false`.

### `pollDelegation(delegationId, timeoutMs?)`
```js
const result = await dispatcher.pollDelegation('delegation-1', 120000);
```
Polls async delegation until completed, failed, or timeout.

## Completion Markers

```js
const { COMPLETION_MARKERS } = require('./modules/agentDispatcher');

COMPLETION_MARKERS.COMPLETE   // '[[TaskComplete]]'
COMPLETION_MARKERS.FAILED     // '[[TaskFailed]]'
COMPLETION_MARKERS.HEARTBEAT  // '[[NextHeartbeat]]'
```

Agents embed these markers in their response text to signal:
- **TaskComplete** — the agent finished its task.
- **TaskFailed** — the agent encountered an unrecoverable error.
- **NextHeartbeat** — the agent is still working; caller should continue polling or extend timeout.

## Agent Configuration Resolution

### Convention-Based (legacy, default)
```js
const { getAgentConfig } = require('./modules/agentDispatcher/AgentDefinitions');
const config = getAgentConfig('worldBuilder', globalConfig);
// Resolves keys: AGENT_WORLD_BUILDER_MODEL_ID, AGENT_WORLD_BUILDER_SYSTEM_PROMPT, ...
```

### Injected Resolver (decoupled)
Pass `agentResolver` in the constructor to override convention-based lookup entirely.

## Error Contract

| Error Message | Trigger |
|---------------|---------|
| `Agent ${type} not configured: missing MODEL_ID` | `delegate()` called for agent with no modelId |
| `Failed to parse response: ${message}` | HTTP body is not valid JSON |
| `Request timeout after ${ms}ms` | Sync request exceeds `timeoutMs` |
| `No delegation ID returned` | Async delegation response lacks `delegation_id` |
| `Delegation timeout: ${id}` | `pollDelegation()` exceeds timeout |

## Zero-Import Guarantee

No file in `modules/agentDispatcher/` imports from `Plugin/StoryOrchestrator/`. Verified by static analysis in M003/S04/T04.
