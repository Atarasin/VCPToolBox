'use strict';

const readline = require('node:readline');

/**
 * StdioTransport implements the {@link import('./mcpTransport').McpTransport}
 * contract over Node.js stdio streams. The transport is intentionally a dumb
 * pipe: it does not parse JSON, manage queues, or interpret JSON-RPC. Higher
 * layers (e.g. `createStdioMcpServer`) own all protocol semantics.
 */
class StdioTransport {
    /**
     * @param {Object} [options]
     * @param {NodeJS.ReadableStream} [options.stdin=process.stdin]
     * @param {NodeJS.WritableStream} [options.stdout=process.stdout]
     * @param {NodeJS.WritableStream} [options.stderr=process.stderr]
     */
    constructor(options = {}) {
        this.stdin = options.stdin || process.stdin;
        this.stdout = options.stdout || process.stdout;
        this.stderr = options.stderr || process.stderr;

        this._messageHandler = null;
        this._errorHandler = null;
        this._closed = false;
        this._finishedPromise = null;

        if (typeof this.stdin.setEncoding === 'function') {
            this.stdin.setEncoding('utf8');
        }

        this._input = readline.createInterface({
            input: this.stdin,
            crlfDelay: Infinity,
            terminal: false
        });

        this._input.on('line', (line) => {
            if (typeof this._messageHandler !== 'function') {
                return;
            }
            try {
                this._messageHandler(line);
            } catch (error) {
                if (typeof this._errorHandler === 'function') {
                    try {
                        this._errorHandler(error);
                    } catch (_innerError) {
                        // Swallow secondary errors to avoid escaping the I/O loop.
                    }
                }
            }
        });
    }

    /**
     * Register the inbound-message callback. Replaces any prior handler.
     * @param {(line: string) => void} handler
     */
    setMessageHandler(handler) {
        this._messageHandler = handler;
    }

    /**
     * Register the error callback. Replaces any prior handler.
     * @param {(error: Error) => void} handler
     */
    setErrorHandler(handler) {
        this._errorHandler = handler;
    }

    /**
     * Send a pre-serialized JSON message to stdout, appending a newline frame.
     * No-ops after {@link StdioTransport#close}.
     * @param {string} jsonString
     */
    send(jsonString) {
        if (this._closed) {
            return;
        }
        this.stdout.write(`${jsonString}\n`);
    }

    /**
     * Close the transport. Idempotent. Resolves once `close()` has been
     * issued to the underlying readline interface.
     * @returns {Promise<void>}
     */
    close() {
        if (this._closed) {
            return Promise.resolve();
        }
        this._closed = true;
        this._input.close();
        return Promise.resolve();
    }

    /**
     * Promise that resolves once the underlying input stream emits `close`.
     * Lazily created on first access so consumers can attach before/after
     * closing without missing the event.
     * @returns {Promise<void>}
     */
    get finished() {
        if (this._finishedPromise === null) {
            this._finishedPromise = new Promise((resolve) => {
                this._input.once('close', resolve);
            });
        }
        return this._finishedPromise;
    }
}

module.exports = {
    StdioTransport
};
