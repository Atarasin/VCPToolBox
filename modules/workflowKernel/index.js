/**
 * WorkflowKernel — VCP Multi-Agent Workflow Kernel
 *
 * Exports:
 * - WorkflowKernel: main orchestrator entry point
 * - StateMachine: execution-state machine
 * - StepRegistry: extensible step type registry
 * - RetryPolicy: retry/backoff policy
 * - WorkflowStateRepository: persistence interface (adapter pattern)
 * - WorkflowDefinitionSchema: config validation
 * - ExpressionEngine: minimal safe expression evaluator
 */

const { WorkflowKernel, CheckpointPauseError } = require('./core/WorkflowKernel');
const { StateMachine, StateTransitionError, EXECUTION_STATES } = require('./core/StateMachine');
const { StepRegistry } = require('./core/StepRegistry');
const { RetryPolicy } = require('./core/RetryPolicy');
const { WorkflowStateRepository } = require('./persistence/WorkflowStateRepository');
const { WorkflowDefinitionSchema } = require('./types/WorkflowDefinition');
const { ExpressionEngine, ExpressionError } = require('./core/ExpressionEngine');
const { CheckpointManager } = require('./core/CheckpointManager');
const { EventBus } = require('./core/EventBus');
const { agentCallStep } = require('./steps/AgentCallStep');
const { checkpointStep } = require('./steps/CheckpointStep');
const { guardStep } = require('./steps/GuardStep');
const { loopStep } = require('./steps/LoopStep');
const { parallelGroupStep, CancellationError } = require('./steps/ParallelGroupStep');
const { StoryEventAdapter } = require('./adapters/StoryEventAdapter');
const { WorkflowTraceSink } = require('./tracing/WorkflowTraceSink');
const { NoopTraceSink } = require('./tracing/NoopTraceSink');
const { FileTraceSink } = require('./tracing/FileTraceSink');
const pluginSdk = require('./pluginSdk');
const {
  createLastErrorView,
  createRunStatusView,
  createStepTraceRecord,
  createTraceEvent
} = require('./tracing/traceModels');

module.exports = {
  WorkflowKernel,
  CheckpointPauseError,
  StateMachine,
  StateTransitionError,
  EXECUTION_STATES,
  StepRegistry,
  RetryPolicy,
  WorkflowStateRepository,
  WorkflowDefinitionSchema,
  ExpressionEngine,
  ExpressionError,
  CheckpointManager,
  EventBus,
  agentCallStep,
  checkpointStep,
  guardStep,
  loopStep,
  parallelGroupStep,
  CancellationError,
  StoryEventAdapter,
  WorkflowTraceSink,
  NoopTraceSink,
  FileTraceSink,
  pluginSdk,
  listSharedHelperFamilies: pluginSdk.listSharedHelperFamilies,
  getSharedHelperFamily: pluginSdk.getSharedHelperFamily,
  createLastErrorView,
  createRunStatusView,
  createStepTraceRecord,
  createTraceEvent
};
