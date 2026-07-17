const {
    AGENT_GATEWAY_HEADERS
} = require('../contracts/protocolGovernance');
const { AGENT_GATEWAY_ROUTE_BINDINGS } = require('../contracts/routeBindings');

function buildQueryString(query = {}) {
    const searchParams = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') {
            return;
        }
        searchParams.set(key, String(value));
    });
    const serialized = searchParams.toString();
    return serialized ? `?${serialized}` : '';
}

function normalizeBaseUrl(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function sanitizeHeaderValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function resolvePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createRequestSignal(externalSignal, timeoutMs) {
    const controller = new AbortController();
    let externalAbortHandler = null;
    let timeout = null;

    if (externalSignal?.aborted) {
        controller.abort(externalSignal.reason);
    } else if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        externalAbortHandler = () => controller.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    if (!controller.signal.aborted) {
        timeout = setTimeout(() => {
            const error = new Error(`Gateway backend request timed out after ${timeoutMs}ms`);
            error.name = 'TimeoutError';
            controller.abort(error);
        }, timeoutMs);
    }

    return {
        signal: controller.signal,
        cleanup() {
            if (timeout) {
                clearTimeout(timeout);
            }
            if (externalAbortHandler) {
                externalSignal.removeEventListener('abort', externalAbortHandler);
            }
        }
    };
}

function parseSsePayload(bodyText) {
    const events = [];
    const blocks = String(bodyText || '').split(/\n\n+/);

    blocks.forEach((block) => {
        const lines = block.split('\n');
        let eventType = '';
        const dataLines = [];

        lines.forEach((line) => {
            if (line.startsWith('event:')) {
                eventType = line.slice('event:'.length).trim();
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice('data:'.length).trim());
            }
        });

        if (!eventType || dataLines.length === 0) {
            return;
        }

        const rawData = dataLines.join('\n');
        try {
            const parsed = JSON.parse(rawData);
            if (parsed && typeof parsed === 'object' && !parsed.eventType) {
                parsed.eventType = eventType;
            }
            events.push(parsed);
        } catch (error) {
            events.push({
                eventType,
                rawData
            });
        }
    });

    return events;
}

class GatewayBackendClient {
    constructor({
        baseUrl,
        gatewayKey,
        gatewayId,
        bearerToken,
        defaultHeaders,
        fetchImpl,
        timeoutMs
    } = {}) {
        if (!baseUrl) {
            throw new Error('Gateway backend baseUrl is required');
        }

        this.baseUrl = normalizeBaseUrl(baseUrl);
        this.gatewayKey = sanitizeHeaderValue(gatewayKey);
        this.gatewayId = sanitizeHeaderValue(gatewayId);
        this.bearerToken = sanitizeHeaderValue(bearerToken);
        this.defaultHeaders = defaultHeaders && typeof defaultHeaders === 'object'
            ? { ...defaultHeaders }
            : {};
        this.fetchImpl = fetchImpl || globalThis.fetch;
        this.timeoutMs = resolvePositiveInteger(
            timeoutMs ?? process.env.VCP_MCP_BACKEND_TIMEOUT_MS,
            30000
        );

        if (typeof this.fetchImpl !== 'function') {
            throw new Error('A fetch implementation is required for GatewayBackendClient');
        }
    }

    createHeaders(extraHeaders = {}) {
        const headers = {
            accept: 'application/json',
            ...this.defaultHeaders,
            ...extraHeaders
        };

        if (this.gatewayKey) {
            headers[AGENT_GATEWAY_HEADERS.GATEWAY_KEY] = this.gatewayKey;
        }
        if (this.gatewayId) {
            headers[AGENT_GATEWAY_HEADERS.GATEWAY_ID] = this.gatewayId;
        }
        if (this.bearerToken && !headers.authorization) {
            headers.authorization = `Bearer ${this.bearerToken}`;
        }

        return headers;
    }

    async requestJson(method, routePath, { query, body, headers, signal } = {}) {
        const requestSignal = createRequestSignal(signal, this.timeoutMs);
        try {
            const response = await this.fetchImpl(
                `${this.baseUrl}${routePath}${buildQueryString(query)}`,
                {
                    method,
                    headers: this.createHeaders({
                        ...(body ? { 'content-type': 'application/json' } : {}),
                        ...(headers || {})
                    }),
                    body: body ? JSON.stringify(body) : undefined,
                    signal: requestSignal.signal
                }
            );
            const responseText = await response.text();
            let payload = null;

            if (responseText) {
                try {
                    payload = JSON.parse(responseText);
                } catch (error) {
                    throw new Error(`Gateway backend returned invalid JSON for ${routePath}: ${error.message}`);
                }
            }

            return {
                ok: response.ok,
                httpStatus: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                payload
            };
        } finally {
            requestSignal.cleanup();
        }
    }

    async requestEventStream(routePath, { query, headers, signal } = {}) {
        const requestSignal = createRequestSignal(signal, this.timeoutMs);
        try {
            const response = await this.fetchImpl(
                `${this.baseUrl}${routePath}${buildQueryString(query)}`,
                {
                    method: 'GET',
                    headers: this.createHeaders({
                        accept: 'text/event-stream',
                        ...(headers || {})
                    }),
                    signal: requestSignal.signal
                }
            );

            const responseText = await response.text();
            return {
                ok: response.ok,
                httpStatus: response.status,
                headers: Object.fromEntries(response.headers.entries()),
                events: parseSsePayload(responseText),
                rawText: responseText
            };
        } finally {
            requestSignal.cleanup();
        }
    }

    renderAgent(agentId, body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.agentRender(agentId), {
            body,
            ...(requestOptions || {})
        });
    }

    getMemoryTargets(query, requestOptions) {
        return this.requestJson('GET', AGENT_GATEWAY_ROUTE_BINDINGS.memoryTargets, {
            query,
            ...(requestOptions || {})
        });
    }

    searchMemory(body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.memorySearch, {
            body,
            ...(requestOptions || {})
        });
    }

    assembleContext(body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.contextAssemble, {
            body,
            ...(requestOptions || {})
        });
    }

    writeMemory(body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.memoryWrite, {
            body,
            ...(requestOptions || {})
        });
    }

    runRecall(body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.recallRun, {
            body,
            ...(requestOptions || {})
        });
    }

    getJob(jobId, query, requestOptions) {
        return this.requestJson('GET', AGENT_GATEWAY_ROUTE_BINDINGS.jobGet(jobId), {
            query,
            ...(requestOptions || {})
        });
    }

    cancelJob(jobId, body, requestOptions) {
        return this.requestJson('POST', AGENT_GATEWAY_ROUTE_BINDINGS.jobCancel(jobId), {
            body,
            ...(requestOptions || {})
        });
    }

    listJobEvents(jobId, query, requestOptions) {
        return this.requestEventStream(AGENT_GATEWAY_ROUTE_BINDINGS.eventStream, {
            query: {
                ...(query || {}),
                jobId
            },
            ...(requestOptions || {})
        });
    }
}

module.exports = {
    GatewayBackendClient
};
