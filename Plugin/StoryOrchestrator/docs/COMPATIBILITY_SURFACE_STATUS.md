# StoryOrchestrator Compatibility Surface Status

## Purpose

This document records which StoryOrchestrator modules still exist as compatibility surface after kernel-led replacement and structural convergence, and how maintainers should reason about their next retirement step.

Compatibility retirement progress does **not** by itself prove that StoryOrchestrator has reached thin reference plugin readiness. Adapter thinning, state projection boundaries, and helper separation still remain separate convergence concerns.

## Compatibility States

| State | Meaning | Maintainer expectation |
|---|---|---|
| `retain-as-shell` | The surface still has a compatibility, migration, or diagnostic role. | Keep it narrow, delegation-only where possible, and do not add new primary control semantics. |
| `degrade-entry` | The entry still exists, but it should collapse to a thinner wrapper or alias. | Prefer canonical kernel-owned or full-definition paths while keeping older references readable. |
| `eligible-for-retirement` | Stable replacement path and verification evidence exist. | The surface may be removed or reduced further once the surrounding call sites are confirmed safe. |

## Current Inventory

| Surface | State | Canonical replacement | Rationale |
|---|---|---|---|
| `WorkflowEngine` | `retain-as-shell` | `WorkflowKernel` control plane via `StoryOrchestratorKernelAdapter` | Still exposes compatibility start/resume/recover/retry entrypoints and operational delegation, but must not regain primary workflow control. |
| `Phase1_WorldBuilding` | `retain-as-shell` | `phase1` in `workflow-definition.js` | Still backs the legacy phase-class path and remains useful for compatibility execution. |
| `Phase2_OutlineDrafting` | `retain-as-shell` | `phase2` in `workflow-definition.js` | Still supports legacy execution and resume flows, but is no longer the canonical workflow controller. |
| `Phase3_Refinement` | `retain-as-shell` | `phase3` in `workflow-definition.js` | Still serves compatibility-driven polish/final acceptance entrypoints. |
| `workflow-phase1.js` | `degrade-entry` | `workflow-definition.js` | Old phase-only `definitionRef` values now degrade to the full workflow definition during recovery, so this file is retained as a compatibility artifact rather than a preferred execution source. |

## Current Governance Notes

- `WorkflowEngine` remains a compatibility shell because it still provides real integration entrypoints and a safe migration boundary.
- The phase classes remain `retain-as-shell` because the legacy path is still supported and regression-tested.
- `workflow-phase1.js` is now a degraded compatibility entry: old persisted `definitionRef` values can still be read, but recovery resolves them onto the full declarative workflow definition.
- None of the above states should be used to claim that StoryOrchestrator has reached thin reference plugin readiness.
