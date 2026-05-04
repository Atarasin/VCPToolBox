# StoryOrchestrator Implementation Summary

## Current Status

This file is retained as a historical summary entrypoint, but its old phase-class implementation notes are no longer the current runtime model.

As of 2026-05-04:

- `WorkflowEngine` is a thin compatibility facade that delegates supported runtime control to `WorkflowKernel` through `StoryOrchestratorKernelAdapter`
- `Phase1_WorldBuilding`, `Phase2_OutlineDrafting`, and `Phase3_Refinement` have been retired as runtime modules
- checkpoint continuation, recovery, restart, rollback, and retry semantics are expected to remain kernel-owned
- timeout continuation no longer falls back to phase-class runtime

## Current Sources Of Truth

Use these documents for current behavior instead of historical phase-class notes:

- `Plugin/StoryOrchestrator/config/workflow-definition.md`
- `Plugin/StoryOrchestrator/docs/COMPATIBILITY_SURFACE_STATUS.md`
- `Plugin/StoryOrchestrator/docs/LEGACY_PATH_RETIREMENT_AUDIT.md`
- `mydoc/workflow_kernel/workflow-kernel-storyorchestrator-target-state.md`

## Historical Note

Earlier revisions of StoryOrchestrator relied on dedicated phase classes for phase execution, checkpoint continuation, and recovery fallback. That implementation model is now retired and should be treated only as migration context when reading older commits or archived reports.
