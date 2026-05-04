'use strict';

/**
 * StoryOrchestrator compatibility surface inventory.
 *
 * This registry makes retirement decisions explicit without forcing immediate
 * physical deletion. It is intentionally small and human-readable so
 * maintainers can audit which legacy surfaces still exist and why.
 */
const COMPATIBILITY_SURFACE_STATES = Object.freeze({
  RETAIN_AS_SHELL: 'retain-as-shell',
  DEGRADE_ENTRY: 'degrade-entry',
  ELIGIBLE_FOR_RETIREMENT: 'eligible-for-retirement'
});

const COMPATIBILITY_SURFACES = Object.freeze([
  Object.freeze({
    id: 'workflow-engine',
    label: 'WorkflowEngine',
    modulePath: 'Plugin/StoryOrchestrator/core/WorkflowEngine.js',
    state: COMPATIBILITY_SURFACE_STATES.RETAIN_AS_SHELL,
    replacementPath: 'WorkflowKernel control plane via StoryOrchestratorKernelAdapter',
    rationale: 'Still exposes start/resume/recover/retry compatibility entrypoints and diagnostic delegation, but must not regain primary workflow control semantics.',
    readinessNote: 'Retention of WorkflowEngine as a shell does not imply thin reference plugin readiness.'
  }),
  Object.freeze({
    id: 'phase1-world-building',
    label: 'Phase1_WorldBuilding',
    modulePath: 'Plugin/StoryOrchestrator/core/Phase1_WorldBuilding.js',
    state: COMPATIBILITY_SURFACE_STATES.RETAIN_AS_SHELL,
    replacementPath: 'phase1 in Plugin/StoryOrchestrator/config/workflow-definition.js',
    rationale: 'Still backs the legacy phase-class path and remains useful for compatibility execution, but it must stay out of new primary control-plane work.',
    readinessNote: 'Phase-class retention is compatibility debt until the remaining legacy path can be reduced further.'
  }),
  Object.freeze({
    id: 'phase2-outline-drafting',
    label: 'Phase2_OutlineDrafting',
    modulePath: 'Plugin/StoryOrchestrator/core/Phase2_OutlineDrafting.js',
    state: COMPATIBILITY_SURFACE_STATES.RETAIN_AS_SHELL,
    replacementPath: 'phase2 in Plugin/StoryOrchestrator/config/workflow-definition.js',
    rationale: 'Still backs compatibility execution and resume behavior for the legacy path, but it is no longer the canonical workflow control source.',
    readinessNote: 'Keeping this shell available does not close adapter or state-boundary debt.'
  }),
  Object.freeze({
    id: 'phase3-refinement',
    label: 'Phase3_Refinement',
    modulePath: 'Plugin/StoryOrchestrator/core/Phase3_Refinement.js',
    state: COMPATIBILITY_SURFACE_STATES.RETAIN_AS_SHELL,
    replacementPath: 'phase3 in Plugin/StoryOrchestrator/config/workflow-definition.js',
    rationale: 'Still serves compatibility entrypoints for legacy polish/final-acceptance flow while WorkflowKernel owns the primary orchestration path.',
    readinessNote: 'Retaining the shell preserves compatibility only; readiness still depends on broader structural convergence.'
  }),
  Object.freeze({
    id: 'workflow-phase1-definition',
    label: 'workflow-phase1.js',
    modulePath: 'Plugin/StoryOrchestrator/config/workflow-phase1.js',
    state: COMPATIBILITY_SURFACE_STATES.DEGRADE_ENTRY,
    replacementPath: 'Plugin/StoryOrchestrator/config/workflow-definition.js',
    rationale: 'The old phase-only definition ref now degrades to the full workflow definition for recovery. The file remains as a compatibility artifact and audit aid, not the preferred execution source.',
    readinessNote: 'Degrading this entry does not by itself justify thin reference plugin readiness.'
  })
]);

function listCompatibilitySurfaces() {
  return COMPATIBILITY_SURFACES.map((surface) => ({ ...surface }));
}

function getCompatibilitySurface(surfaceId) {
  const surface = COMPATIBILITY_SURFACES.find((item) => item.id === surfaceId);
  return surface ? { ...surface } : null;
}

module.exports = {
  COMPATIBILITY_SURFACE_STATES,
  listCompatibilitySurfaces,
  getCompatibilitySurface
};
