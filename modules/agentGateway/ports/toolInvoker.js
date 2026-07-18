const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createToolInvokerPort({ invoke, getTool, requiresApproval, listTools } = {}) {
    if (typeof invoke !== 'function') return createUnavailablePort('toolInvoker');
    return freezeAvailablePort('toolInvoker', {
        invoke,
        getTool: getTool || (() => null),
        requiresApproval: requiresApproval || (() => false),
        listTools: listTools || (() => [])
    });
}

module.exports = { createToolInvokerPort };
