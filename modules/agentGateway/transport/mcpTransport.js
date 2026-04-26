'use strict';

/**
 * @typedef {Object} McpTransport
 * @property {(message: string) => void} send
 *   Send a pre-serialized JSON-RPC message string to the peer. Implementations
 *   must append framing (e.g. newline) as required by the underlying channel
 *   and must not re-stringify the payload.
 * @property {() => Promise<void>|void} close
 *   Close the transport. Idempotent. Resolves once the underlying I/O resources
 *   have been released. Subsequent {@link McpTransport.send} calls must be no-ops.
 * @property {(handler: (message: string) => void) => void} setMessageHandler
 *   Register a callback invoked with each inbound message string. Setting a
 *   handler replaces any previously registered handler.
 * @property {(handler: (error: Error) => void) => void} setErrorHandler
 *   Register a callback invoked when the transport surfaces an error (typically
 *   thrown by the message handler). Setting a handler replaces any previously
 *   registered handler.
 * @property {Promise<void>|{then: Function}} finished
 *   Promise-like value that resolves when the underlying transport has fully
 *   closed and no further inbound messages will arrive.
 */

/**
 * Reference shape of the McpTransport contract. Provided as a documentation
 * anchor so consumers can `Object.keys(McpTransport)` to discover required
 * method names.
 */
const McpTransport = Object.freeze({
    send: 'function',
    close: 'function',
    setMessageHandler: 'function',
    setErrorHandler: 'function',
    finished: 'promise'
});

const REQUIRED_METHODS = Object.keys(McpTransport);

/**
 * Validate that a value implements the {@link McpTransport} contract.
 *
 * @param {unknown} transport - Candidate transport instance to validate.
 * @returns {McpTransport} The same transport reference when valid.
 * @throws {TypeError} When the transport is missing a required method.
 */
function validateMcpTransport(transport) {
    if (!transport || (typeof transport !== 'object' && typeof transport !== 'function')) {
        throw new TypeError('McpTransport missing required method: send');
    }

    for (const methodName of REQUIRED_METHODS) {
        if (methodName === 'finished') {
            continue;
        }
        if (typeof transport[methodName] !== 'function') {
            throw new TypeError(`McpTransport missing required method: ${methodName}`);
        }
    }

    const finished = transport.finished;
    const isPromiseLike = Boolean(finished) && typeof finished.then === 'function';
    if (!isPromiseLike) {
        throw new TypeError('McpTransport missing required method: finished');
    }

    return transport;
}

module.exports = {
    McpTransport,
    validateMcpTransport
};
