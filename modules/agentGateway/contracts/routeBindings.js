const AGENT_GATEWAY_ROUTE_BINDINGS = Object.freeze({
    agentRender: (agentId) => `/agent_gateway/agents/${encodeURIComponent(agentId)}/render`,
    agentGuidance: (agentId) => `/agent_gateway/agents/${encodeURIComponent(agentId)}/guidance`,
    memoryTargets: '/agent_gateway/memory/targets',
    memorySearch: '/agent_gateway/memory/search',
    contextAssemble: '/agent_gateway/context/assemble',
    memoryWrite: '/agent_gateway/memory/write',
    recallRun: '/agent_gateway/recall/run',
    credentialContext: '/agent_gateway/credential/context',
    jobGet: (jobId) => `/agent_gateway/jobs/${encodeURIComponent(jobId)}`,
    jobCancel: (jobId) => `/agent_gateway/jobs/${encodeURIComponent(jobId)}/cancel`,
    eventStream: '/agent_gateway/events/stream'
});

module.exports = { AGENT_GATEWAY_ROUTE_BINDINGS };
