'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');

const WebSocket = require('ws');
const { WebSocketServer } = require('ws');

const {
    WebSocketTransport,
    validateMcpTransport
} = require('../../../modules/agentGateway/transport');

async function createWebSocketPair(clientOptions = {}) {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const serverSocketPromise = once(wss, 'connection').then(([socket]) => socket);
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`, clientOptions);
    await once(client, 'open');
    const serverSocket = await serverSocketPromise;

    return {
        client,
        serverSocket,
        async close() {
            if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
                client.close();
            }

            if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CONNECTING) {
                serverSocket.close();
            }

            await new Promise((resolve) => wss.close(resolve));
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    resolve();
                });
            });
        }
    };
}

test('WebSocketTransport instance satisfies the McpTransport contract', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    assert.equal(validateMcpTransport(transport), transport);
});

test('send writes the serialized string to the websocket peer', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const nextMessage = once(fixture.client, 'message').then(([message]) => message.toString());

    transport.send('{"jsonrpc":"2.0","id":1,"result":{}}');

    assert.equal(await nextMessage, '{"jsonrpc":"2.0","id":1,"result":{}}');
});

test('setMessageHandler delivers inbound text frames to the registered handler', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const received = [];

    transport.setMessageHandler((message) => {
        received.push(message);
    });

    fixture.client.send('hello');
    fixture.client.send('{"jsonrpc":"2.0","method":"ping"}');

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(received, ['hello', '{"jsonrpc":"2.0","method":"ping"}']);
});

test('setMessageHandler ignores binary websocket frames', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const received = [];

    transport.setMessageHandler((message) => {
        received.push(message);
    });

    fixture.client.send(Buffer.from([1, 2, 3, 4]));

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(received, []);
});

test('setErrorHandler receives errors thrown by the message handler', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const errors = [];

    transport.setMessageHandler(() => {
        throw new Error('boom');
    });
    transport.setErrorHandler((error) => {
        errors.push(error);
    });

    fixture.client.send('trigger');

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'boom');
});

test('setErrorHandler receives underlying websocket error events', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const errors = [];

    transport.setErrorHandler((error) => {
        errors.push(error);
    });

    fixture.serverSocket.emit('error', new Error('socket-failure'));

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, 'socket-failure');
});

test('close prevents subsequent send calls from writing to the websocket peer', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    await transport.close();

    let received = false;
    fixture.client.once('message', () => {
        received = true;
    });

    transport.send('{"after":"close"}');

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received, false);
});

test('close is idempotent and resolves on every invocation', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    const first = transport.close();
    const second = transport.close();

    assert.ok(first instanceof Promise);
    assert.ok(second instanceof Promise);
    await assert.doesNotReject(Promise.all([first, second]));
});

test('finished resolves after the websocket closes', async (t) => {
    const fixture = await createWebSocketPair();
    t.after(async () => fixture.close());

    const transport = new WebSocketTransport(fixture.serverSocket);
    let resolved = false;

    const finishedPromise = transport.finished.then(() => {
        resolved = true;
    });

    fixture.client.close();

    await Promise.race([
        finishedPromise,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('finished did not resolve in time')), 1000))
    ]);

    assert.equal(resolved, true);
});
