/**
 * AgentDispatcher — generic agent delegation module.
 *
 * Provides agent resolution and delegation services for any
 * consumer (orchestrators, kernels, plugins, etc.).
 *
 * @see docs/agent-dispatcher-contract.md for interface specification.
 */

const { AgentDispatcher, COMPLETION_MARKERS } = require('./AgentDispatcher');

module.exports = {
  AgentDispatcher,
  COMPLETION_MARKERS
};
