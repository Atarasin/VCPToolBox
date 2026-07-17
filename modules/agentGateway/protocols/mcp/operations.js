const { MCP_GATEWAY_TOOL_NAMES } = require('./descriptors');

const GATEWAY_OPERATIONS = Object.freeze({
    [MCP_GATEWAY_TOOL_NAMES.AGENT_RENDER]: Object.freeze({
        operationName: 'agents.render', source: 'mcp-agent-render', requiresAgentOnly: true,
        publishedAsTool: false, executor: 'render', backendExecutor: 'removedRender'
    }),
    [MCP_GATEWAY_TOOL_NAMES.AGENT_BOOTSTRAP]: Object.freeze({
        operationName: 'agents.render', source: 'mcp-agent-bootstrap', requiresAgentOnly: true,
        asBootstrap: true, executor: 'render', backendExecutor: 'render'
    }),
    [MCP_GATEWAY_TOOL_NAMES.JOB_GET]: Object.freeze({
        operationName: 'jobs.read', source: 'mcp-job-get', requiresJobIdentity: true,
        executor: 'jobGet', backendExecutor: 'jobGet'
    }),
    [MCP_GATEWAY_TOOL_NAMES.JOB_CANCEL]: Object.freeze({
        operationName: 'jobs.cancel', source: 'mcp-job-cancel', requiresJobIdentity: true,
        executor: 'jobCancel', backendExecutor: 'jobCancel'
    }),
    [MCP_GATEWAY_TOOL_NAMES.MEMORY_SEARCH]: Object.freeze({
        operationName: 'memory.search', source: 'mcp-memory-search', diaryPolicy: true,
        executor: 'memorySearch', backendExecutor: 'memorySearch'
    }),
    [MCP_GATEWAY_TOOL_NAMES.CONTEXT_ASSEMBLE]: Object.freeze({
        operationName: 'context.assemble', source: 'mcp-context-assemble', diaryPolicy: true,
        executor: 'contextAssemble', backendExecutor: 'contextAssemble'
    }),
    [MCP_GATEWAY_TOOL_NAMES.MEMORY_WRITE]: Object.freeze({
        operationName: 'memory.write', source: 'mcp-memory-write',
        executor: 'memoryWrite', backendExecutor: 'memoryWrite'
    }),
    [MCP_GATEWAY_TOOL_NAMES.RECALL_RUN]: Object.freeze({
        operationName: 'recall.run', source: 'mcp-recall-run', requireSession: false,
        executor: 'recallRun', backendExecutor: 'recallRun'
    })
});

function getGatewayOperation(toolName) {
    return GATEWAY_OPERATIONS[toolName] || null;
}

module.exports = {
    GATEWAY_OPERATIONS,
    getGatewayOperation
};
