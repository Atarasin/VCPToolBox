# StoryOrchestrator Compatibility Surface Status

## Purpose

This document records which StoryOrchestrator modules still exist as compatibility surface after kernel-led replacement and phase-class shell retirement.

Compatibility retirement progress does **not** by itself prove that StoryOrchestrator has reached thin reference plugin readiness. Adapter thinning, state projection boundaries, and helper separation remain separate convergence concerns.

## Related Audit

Use `LEGACY_PATH_RETIREMENT_AUDIT.md` when you need the current evidence package for retirement decisions.

That companion document answers:

- which surfaces still serve canonical delegation or migration-input-only roles
- which tests still protect those contracts
- what retirement preconditions must be satisfied before a later implementation change removes any surviving compatibility surface

## Compatibility States

| State | Meaning | Maintainer expectation |
|---|---|---|
| `retain-as-shell` | The surface still has a compatibility, migration, or diagnostic role. | Keep it narrow, delegation-only where possible, and do not add new primary control semantics. |
| `degrade-entry` | The entry still exists, but it should collapse to a thinner wrapper or alias. | Prefer canonical kernel-owned or full-definition paths while keeping older references readable. |
| `eligible-for-retirement` | Stable replacement path and verification evidence exist. | The surface may be removed or reduced further once the surrounding call sites are confirmed safe. |

## Current Inventory

| Surface | State | Canonical replacement | Rationale |
|---|---|---|---|
| `WorkflowEngine` | `retain-as-shell` | `WorkflowKernel` control plane via `StoryOrchestratorKernelAdapter` | Still exposes compatibility `start` / `resume` / `recover` / `retryPhase` entrypoints and status projection, but phase execution is fully kernel-owned and must not return to phase-class shells. |

## Current Governance Notes

- `WorkflowEngine` remains a compatibility shell because `StoryOrchestrator` still routes public commands and status reads through it.
- `Phase1_WorldBuilding`, `Phase2_OutlineDrafting`, and `Phase3_Refinement` have been retired as runtime compatibility surfaces; their source files and dedicated unit tests have been removed.
- `story-orchestrator-phase1` remains readable only as migration input: recovery normalizes that legacy ref onto the full declarative workflow definition, and the old `workflow-phase1.js` file is no longer a supported compatibility surface.
- None of the above states should be used to claim that StoryOrchestrator has reached thin reference plugin readiness.

## Current Retirement Audit Summary

| Surface | Routing class | Current judgment |
|---|---|---|
| `WorkflowEngine` | `canonical-delegation-shell` | Keep as shell for now; it still fronts command routing and compatibility state projection, but kernel-unavailable paths now fail explicitly instead of re-entering retired phase-class runtime. |
| `Phase1_WorldBuilding` | `retired` | Removed from supported runtime paths; keep only historical references needed for audit context. |
| `Phase2_OutlineDrafting` | `retired` | Removed from supported runtime paths; outline/content continuation is now kernel-owned. |
| `Phase3_Refinement` | `retired` | Removed from supported runtime paths; final-phase continuation is now kernel-owned. |

`workflow-phase1.js` has been retired as a file-backed degraded entry. The surviving compatibility rule is narrower: old `story-orchestrator-phase1` refs are accepted only as migration input and immediately normalized onto the canonical full workflow definition.

The detailed evidence, retirement preconditions, and verification checklist now live in `LEGACY_PATH_RETIREMENT_AUDIT.md`.
