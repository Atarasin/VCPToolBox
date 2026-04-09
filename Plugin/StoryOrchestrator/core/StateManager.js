const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STATE_DIR = path.join(__dirname, '..', 'state', 'stories');

class StateManager {
  constructor() {
    this.cache = new Map();
    this.initialized = false;
  }

  async initialize() {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      this.initialized = true;
      console.log('[StateManager] Initialized');
    } catch (error) {
      console.error('[StateManager] Initialization failed:', error);
      throw error;
    }
  }

  generateStoryId() {
    return `story-${uuidv4().replace(/-/g, '').substring(0, 12)}`;
  }

  getStatePath(storyId) {
    return path.join(STATE_DIR, `${storyId}.json`);
  }

  async createStory(storyPrompt, config = {}) {
    const storyId = this.generateStoryId();
    const now = new Date().toISOString();

    const story = {
      id: storyId,
      status: 'phase1_running',
      createdAt: now,
      updatedAt: now,
      config: {
        targetWordCount: config.target_word_count || { min: 2500, max: 3500 },
        genre: config.genre || 'general',
        stylePreference: config.style_preference || '',
        storyPrompt: storyPrompt
      },
      phase1: {
        worldview: null,
        characters: [],
        validation: null,
        userConfirmed: false,
        checkpointId: null,
        status: 'running'
      },
      phase2: {
        outline: null,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      },
      phase3: {
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      },
      finalOutput: null,
      workflow: {
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
        runToken: uuidv4()
      }
    };

    await this._saveStory(storyId, story);
    this.cache.set(storyId, story);

    return story;
  }

  async getStory(storyId) {
    if (this.cache.has(storyId)) {
      return this.cache.get(storyId);
    }

    try {
      const data = await fs.readFile(this.getStatePath(storyId), 'utf8');
      const story = JSON.parse(data);
      this.cache.set(storyId, story);
      return story;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async updateStory(storyId, updates) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const updated = {
      ...story,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    await this._saveStory(storyId, updated);
    this.cache.set(storyId, updated);

    return updated;
  }

  async updatePhase1(storyId, updates) {
    const story = await this.getStory(storyId);
    story.phase1 = { ...story.phase1, ...updates };
    return this.updateStory(storyId, story);
  }

  async updatePhase2(storyId, updates) {
    const story = await this.getStory(storyId);
    story.phase2 = { ...story.phase2, ...updates };
    return this.updateStory(storyId, story);
  }

  async updatePhase3(storyId, updates) {
    const story = await this.getStory(storyId);
    story.phase3 = { ...story.phase3, ...updates };
    return this.updateStory(storyId, story);
  }

  async updateWorkflow(storyId, updates) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (!story.workflow) {
      story.workflow = {
        state: 'idle',
        currentPhase: null,
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
        runToken: uuidv4()
      };
    }

    if (updates.retryContext !== undefined) {
      story.workflow.retryContext = {
        ...story.workflow.retryContext,
        ...updates.retryContext
      };
    }

    story.workflow = {
      ...story.workflow,
      ...updates,
      retryContext: story.workflow.retryContext
    };

    return this.updateStory(storyId, story);
  }

  async appendWorkflowHistory(storyId, entry) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (!story.workflow) {
      story.workflow = {
        state: 'idle',
        currentPhase: null,
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
        runToken: uuidv4()
      };
    }

    const historyEntry = {
      at: entry.at || new Date().toISOString(),
      type: entry.type || 'notification',
      phase: entry.phase !== undefined ? entry.phase : story.workflow.currentPhase,
      step: entry.step !== undefined ? entry.step : story.workflow.currentStep,
      detail: entry.detail || {}
    };

    story.workflow.history.push(historyEntry);
    return this.updateStory(storyId, story);
  }

  async setActiveCheckpoint(storyId, checkpoint) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (!story.workflow) {
      story.workflow = {
        state: 'idle',
        currentPhase: null,
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
        runToken: uuidv4()
      };
    }

    story.workflow.activeCheckpoint = {
      id: checkpoint.id || `cp-${uuidv4().replace(/-/g, '').substring(0, 8)}`,
      phase: checkpoint.phase || story.workflow.currentPhase,
      type: checkpoint.type || 'outline_confirmation',
      status: checkpoint.status || 'pending',
      createdAt: checkpoint.createdAt || new Date().toISOString(),
      expiresAt: checkpoint.expiresAt || null,
      autoContinueOnTimeout: checkpoint.autoContinueOnTimeout !== undefined ? checkpoint.autoContinueOnTimeout : true,
      feedback: checkpoint.feedback || ''
    };

    return this.updateStory(storyId, story);
  }

  async clearActiveCheckpoint(storyId) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (story.workflow) {
      story.workflow.activeCheckpoint = null;
      return this.updateStory(storyId, story);
    }

    return story;
  }

  async recordPhaseFeedback(storyId, phaseName, feedback, resolutionStatus = 'approved') {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const now = new Date().toISOString();

    if (story.workflow.activeCheckpoint) {
      story.workflow.activeCheckpoint.feedback = feedback;
      story.workflow.activeCheckpoint.status = resolutionStatus;
      story.workflow.activeCheckpoint.resolvedAt = now;
    }

    if (story[phaseName]) {
      story[phaseName].userFeedback = feedback;
      story[phaseName].feedbackRecordedAt = now;
    }

    if (story.workflow) {
      story.workflow.history.push({
        at: now,
        type: 'checkpoint_resolved',
        phase: phaseName,
        step: story.workflow.currentStep,
        detail: { feedback, checkpointId: story.workflow.activeCheckpoint?.id, resolutionStatus }
      });
    }

    return this.updateStory(storyId, story);
  }

  async replaceChapter(storyId, chapterNumber, chapterData) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const index = chapterNumber - 1;

    if (!story.phase2 || !story.phase2.chapters) {
      throw new Error('Phase2 chapters not initialized');
    }

    if (index < 0 || index >= story.phase2.chapters.length) {
      throw new Error(`Chapter ${chapterNumber} out of bounds (1-${story.phase2.chapters.length})`);
    }

    story.phase2.chapters[index] = {
      ...story.phase2.chapters[index],
      ...chapterData,
      number: chapterNumber,
      updatedAt: new Date().toISOString()
    };

    return this.updateStory(storyId, story);
  }

  async upsertChapter(storyId, chapterData) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (!story.phase2) {
      story.phase2 = {
        outline: null,
        chapters: [],
        currentChapter: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending'
      };
    }

    if (!story.phase2.chapters) {
      story.phase2.chapters = [];
    }

    const chapterNumber = chapterData.number;
    const index = chapterNumber - 1;

    const now = new Date().toISOString();
    const baseChapter = {
      number: chapterNumber,
      title: '',
      content: '',
      wordCount: 0,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
      ...chapterData
    };

    if (index >= 0 && index < story.phase2.chapters.length) {
      story.phase2.chapters[index] = {
        ...story.phase2.chapters[index],
        ...baseChapter,
        updatedAt: now
      };
    } else if (index === story.phase2.chapters.length) {
      story.phase2.chapters.push(baseChapter);
    } else {
      while (story.phase2.chapters.length < index) {
        story.phase2.chapters.push({
          number: story.phase2.chapters.length + 1,
          title: '',
          content: '',
          wordCount: 0,
          status: 'empty',
          createdAt: now,
          updatedAt: now
        });
      }
      story.phase2.chapters.push(baseChapter);
    }

    if (story.phase2.currentChapter === 0 || chapterNumber <= story.phase2.currentChapter) {
      const firstIncomplete = story.phase2.chapters.findIndex(c => c.status !== 'completed');
      story.phase2.currentChapter = firstIncomplete >= 0 ? firstIncomplete + 1 : story.phase2.chapters.length;
    }

    return this.updateStory(storyId, story);
  }

  async _saveStory(storyId, story) {
    const statePath = this.getStatePath(storyId);
    const tempPath = `${statePath}.tmp`;

    try {
      await fs.writeFile(tempPath, JSON.stringify(story, null, 2), 'utf8');
      await fs.rename(tempPath, statePath);
    } catch (error) {
      try {
        await fs.unlink(tempPath);
      } catch {}
      throw error;
    }
  }

  async deleteStory(storyId) {
    try {
      await fs.unlink(this.getStatePath(storyId));
      this.cache.delete(storyId);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async listStories() {
    try {
      const files = await fs.readdir(STATE_DIR);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch {
      return [];
    }
  }

  async cleanupExpired(retentionDays = 30) {
    const stories = await this.listStories();
    const now = Date.now();
    const maxAge = retentionDays * 24 * 60 * 60 * 1000;

    let cleaned = 0;
    for (const storyId of stories) {
      try {
        const story = await this.getStory(storyId);
        if (story && story.updatedAt) {
          const age = now - new Date(story.updatedAt).getTime();
          if (age > maxAge) {
            await this.deleteStory(storyId);
            cleaned++;
          }
        }
      } catch (error) {
        console.error(`[StateManager] Cleanup error for ${storyId}:`, error);
      }
    }

    return cleaned;
  }

  getConfig(storyId) {
    const story = this.cache.get(storyId);
    return story?.config || null;
  }

  getStoryBible(storyId) {
    const story = this.cache.get(storyId);
    if (!story || !story.phase1) return null;

    return {
      worldview: story.phase1.worldview,
      characters: story.phase1.characters,
      plotSummary: story.phase2?.outline
    };
  }
}

module.exports = { StateManager };
