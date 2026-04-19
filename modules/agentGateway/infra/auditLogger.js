const { getDurationMs } = require('./trace');

function createAuditLogger(options = {}) {
    const prefix = typeof options.prefix === 'string' && options.prefix.trim()
        ? options.prefix.trim()
        : '[AgentGatewayAudit]';
    const write = typeof options.write === 'function'
        ? options.write
        : (line) => console.log(line);

    function emit(event, payload = {}) {
        write(`${prefix} ${JSON.stringify({ event, ...payload })}`);
    }

    function withDuration(payload, startedAt) {
        if (typeof startedAt !== 'number') {
            return payload;
        }
        return {
            ...payload,
            durationMs: getDurationMs(startedAt)
        };
    }

    return {
        log(event, payload) {
            emit(event, payload);
        },
        logGatewayOperation(event, payload, startedAt) {
            emit(`gateway.${event}`, withDuration(payload, startedAt));
        },
        logCapability(event, payload, startedAt) {
            emit(`capability.${event}`, withDuration(payload, startedAt));
        },
        logMemory(event, payload, startedAt) {
            emit(`memory.${event}`, withDuration(payload, startedAt));
        },
        logContext(event, payload, startedAt) {
            emit(`rag.context.${event}`, withDuration(payload, startedAt));
        },
        logSearch(event, payload, startedAt) {
            emit(`rag.search.${event}`, withDuration(payload, startedAt));
        },
        logToolInvoke(event, payload, startedAt) {
            emit(`tool.${event}`, withDuration(payload, startedAt));
        }
    };
}

module.exports = {
    createAuditLogger
};
