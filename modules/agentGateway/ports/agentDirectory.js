const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createAgentDirectoryPort({ agentManager, renderPrompt } = {}) {
    if (!agentManager) return createUnavailablePort('agentDirectory');
    return freezeAvailablePort('agentDirectory', { agentManager, renderPrompt });
}

module.exports = { createAgentDirectoryPort };
