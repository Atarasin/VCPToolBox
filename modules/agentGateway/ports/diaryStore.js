const { createUnavailablePort, freezeAvailablePort } = require('./portUtils');

function createDiaryStorePort({ invoke, getWriter } = {}) {
    if (typeof invoke !== 'function') return createUnavailablePort('diaryStore');
    return freezeAvailablePort('diaryStore', { invoke, getWriter: getWriter || (() => null) });
}

module.exports = { createDiaryStorePort };
