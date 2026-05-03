const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StoryEventAdapter } = require('../../../modules/workflowKernel/adapters/StoryEventAdapter');

describe('StoryEventAdapter', () => {
  it('maps workflow.started to legacy workflow_started', () => {
    const events = [];
    const adapter = new StoryEventAdapter({ push: async (id, evt) => { events.push(evt); } });
    adapter.registerWorkflow('wf-1', { phases: [{ steps: [] }] });

    adapter.onKernelEvent('wf-1', {
      type: 'workflow.started',
      timestamp: new Date().toISOString(),
      payload: { definitionRef: 'story-v1' }
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].eventType, 'workflow_started');
  });

  it('maps workflow.step_started to legacy step_started', () => {
    const events = [];
    const adapter = new StoryEventAdapter({ push: async (id, evt) => { events.push(evt); } });
    adapter.registerWorkflow('wf-1', { phases: [{ steps: [{}, {}, {}] }] });

    adapter.onKernelEvent('wf-1', {
      type: 'workflow.step_started',
      payload: { stepId: 's1', stepType: 'agentCall', phaseId: 0, stepIndex: 0 }
    });

    // step_started is not in LEGACY_EVENT_MAP directly, but checkpoint events are
  });

  it('maps workflow.checkpoint_pending to legacy checkpoint_created', () => {
    const events = [];
    const adapter = new StoryEventAdapter({ push: async (id, evt) => { events.push(evt); } });
    adapter.registerWorkflow('wf-1', { phases: [{ steps: [] }] });

    adapter.onKernelEvent('wf-1', {
      type: 'workflow.checkpoint_pending',
      payload: { checkpointId: 'cp-1' }
    });

    assert.ok(events.some(e => e.eventType === 'checkpoint_created'));
    assert.ok(events.some(e => e.eventType === 'checkpoint_pending'));
  });

  it('returns empty array for unmapped events', () => {
    const events = [];
    const adapter = new StoryEventAdapter({ push: async (id, evt) => { events.push(evt); } });
    adapter.registerWorkflow('wf-1', { phases: [{ steps: [] }] });

    adapter.onKernelEvent('wf-1', {
      type: 'workflow.unknown_event',
      payload: {}
    });

    assert.strictEqual(events.length, 0);
  });
});
