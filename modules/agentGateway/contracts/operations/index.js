const { MCP_GATEWAY_TOOL_NAMES, createGatewayManagedToolDescriptors } = require('../../protocols/mcp/descriptors');

const REST_OPERATIONS = Object.freeze([
    ['health.read', 'get', '/agent_gateway/health'],
    ['capabilities.read', 'get', '/agent_gateway/capabilities'],
    ['agents.list', 'get', '/agent_gateway/agents'],
    ['agents.read', 'get', '/agent_gateway/agents/{agentId}'],
    ['agents.render', 'post', '/agent_gateway/agents/{agentId}/render'],
    ['metrics.read', 'get', '/agent_gateway/metrics'],
    ['memory.targets', 'get', '/agent_gateway/memory/targets'],
    ['memory.search', 'post', '/agent_gateway/memory/search'],
    ['memory.write', 'post', '/agent_gateway/memory/write'],
    ['context.assemble', 'post', '/agent_gateway/context/assemble'],
    ['recall.run', 'post', '/agent_gateway/recall/run'],
    ['tools.invoke', 'post', '/agent_gateway/tools/{toolName}/invoke'],
    ['jobs.read', 'get', '/agent_gateway/jobs/{jobId}'],
    ['jobs.cancel', 'post', '/agent_gateway/jobs/{jobId}/cancel'],
    ['events.stream', 'get', '/agent_gateway/events/stream']
].map(([operationId, method, path]) => Object.freeze({ operationId, method, path })));

const gatewayToolSchemas = Object.freeze(Object.fromEntries(
    createGatewayManagedToolDescriptors().map((descriptor) => [descriptor.name, descriptor.inputSchema])
));

const GATEWAY_OPERATIONS = Object.freeze({
    [MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER]: Object.freeze({
        operationName: 'agents.render', source: 'mcp-agent-render', requiresAgentOnly: true,
        publishedAsTool: false, executor: 'render', backendExecutor: 'removedRender'
    }),
    [MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP]: Object.freeze({
        operationName: 'agents.render', source: 'mcp-agent-bootstrap', requiresAgentOnly: true,
        asBootstrap: true, executor: 'render', backendExecutor: 'render'
    }),
    [MCP_GATEWAY_TOOL_NAMES.JOB_GET]: Object.freeze({ operationName: 'jobs.read', source: 'mcp-job-get', requiresJobIdentity: true, executor: 'jobGet', backendExecutor: 'jobGet' }),
    [MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL]: Object.freeze({ operationName: 'jobs.cancel', source: 'mcp-job-cancel', requiresJobIdentity: true, executor: 'jobCancel', backendExecutor: 'jobCancel' }),
    [MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH]: Object.freeze({ operationName: 'memory.search', source: 'mcp-memory-search', diaryPolicy: true, executor: 'memorySearch', backendExecutor: 'memorySearch' }),
    [MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE]: Object.freeze({ operationName: 'context.assemble', source: 'mcp-context-assemble', diaryPolicy: true, executor: 'contextAssemble', backendExecutor: 'contextAssemble' }),
    [MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE]: Object.freeze({ operationName: 'memory.write', source: 'mcp-memory-write', executor: 'memoryWrite', backendExecutor: 'memoryWrite' }),
    [MCP_GATEWAY_TOOL_NAMES.RECALL_RUN]: Object.freeze({ operationName: 'recall.run', source: 'mcp-recall-run', requireSession: false, executor: 'recallRun', backendExecutor: 'recallRun' })
});

const OPERATION_CATALOG = Object.freeze({ rest: REST_OPERATIONS, mcp: GATEWAY_OPERATIONS, schemas: gatewayToolSchemas });

function getGatewayOperation(toolName) { return GATEWAY_OPERATIONS[toolName] || null; }

module.exports = { GATEWAY_OPERATIONS, OPERATION_CATALOG, REST_OPERATIONS, gatewayToolSchemas, getGatewayOperation };
