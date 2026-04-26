'use strict';

const WebSocket = require('ws');

/**
 * WebSocketTransport implements the callback-based MCP transport contract over
 * a single established `ws` connection. It intentionally stays as a dumb pipe:
 * no JSON parsing, auth, or session handling lives here.
 */
class WebSocketTransport {
    /**
     * @param {WebSocket} ws
     * @param {Object} [options]
     * @param {string} [options.binaryType='nodebuffer']
     */
    constructor(ws, options = {}) {
        this.ws = ws;
        this._messageHandler = null;
        this._errorHandler = null;
        this._closed = false;
        this._finishedPromise = new Promise((resolve) => {
            ws.once('close', () => {
                this._closed = true;
                resolve();
            });
        });

        this.ws.binaryType = options.binaryType || 'nodebuffer';

        this.ws.on('message', (data, isBinary) => {
            if (isBinary || typeof this._messageHandler !== 'function') {
                return;
            }

            try {
                const message = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
                this._messageHandler(message);
            } catch (error) {
                this._emitError(error);
            }
        });

        this.ws.on('error', (error) => {
            this._emitError(error);
        });
    }

    setMessageHandler(handler) {
        this._messageHandler = handler;
    }

    setErrorHandler(handler) {
        this._errorHandler = handler;
    }

    send(jsonString) {
        if (this._closed || this.ws.readyState !== WebSocket.OPEN || typeof jsonString !== 'string') {
            return;
        }

        this.ws.send(jsonString);
    }

    close(code = 1000, reason = 'normal closure') {
        if (this._closed) {
            return Promise.resolve();
        }

        this._closed = true;
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close(code, reason);
        }

        return Promise.resolve();
    }

    get finished() {
        return this._finishedPromise;
    }

    _emitError(error) {
        if (typeof this._errorHandler !== 'function') {
            return;
        }

        try {
            this._errorHandler(error);
        } catch (_secondaryError) {
            // Swallow secondary handler failures so transport I/O stays contained.
        }
    }
}

module.exports = {
    WebSocketTransport
};
