const {
    AGENT_GATEWAY_HEADERS
} = require('./contracts/protocolGovernance');

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
        fetchImpl
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

    async requestJson(method, routePath, { query, body, headers } = {}) {
        const response = await this.fetchImpl(
            `${this.baseUrl}${routePath}${buildQueryString(query)}`,
            {
                method,
                headers: this.createHeaders({
                    ...(body ? { 'content-type': 'application/json' } : {}),
                    ...(headers || {})
                }),
                body: body ? JSON.stringify(body) : undefined
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
    }

    async requestEventStream(routePath, { query, headers } = {}) {
        const response = await this.fetchImpl(
            `${this.baseUrl}${routePath}${buildQueryString(query)}`,
            {
                method: 'GET',
                headers: this.createHeaders({
                    accept: 'text/event-stream',
                    ...(headers || {})
                })
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
    }

    renderAgent(agentId, body) {
        return this.requestJson('POST', `/agent_gateway/agents/${encodeURIComponent(agentId)}/render`, {
            body
        });
    }

    getMemoryTargets(query) {
        return this.requestJson('GET', '/agent_gateway/memory/targets', {
            query
        });
    }

    searchMemory(body) {
        return this.requestJson('POST', '/agent_gateway/memory/search', {
            body
        });
    }

    assembleContext(body) {
        return this.requestJson('POST', '/agent_gateway/context/assemble', {
            body
        });
    }

    writeMemory(body) {
        return this.requestJson('POST', '/agent_gateway/memory/write', {
            body
        });
    }

    recallForCoding(body) {
        return this.requestJson('POST', '/agent_gateway/coding/recall', {
            body
        });
    }

    commitMemoryForCoding(body) {
        return this.requestJson('POST', '/agent_gateway/coding/memory-writeback', {
            body
        });
    }

    getJob(jobId, query) {
        return this.requestJson('GET', `/agent_gateway/jobs/${encodeURIComponent(jobId)}`, {
            query
        });
    }

    cancelJob(jobId, body) {
        return this.requestJson('POST', `/agent_gateway/jobs/${encodeURIComponent(jobId)}/cancel`, {
            body
        });
    }

    listJobEvents(jobId, query) {
        return this.requestEventStream('/agent_gateway/events/stream', {
            query: {
                ...(query || {}),
                jobId
            }
        });
    }
}

module.exports = {
    GatewayBackendClient
};
