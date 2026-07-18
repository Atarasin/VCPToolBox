const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createLlmCompletionPort({ complete } = {}) {
    if (typeof complete !== 'function') return createUnavailablePort('llmCompletion');
    return freezeAvailablePort('llmCompletion', { complete });
}

module.exports = { createLlmCompletionPort };
