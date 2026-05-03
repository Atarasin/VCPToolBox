/**
 * Backward compatibility shim — re-exports from modules/agentDispatcher.
 *
 * @deprecated Use `require('../../../modules/agentDispatcher')` instead.
 */

const { AgentDispatcher, COMPLETION_MARKERS } = require('../../../modules/agentDispatcher');

module.exports = { AgentDispatcher, COMPLETION_MARKERS };
