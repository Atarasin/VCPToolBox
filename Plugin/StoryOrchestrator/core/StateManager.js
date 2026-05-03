const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { StoryStateRepository } = require('./StoryStateRepository');
const { ArtifactManager } = require('./ArtifactManager');

const STATE_DIR = path.join(__dirname, '..', 'state', 'stories');

class StateManager {
  constructor() {
    this.cache = new Map();
    this.initialized = false;
    this.repository = new StoryStateRepository();
    this.artifactManager = new ArtifactManager(this.repository);
  }

  async initialize() {
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      this.repository.initialize();
      await this.artifactManager.initialize();
      this.initialized = true;
      console.log('[StateManager] Initialized with SQLite + JSON dual-write');
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

  _createDefaultRetryContext() {
    return {
      phase: null,
      step: null,
      attempt: 0,
      maxAttempts: 3,
      lastError: null
    };
  }

  /**
   * StoryOrchestrator persists a compatibility-oriented workflow view alongside
   * business phase projections. This helper keeps that shape explicit so later
   * convergence work can tighten the boundary without chasing repeated literals.
   */
  _createWorkflowCompatibilityState(overrides = {}) {
    return {
      state: 'idle',
      currentPhase: 'phase1',
      currentStep: null,
      activeCheckpoint: null,
      retryContext: {
        ...this._createDefaultRetryContext(),
        ...(overrides.retryContext || {})
      },
      history: [],
      runToken: overrides.runToken || uuidv4(),
      ...overrides
    };
  }

  _ensureWorkflowCompatibilityState(story) {
    if (!story.workflow) {
      story.workflow = this._createWorkflowCompatibilityState();
      return story.workflow;
    }

    story.workflow = this._createWorkflowCompatibilityState({
      ...story.workflow,
      retryContext: {
        ...this._createDefaultRetryContext(),
        ...(story.workflow.retryContext || {})
      },
      history: Array.isArray(story.workflow.history) ? story.workflow.history : []
    });

    return story.workflow;
  }

  _createDefaultPhaseProjection(phaseName) {
    const phaseDefaults = {
      phase1: { worldview: null, characters: [], validation: null, userConfirmed: false, checkpointId: null, status: 'pending' },
      phase2: { outline: null, chapters: [], currentChapter: 0, userConfirmed: false, checkpointId: null, status: 'pending' },
      phase3: { polishedChapters: [], finalValidation: null, iterationCount: 0, userConfirmed: false, checkpointId: null, status: 'pending' }
    };

    return {
      ...(phaseDefaults[phaseName] || {})
    };
  }

  _buildInitialStoryProjection(storyId, storyPrompt, config, now) {
    return {
      id: storyId,
      status: 'phase1_running',
      createdAt: now,
      updatedAt: now,
      config: {
        targetWordCount: typeof config.target_word_count === 'number'
          ? { min: Math.floor(config.target_word_count * 0.8), max: config.target_word_count }
          : (config.target_word_count || { min: 2500, max: 3500 }),
        genre: config.genre || 'general',
        stylePreference: config.style_preference || '',
        storyPrompt
      },
      phase1: {
        ...this._createDefaultPhaseProjection('phase1'),
        status: 'running'
      },
      phase2: this._createDefaultPhaseProjection('phase2'),
      phase3: this._createDefaultPhaseProjection('phase3'),
      finalOutput: null,
      workflow: this._createWorkflowCompatibilityState()
    };
  }

  _parseProjectionJson(payload, fallback) {
    if (!payload) {
      return fallback;
    }

    try {
      return JSON.parse(payload);
    } catch (error) {
      return fallback;
    }
  }

  _loadPhaseProjection(snapshotId, phaseName) {
    if (!snapshotId) {
      return this._createDefaultPhaseProjection(phaseName);
    }

    const snapshot = this.repository.getSnapshot(snapshotId);
    if (!snapshot) {
      return this._createDefaultPhaseProjection(phaseName);
    }

    const parsedPayload = this._parseProjectionJson(snapshot.payload_json, null);
    if (!parsedPayload || typeof parsedPayload !== 'object') {
      return this._createDefaultPhaseProjection(phaseName);
    }

    return {
      ...this._createDefaultPhaseProjection(phaseName),
      ...parsedPayload
    };
  }

  _buildActiveCheckpointCompatibilityView(checkpointRecord) {
    if (!checkpointRecord) {
      return null;
    }

    return {
      id: checkpointRecord.checkpoint_id,
      phase: checkpointRecord.phase_name,
      type: checkpointRecord.checkpoint_type,
      status: checkpointRecord.status,
      createdAt: checkpointRecord.created_at,
      expiresAt: checkpointRecord.expires_at,
      autoContinueOnTimeout: true,
      feedback: checkpointRecord.feedback || ''
    };
  }

  /**
   * Assemble the plugin-facing story projection from repository fields. The
   * resulting object intentionally combines business phase projections with a
   * compatibility-only workflow view, rather than claiming to re-create kernel
   * runtime truth from plugin storage alone.
   */
  _assembleStoryProjectionFromRow(row) {
    const finalOutput = this._parseProjectionJson(row.final_output_json, null);
    const retryContext = this._parseProjectionJson(row.retry_context_json, this._createDefaultRetryContext());
    const story = {
      id: row.story_id,
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config: this._parseProjectionJson(row.config_json, {}),
      phase1: this._loadPhaseProjection(row.current_phase1_snapshot_id, 'phase1'),
      phase2: this._loadPhaseProjection(row.current_phase2_snapshot_id, 'phase2'),
      phase3: this._loadPhaseProjection(row.current_phase3_snapshot_id, 'phase3'),
      finalOutput,
      workflow: this._createWorkflowCompatibilityState({
        state: row.workflow_state || (row.status === 'completed' ? 'completed' : 'idle'),
        currentPhase: row.current_phase,
        currentStep: row.current_step,
        activeCheckpoint: null,
        retryContext,
        history: [],
        runToken: uuidv4()
      })
    };

    if (row.active_checkpoint_id) {
      story.workflow.activeCheckpoint = this._buildActiveCheckpointCompatibilityView(
        this.repository.getCheckpoint(row.active_checkpoint_id)
      );
    }

    const events = this.repository.getEvents(row.story_id, { limit: 1000 });
    story.workflow.history = events.reverse().map((evt) => {
      const detail = this._parseProjectionJson(evt.event_detail_json, {});
      return {
        at: evt.created_at,
        type: evt.event_type,
        phase: evt.phase_name,
        step: detail.step || null,
        detail
      };
    });

    return story;
  }

  _applyWorkflowCompatibilityPatch(workflow, updates) {
    const nextWorkflow = this._createWorkflowCompatibilityState({
      ...workflow,
      ...updates,
      retryContext: {
        ...workflow.retryContext,
        ...(updates.retryContext || {})
      }
    });

    return nextWorkflow;
  }

  async createStory(storyPrompt, config = {}) {
    const storyId = this.generateStoryId();
    const now = new Date().toISOString();

    const story = this._buildInitialStoryProjection(storyId, storyPrompt, config, now);

    this.repository.createStory(storyId, story.config, now);

    await this._saveStory(storyId, story);
    this.cache.set(storyId, story);

    return story;
  }

  async getStory(storyId) {
    if (this.cache.has(storyId)) {
      const cached = this.cache.get(storyId);
      const row = this.repository.getStory(storyId);
      if (!row) {
        this.cache.delete(storyId);
        return null;
      }
      if (cached.version !== undefined && row.version !== undefined && cached.version !== row.version) {
        this.cache.delete(storyId);
        const assembled = this._assembleStoryFromSQLite(storyId);
        if (assembled) {
          this.cache.set(storyId, assembled);
          return assembled;
        }
        return null;
      }
      return cached;
    }

    const assembled = this._assembleStoryFromSQLite(storyId);
    if (assembled) {
      this.cache.set(storyId, assembled);
      return assembled;
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

  _assembleStoryFromSQLite(storyId) {
    const row = this.repository.getStoryWithFields(storyId);
    if (!row) return null;

    return this._assembleStoryProjectionFromRow(row);
  }

  async updateStory(storyId, updates, repoExtraUpdates = {}) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const updated = {
      ...story,
      ...updates,
      updatedAt: new Date().toISOString()
    };

    const repoUpdates = { ...repoExtraUpdates };
    if (updates.status !== undefined) repoUpdates.status = updates.status;
    if (updates.config !== undefined) repoUpdates.config_json = JSON.stringify(updates.config);
    if (updates.finalOutput !== undefined) repoUpdates.final_output_json = JSON.stringify(updates.finalOutput);
    if (updates.workflow?.retryContext !== undefined) {
      repoUpdates.retry_context_json = JSON.stringify(updates.workflow.retryContext);
    } else if (updates.retryContext !== undefined) {
      repoUpdates.retry_context_json = JSON.stringify(updates.retryContext);
    }

    const hasSnapshotRefChanges = [
      'current_phase1_snapshot_id',
      'current_phase2_snapshot_id',
      'current_phase3_snapshot_id'
    ].some(k => repoUpdates[k] !== undefined);

    if (Object.keys(repoUpdates).length > 0) {
      const expectedVersion = story.version;
      this.repository.updateStory(storyId, repoUpdates, expectedVersion);
      const refreshed = this.repository.getStory(storyId);
      if (refreshed) {
        updated.version = refreshed.version;
      }
    }

    if (hasSnapshotRefChanges) {
      const reassembled = this._assembleStoryFromSQLite(storyId);
      if (reassembled) {
        if (updated.finalOutput !== undefined) {
          reassembled.finalOutput = updated.finalOutput;
        }
        if (updated.workflow?.runToken) {
          reassembled.workflow.runToken = updated.workflow.runToken;
        }
        reassembled.version = updated.version;
        reassembled.updatedAt = updated.updatedAt;
        await this._saveStory(storyId, reassembled);
        this.cache.set(storyId, reassembled);
        return reassembled;
      }
    }

    await this._saveStory(storyId, updated);
    this.cache.set(storyId, updated);

    return updated;
  }

  _resolveSnapshotType(mergedPhase) {
    const candidateStatuses = ['validating', 'running', 'retrying', 'content_production'];
    if (candidateStatuses.includes(mergedPhase.status)) {
      return 'candidate';
    }
    if (mergedPhase.userConfirmed) {
      return 'approved';
    }
    return 'validated';
  }

  async updatePhase1(storyId, updates, { snapshotType, schemaValid } = {}) {
    const story = await this.getStory(storyId);
    const newPhase1 = { ...story.phase1, ...updates };

    const snapId = this.repository.createSnapshot({
      story_id: storyId,
      phase_name: 'phase1',
      snapshot_type: snapshotType || this._resolveSnapshotType(newPhase1),
      payload_json: newPhase1,
      schema_version: 'phase1.v1',
      schema_valid: schemaValid !== undefined ? !!schemaValid : true
    });

    story.phase1 = newPhase1;
    return this.updateStory(storyId, story, { current_phase1_snapshot_id: snapId });
  }

  async updatePhase2(storyId, updates, { snapshotType, schemaValid } = {}) {
    const story = await this.getStory(storyId);
    const newPhase2 = { ...story.phase2, ...updates };

    const snapId = this.repository.createSnapshot({
      story_id: storyId,
      phase_name: 'phase2',
      snapshot_type: snapshotType || this._resolveSnapshotType(newPhase2),
      payload_json: newPhase2,
      schema_version: 'phase2.v1',
      schema_valid: schemaValid !== undefined ? !!schemaValid : true
    });

    story.phase2 = newPhase2;
    return this.updateStory(storyId, story, { current_phase2_snapshot_id: snapId });
  }

  async updatePhase3(storyId, updates, { snapshotType, schemaValid } = {}) {
    const story = await this.getStory(storyId);
    const newPhase3 = { ...story.phase3, ...updates };

    const snapId = this.repository.createSnapshot({
      story_id: storyId,
      phase_name: 'phase3',
      snapshot_type: snapshotType || this._resolveSnapshotType(newPhase3),
      payload_json: newPhase3,
      schema_version: 'phase3.v1',
      schema_valid: schemaValid !== undefined ? !!schemaValid : true
    });

    story.phase3 = newPhase3;
    return this.updateStory(storyId, story, { current_phase3_snapshot_id: snapId });
  }

  async updateWorkflow(storyId, updates) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    this._ensureWorkflowCompatibilityState(story);
    story.workflow = this._applyWorkflowCompatibilityPatch(story.workflow, updates);

    const repoUpdates = {
      status: story.status,
      current_phase: story.workflow.currentPhase,
      current_step: story.workflow.currentStep,
      workflow_state: story.workflow.state
    };

    return this.updateStory(storyId, story, repoUpdates);
  }

  async appendWorkflowHistory(storyId, entry) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    this._ensureWorkflowCompatibilityState(story);

    const historyEntry = {
      at: entry.at || new Date().toISOString(),
      type: entry.type || 'notification',
      phase: entry.phase !== undefined ? entry.phase : story.workflow.currentPhase,
      step: entry.step !== undefined ? entry.step : story.workflow.currentStep,
      detail: entry.detail || {}
    };

    story.workflow.history.push(historyEntry);

    this.repository.appendEvent({
      story_id: storyId,
      phase_name: historyEntry.phase,
      event_type: historyEntry.type,
      event_detail_json: historyEntry.detail
    });

    return this.updateStory(storyId, story);
  }

  async setActiveCheckpoint(storyId, checkpoint) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    this._ensureWorkflowCompatibilityState(story);

    const checkpointId = checkpoint.id || checkpoint.checkpointId || `cp-${uuidv4().replace(/-/g, '').substring(0, 8)}`;
    const effectivePhase = checkpoint.phase || story.workflow.currentPhase || 'phase1';

    story.workflow.activeCheckpoint = {
      id: checkpointId,
      phase: effectivePhase,
      type: checkpoint.type || 'outline_confirmation',
      status: checkpoint.status || 'pending',
      createdAt: checkpoint.createdAt || new Date().toISOString(),
      expiresAt: checkpoint.expiresAt || null,
      autoContinueOnTimeout: checkpoint.autoContinueOnTimeout !== undefined ? checkpoint.autoContinueOnTimeout : true,
      feedback: checkpoint.feedback || ''
    };

    let snapshotId = checkpoint.snapshot_id || null;
    if (!snapshotId && effectivePhase) {
      const phase = effectivePhase;
      if (phase === 'phase1' && story.phase1) {
        snapshotId = this.repository.createSnapshot({
          story_id: storyId,
          phase_name: 'phase1',
          snapshot_type: 'validated',
          payload_json: story.phase1,
          schema_version: 'phase1.v1',
          schema_valid: true
        });
      } else if (phase === 'phase2' && story.phase2) {
        snapshotId = this.repository.createSnapshot({
          story_id: storyId,
          phase_name: 'phase2',
          snapshot_type: 'validated',
          payload_json: story.phase2,
          schema_version: 'phase2.v1',
          schema_valid: true
        });
      } else if (phase === 'phase3' && story.phase3) {
        snapshotId = this.repository.createSnapshot({
          story_id: storyId,
          phase_name: 'phase3',
          snapshot_type: 'validated',
          payload_json: story.phase3,
          schema_version: 'phase3.v1',
          schema_valid: true
        });
      }
    }

    const existingCheckpoint = this.repository.getCheckpoint(checkpointId);
    if (existingCheckpoint) {
      this.repository.updateCheckpoint(checkpointId, {
        status: story.workflow.activeCheckpoint.status,
        snapshot_id: snapshotId,
        feedback: story.workflow.activeCheckpoint.feedback,
        expires_at: story.workflow.activeCheckpoint.expiresAt
      });
    } else {
      this.repository.createCheckpoint({
        checkpoint_id: checkpointId,
        story_id: storyId,
        phase_name: story.workflow.activeCheckpoint.phase,
        checkpoint_type: story.workflow.activeCheckpoint.type,
        status: story.workflow.activeCheckpoint.status,
        snapshot_id: snapshotId,
        feedback: story.workflow.activeCheckpoint.feedback,
        created_at: story.workflow.activeCheckpoint.createdAt,
        expires_at: story.workflow.activeCheckpoint.expiresAt
      });
    }

    return this.updateStory(storyId, story, { active_checkpoint_id: checkpointId });
  }

  async clearActiveCheckpoint(storyId) {
    const story = await this.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    if (story.workflow) {
      story.workflow.activeCheckpoint = null;
      return this.updateStory(storyId, story, { active_checkpoint_id: null });
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

      const checkpointUpdates = {
        feedback: feedback,
        resolved_at: now
      };
      if (resolutionStatus !== null) {
        checkpointUpdates.status = resolutionStatus;
      }
      this.repository.updateCheckpoint(story.workflow.activeCheckpoint.id, checkpointUpdates);
    }

    if (story[phaseName]) {
      story[phaseName].userFeedback = feedback;
      story[phaseName].feedbackRecordedAt = now;
    }

    if (story.workflow) {
      const detail = { feedback, checkpointId: story.workflow.activeCheckpoint?.id, resolutionStatus };
      story.workflow.history.push({
        at: now,
        type: 'checkpoint_resolved',
        phase: phaseName,
        step: story.workflow.currentStep,
        detail
      });

      this.repository.appendEvent({
        story_id: storyId,
        phase_name: phaseName,
        event_type: 'checkpoint_resolved',
        event_detail_json: detail
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

    return this.updatePhase2(storyId, story.phase2);
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

    return this.updatePhase2(storyId, story.phase2);
  }

  async _saveStory(storyId, story) {
    const statePath = this.getStatePath(storyId);
    const tempPath = `${statePath}.tmp`;

    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
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
    const success = this.repository.deleteStory(storyId);
    try {
      await fs.unlink(this.getStatePath(storyId));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    this.cache.delete(storyId);
    return success;
  }

  async listStories() {
    const rows = this.repository.listStories();
    if (rows && rows.length > 0) {
      return rows.map(r => r.story_id);
    }

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

  async getConfig(storyId) {
    const story = await this.getStory(storyId);
    return story?.config || null;
  }

  async getStoryBible(storyId) {
    const story = await this.getStory(storyId);
    if (!story || !story.phase1) return null;

    return {
      worldview: story.phase1.worldview,
      characters: story.phase1.characters,
      plotSummary: story.phase2?.outline
    };
  }
}

module.exports = { StateManager };
