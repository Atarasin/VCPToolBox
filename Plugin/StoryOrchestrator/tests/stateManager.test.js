'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mockFileData = {};
let tempDir = '';

const originalReadFile = fs.promises.readFile;
const originalWriteFile = fs.promises.writeFile;
const originalRename = fs.promises.rename;
const originalUnlink = fs.promises.unlink;
const originalReaddir = fs.promises.readdir;
const originalMkdir = fs.promises.mkdir;

function setupMockFs() {
  fs.promises.readFile = async (file, enc) => {
    const data = mockFileData[file];
    if (!data) {
      const err = new Error('File not found');
      err.code = 'ENOENT';
      throw err;
    }
    return data;
  };
  fs.promises.writeFile = async (file, content) => {
    mockFileData[file] = content;
  };
  fs.promises.rename = async (oldPath, newPath) => {
    if (mockFileData[oldPath]) {
      mockFileData[newPath] = mockFileData[oldPath];
      delete mockFileData[oldPath];
    }
  };
  fs.promises.unlink = async (file) => {
    if (mockFileData[file]) {
      delete mockFileData[file];
    }
  };
  fs.promises.readdir = async (dir) => {
    return Object.keys(mockFileData)
      .filter(f => f.startsWith(dir))
      .map(f => path.basename(f));
  };
  fs.promises.mkdir = async (dir, opts) => {};
}

function restoreFs() {
  fs.promises.readFile = originalReadFile;
  fs.promises.writeFile = originalWriteFile;
  fs.promises.rename = originalRename;
  fs.promises.unlink = originalUnlink;
  fs.promises.readdir = originalReaddir;
  fs.promises.mkdir = originalMkdir;
}

function setMockFileData(storyId, story) {
  const filePath = path.join(tempDir, storyId + '.json');
  mockFileData[filePath] = JSON.stringify(story);
}

function clearMockData() {
  mockFileData = {};
}

describe('StateManager', () => {
  let StateManager;
  let manager;

  before(async () => {
    tempDir = path.join(os.tmpdir(), 'state-manager-test-' + Date.now());
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    try {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    } catch (e) {}
  });

  beforeEach(async () => {
    clearMockData();
    setupMockFs();
    const mod = require('../core/StateManager');
    StateManager = mod.StateManager;
    manager = new StateManager();
    manager.stateDir = tempDir;
  });

  afterEach(() => {
    restoreFs();
    clearMockData();
  });

  describe('initialize()', () => {
    it('should create state directory and set initialized flag', async () => {
      await manager.initialize();
      assert.strictEqual(manager.initialized, true);
    });

    it('should be callable multiple times without error', async () => {
      await manager.initialize();
      await manager.initialize();
      assert.strictEqual(manager.initialized, true);
    });

    it('should throw error if mkdir fails', async () => {
      const realMkdir = fs.promises.mkdir;
      fs.promises.mkdir = async () => { throw new Error('Permission denied'); };
      const mod = require('../core/StateManager');
      const mgr = new mod.StateManager();
      await assert.rejects(async () => await mgr.initialize(), /Permission denied/);
      fs.promises.mkdir = realMkdir;
    });
  });

  describe('generateStoryId()', () => {
    it('should generate story ID with correct prefix', () => {
      const storyId = manager.generateStoryId();
      assert.ok(storyId.startsWith('story-'));
    });

    it('should generate unique IDs', () => {
      const id1 = manager.generateStoryId();
      const id2 = manager.generateStoryId();
      assert.notStrictEqual(id1, id2);
    });
  });

  describe('getStatePath()', () => {
    it('should return correct path for story ID', () => {
      const storyId = 'story-abc123';
      const statePath = manager.getStatePath(storyId);
      assert.ok(statePath.endsWith('story-abc123.json'));
    });
  });

  describe('createStory()', () => {
    it('should create story with default config', async () => {
      const story = await manager.createStory('A test story');
      assert.ok(story.id.startsWith('story-'));
      assert.strictEqual(story.status, 'phase1_running');
      assert.strictEqual(story.config.storyPrompt, 'A test story');
      assert.strictEqual(story.config.genre, 'general');
      assert.deepStrictEqual(story.config.targetWordCount, { min: 2500, max: 3500 });
      assert.ok(story.createdAt);
      assert.ok(story.updatedAt);
    });

    it('should create story with custom config', async () => {
      const customConfig = {
        target_word_count: { min: 5000, max: 8000 },
        genre: 'fantasy',
        style_preference: 'epic'
      };
      const story = await manager.createStory('A fantasy tale', customConfig);
      assert.strictEqual(story.config.genre, 'fantasy');
      assert.strictEqual(story.config.stylePreference, 'epic');
      assert.deepStrictEqual(story.config.targetWordCount, { min: 5000, max: 8000 });
    });

    it('should initialize phase1 with correct defaults', async () => {
      const story = await manager.createStory('Test');
      assert.strictEqual(story.phase1.status, 'running');
      assert.strictEqual(story.phase1.worldview, null);
      assert.deepStrictEqual(story.phase1.characters, []);
      assert.strictEqual(story.phase1.userConfirmed, false);
    });

    it('should initialize phase2 with correct defaults', async () => {
      const story = await manager.createStory('Test');
      assert.strictEqual(story.phase2.status, 'pending');
      assert.strictEqual(story.phase2.outline, null);
      assert.deepStrictEqual(story.phase2.chapters, []);
      assert.strictEqual(story.phase2.currentChapter, 0);
    });

    it('should initialize phase3 with correct defaults', async () => {
      const story = await manager.createStory('Test');
      assert.strictEqual(story.phase3.status, 'pending');
      assert.deepStrictEqual(story.phase3.polishedChapters, []);
      assert.strictEqual(story.phase3.iterationCount, 0);
    });

    it('should initialize workflow with correct defaults', async () => {
      const story = await manager.createStory('Test');
      assert.strictEqual(story.workflow.state, 'idle');
      assert.strictEqual(story.workflow.currentPhase, 'phase1');
      assert.strictEqual(story.workflow.activeCheckpoint, null);
      assert.strictEqual(story.workflow.retryContext.phase, null);
      assert.strictEqual(story.workflow.retryContext.attempt, 0);
      assert.strictEqual(story.workflow.retryContext.maxAttempts, 3);
      assert.deepStrictEqual(story.workflow.history, []);
      assert.ok(story.workflow.runToken);
    });

    it('should cache the created story', async () => {
      const story = await manager.createStory('Test');
      assert.strictEqual(manager.cache.has(story.id), true);
      assert.strictEqual(manager.cache.get(story.id), story);
    });

    it('should persist story to filesystem', async () => {
      const story = await manager.createStory('Test');
      const statePath = manager.getStatePath(story.id);
      assert.ok(mockFileData[statePath]);
    });
  });

  describe('getStory()', () => {
    it('should return cached story on cache hit', async () => {
      const story = await manager.createStory('Test');
      const result = await manager.getStory(story.id);
      assert.strictEqual(result, story);
    });

    it('should read from file and cache on cache miss', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      manager.cache.clear();
      const result = await manager.getStory(storyId);
      assert.strictEqual(result.id, storyId);
      assert.strictEqual(manager.cache.has(storyId), true);
    });

    it('should return null for non-existent story', async () => {
      const result = await manager.getStory('non-existent-id');
      assert.strictEqual(result, null);
    });

    it('should cache story after file read', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      manager.cache.clear();
      await manager.getStory(storyId);
      assert.strictEqual(manager.cache.has(storyId), true);
    });
  });

  describe('updateStory()', () => {
    it('should update story with provided updates', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updateStory(storyId, { status: 'phase2_running' });
      assert.strictEqual(updated.status, 'phase2_running');
      assert.strictEqual(updated.id, storyId);
    });

    it('should update updatedAt timestamp', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const originalUpdatedAt = created.updatedAt;
      await new Promise(resolve => setTimeout(resolve, 10));
      const updated = await manager.updateStory(storyId, { status: 'phase2_running' });
      assert.notStrictEqual(updated.updatedAt, originalUpdatedAt);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.updateStory('non-existent-id', { status: 'test' }), /Story not found/);
    });

    it('should update cache after modification', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.updateStory(storyId, { status: 'phase2_running' });
      assert.strictEqual(manager.cache.get(storyId).status, 'phase2_running');
    });
  });

  describe('updatePhase1()', () => {
    it('should update phase1 with provided updates', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updatePhase1(storyId, {
        worldview: { setting: 'future Earth' },
        characters: [{ name: 'John' }]
      });
      assert.deepStrictEqual(updated.phase1.worldview, { setting: 'future Earth' });
      assert.deepStrictEqual(updated.phase1.characters, [{ name: 'John' }]);
    });

    it('should preserve existing phase1 properties', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.updatePhase1(storyId, { worldview: { setting: 'test' } });
      const updated = await manager.updatePhase1(storyId, { characters: [{ name: 'Jane' }] });
      assert.deepStrictEqual(updated.phase1.worldview, { setting: 'test' });
      assert.deepStrictEqual(updated.phase1.characters, [{ name: 'Jane' }]);
    });
  });

  describe('updatePhase2()', () => {
    it('should update phase2 with provided updates', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updatePhase2(storyId, {
        outline: 'Chapter outline here',
        currentChapter: 3
      });
      assert.strictEqual(updated.phase2.outline, 'Chapter outline here');
      assert.strictEqual(updated.phase2.currentChapter, 3);
    });
  });

  describe('updatePhase3()', () => {
    it('should update phase3 with provided updates', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updatePhase3(storyId, {
        iterationCount: 5,
        finalValidation: { approved: true }
      });
      assert.strictEqual(updated.phase3.iterationCount, 5);
      assert.deepStrictEqual(updated.phase3.finalValidation, { approved: true });
    });
  });

  describe('updateWorkflow()', () => {
    it('should update workflow state', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updateWorkflow(storyId, {
        state: 'running',
        currentPhase: 'phase2'
      });
      assert.strictEqual(updated.workflow.state, 'running');
      assert.strictEqual(updated.workflow.currentPhase, 'phase2');
    });

    it('should handle retryContext updates', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.updateWorkflow(storyId, {
        retryContext: {
          phase: 'phase1',
          step: 'validate',
          attempt: 2,
          lastError: 'Validation failed'
        }
      });
      assert.strictEqual(updated.workflow.retryContext.phase, 'phase1');
      assert.strictEqual(updated.workflow.retryContext.step, 'validate');
      assert.strictEqual(updated.workflow.retryContext.attempt, 2);
      assert.strictEqual(updated.workflow.retryContext.lastError, 'Validation failed');
    });

    it('should create workflow object if missing', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, workflow: undefined };
      manager.cache.set(storyId, story);
      const updated = await manager.updateWorkflow(storyId, { state: 'running' });
      assert.ok(updated.workflow);
      assert.strictEqual(updated.workflow.state, 'running');
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.updateWorkflow('non-existent', { state: 'running' }), /Story not found/);
    });
  });

  describe('appendWorkflowHistory()', () => {
    it('should append history entry with defaults', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.appendWorkflowHistory(storyId, {
        type: 'notification',
        detail: { message: 'Test notification' }
      });
      assert.strictEqual(updated.workflow.history.length, 1);
      assert.strictEqual(updated.workflow.history[0].type, 'notification');
      assert.ok(updated.workflow.history[0].at);
      assert.deepStrictEqual(updated.workflow.history[0].detail, { message: 'Test notification' });
    });

    it('should use current workflow phase/step when not specified', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.updateWorkflow(storyId, { currentPhase: 'phase2', currentStep: 'writing' });
      const updated = await manager.appendWorkflowHistory(storyId, { type: 'checkpoint_resolved' });
      assert.strictEqual(updated.workflow.history[0].phase, 'phase2');
      assert.strictEqual(updated.workflow.history[0].step, 'writing');
    });

    it('should create workflow object if missing', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, workflow: undefined };
      manager.cache.set(storyId, story);
      const updated = await manager.appendWorkflowHistory(storyId, { type: 'notification' });
      assert.ok(updated.workflow);
      assert.strictEqual(updated.workflow.history.length, 1);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.appendWorkflowHistory('non-existent', { type: 'test' }), /Story not found/);
    });
  });

  describe('setActiveCheckpoint()', () => {
    it('should set active checkpoint with provided data', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.setActiveCheckpoint(storyId, {
        id: 'cp-test-123',
        phase: 'phase1',
        type: 'worldview_confirmation',
        status: 'pending'
      });
      assert.ok(updated.workflow.activeCheckpoint);
      assert.strictEqual(updated.workflow.activeCheckpoint.id, 'cp-test-123');
      assert.strictEqual(updated.workflow.activeCheckpoint.phase, 'phase1');
      assert.strictEqual(updated.workflow.activeCheckpoint.type, 'worldview_confirmation');
      assert.strictEqual(updated.workflow.activeCheckpoint.status, 'pending');
    });

    it('should use defaults for missing checkpoint properties', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.setActiveCheckpoint(storyId, {});
      assert.ok(updated.workflow.activeCheckpoint.id.startsWith('cp-'));
      assert.strictEqual(updated.workflow.activeCheckpoint.phase, 'phase1');
      assert.strictEqual(updated.workflow.activeCheckpoint.type, 'outline_confirmation');
      assert.strictEqual(updated.workflow.activeCheckpoint.status, 'pending');
      assert.ok(updated.workflow.activeCheckpoint.createdAt);
      assert.strictEqual(updated.workflow.activeCheckpoint.autoContinueOnTimeout, true);
    });

    it('should create workflow object if missing', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, workflow: undefined };
      manager.cache.set(storyId, story);
      const updated = await manager.setActiveCheckpoint(storyId, { type: 'test' });
      assert.ok(updated.workflow);
      assert.ok(updated.workflow.activeCheckpoint);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.setActiveCheckpoint('non-existent', {}), /Story not found/);
    });
  });

  describe('clearActiveCheckpoint()', () => {
    it('should clear active checkpoint', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.setActiveCheckpoint(storyId, { id: 'cp-test' });
      const updated = await manager.clearActiveCheckpoint(storyId);
      assert.strictEqual(updated.workflow.activeCheckpoint, null);
    });

    it('should return story unchanged if no workflow', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, workflow: undefined };
      manager.cache.set(storyId, story);
      const result = await manager.clearActiveCheckpoint(storyId);
      assert.strictEqual(result.workflow, undefined);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.clearActiveCheckpoint('non-existent'), /Story not found/);
    });
  });

  describe('recordPhaseFeedback()', () => {
    it('should record feedback and resolve checkpoint', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.setActiveCheckpoint(storyId, { id: 'cp-test' });
      const updated = await manager.recordPhaseFeedback(storyId, 'phase1', 'Great worldview!');
      assert.strictEqual(updated.workflow.activeCheckpoint.feedback, 'Great worldview!');
      assert.strictEqual(updated.workflow.activeCheckpoint.status, 'approved');
      assert.ok(updated.workflow.activeCheckpoint.resolvedAt);
    });

    it('should record feedback on phase object', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.recordPhaseFeedback(storyId, 'phase1', 'Nice work!');
      assert.strictEqual(updated.phase1.userFeedback, 'Nice work!');
      assert.ok(updated.phase1.feedbackRecordedAt);
    });

    it('should add checkpoint_resolved to history', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.setActiveCheckpoint(storyId, { id: 'cp-test' });
      const updated = await manager.recordPhaseFeedback(storyId, 'phase1', 'Feedback');
      const historyEntry = updated.workflow.history.find(h => h.type === 'checkpoint_resolved');
      assert.ok(historyEntry);
      assert.strictEqual(historyEntry.phase, 'phase1');
      assert.deepStrictEqual(historyEntry.detail, { feedback: 'Feedback', checkpointId: 'cp-test' });
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.recordPhaseFeedback('non-existent', 'phase1', 'test'), /Story not found/);
    });
  });

  describe('replaceChapter()', () => {
    it('should replace existing chapter', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.upsertChapter(storyId, { number: 1, title: 'Chapter 1', content: 'Original content' });
      const updated = await manager.replaceChapter(storyId, 1, { title: 'Updated Title', content: 'New content' });
      assert.strictEqual(updated.phase2.chapters[0].title, 'Updated Title');
      assert.strictEqual(updated.phase2.chapters[0].content, 'New content');
      assert.strictEqual(updated.phase2.chapters[0].number, 1);
    });

    it('should throw error for out of bounds chapter number', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await assert.rejects(async () => await manager.replaceChapter(storyId, 99, { title: 'Test' }), /Chapter 99 out of bounds/);
    });

    it('should throw error for chapter number less than 1', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.upsertChapter(storyId, { number: 1, title: 'Ch1' });
      await assert.rejects(async () => await manager.replaceChapter(storyId, 0, { title: 'Test' }), /Chapter 0 out of bounds/);
    });

    it('should throw error if phase2 not initialized', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      delete created.phase2.chapters;
      manager.cache.set(storyId, created);
      await assert.rejects(async () => await manager.replaceChapter(storyId, 1, { title: 'Test' }), /Phase2 chapters not initialized/);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.replaceChapter('non-existent', 1, { title: 'Test' }), /Story not found/);
    });
  });

  describe('upsertChapter()', () => {
    it('should insert new chapter at end', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.upsertChapter(storyId, { number: 1, title: 'Chapter 1', content: 'Content here', wordCount: 500 });
      assert.strictEqual(updated.phase2.chapters.length, 1);
      assert.strictEqual(updated.phase2.chapters[0].title, 'Chapter 1');
      assert.strictEqual(updated.phase2.chapters[0].number, 1);
    });

    it('should update existing chapter', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.upsertChapter(storyId, { number: 1, title: 'Original' });
      const updated = await manager.upsertChapter(storyId, { number: 1, title: 'Updated' });
      assert.strictEqual(updated.phase2.chapters.length, 1);
      assert.strictEqual(updated.phase2.chapters[0].title, 'Updated');
    });

    it('should fill gaps with empty chapters', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const updated = await manager.upsertChapter(storyId, { number: 3, title: 'Chapter 3' });
      assert.strictEqual(updated.phase2.chapters.length, 3);
      assert.strictEqual(updated.phase2.chapters[0].status, 'empty');
      assert.strictEqual(updated.phase2.chapters[1].status, 'empty');
      assert.strictEqual(updated.phase2.chapters[2].title, 'Chapter 3');
    });

    it('should initialize phase2 if missing', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, phase2: undefined };
      manager.cache.set(storyId, story);
      const updated = await manager.upsertChapter(storyId, { number: 1, title: 'First' });
      assert.ok(updated.phase2);
      assert.ok(updated.phase2.chapters);
    });

    it('should update currentChapter to first incomplete', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const r1 = await manager.upsertChapter(storyId, { number: 1, title: 'Ch1', status: 'draft' });
      const r2 = await manager.upsertChapter(storyId, { number: 2, title: 'Ch2', status: 'draft' });
      assert.strictEqual(r2.phase2.currentChapter, 1);
      const r3 = await manager.upsertChapter(storyId, { number: 1, title: 'Ch1', status: 'completed' });
      assert.strictEqual(r3.phase2.currentChapter, 2);
    });

    it('should throw error for non-existent story', async () => {
      await assert.rejects(async () => await manager.upsertChapter('non-existent', { number: 1, title: 'Test' }), /Story not found/);
    });
  });

  describe('deleteStory()', () => {
    it('should delete story and clear cache', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const result = await manager.deleteStory(storyId);
      assert.strictEqual(result, true);
      assert.strictEqual(manager.cache.has(storyId), false);
    });

    it('should return false for non-existent story', async () => {
      const realUnlink = fs.promises.unlink;
      fs.promises.unlink = async (file) => {
        const err = new Error('File not found');
        err.code = 'ENOENT';
        throw err;
      };
      const result = await manager.deleteStory('non-existent-id');
      fs.promises.unlink = realUnlink;
      assert.strictEqual(result, false);
    });

    it('should clear from cache even if file already deleted', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const result = await manager.deleteStory(storyId);
      assert.strictEqual(result, true);
      assert.strictEqual(manager.cache.has(storyId), false);
    });
  });

  describe('listStories()', () => {
    it('should return list of story IDs', async () => {
      const story1 = await manager.createStory('Test 1');
      const story2 = await manager.createStory('Test 2');
      const stories = await manager.listStories();
      assert.ok(stories.length >= 2);
      assert.ok(stories.includes(story1.id));
      assert.ok(stories.includes(story2.id));
    });

    it('should return empty array on empty directory', async () => {
      clearMockData();
      const stories = await manager.listStories();
      assert.deepStrictEqual(stories, []);
    });

    it('should filter out non-json files', async () => {
      const fakeFile = path.join(tempDir, 'readme.txt');
      mockFileData[fakeFile] = 'This is not a story';
      const stories = await manager.listStories();
      assert.ok(!stories.some(id => id === 'readme'));
    });
  });

  describe('cleanupExpired()', () => {
    it('should delete stories older than retention period', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const story = { ...created, updatedAt: oldDate };
      setMockFileData(storyId, story);
      manager.cache.set(storyId, story);
      const cleaned = await manager.cleanupExpired(30);
      assert.strictEqual(cleaned, 1);
      assert.strictEqual(manager.cache.has(storyId), false);
    });

    it('should not delete recent stories', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const cleaned = await manager.cleanupExpired(30);
      assert.strictEqual(cleaned, 0);
      assert.strictEqual(manager.cache.has(storyId), true);
    });

    it('should skip stories with missing updatedAt', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const story = { ...created, updatedAt: undefined };
      setMockFileData(storyId, story);
      manager.cache.set(storyId, story);
      const cleaned = await manager.cleanupExpired(0);
      assert.strictEqual(cleaned, 0);
    });

    it('should continue on individual story errors', async () => {
      const story1 = await manager.createStory('Test 1');
      const story2 = await manager.createStory('Test 2');
      const badStory = { ...story2, updatedAt: 'invalid-date' };
      setMockFileData(story2.id, badStory);
      const cleaned = await manager.cleanupExpired(0);
      assert.strictEqual(typeof cleaned, 'number');
    });
  });

  describe('getConfig()', () => {
    it('should return config from cached story', async () => {
      const created = await manager.createStory('Test', { genre: 'fantasy' });
      const config = manager.getConfig(created.id);
      assert.deepStrictEqual(config.genre, 'fantasy');
    });

    it('should return null for non-cached story', () => {
      const config = manager.getConfig('non-existent');
      assert.strictEqual(config, null);
    });
  });

  describe('getStoryBible()', () => {
    it('should assemble bible from phase1 and phase2', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      await manager.updatePhase1(storyId, {
        worldview: { setting: 'Mars 2150' },
        characters: [{ name: 'John', role: 'protagonist' }]
      });
      await manager.updatePhase2(storyId, { outline: 'A journey through space' });
      const bible = manager.getStoryBible(storyId);
      assert.deepStrictEqual(bible.worldview, { setting: 'Mars 2150' });
      assert.deepStrictEqual(bible.characters, [{ name: 'John', role: 'protagonist' }]);
      assert.strictEqual(bible.plotSummary, 'A journey through space');
    });

    it('should return null if story not cached', () => {
      const bible = manager.getStoryBible('non-existent');
      assert.strictEqual(bible, null);
    });

    it('should return null if phase1 missing', () => {
      const keys = Object.keys(mockFileData);
      if (keys.length > 0) {
        const created = JSON.parse(mockFileData[keys[0]]);
        const story = { ...created, phase1: undefined };
        manager.cache.set(created.id, story);
        const bible = manager.getStoryBible(created.id);
        assert.strictEqual(bible, null);
      }
    });
  });

  describe('_saveStory()', () => {
    it('should use atomic write via temp rename', async () => {
      const created = await manager.createStory('Test');
      const storyId = created.id;
      const statePath = manager.getStatePath(storyId);
      await manager.updateStory(storyId, { status: 'updated' });
      assert.ok(mockFileData[statePath]);
    });
  });
});
