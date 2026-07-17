function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
    if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean);
    if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
    return [];
}

function parseBoolean(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') return true;
        if (normalized === 'false' || normalized === '0') return false;
    }
    return fallback;
}

function parseJsonObject(value, fallback = {}) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (_error) {
        return fallback;
    }
}

module.exports = { normalizeString, normalizeStringArray, parseBoolean, parseJsonObject };
