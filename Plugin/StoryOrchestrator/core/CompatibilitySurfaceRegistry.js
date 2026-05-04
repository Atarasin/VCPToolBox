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
    rationale: 'Still exposes start/resume/recover/retry compatibility entrypoints and diagnostic delegation, but phase execution now belongs to WorkflowKernel and must not return to phase-class shells.',
    readinessNote: 'Retention of WorkflowEngine as a shell does not imply thin reference plugin readiness.'
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
