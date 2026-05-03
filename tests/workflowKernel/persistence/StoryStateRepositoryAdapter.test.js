const { describe, it } = require('node:test');
const assert = require('node:assert');
const { StoryStateRepositoryAdapter } = require('../../../modules/workflowKernel/persistence/StoryStateRepositoryAdapter');

describe('StoryStateRepositoryAdapter', () => {
  function makeMockRepo() {
    const stories = new Map();
    const events = [];
    return {
      createStory: (id, data) => {
        stories.set(id, { story_id: id, ...data, version: 1 });
        return { story_id: id };
      },
      getStory: (id) => stories.get(id) || null,
      getStoryWithFields: (id) => stories.get(id) || null,
      updateStory: (id, updates, version) => {
        const s = stories.get(id);
        if (!s) throw new Error('Not found');
        Object.assign(s, updates, { version: version + 1 });
        return s;
      },
      appendEvent: (evt) => { events.push(evt); return evt; },
      listStories: () => Array.from(stories.values()),
      _stories: stories,
      _events: events
    };
  }

  it('creates workflow through story repository', async () => {
    const repo = makeMockRepo();
    const adapter = new StoryStateRepositoryAdapter(repo);
    await adapter.create('wf-1', 'def-1', { input: 'test' });
    const story = repo.getStoryWithFields('wf-1');
    assert.strictEqual(story.story_id, 'wf-1');
  });

  it('maps executionCursor to current_step', async () => {
    const repo = makeMockRepo();
    const adapter = new StoryStateRepositoryAdapter(repo);
    await adapter.create('wf-1', 'def-1', {});
    await adapter.update('wf-1', { executionCursor: [{ phase: 0 }, { step: 2 }] });
    const story = repo.getStoryWithFields('wf-1');
    assert.strictEqual(story.current_step, JSON.stringify([{ phase: 0 }, { step: 2 }]));
  });

  it('maps context to workflow_state', async () => {
    const repo = makeMockRepo();
    const adapter = new StoryStateRepositoryAdapter(repo);
    await adapter.create('wf-1', 'def-1', {});
    await adapter.update('wf-1', { context: { outputs: { result: 42 } } });
    const story = repo.getStoryWithFields('wf-1');
    assert.deepStrictEqual(JSON.parse(story.workflow_state), { outputs: { result: 42 } });
  });

  it('appends history events', async () => {
    const repo = makeMockRepo();
    const adapter = new StoryStateRepositoryAdapter(repo);
    await adapter.appendHistory('wf-1', { type: 'step_completed', timestamp: '2024-01-01T00:00:00Z' });
    assert.strictEqual(repo._events.length, 1);
    assert.strictEqual(repo._events[0].story_id, 'wf-1');
  });

  it('lists only active workflows', async () => {
    const repo = makeMockRepo();
    const adapter = new StoryStateRepositoryAdapter(repo);
    await adapter.create('wf-1', 'def-1', {});
    await adapter.create('wf-2', 'def-1', {});
    repo._stories.get('wf-1').status = 'running';
    repo._stories.get('wf-2').status = 'completed';
    const active = await adapter.listActive();
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].story_id, 'wf-1');
  });
});
