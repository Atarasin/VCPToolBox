'use strict';

const { validateInput } = require('../../utils/ValidationSchemas');
const { exportStoryContent } = require('../services/storyExport');
const { calculateTotalWordCount } = require('../services/storyProjection');

async function createChapterDraft(orchestrator, args) {
  const validation = validateInput('createChapterDraft', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const result = await orchestrator.chapterOperations.createChapterDraft(
    args.story_id,
    args.chapter_number,
    {
      targetWordCount: args.target_word_count,
      outlineContext: args.outline_context
    }
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

async function reviewChapter(orchestrator, args) {
  const validation = validateInput('reviewChapter', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const result = await orchestrator.chapterOperations.reviewChapter(
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

async function reviseChapter(orchestrator, args) {
  const validation = validateInput('reviseChapter', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const result = await orchestrator.chapterOperations.reviseChapter(
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

async function polishChapter(orchestrator, args) {
  const validation = validateInput('polishChapter', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const result = await orchestrator.chapterOperations.polishChapter(
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

async function validateConsistency(orchestrator, args) {
  const validation = validateInput('validateConsistency', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.getStory(args.story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const storyBible = await orchestrator.stateManager.getStoryBible(args.story_id);
  if (!storyBible) {
    return { status: 'error', error: 'Story Bible not found' };
  }

  const previousChapters = story.phase2?.chapters || [];

  let result;
  switch (args.validation_type) {
    case 'worldview':
      result = await orchestrator.contentValidator.validateWorldview(args.story_id, args.content, storyBible);
      break;
    case 'character':
      result = await orchestrator.contentValidator.validateCharacters(args.story_id, args.content, storyBible);
      break;
    case 'plot':
      result = await orchestrator.contentValidator.validatePlot(args.story_id, args.content, storyBible, previousChapters);
      break;
    default:
      result = await orchestrator.contentValidator.comprehensiveValidation(
        args.story_id,
        0,
        args.content,
        storyBible,
        previousChapters
      );
  }

  return {
    status: 'success',
    result
  };
}

async function countChapterMetrics(orchestrator, args) {
  const validation = validateInput('countChapterMetrics', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const result = orchestrator.chapterOperations.countChapterLength(
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

async function exportStory(orchestrator, args) {
  const validation = validateInput('exportStory', args);
  if (!validation.valid) {
    return { status: 'error', error: validation.errors.join(', ') };
  }

  const story = await orchestrator.stateManager.getStory(args.story_id);
  if (!story) {
    return { status: 'error', error: 'Story not found' };
  }

  const format = args.format || 'markdown';
  const chapters = story.phase2?.chapters || [];
  const content = exportStoryContent(story, format);
  const totalWordCount = calculateTotalWordCount(story);

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

module.exports = {
  countChapterMetrics,
  createChapterDraft,
  exportStory,
  polishChapter,
  reviewChapter,
  reviseChapter,
  validateConsistency
};
