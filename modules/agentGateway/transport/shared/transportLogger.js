function createTransportLogger({ stderr = process.stderr, transport = 'mcp' } = {}) {
    function write(level, event, fields = {}) {
        if (!stderr || typeof stderr.write !== 'function') return;
        stderr.write(`${JSON.stringify({ level, transport, event, ...fields })}\n`);
    }
    return {
        info(event, fields) { write('info', event, fields); },
        error(event, error, fields = {}) {
            write('error', event, {
                ...fields,
                message: error?.message || String(error || 'Unknown error')
            });
        }
    };
}

module.exports = { createTransportLogger };
