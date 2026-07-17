const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createRagRetrieverPort({ knowledgeBaseManager, ragPlugin, embeddingUtilsLoader } = {}) {
    if (!knowledgeBaseManager && !ragPlugin) return createUnavailablePort('ragRetriever');
    return freezeAvailablePort('ragRetriever', { knowledgeBaseManager, ragPlugin, embeddingUtilsLoader });
}

module.exports = { createRagRetrieverPort };
