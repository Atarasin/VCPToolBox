const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

const REQUIRED_METHODS = ['ensureLoaded', 'listAgents', 'isAgent', 'getAgentPrompt', 'getAgentSourcePath', 'renderPrompt'];

function createAgentDirectoryPort(bindings = {}) {
    const missing = REQUIRED_METHODS.filter((name) => typeof bindings[name] !== 'function');
    if (missing.length > 0) return createUnavailablePort('agentDirectory', `missing:${missing.join(',')}`);
    return freezeAvailablePort('agentDirectory', Object.fromEntries(
        REQUIRED_METHODS.map((name) => [name, bindings[name]])
    ));
}

module.exports = { createAgentDirectoryPort, REQUIRED_METHODS };
