const fs = require('fs');

function createHotJsonConfigLoader({ fallback, normalize = (value) => value } = {}) {
    const frozenFallback = Object.freeze(normalize(fallback || {}));
    let cachedPath = '';
    let cachedMtimeMs = -1;
    let cachedPayload = frozenFallback;

    return function loadHotJsonConfig(configPath) {
        let mtimeMs;
        try {
            mtimeMs = fs.statSync(configPath).mtimeMs;
        } catch (_error) {
            cachedPath = configPath;
            cachedMtimeMs = -1;
            cachedPayload = frozenFallback;
            return cachedPayload;
        }
        if (cachedPath === configPath && cachedMtimeMs === mtimeMs) return cachedPayload;
        try {
            const payload = normalize(JSON.parse(fs.readFileSync(configPath, 'utf8')));
            cachedPath = configPath;
            cachedMtimeMs = mtimeMs;
            cachedPayload = Object.freeze(payload);
        } catch (_error) {
            cachedPath = configPath;
            cachedMtimeMs = mtimeMs;
            cachedPayload = frozenFallback;
        }
        return cachedPayload;
    };
}

module.exports = { createHotJsonConfigLoader };
