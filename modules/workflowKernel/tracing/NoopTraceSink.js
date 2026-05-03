const { WorkflowTraceSink } = require('./WorkflowTraceSink');

/**
 * NoopTraceSink keeps observability optional by swallowing all trace writes.
 */
class NoopTraceSink extends WorkflowTraceSink {}

module.exports = { NoopTraceSink };
