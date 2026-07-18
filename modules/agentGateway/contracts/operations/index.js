const restOperations = require('./restOperations.json');
const mcpOperations = require('./mcpOperations.json');

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

function toolName(suffix) {
    return mcpOperations.find((operation) => operation.toolName === `gateway_${suffix}`)?.toolName || '';
}

const MCP_GATEWAY_TOOL_NAMES = deepFreeze({
    AGENT_RENDER: toolName('agent_render'),
    AGENT_BOOTSTRAP: toolName('agent_bootstrap'),
    JOB_GET: toolName('job_get'),
    JOB_CANCEL: toolName('job_cancel'),
    MEMORY_SEARCH: toolName('memory_search'),
    CONTEXT_ASSEMBLE: toolName('context_assemble'),
    MEMORY_WRITE: toolName('memory_write'),
    RECALL_RUN: toolName('recall_run')
});

const REST_OPERATIONS = deepFreeze(restOperations);
const MCP_OPERATIONS = deepFreeze(mcpOperations);
const GATEWAY_OPERATIONS = deepFreeze(Object.fromEntries(
    MCP_OPERATIONS.map((operation) => [operation.toolName, {
        ...operation.execution,
        operationId: operation.operationId,
        argsSchema: operation.argsSchema,
        resultSchema: operation.resultSchema,
        errors: operation.errors,
        mcp: operation.mcp
    }])
));
const gatewayToolSchemas = deepFreeze(Object.fromEntries(
    MCP_OPERATIONS.map((operation) => [operation.toolName, operation.argsSchema])
));
const OPERATION_CATALOG = deepFreeze({ rest: REST_OPERATIONS, mcp: MCP_OPERATIONS });

function getGatewayOperation(name) { return GATEWAY_OPERATIONS[name] || null; }

module.exports = {
    GATEWAY_OPERATIONS,
    MCP_GATEWAY_TOOL_NAMES,
    MCP_OPERATIONS,
    OPERATION_CATALOG,
    REST_OPERATIONS,
    gatewayToolSchemas,
    getGatewayOperation
};
