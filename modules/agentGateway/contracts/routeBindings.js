const AGENT_GATEWAY_ROUTE_BINDINGS = Object.freeze({
    agentRender: (agentId) => `/agent_gateway/agents/${encodeURIComponent(agentId)}/render`,
    agentGuidance: (agentId) => `/agent_gateway/agents/${encodeURIComponent(agentId)}/guidance`,
    memoryTargets: '/agent_gateway/memory/targets',
    memorySearch: '/agent_gateway/memory/search',
    contextAssemble: '/agent_gateway/context/assemble',
    memoryWrite: '/agent_gateway/memory/write',
    recallRun: '/agent_gateway/recall/run',
    knowledgeSearch: '/agent_gateway/knowledge/search',
    credentialContext: '/agent_gateway/credential/context',
    jobGet: (jobId) => `/agent_gateway/jobs/${encodeURIComponent(jobId)}`,
    jobCancel: (jobId) => `/agent_gateway/jobs/${encodeURIComponent(jobId)}/cancel`,
    forgeCreate: '/agent_gateway/forge/experts',
    forgeConfirm: (jobId) => `/agent_gateway/forge/jobs/${encodeURIComponent(jobId)}/confirm`,
    forgeLearn: '/agent_gateway/forge/learn',
    forgeRetrial: '/agent_gateway/forge/retrial',
    gapReport: '/agent_gateway/forge/gaps',
    eventStream: '/agent_gateway/events/stream'
});

module.exports = { AGENT_GATEWAY_ROUTE_BINDINGS };
