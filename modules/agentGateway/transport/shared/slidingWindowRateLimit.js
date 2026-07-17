function createSlidingWindowRateLimit({ limit, windowMs } = {}) {
    return {
        limit: Number(limit) || 0,
        windowMs: Number(windowMs) || 0,
        timestamps: []
    };
}

function checkSlidingWindowRateLimit(state, timestamp = Date.now()) {
    if (!state || state.limit <= 0 || state.windowMs <= 0) {
        return { allowed: true };
    }
    const cutoff = timestamp - state.windowMs;
    state.timestamps = state.timestamps.filter((entry) => entry > cutoff);
    if (state.timestamps.length >= state.limit) {
        return {
            allowed: false,
            retryAfterMs: Math.max(0, state.timestamps[0] + state.windowMs - timestamp),
            limit: state.limit,
            windowMs: state.windowMs
        };
    }
    state.timestamps.push(timestamp);
    return { allowed: true };
}

module.exports = { createSlidingWindowRateLimit, checkSlidingWindowRateLimit };
