const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createToolInvokerPort({ invoke, getTool, requiresApproval } = {}) {
    if (typeof invoke !== 'function') return createUnavailablePort('toolInvoker');
    return freezeAvailablePort('toolInvoker', {
        invoke,
        getTool: getTool || (() => null),
        requiresApproval: requiresApproval || (() => false)
    });
}

module.exports = { createToolInvokerPort };
