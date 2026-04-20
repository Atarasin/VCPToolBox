class AgentGatewayClientError extends Error {
    constructor(message, payload = {}) {
        super(message);
        this.name = 'AgentGatewayClientError';
        this.status = payload.status || 500;
        this.code = payload.code || 'AGW_CLIENT_ERROR';
        this.details = payload.details || null;
        this.meta = payload.meta || null;
    }
}

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

class AgentGatewayClient {
    constructor({
        baseUrl,
        gatewayKey,
        gatewayId,
        bearerToken,
        defaultHeaders,
        fetchImpl
    } = {}) {
        if (!baseUrl) {
            throw new Error('baseUrl is required');
        }

        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.gatewayKey = gatewayKey || '';
        this.gatewayId = gatewayId || '';
        this.bearerToken = bearerToken || '';
        this.defaultHeaders = defaultHeaders && typeof defaultHeaders === 'object'
            ? { ...defaultHeaders }
            : {};
        this.fetchImpl = fetchImpl || globalThis.fetch;

        if (typeof this.fetchImpl !== 'function') {
            throw new Error('A fetch implementation is required');
        }
    }

    createHeaders(extraHeaders = {}) {
        const headers = {
            accept: 'application/json',
            ...this.defaultHeaders,
            ...extraHeaders
        };

        if (this.gatewayKey) {
            headers['x-agent-gateway-key'] = this.gatewayKey;
        }
        if (this.gatewayId) {
            headers['x-agent-gateway-id'] = this.gatewayId;
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

        const rawText = await response.text();
        const payload = rawText ? JSON.parse(rawText) : null;

        if (!response.ok || !payload?.success) {
            throw new AgentGatewayClientError(
                payload?.error || `Gateway request failed with status ${response.status}`,
                {
                    status: response.status,
                    code: payload?.code,
                    details: payload?.details,
                    meta: payload?.meta
                }
            );
        }

        return payload;
    }

    getCapabilities(params) {
        return this.requestJson('GET', '/agent_gateway/capabilities', {
            query: params
        });
    }

    getAgent(agentId, params) {
        return this.requestJson('GET', `/agent_gateway/agents/${encodeURIComponent(agentId)}`, {
            query: params
        });
    }

    renderAgent(agentId, body) {
        return this.requestJson('POST', `/agent_gateway/agents/${encodeURIComponent(agentId)}/render`, {
            body
        });
    }

    searchMemory(body) {
        return this.requestJson('POST', '/agent_gateway/memory/search', { body });
    }

    writeMemory(body) {
        return this.requestJson('POST', '/agent_gateway/memory/write', { body });
    }

    assembleContext(body) {
        return this.requestJson('POST', '/agent_gateway/context/assemble', { body });
    }

    recallForCoding(body) {
        return this.requestJson('POST', '/agent_gateway/coding/recall', { body });
    }

    commitMemoryForCoding(body) {
        return this.requestJson('POST', '/agent_gateway/coding/memory-writeback', { body });
    }

    invokeTool(toolName, body) {
        return this.requestJson('POST', `/agent_gateway/tools/${encodeURIComponent(toolName)}/invoke`, {
            body
        });
    }

    getJob(jobId, params) {
        return this.requestJson('GET', `/agent_gateway/jobs/${encodeURIComponent(jobId)}`, {
            query: params
        });
    }

    cancelJob(jobId, body) {
        return this.requestJson('POST', `/agent_gateway/jobs/${encodeURIComponent(jobId)}/cancel`, {
            body
        });
    }

    createEventStreamRequest(params = {}) {
        return {
            url: `${this.baseUrl}/agent_gateway/events/stream${buildQueryString(params)}`,
            headers: this.createHeaders({
                accept: 'text/event-stream'
            })
        };
    }
}

module.exports = {
    AgentGatewayClient,
    AgentGatewayClientError
};
