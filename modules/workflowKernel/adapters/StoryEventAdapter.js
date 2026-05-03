/**
 * StoryEventAdapter — maps kernel generic events to StoryOrchestrator legacy events.
 *
 * Strategy: kernel emits generic events; adapter maps to legacy format for
 * StoryOrchestrator consumers during migration. Can be deprecated once frontend
 * directly consumes generic events.
 */

const LEGACY_EVENT_MAP = {
  'workflow.started': ['workflow_started'],
  'workflow.state_changed': (payload) => {
    if (payload.to === 'running' && payload.from === 'waiting_checkpoint') {
      return ['workflow_resuming'];
    }
    if (payload.to === 'recovering') {
      return ['workflow_recovery_started'];
    }
    return [];
  },
  'workflow.step_completed': (payload, phaseMeta) => {
    if (phaseMeta?.isLastStep) {
      return ['phase_completed'];
    }
    return [];
  },
  'workflow.step_failed': ['phase_failed'],
  'workflow.retrying': ['phase_retry', 'phase_restart'],
  'workflow.checkpoint_pending': ['checkpoint_created', 'checkpoint_pending'],
  'workflow.checkpoint_approved': ['checkpoint_approved'],
  'workflow.checkpoint_skipped': ['checkpoint_approved'],
  'workflow.checkpoint_modified': ['checkpoint_approved'],
  'workflow.checkpoint_rejected': (payload) => {
    if (payload.checkpointType?.includes('chapter')) {
      return ['chapter_checkpoint_rejected'];
    }
    return ['checkpoint_rejected'];
  },
  'workflow.checkpoint_timeout': ['checkpoint_auto_approved'],
  'workflow.completed': (payload, phaseMeta) => {
    if (phaseMeta?.isFinalAcceptance) {
      return ['final_acceptance', 'workflow_completed'];
    }
    return ['workflow_completed'];
  },
  'workflow.failed': ['phase_failed'],
  'workflow.rollback': ['workflow_rollback', 'rollback']
};

class StoryEventAdapter {
  constructor(eventSink) {
    this.eventSink = eventSink;
    this.phaseMeta = new Map(); // workflowId -> { phaseIndex, totalSteps }
  }

  registerWorkflow(workflowId, definition) {
    this.phaseMeta.set(workflowId, {
      phases: definition.phases.map(p => p.steps.length)
    });
  }

  onKernelEvent(workflowId, event) {
    const legacyEvents = this._mapToLegacy(workflowId, event);
    for (const legacy of legacyEvents) {
      this._emitLegacy(workflowId, legacy);
    }
  }

  _mapToLegacy(workflowId, event) {
    const mapper = LEGACY_EVENT_MAP[event.type];
    if (!mapper) {
      return [];
    }

    const meta = this._getPhaseMeta(workflowId, event.payload);

    if (typeof mapper === 'function') {
      return mapper(event.payload, meta).map(eventType => ({
        eventType,
        payload: event.payload,
        timestamp: event.timestamp
      }));
    }

    return mapper.map(eventType => ({
      eventType,
      payload: event.payload,
      timestamp: event.timestamp
    }));
  }

  _getPhaseMeta(workflowId, payload) {
    const meta = this.phaseMeta.get(workflowId);
    if (!meta || !payload) return null;

    // Detect if this is the last step of a phase
    if (payload.phaseId !== undefined && payload.stepIndex !== undefined) {
      const phaseSteps = meta.phases[payload.phaseId];
      return {
        isLastStep: phaseSteps !== undefined && payload.stepIndex === phaseSteps - 1,
        isFinalAcceptance: payload.stepId === 'final_acceptance'
      };
    }

    return null;
  }

  _emitLegacy(workflowId, legacy) {
    if (this.eventSink && typeof this.eventSink.push === 'function') {
      this.eventSink.push(workflowId, legacy).catch(err => {
        console.error('[StoryEventAdapter] Event push failed:', err.message);
      });
    }
  }
}

module.exports = { StoryEventAdapter };
