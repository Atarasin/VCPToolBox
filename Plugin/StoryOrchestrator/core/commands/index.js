'use strict';

const workflowLifecycleCommands = require('./workflowLifecycleCommands');
const chapterCommands = require('./chapterCommands');

const commandMap = Object.freeze({
  StartStoryProject: workflowLifecycleCommands.startStoryProject,
  QueryStoryStatus: workflowLifecycleCommands.queryStoryStatus,
  UserConfirmCheckpoint: workflowLifecycleCommands.userConfirmCheckpoint,
  ExportStory: chapterCommands.exportStory,
  RecoverStoryWorkflow: workflowLifecycleCommands.recoverStoryWorkflow,
  RetryPhase: workflowLifecycleCommands.retryPhase
});

module.exports = {
  chapterCommands,
  commandMap,
  workflowLifecycleCommands
};
