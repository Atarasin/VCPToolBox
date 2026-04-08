'use strict';

const path = require('path');

const mockFsPromises = {
  mkdir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
  unlink: jest.fn(),
  readdir: jest.fn()
};

const mockUuidV4 = jest.fn();

jest.mock('fs', () => ({
  promises: mockFsPromises
}));

jest.mock('uuid', () => ({
  v4: mockUuidV4
}));

const { StateManager } = require('../core/StateManager');

describe('StateManager', () => {
  const stateDir = path.join(__dirname, '..', 'state', 'stories');

  beforeEach(() => {
    jest.clearAllMocks();
    mockFsPromises.mkdir.mockResolvedValue(undefined);
    mockFsPromises.readFile.mockResolvedValue(undefined);
    mockFsPromises.writeFile.mockResolvedValue(undefined);
    mockFsPromises.rename.mockResolvedValue(undefined);
    mockFsPromises.unlink.mockResolvedValue(undefined);
    mockFsPromises.readdir.mockResolvedValue([]);
    mockUuidV4
      .mockReturnValueOnce('12345678-1234-1234-1234-123456789abc')
      .mockReturnValueOnce('abcdefab-cdef-cdef-cdef-abcdefabcdef');
  });

  describe('constructor()', () => {
    test('initializes cache, initialized flag, and internal state path resolution', () => {
      const manager = new StateManager();

      expect(manager.cache).toBeInstanceOf(Map);
      expect(manager.initialized).toBe(false);
      expect(manager.getStatePath('story-001')).toBe(path.join(stateDir, 'story-001.json'));
    });
  });

  describe('getStory()', () => {
    test('loads story state from JSON and caches it', async () => {
      const manager = new StateManager();
      const storyId = 'story-load-001';
      const storyState = {
        id: storyId,
        status: 'phase2_running',
        workflow: { state: 'running' }
      };

      mockFsPromises.readFile.mockResolvedValueOnce(JSON.stringify(storyState));

      const loaded = await manager.getStory(storyId);

      expect(mockFsPromises.readFile).toHaveBeenCalledWith(
        path.join(stateDir, `${storyId}.json`),
        'utf8'
      );
      expect(loaded).toEqual(storyState);
      expect(manager.cache.get(storyId)).toEqual(storyState);
    });
  });

  describe('_saveStory()', () => {
    test('saves story state using atomic temp write then rename', async () => {
      const manager = new StateManager();
      const storyId = 'story-save-001';
      const storyState = {
        id: storyId,
        status: 'completed',
        finalOutput: 'done'
      };
      const statePath = path.join(stateDir, `${storyId}.json`);
      const tempPath = `${statePath}.tmp`;

      await manager._saveStory(storyId, storyState);

      expect(mockFsPromises.writeFile).toHaveBeenCalledWith(
        tempPath,
        JSON.stringify(storyState, null, 2),
        'utf8'
      );
      expect(mockFsPromises.rename).toHaveBeenCalledWith(tempPath, statePath);
      expect(mockFsPromises.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        mockFsPromises.rename.mock.invocationCallOrder[0]
      );
    });
  });

  describe('createStory()', () => {
    test('creates a new story with initial state and persists it', async () => {
      const manager = new StateManager();

      const story = await manager.createStory('A detective enters a time loop', {
        genre: 'mystery',
        target_word_count: { min: 1800, max: 2200 },
        style_preference: 'tight pacing'
      });

      expect(story.id).toBe('story-123456781234');
      expect(story.status).toBe('phase1_running');
      expect(story.config).toEqual({
        targetWordCount: { min: 1800, max: 2200 },
        genre: 'mystery',
        stylePreference: 'tight pacing',
        storyPrompt: 'A detective enters a time loop'
      });
      expect(story.phase1.status).toBe('running');
      expect(story.phase2.status).toBe('pending');
      expect(story.phase3.status).toBe('pending');
      expect(story.workflow).toMatchObject({
        state: 'idle',
        currentPhase: 'phase1',
        currentStep: null,
        activeCheckpoint: null,
        retryContext: {
          phase: null,
          step: null,
          attempt: 0,
          maxAttempts: 3,
          lastError: null
        },
        history: [],
        runToken: 'abcdefab-cdef-cdef-cdef-abcdefabcdef'
      });
      expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
      expect(mockFsPromises.rename).toHaveBeenCalledTimes(1);
      expect(manager.cache.get(story.id)).toEqual(story);
    });
  });

  describe('updateWorkflow()', () => {
    test('updates workflow state while preserving and merging retry context', async () => {
      const manager = new StateManager();
      const storyId = 'story-workflow-001';
      const storyState = {
        id: storyId,
        status: 'phase1_running',
        updatedAt: '2026-04-01T00:00:00.000Z',
        workflow: {
          state: 'idle',
          currentPhase: 'phase1',
          currentStep: null,
          activeCheckpoint: null,
          retryContext: {
            phase: 'phase1',
            step: 'draft',
            attempt: 1,
            maxAttempts: 3,
            lastError: null
          },
          history: [],
          runToken: 'run-1'
        }
      };

      manager.cache.set(storyId, storyState);

      const updated = await manager.updateWorkflow(storyId, {
        state: 'waiting_checkpoint',
        currentStep: 'user_confirmation',
        retryContext: {
          attempt: 2,
          lastError: 'validation failed'
        }
      });

      expect(updated.workflow).toMatchObject({
        state: 'waiting_checkpoint',
        currentPhase: 'phase1',
        currentStep: 'user_confirmation',
        retryContext: {
          phase: 'phase1',
          step: 'draft',
          attempt: 2,
          maxAttempts: 3,
          lastError: 'validation failed'
        },
        runToken: 'run-1'
      });
      expect(mockFsPromises.writeFile).toHaveBeenCalledTimes(1);
      expect(mockFsPromises.rename).toHaveBeenCalledTimes(1);
    });
  });

  describe('listStories()', () => {
    test('returns story ids derived from json files only', async () => {
      const manager = new StateManager();

      mockFsPromises.readdir.mockResolvedValueOnce([
        'story-alpha.json',
        'story-beta.json',
        'notes.txt',
        'story-gamma.tmp'
      ]);

      const storyIds = await manager.listStories();

      expect(mockFsPromises.readdir).toHaveBeenCalledWith(stateDir);
      expect(storyIds).toEqual(['story-alpha', 'story-beta']);
    });
  });
});
