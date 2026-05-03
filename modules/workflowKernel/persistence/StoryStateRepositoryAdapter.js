/**
 * StoryStateRepositoryAdapter — adapts existing StoryStateRepository to WorkflowStateRepository interface.
 *
 * Maps workflow concepts to StoryOrchestrator's existing tables:
 * - workflows → stories table
 * - workflow_events → workflow_events table
 * - checkpoints → checkpoints table
 */

const { WorkflowStateRepository } = require('./WorkflowStateRepository');

class StoryStateRepositoryAdapter extends WorkflowStateRepository {
  constructor(storyStateRepository) {
    super();
    this.repo = storyStateRepository;
  }

  async create(workflowId, definitionRef, initialContext) {
    const existing = this.repo.getStory(workflowId);
    if (existing) {
      return existing;
    }
    return this.repo.createStory(workflowId, {
      definitionRef,
      initialContext,
      isWorkflowKernel: true
    });
  }

  async get(workflowId) {
    return this.repo.getStoryWithFields(workflowId);
  }

  async update(workflowId, patch) {
    const story = await this.get(workflowId);
    if (!story) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    const updates = {};

    // Map workflow patch fields to story table fields
    if (patch.status !== undefined) {
      updates.status = patch.status;
    }
    if (patch.executionCursor !== undefined) {
      updates.current_step = JSON.stringify(patch.executionCursor);
    }
    if (patch.context !== undefined) {
      updates.workflow_state = JSON.stringify(patch.context);
    }
    if (patch.checkpointState !== undefined) {
      updates.active_checkpoint_id = patch.checkpointState?.checkpointId || null;
    }
    if (patch.retryContext !== undefined) {
      updates.retry_context_json = JSON.stringify(patch.retryContext);
    }
    if (patch.runToken !== undefined) {
      // Store runToken in config_json as part of workflow metadata
      const config = JSON.parse(story.config_json || '{}');
      config.runToken = patch.runToken;
      updates.config_json = JSON.stringify(config);
    }

    return this.repo.updateStory(workflowId, updates, story.version);
  }

  async appendHistory(workflowId, event) {
    return this.repo.appendEvent({
      story_id: workflowId,
      event_type: event.type || 'workflow_event',
      event_detail_json: JSON.stringify(event),
      created_at: event.timestamp || new Date().toISOString()
    });
  }

  async listActive() {
    const allStories = this.repo.listStories();
    // Filter for active statuses (running, waiting_checkpoint, retrying, recovering)
    const activeStatuses = ['phase1_running', 'phase2_running', 'phase3_running', 'running', 'waiting_checkpoint', 'retrying', 'recovering'];
    return allStories.filter(s => activeStatuses.includes(s.status));
  }
}

module.exports = { StoryStateRepositoryAdapter };
