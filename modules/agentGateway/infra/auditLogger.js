const fs = require('node:fs/promises');
const path = require('node:path');
const { getDurationMs } = require('./trace');

const SENSITIVE_KEY_PATTERN = /(?:authorization|api[_-]?key|token|secret|password|cookie|gateway[_-]?key)/i;

function sanitizeAuditValue(value, seen = new WeakSet()) {
    if (Array.isArray(value)) return value.map((entry) => sanitizeAuditValue(entry, seen));
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeAuditValue(entry, seen)
    ]));
}

function createConsoleAuditSink({ write = (line) => console.log(line) } = {}) {
    return { name: 'console', write };
}

function createFileAuditSink(filePath) {
    const resolvedPath = path.resolve(filePath);
    let ready;
    return {
        name: 'file',
        async write(line) {
            ready ||= fs.mkdir(path.dirname(resolvedPath), { recursive: true });
            await ready;
            await fs.appendFile(resolvedPath, `${line}\n`, 'utf8');
        }
    };
}

function createAuditLogger(options = {}) {
    const prefix = typeof options.prefix === 'string' && options.prefix.trim() ? options.prefix.trim() : '[AgentGatewayAudit]';
    const sinks = Array.isArray(options.sinks) && options.sinks.length
        ? options.sinks
        : [createConsoleAuditSink({ write: options.write })];
    const onSinkError = typeof options.onSinkError === 'function'
        ? options.onSinkError
        : (error, sink) => console.error(`[AgentGatewayAudit] sink ${sink.name || 'unknown'} failed: ${error.message}`);
    const pending = new Set();

    function emit(event, payload = {}) {
        const line = `${prefix} ${JSON.stringify(sanitizeAuditValue({ event, ...payload }))}`;
        for (const sink of sinks) {
            try {
                const result = sink.write(line);
                if (result && typeof result.then === 'function') {
                    const task = Promise.resolve(result).catch((error) => onSinkError(error, sink)).finally(() => pending.delete(task));
                    pending.add(task);
                }
            } catch (error) { onSinkError(error, sink); }
        }
    }

    function withDuration(payload, startedAt) {
        return typeof startedAt === 'number' ? { ...payload, durationMs: getDurationMs(startedAt) } : payload;
    }

    return {
        flush: () => Promise.allSettled([...pending]),
        log: emit,
        logGatewayOperation: (event, payload, startedAt) => emit(`gateway.${event}`, withDuration(payload, startedAt)),
        logCapability: (event, payload, startedAt) => emit(`capability.${event}`, withDuration(payload, startedAt)),
        logMemory: (event, payload, startedAt) => emit(`memory.${event}`, withDuration(payload, startedAt)),
        logContext: (event, payload, startedAt) => emit(`rag.context.${event}`, withDuration(payload, startedAt)),
        logSearch: (event, payload, startedAt) => emit(`rag.search.${event}`, withDuration(payload, startedAt)),
        logToolInvoke: (event, payload, startedAt) => emit(`tool.${event}`, withDuration(payload, startedAt))
    };
}

module.exports = { createAuditLogger, createConsoleAuditSink, createFileAuditSink, sanitizeAuditValue };
