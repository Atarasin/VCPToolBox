'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');

const {
    StdioTransport,
    validateMcpTransport
} = require('../../../modules/agentGateway/transport');

function createMockStreams() {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    return { stdin, stdout, stderr };
}

function collectStdoutChunks(stdout) {
    const chunks = [];
    stdout.on('data', (chunk) => {
        chunks.push(chunk);
    });
    return chunks;
}

test('StdioTransport instance satisfies the McpTransport contract', () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const transport = new StdioTransport({ stdin, stdout, stderr });
    assert.equal(validateMcpTransport(transport), transport);
});

test('send writes the JSON string followed by a newline to stdout', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const chunks = collectStdoutChunks(stdout);
    const transport = new StdioTransport({ stdin, stdout, stderr });

    const payload = '{"jsonrpc":"2.0","id":1,"result":{}}';
    transport.send(payload);

    // Allow PassThrough to flush the synchronous write.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(chunks.join(''), `${payload}\n`);

    await transport.close();
});

test('setMessageHandler delivers each inbound line to the registered handler', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const transport = new StdioTransport({ stdin, stdout, stderr });
    const received = [];

    transport.setMessageHandler((line) => {
        received.push(line);
    });

    stdin.write('hello\n');
    stdin.write('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');

    // Wait one tick so readline emits the buffered lines.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(received, ['hello', '{"jsonrpc":"2.0","id":2,"method":"ping"}']);

    await transport.close();
});

test('setErrorHandler receives errors thrown by the message handler', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const transport = new StdioTransport({ stdin, stdout, stderr });

    transport.setMessageHandler(() => {
        throw new Error('boom');
    });

    const errors = [];
    transport.setErrorHandler((error) => {
        errors.push(error);
    });

    stdin.write('trigger\n');
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'boom');

    await transport.close();
});

test('close prevents subsequent send calls from writing to stdout', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const chunks = collectStdoutChunks(stdout);
    const transport = new StdioTransport({ stdin, stdout, stderr });

    await transport.close();
    transport.send('{"after":"close"}');

    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(chunks, []);
});

test('close is idempotent and resolves on every invocation', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const transport = new StdioTransport({ stdin, stdout, stderr });

    const first = transport.close();
    const second = transport.close();

    assert.ok(first instanceof Promise);
    assert.ok(second instanceof Promise);

    await assert.doesNotReject(Promise.all([first, second]));
});

test('finished resolves after the input stream closes', async () => {
    const { stdin, stdout, stderr } = createMockStreams();
    const transport = new StdioTransport({ stdin, stdout, stderr });

    let resolved = false;
    const finishedPromise = transport.finished.then(() => {
        resolved = true;
    });

    stdin.end();

    await Promise.race([
        finishedPromise,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('finished did not resolve in time')), 1000))
    ]);

    assert.equal(resolved, true);
});
