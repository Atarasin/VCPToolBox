const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAuditLogger, createFileAuditSink } = require('../../../modules/agentGateway/infra/auditLogger');

test('audit logger redacts secrets and flushes optional file sink', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-audit-'));
    const filePath = path.join(directory, 'nested', 'audit.log');
    const logger = createAuditLogger({ sinks: [createFileAuditSink(filePath)] });
    logger.log('request', { token: 'secret', nested: { apiKey: 'key', safe: 'value' } });
    await logger.flush();
    const line = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(line, /secret|"key"/);
    assert.match(line, /\[REDACTED\]/);
    assert.match(line, /"safe":"value"/);
});

test('audit sink failures are isolated from business callers', async () => {
    const errors = [];
    const logger = createAuditLogger({
        sinks: [{ name: 'broken', write() { throw new Error('disk unavailable'); } }],
        onSinkError(error, sink) { errors.push(`${sink.name}:${error.message}`); }
    });
    assert.doesNotThrow(() => logger.log('request', { authorization: 'hidden' }));
    await logger.flush();
    assert.deepEqual(errors, ['broken:disk unavailable']);
});
