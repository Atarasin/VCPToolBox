const { clearPresentedCredential } = require('../../policy/trustedCredentialContext');

const TERMINATED_TOMBSTONE_LIMIT = 256;
const TOMBSTONE_REASONS = new Set(['session_deleted', 'initialize_failed']);

function createSessionStore({
    normalizeId = (value) => String(value || ''),
    standardIdleMs,
    discoveryTtlMs,
    discoveryMaxSessions,
    onDestroy = async () => {}
}) {
    const standard = new Map();
    const discovery = new Map();
    const terminated = new Set();

    function recordTermination(sessionId) {
        terminated.delete(sessionId);
        terminated.add(sessionId);
        while (terminated.size > TERMINATED_TOMBSTONE_LIMIT) {
            terminated.delete(terminated.values().next().value);
        }
    }

    function getMap(session) {
        return session.kind === 'discovery' ? discovery : standard;
    }

    function clearTimer(session) {
        if (session.idleTimer) clearTimeout(session.idleTimer);
        session.idleTimer = null;
    }

    async function destroy(session, reason = 'session_deleted') {
        if (!session || session.cleanedUp) return;
        session.cleanedUp = true;
        if (TOMBSTONE_REASONS.has(reason)) recordTermination(session.context.sessionId);
        standard.delete(session.context.sessionId);
        discovery.delete(session.context.sessionId);
        clearTimer(session);
        // 销毁时清除对 presented token 的引用（§3.3）
        clearPresentedCredential(session.context);
        await onDestroy(session, reason);
    }

    function schedule(session) {
        clearTimer(session);
        const timeoutMs = session.kind === 'discovery' ? discoveryTtlMs : standardIdleMs;
        session.idleTimer = setTimeout(() => void destroy(session, 'idle_expired'), timeoutMs);
        if (typeof session.idleTimer.unref === 'function') session.idleTimer.unref();
    }

    function touch(session) {
        session.lastActivityAt = Date.now();
        if (session.kind === 'discovery') {
            discovery.delete(session.context.sessionId);
            discovery.set(session.context.sessionId, session);
        }
        schedule(session);
    }

    function add(session) {
        getMap(session).set(session.context.sessionId, session);
        schedule(session);
        return session;
    }

    async function addDiscovery(session) {
        while (discovery.size >= discoveryMaxSessions) {
            const oldest = discovery.values().next().value;
            if (!oldest) break;
            await destroy(oldest, 'discovery_lru_evicted');
        }
        return add(session);
    }

    return {
        add,
        addDiscovery,
        destroy,
        find(sessionId) {
            const id = normalizeId(sessionId);
            return id ? standard.get(id) || discovery.get(id) || null : null;
        },
        touch,
        isTerminated(sessionId) {
            const id = normalizeId(sessionId);
            return Boolean(id) && terminated.has(id);
        },
        async closeAll(reason = 'server_close') {
            await Promise.all([...standard.values(), ...discovery.values()].map((session) => destroy(session, reason)));
        },
        get totalSize() { return standard.size + discovery.size; },
        get standardSize() { return standard.size; },
        get discoverySize() { return discovery.size; }
    };
}

module.exports = { createSessionStore };
