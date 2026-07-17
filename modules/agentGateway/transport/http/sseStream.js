const { once } = require('node:events');

function createSseFrame(eventType, payload) {
    return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function createHeartbeatFrame() {
    return `: heartbeat ${Date.now()}\n\n`;
}

function createSseStreamController({ heartbeatIntervalMs, backpressureTimeoutMs, messagesPath, logError }) {
    function close(session, reason = 'stream_closed') {
        const stream = session.activeStream;
        if (!stream) return;
        session.activeStream = null;
        stream.closed = true;
        if (stream.heartbeatTimer) clearInterval(stream.heartbeatTimer);
        if (stream.cleanup) stream.cleanup();
        if (!stream.res.writableEnded && !stream.res.destroyed) {
            try {
                if (reason === 'session_deleted') {
                    stream.res.write(createSseFrame('endpoint_removed', { sessionId: session.context.sessionId }));
                }
                stream.res.end();
            } catch (_error) {
                // Ignore close races.
            }
        }
    }

    async function waitForDrain(res) {
        let timeout;
        try {
            await Promise.race([
                once(res, 'drain'),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('SSE backpressure timeout')), backpressureTimeoutMs);
                    if (typeof timeout.unref === 'function') timeout.unref();
                })
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    async function queue(session, frame, { allowDrop = false } = {}) {
        const stream = session.activeStream;
        if (!stream || stream.closed || !frame) return false;
        if (allowDrop && (stream.writing || stream.res.writableNeedDrain)) return false;
        stream.queue = stream.queue.then(async () => {
            if (stream.closed || stream.res.writableEnded || stream.res.destroyed) return;
            stream.writing = true;
            if (allowDrop && stream.res.writableNeedDrain) return;
            const wrote = stream.res.write(frame);
            if (typeof stream.res.flush === 'function') stream.res.flush();
            if (!wrote && !allowDrop) await waitForDrain(stream.res);
        }).catch((error) => {
            logError(error);
            close(session, 'stream_write_failed');
        }).finally(() => { stream.writing = false; });
        session.streamQueue = stream.queue;
        return true;
    }

    function open(req, res, session, { compatibility = false, touch } = {}) {
        close(session, 'stream_replaced');
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('MCP-Session-Id', session.context.sessionId);
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        const stream = { req, res, queue: Promise.resolve(), writing: false, closed: false, heartbeatTimer: null, cleanup: null };
        session.activeStream = stream;
        session.streamQueue = stream.queue;
        touch(session);
        const handleClose = () => {
            if (session.activeStream === stream) close(session, 'client_closed_stream');
        };
        req.on('close', handleClose);
        req.on('aborted', handleClose);
        res.on('close', handleClose);
        stream.cleanup = () => {
            req.off('close', handleClose);
            req.off('aborted', handleClose);
            res.off('close', handleClose);
        };
        void queue(session, compatibility
            ? createSseFrame('endpoint', { endpoint: messagesPath, sessionId: session.context.sessionId, deprecated: true })
            : createHeartbeatFrame(), { allowDrop: !compatibility });
        stream.heartbeatTimer = setInterval(() => {
            if (session.activeStream && !stream.closed) void queue(session, createHeartbeatFrame(), { allowDrop: true });
        }, heartbeatIntervalMs);
        if (typeof stream.heartbeatTimer.unref === 'function') stream.heartbeatTimer.unref();
    }

    return { close, open, queue, createSseFrame };
}

module.exports = { createSseFrame, createSseStreamController };
