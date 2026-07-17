function createUnavailablePort(name, reason = 'capability_unavailable') {
    return Object.freeze({
        available: false,
        name,
        reason,
        assertAvailable() {
            const error = new Error(`${name} is unavailable`);
            error.code = 'AGW_CAPABILITY_UNAVAILABLE';
            error.details = { capability: name, reason };
            throw error;
        }
    });
}

function freezeAvailablePort(name, implementation) {
    return Object.freeze({ available: true, name, ...implementation });
}

module.exports = { createUnavailablePort, freezeAvailablePort };
