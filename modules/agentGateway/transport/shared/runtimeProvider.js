function createRuntimeProvider(initializer) {
    let context = null;
    let initializePromise = null;

    return Object.freeze({
        async get(options = {}) {
            if (context) return context;
            if (!initializePromise) {
                initializePromise = Promise.resolve(initializer(options))
                    .then((created) => {
                        context = created;
                        return created;
                    })
                    .catch((error) => {
                        initializePromise = null;
                        throw error;
                    });
            }
            return initializePromise;
        },
        peek() {
            return context;
        },
        async reset() {
            context = null;
            initializePromise = null;
        }
    });
}

module.exports = { createRuntimeProvider };
