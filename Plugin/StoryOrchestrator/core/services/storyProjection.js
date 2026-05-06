'use strict';

function calculateProgress(story) {
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

function getCurrentPhase(story) {
  const workflowPhase = story?.workflow?.currentPhase;
  if (workflowPhase === 'phase1') return 1;
  if (workflowPhase === 'phase2') return 2;
  if (workflowPhase === 'phase3') return 3;
  if (workflowPhase === 'completed' || story?.phase3?.userConfirmed) return 4;
  if (story?.phase2?.userConfirmed) return 3;
  if (story?.phase1?.userConfirmed) return 2;
  return 1;
}

function getPhaseName(story) {
  const phases = {
    1: '世界观与人设搭建',
    2: '大纲与正文生产',
    3: '润色与终稿',
    4: '已完成'
  };

  return phases[getCurrentPhase(story)];
}

function isCheckpointPending(story) {
  if (story?.workflow?.activeCheckpoint) {
    return story.workflow.activeCheckpoint.status === 'pending';
  }

  if (!story?.phase1?.userConfirmed) return story?.phase1?.status === 'pending_confirmation';
  if (!story?.phase2?.userConfirmed) return story?.phase2?.status === 'pending_confirmation';
  if (!story?.phase3?.userConfirmed) return story?.phase3?.status === 'pending_confirmation';
  return false;
}

function getCurrentCheckpointId(story) {
  if (story?.workflow?.activeCheckpoint) {
    return story.workflow.activeCheckpoint.id;
  }

  if (!story?.phase1?.userConfirmed) return story?.phase1?.checkpointId;
  if (!story?.phase2?.userConfirmed) return story?.phase2?.checkpointId;
  if (!story?.phase3?.userConfirmed) return story?.phase3?.checkpointId;
  return null;
}

function calculateTotalWordCount(story) {
  if (!story?.phase2?.chapters) return 0;

  return story.phase2.chapters.reduce((sum, chapter) => {
    return sum + (chapter.metrics?.counts?.chineseChars || 0);
  }, 0);
}

function buildStoryStatusResult(story, workflowStatus, kernelStatus, routingPath) {
  const checkpointPending = kernelStatus?.activeCheckpoint
    ? true
    : isCheckpointPending(story);
  const checkpointId = kernelStatus?.activeCheckpoint
    ? kernelStatus.activeCheckpoint
    : getCurrentCheckpointId(story);

  return {
    story_id: story.id,
    phase: getCurrentPhase(story),
    phase_name: getPhaseName(story),
    status: story.status,
    progress_percent: calculateProgress(story),
    checkpoint_pending: checkpointPending,
    checkpoint_id: checkpointId,
    chapters_completed: story.phase2?.chapters?.length || 0,
    total_word_count: calculateTotalWordCount(story),
    updated_at: story.updatedAt,
    workflow_state: workflowStatus?.state || 'idle',
    current_step: workflowStatus?.currentStep || null,
    active_checkpoint: workflowStatus?.activeCheckpoint || null,
    retry_attempt: workflowStatus?.retryContext?.attempt || 0,
    last_error: workflowStatus?.retryContext?.lastError || null,
    kernel_state: kernelStatus?.state || null,
    kernel_current_step: kernelStatus?.currentStep || null,
    routing_path: routingPath
  };
}

module.exports = {
  buildStoryStatusResult,
  calculateProgress,
  calculateTotalWordCount,
  getCurrentCheckpointId,
  getCurrentPhase,
  getPhaseName,
  isCheckpointPending
};
