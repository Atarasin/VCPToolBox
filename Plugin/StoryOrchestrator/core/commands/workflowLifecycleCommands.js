'use strict';

const { v4: uuidv4 } = require('uuid');

const { validateInput } = require('../../utils/ValidationSchemas');
const { buildStoryStatusResult } = require('../services/storyProjection');

function getRoutingPath(orchestrator) {
  return orchestrator.useKernel && orchestrator.kernelAdapter ? 'kernel' : 'legacy';
}

async function startStoryProject(orchestrator, args) {
  const validation = validateInput('startStoryProject', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.createStory(args.story_prompt, {
    target_word_count: args.target_word_count,
    genre: args.genre,
    style_preference: args.style_preference
  });

  if (orchestrator.useKernel && orchestrator.kernelAdapter) {
    orchestrator._logRoutingDecision('StartStoryProject', story.id, 'kernel');

    // Seed a stable workflow shell before the kernel run starts in the background.
    const runToken = uuidv4();
    await orchestrator.stateManager.updateWorkflow(story.id, {
      state: 'running',
      currentPhase: 'phase1',
      currentStep: 'initial',
      retryContext: {
        phase: 'phase1',
        step: 'initial',
        attempt: 0,
        maxAttempts: orchestrator.globalConfig.MAX_PHASE_RETRY_ATTEMPTS || 3,
        lastError: null
      },
      runToken
    });
    await orchestrator.stateManager.updateStory(story.id, {
      status: 'phase1_running'
    });

    orchestrator.kernelAdapter.executeWorkflow(story.id, {
      storyPrompt: args.story_prompt,
      targetWordCount: {
        min: args.target_word_count || 2500,
        max: (args.target_word_count || 2500) + 1000
      },
      genre: args.genre,
      stylePreference: args.style_preference
    }).then((result) => {
      const outcome = result.status === 'completed' ? 'success' : 'failure';
      orchestrator._recordOutcome('kernel', outcome, { storyId: story.id, command: 'StartStoryProject' });
    }).catch((err) => {
      console.error('[StoryOrchestrator] Kernel workflow start error:', err);
      orchestrator._recordOutcome('kernel', 'error', {
        storyId: story.id,
        command: 'StartStoryProject',
        error: err.message
      });
    });
  } else {
    orchestrator._logRoutingDecision('StartStoryProject', story.id, 'legacy');

    orchestrator.workflowEngine.start(story.id).then((result) => {
      const outcome = result?.status === 'error' ? 'failure' : 'success';
      orchestrator._recordOutcome('legacy', outcome, { storyId: story.id, command: 'StartStoryProject' });
    }).catch((err) => {
      console.error('[StoryOrchestrator] Workflow start error:', err);
      orchestrator._recordOutcome('legacy', 'error', {
        storyId: story.id,
        command: 'StartStoryProject',
        error: err.message
      });
    });
  }

  return {
    status: 'success',
    result: {
      story_id: story.id,
      status: story.status,
      message: '故事项目已启动，正在执行第一阶段：世界观与人设搭建',
      routing_path: getRoutingPath(orchestrator)
    }
  };
}

async function queryStoryStatus(orchestrator, args) {
  const validation = validateInput('queryStoryStatus', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.getStory(args.story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const workflowStatus = await orchestrator.workflowEngine.getWorkflowStatus(args.story_id);
  let kernelStatus = null;

  if (orchestrator.useKernel && orchestrator.kernelAdapter) {
    try {
      kernelStatus = await orchestrator.kernelAdapter.getStatus(args.story_id);
    } catch (err) {
      console.warn('[StoryOrchestrator] Failed to get kernel status:', err.message);
    }
  }

  return {
    status: 'success',
    result: buildStoryStatusResult(story, workflowStatus, kernelStatus, getRoutingPath(orchestrator))
  };
}

async function userConfirmCheckpoint(orchestrator, args) {
  if (args.approval === 'true') args.approval = true;
  if (args.approval === 'false') args.approval = false;

  const validation = validateInput('userConfirmCheckpoint', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const { story_id, checkpoint_id, approval, feedback, chapter_number } = args;
  const story = await orchestrator.stateManager.getStory(story_id);

  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const normalizedCheckpointDecision = {
    checkpointId: checkpoint_id,
    approval,
    action: approval ? 'approve' : 'reject',
    feedback,
    chapter_number: chapter_number || null
  };

  let result;
  if (orchestrator.useKernel && orchestrator.kernelAdapter) {
    orchestrator._logRoutingDecision('UserConfirmCheckpoint', story_id, 'kernel');
    try {
      result = await orchestrator.kernelAdapter.resume(story_id, normalizedCheckpointDecision);
      const outcome = result.status === 'error' ? 'failure' : 'success';
      orchestrator._recordOutcome('kernel', outcome, {
        storyId: story_id,
        command: 'UserConfirmCheckpoint',
        checkpointId: checkpoint_id
      });
    } catch (error) {
      const kernelInactive = /is not active/i.test(error.message || '');
      if (!kernelInactive) {
        throw error;
      }

      // Persisted checkpoints can outlive the in-memory kernel run during recovery.
      orchestrator._logRoutingDecision('UserConfirmCheckpoint', story_id, 'legacy-fallback');
      result = await orchestrator.workflowEngine.resume(story_id, normalizedCheckpointDecision);
      const outcome = result.status === 'error' ? 'failure' : 'success';
      orchestrator._recordOutcome('legacy', outcome, {
        storyId: story_id,
        command: 'UserConfirmCheckpoint',
        checkpointId: checkpoint_id,
        fallbackReason: error.message
      });
    }
  } else {
    orchestrator._logRoutingDecision('UserConfirmCheckpoint', story_id, 'legacy');
    result = await orchestrator.workflowEngine.resume(story_id, normalizedCheckpointDecision);
    const outcome = result.status === 'error' ? 'failure' : 'success';
    orchestrator._recordOutcome('legacy', outcome, {
      storyId: story_id,
      command: 'UserConfirmCheckpoint',
      checkpointId: checkpoint_id
    });
  }

  return {
    status: result.status === 'error' ? 'error' : 'success',
    result
  };
}

async function recoverStoryWorkflow(orchestrator, args) {
  const validation = validateInput('recoverStoryWorkflow', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.getStory(args.story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const recoveryOptions = {
    recoveryAction: args.recovery_action || 'continue',
    targetPhase: args.target_phase,
    targetCheckpoint: args.target_checkpoint,
    feedback: args.feedback
  };

  const result = await orchestrator.workflowEngine.recover(args.story_id, recoveryOptions);
  return {
    status: result.status === 'error' ? 'error' : 'success',
    result
  };
}

async function retryPhase(orchestrator, args) {
  const validation = validateInput('retryPhase', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.getStory(args.story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const result = await orchestrator.workflowEngine.retryPhase(
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

async function retryChapter(orchestrator, args) {
  const validation = validateInput('retryChapter', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const { story_id, chapter_number, phase_name, feedback } = args;
  const story = await orchestrator.stateManager.getStory(story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const result = await orchestrator.workflowEngine.handleChapterRetry(story_id, {
    phase: phase_name,
    chapter_number,
    feedback
  });

  return {
    status: result.status === 'error' ? 'error' : 'success',
    result
  };
}

module.exports = {
  queryStoryStatus,
  recoverStoryWorkflow,
  retryChapter,
  retryPhase,
  startStoryProject,
  userConfirmCheckpoint
};
