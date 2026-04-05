const { StateManager } = require('./StateManager');
const { ChapterOperations } = require('./ChapterOperations');
const { ContentValidator } = require('./ContentValidator');
const { AgentDispatcher } = require('../agents/AgentDispatcher');
const { WorkflowEngine } = require('./WorkflowEngine');
const { validateInput } = require('../utils/ValidationSchemas');
const { TextMetrics } = require('../utils/TextMetrics');

class StoryOrchestrator {
  constructor() {
    this.stateManager = new StateManager();
    this.agentDispatcher = null;
    this.chapterOperations = null;
    this.contentValidator = null;
    this.workflowEngine = null;
    this.textMetrics = new TextMetrics();
    this.globalConfig = {};
  }

  async initialize(config, dependencies) {
    console.log('[StoryOrchestrator] Initializing...');
    
    this.globalConfig = config || {};
    
    await this.stateManager.initialize();
    
    this.agentDispatcher = new AgentDispatcher(this.globalConfig, this.stateManager);
    await this.agentDispatcher.initialize();
    
    this.chapterOperations = new ChapterOperations(this.agentDispatcher, this.stateManager);
    this.contentValidator = new ContentValidator(this.agentDispatcher);
    
    // Initialize WorkflowEngine with all dependencies
    this.workflowEngine = new WorkflowEngine({
      stateManager: this.stateManager,
      agentDispatcher: this.agentDispatcher,
      chapterOperations: this.chapterOperations,
      contentValidator: this.contentValidator,
      config: this.globalConfig
    });
    await this.workflowEngine.initialize();
    
    console.log('[StoryOrchestrator] Initialized successfully');
  }

  async shutdown() {
    console.log('[StoryOrchestrator] Shutting down...');
    const cleaned = await this.stateManager.cleanupExpired(
      this.globalConfig.STORY_STATE_RETENTION_DAYS || 30
    );
    console.log(`[StoryOrchestrator] Cleaned up ${cleaned} expired stories`);
  }

  async processToolCall(args) {
    const { command } = args;
    
    console.log(`[StoryOrchestrator] Processing command: ${command}`);
    
    try {
      switch (command) {
        case 'StartStoryProject':
          return await this.startStoryProject(args);
        case 'QueryStoryStatus':
          return await this.queryStoryStatus(args);
        case 'UserConfirmCheckpoint':
          return await this.userConfirmCheckpoint(args);
        case 'CreateChapterDraft':
          return await this.createChapterDraft(args);
        case 'ReviewChapter':
          return await this.reviewChapter(args);
        case 'ReviseChapter':
          return await this.reviseChapter(args);
        case 'PolishChapter':
          return await this.polishChapter(args);
        case 'ValidateConsistency':
          return await this.validateConsistency(args);
        case 'CountChapterMetrics':
          return await this.countChapterMetrics(args);
        case 'ExportStory':
          return await this.exportStory(args);
        case 'RecoverStoryWorkflow':
          return await this.recoverStoryWorkflow(args);
        case 'RetryPhase':
          return await this.retryPhase(args);
        default:
          return {
            status: 'error',
            error: `Unknown command: ${command}`
          };
      }
    } catch (error) {
      console.error(`[StoryOrchestrator] Error processing ${command}:`, error);
      return {
        status: 'error',
        error: error.message
      };
    }
  }

  async startStoryProject(args) {
    const validation = validateInput('startStoryProject', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const story = await this.stateManager.createStory(args.story_prompt, {
      target_word_count: args.target_word_count,
      genre: args.genre,
      style_preference: args.style_preference
    });

    this.workflowEngine.start(story.id).catch(err => {
      console.error('[StoryOrchestrator] Workflow start error:', err);
    });

    return {
      status: 'success',
      result: {
        story_id: story.id,
        status: story.status,
        message: '故事项目已启动，正在执行第一阶段：世界观与人设搭建'
      }
    };
  }

  async queryStoryStatus(args) {
    const validation = validateInput('queryStoryStatus', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const story = await this.stateManager.getStory(args.story_id);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const progress = this._calculateProgress(story);
    const workflowStatus = await this.workflowEngine.getWorkflowStatus(args.story_id);

    return {
      status: 'success',
      result: {
        story_id: story.id,
        phase: this._getCurrentPhase(story),
        phase_name: this._getPhaseName(story),
        status: story.status,
        progress_percent: progress,
        checkpoint_pending: this._isCheckpointPending(story),
        checkpoint_id: this._getCurrentCheckpointId(story),
        chapters_completed: story.phase2?.chapters?.length || 0,
        total_word_count: this._calculateTotalWordCount(story),
        updated_at: story.updatedAt,
        workflow_state: workflowStatus?.state || 'idle',
        current_step: workflowStatus?.currentStep || null,
        active_checkpoint: workflowStatus?.activeCheckpoint || null,
        retry_attempt: workflowStatus?.retryContext?.attempt || 0,
        last_error: workflowStatus?.retryContext?.lastError || null
      }
    };
  }

  async userConfirmCheckpoint(args) {
    const validation = validateInput('userConfirmCheckpoint', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const { story_id, checkpoint_id, approval, feedback } = args;
    const story = await this.stateManager.getStory(story_id);
    
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const result = await this.workflowEngine.resume(story_id, {
      checkpointId: checkpoint_id,
      approval,
      feedback
    });

    return {
      status: result.status === 'error' ? 'error' : 'success',
      result: result
    };
  }

  async createChapterDraft(args) {
    const validation = validateInput('createChapterDraft', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const result = await this.chapterOperations.createChapterDraft(
      args.story_id,
      args.chapter_number,
      { targetWordCount: args.target_word_count }
    );

    return {
      status: 'success',
      result: {
        story_id: args.story_id,
        chapter_number: args.chapter_number,
        content: result.content,
        metrics: result.metrics,
        was_expanded: result.wasExpanded
      }
    };
  }

  async reviewChapter(args) {
    const validation = validateInput('reviewChapter', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const result = await this.chapterOperations.reviewChapter(
      args.story_id,
      args.chapter_number,
      args.chapter_content,
      { reviewFocus: args.review_focus }
    );

    return {
      status: 'success',
      result
    };
  }

  async reviseChapter(args) {
    const validation = validateInput('reviseChapter', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const result = await this.chapterOperations.reviseChapter(
      args.story_id,
      args.chapter_number,
      args.chapter_content,
      {
        revisionInstructions: args.revision_instructions,
        issues: args.issues,
        maxRewriteRatio: args.max_rewrite_ratio
      }
    );

    return {
      status: 'success',
      result
    };
  }

  async polishChapter(args) {
    const validation = validateInput('polishChapter', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const result = await this.chapterOperations.polishChapter(
      args.story_id,
      args.chapter_number,
      args.chapter_content,
      { polishFocus: args.polish_focus }
    );

    return {
      status: 'success',
      result
    };
  }

  async validateConsistency(args) {
    const story = await this.stateManager.getStory(args.story_id);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const storyBible = this.stateManager.getStoryBible(args.story_id);
    
    let result;
    switch (args.validation_type) {
      case 'worldview':
        result = await this.contentValidator.validateWorldview(args.story_id, args.content, storyBible);
        break;
      case 'character':
        result = await this.contentValidator.validateCharacters(args.story_id, args.content, storyBible);
        break;
      case 'plot':
        result = await this.contentValidator.validatePlot(args.story_id, args.content, storyBible);
        break;
      default:
        result = await this.contentValidator.comprehensiveValidation(
          args.story_id,
          0,
          args.content,
          storyBible
        );
    }

    return {
      status: 'success',
      result
    };
  }

  async countChapterMetrics(args) {
    const validation = validateInput('countChapterMetrics', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const result = this.chapterOperations.countChapterLength(
      args.chapter_content,
      args.target_min,
      args.target_max,
      {
        countMode: args.count_mode,
        lengthPolicy: args.length_policy
      }
    );

    return {
      status: 'success',
      result
    };
  }

  async exportStory(args) {
    const validation = validateInput('exportStory', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const story = await this.stateManager.getStory(args.story_id);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const format = args.format || 'markdown';
    const chapters = story.phase2?.chapters || [];
    
    let content;
    switch (format) {
      case 'json':
        content = JSON.stringify(story, null, 2);
        break;
      case 'txt':
        content = this._exportAsPlainText(story);
        break;
      case 'markdown':
      default:
        content = this._exportAsMarkdown(story);
    }

    const totalWordCount = this._calculateTotalWordCount(story);

    return {
      status: 'success',
      result: {
        story_id: args.story_id,
        format,
        content,
        word_count: totalWordCount,
        chapter_count: chapters.length,
        exported_at: new Date().toISOString()
      }
    };
  }

  async recoverStoryWorkflow(args) {
    const validation = validateInput('recoverStoryWorkflow', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    const story = await this.stateManager.getStory(args.story_id);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const recoveryOptions = {
      recoveryAction: args.recovery_action || 'continue',
      targetPhase: args.target_phase,
      targetCheckpoint: args.target_checkpoint,
      feedback: args.feedback
    };

    const result = await this.workflowEngine.recover(args.story_id, recoveryOptions);

    return {
      status: result.status === 'error' ? 'error' : 'success',
      result
    };
  }

  async retryPhase(args) {
    const validation = validateInput('queryStoryStatus', args);
    if (!validation.valid) {
      return { status: 'error', error: validation.errors.join(', ') };
    }

    if (!args.phase_name || !['phase1', 'phase2', 'phase3'].includes(args.phase_name)) {
      return { status: 'error', error: 'Invalid or missing phase_name (phase1, phase2, or phase3)' };
    }

    const story = await this.stateManager.getStory(args.story_id);
    if (!story) {
      return { status: 'error', error: 'Story not found' };
    }

    const result = await this.workflowEngine.retryPhase(
      args.story_id,
      args.phase_name,
      args.reason || 'Manual retry requested'
    );

    if (result.status === 'failed') {
      return {
        status: 'error',
        error: result.error || 'Retry failed',
        result
      };
    }

    return {
      status: result.status === 'error' ? 'error' : 'success',
      result
    };
  }

  async getPlaceholderValue(placeholder) {
    if (placeholder === 'StoryOrchestratorStatus') {
      const stories = await this.stateManager.listStories();
      const activeStories = [];
      
      for (const storyId of stories.slice(0, 5)) {
        const story = await this.stateManager.getStory(storyId);
        if (story && !story.finalOutput) {
          activeStories.push({
            id: storyId,
            phase: this._getPhaseName(story),
            progress: this._calculateProgress(story)
          });
        }
      }

      return JSON.stringify(activeStories, null, 2);
    }

    if (placeholder === 'StoryBible') {
      const stories = await this.stateManager.listStories();
      const activeStories = [];
      
      for (const storyId of stories.slice(0, 3)) {
        const story = await this.stateManager.getStory(storyId);
        if (story && !story.finalOutput && (story.phase1?.worldview || story.phase1?.characters)) {
          activeStories.push({
            id: storyId,
            genre: story.genre,
            worldview: story.phase1?.worldview || null,
            characters: story.phase1?.characters || null,
            plot_outline: story.phase2?.outline || null
          });
        }
      }

      if (activeStories.length === 0) {
        return 'No active story projects with bible data';
      }
      return JSON.stringify(activeStories, null, 2);
    }

    return null;
  }

  _calculateProgress(story) {
    if (!story) return 0;
    
    if (story.finalOutput) return 100;
    
    const phaseWeights = { phase1: 30, phase2: 50, phase3: 20 };
    let progress = 0;

    if (story.phase1?.userConfirmed) {
      progress += phaseWeights.phase1;
    } else if (story.phase1?.worldview) {
      progress += phaseWeights.phase1 * 0.7;
    }

    if (story.phase2?.userConfirmed) {
      progress += phaseWeights.phase2;
    } else if (story.phase2?.chapters?.length > 0) {
      const totalChapters = story.phase2.outline?.chapters?.length || 5;
      progress += phaseWeights.phase2 * (story.phase2.chapters.length / totalChapters) * 0.8;
    }

    if (story.phase3?.userConfirmed) {
      progress += phaseWeights.phase3;
    } else if (story.phase3?.polishedChapters?.length > 0) {
      const totalChapters = story.phase2?.chapters?.length || 5;
      progress += phaseWeights.phase3 * (story.phase3.polishedChapters.length / totalChapters) * 0.8;
    }

    return Math.round(progress);
  }

  _getCurrentPhase(story) {
    if (story.phase3?.userConfirmed) return 4;
    if (story.phase2?.userConfirmed) return 3;
    if (story.phase1?.userConfirmed) return 2;
    return 1;
  }

  _getPhaseName(story) {
    const phases = {
      1: '世界观与人设搭建',
      2: '大纲与正文生产',
      3: '润色与终稿',
      4: '已完成'
    };
    return phases[this._getCurrentPhase(story)];
  }

  _isCheckpointPending(story) {
    // First check workflow's activeCheckpoint
    if (story.workflow?.activeCheckpoint) {
      return story.workflow.activeCheckpoint.status === 'pending';
    }
    // Fall back to legacy phase-based check
    if (!story.phase1?.userConfirmed) return story.phase1?.status === 'pending_confirmation';
    if (!story.phase2?.userConfirmed) return story.phase2?.status === 'pending_confirmation';
    if (!story.phase3?.userConfirmed) return story.phase3?.status === 'pending_confirmation';
    return false;
  }

  _getCurrentCheckpointId(story) {
    // First check workflow's activeCheckpoint
    if (story.workflow?.activeCheckpoint) {
      return story.workflow.activeCheckpoint.id;
    }
    // Fall back to legacy phase-based check
    if (!story.phase1?.userConfirmed) return story.phase1?.checkpointId;
    if (!story.phase2?.userConfirmed) return story.phase2?.checkpointId;
    if (!story.phase3?.userConfirmed) return story.phase3?.checkpointId;
    return null;
  }

  _calculateTotalWordCount(story) {
    if (!story?.phase2?.chapters) return 0;
    return story.phase2.chapters.reduce((sum, ch) => {
      return sum + (ch.metrics?.counts?.chineseChars || 0);
    }, 0);
  }

  _exportAsMarkdown(story) {
    const chapters = story.phase2?.chapters || [];
    const lines = ['# 故事创作', ''];
    
    if (story.phase1?.worldview?.setting) {
      lines.push('## 世界观', '', story.phase1.worldview.setting, '');
    }

    chapters.forEach(ch => {
      lines.push(`## ${ch.title || `第${ch.number}章`}`, '', ch.content || '', '');
    });

    return lines.join('\n');
  }

  _exportAsPlainText(story) {
    const chapters = story.phase2?.chapters || [];
    return chapters.map(ch => ch.content || '').join('\n\n');
  }
}

module.exports = new StoryOrchestrator();
