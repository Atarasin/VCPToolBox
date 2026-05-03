# StoryOrchestrator Feature-Switch Rollback Procedure

## Overview

StoryOrchestrator supports two execution paths controlled by the `USE_WORKFLOW_KERNEL` feature flag:

- **`USE_WORKFLOW_KERNEL=true`** — Uses the `WorkflowKernel` engine with a declarative workflow definition.
- **`USE_WORKFLOW_KERNEL=false`** (or unset) — Uses the legacy `WorkflowEngine` with hardcoded phase classes (Phase1, Phase2, Phase3).

This document describes how to roll back from the kernel path to the legacy path safely.

---

## Prerequisites

- Access to `Plugin/StoryOrchestrator/config.env`
- Ability to restart the VCP service (or the Node.js process running `server.js`)
- Both paths are always importable — no package install/uninstall is required

---

## Rollback Steps

### Step 1: Edit Plugin Configuration

Open `Plugin/StoryOrchestrator/config.env` and change:

```diff
- USE_WORKFLOW_KERNEL=true
+ USE_WORKFLOW_KERNEL=false
```

Or simply comment out / remove the line:

```diff
- USE_WORKFLOW_KERNEL=true
+ # USE_WORKFLOW_KERNEL=false
```

> **Note:** When the key is absent or set to any value other than `'true'`, the legacy path is selected.

### Step 2: Restart the Service

The feature flag is read once during `StoryOrchestrator.initialize()`. A process restart is required for the change to take effect.

```bash
# If using PM2
pm2 restart server

# If running directly
# Stop the current process (Ctrl+C or kill) and rerun:
node server.js

# If using Docker
docker-compose restart
```

**Expected latency:** Under 10 seconds for config edit + process restart on typical hardware. Well under the one-minute SLA.

### Step 3: Verify Rollback

Check the startup logs for the routing path indicator:

```
[StoryOrchestrator] Initialized successfully (kernel: false )
```

Run the integration test suite to confirm the legacy path is healthy:

```bash
node --test Plugin/StoryOrchestrator/tests/integration.test.js
```

Expected output: `pass 40, fail 0`.

---

## In-Flight Workflow Behavior

| Scenario | Behavior |
|----------|----------|
| Active kernel workflows at shutdown | Kernel workflows persist state in SQLite (`wk_workflows` / `wk_workflow_events`). After rollback, these workflows are **not** automatically resumed by the legacy engine. Use `RecoverStoryWorkflow` with `recovery_action=continue` to attempt recovery, or manually inspect the database. |
| New stories started after rollback | Routed through the legacy `WorkflowEngine` path. |
| Checkpoints pending at rollback | Kernel checkpoint records remain in `wk_workflow_events`. The legacy engine does not read these tables. Manual intervention or a kernel-path restart may be needed to resolve them. |

---

## Coexistence Guarantee

Both paths share the same codebase without import conflicts:

- `StoryOrchestrator.js` unconditionally `require`s both `WorkflowEngine` and `StoryOrchestratorKernelAdapter` at module load time.
- The adapter is instantiated **only** when `USE_WORKFLOW_KERNEL=true`.
- No dynamic `require()` or conditional module unloading is used.
- The same `StateManager`, `AgentDispatcher`, `ChapterOperations`, and `ContentValidator` instances are passed to both engines.

This means:

1. You can toggle the switch repeatedly without reinstalling dependencies.
2. Both paths can be validated in the same test run by spawning separate processes with different env vars.
3. There is no risk of stale module caches or singleton corruption on switch.

---

## Emergency Fast Rollback (One-Liner)

```bash
sed -i 's/^USE_WORKFLOW_KERNEL=true/USE_WORKFLOW_KERNEL=false/' Plugin/StoryOrchestrator/config.env && pm2 restart server
```

---

## Verification Checklist

- [ ] `config.env` contains `USE_WORKFLOW_KERNEL=false` (or the line is absent)
- [ ] Service restarted and logs show `(kernel: false)`
- [ ] Integration tests pass: `node --test Plugin/StoryOrchestrator/tests/integration.test.js`
- [ ] New `StartStoryProject` commands route to `legacy` path (check logs for `Routing decision: ... path=legacy`)
- [ ] QueryStoryStatus returns `routing_path: 'legacy'`
