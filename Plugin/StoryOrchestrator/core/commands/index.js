'use strict';

const workflowLifecycleCommands = require('./workflowLifecycleCommands');
const chapterCommands = require('./chapterCommands');

const commandMap = Object.freeze({
  StartStoryProject: workflowLifecycleCommands.startStoryProject,
  QueryStoryStatus: workflowLifecycleCommands.queryStoryStatus,
  UserConfirmCheckpoint: workflowLifecycleCommands.userConfirmCheckpoint,
  CreateChapterDraft: chapterCommands.createChapterDraft,
  ReviewChapter: chapterCommands.reviewChapter,
  ReviseChapter: chapterCommands.reviseChapter,
  PolishChapter: chapterCommands.polishChapter,
  ValidateConsistency: chapterCommands.validateConsistency,
  CountChapterMetrics: chapterCommands.countChapterMetrics,
  ExportStory: chapterCommands.exportStory,
  RecoverStoryWorkflow: workflowLifecycleCommands.recoverStoryWorkflow,
  RetryPhase: workflowLifecycleCommands.retryPhase,
  RetryChapter: workflowLifecycleCommands.retryChapter
});

module.exports = {
  chapterCommands,
  commandMap,
  workflowLifecycleCommands
};
