/**
 * Gateway adapters 统一从这里导出，便于 Native / MCP 等边界层按需复用。
 */
module.exports = {
    mcpAdapter: require('./mcpAdapter')
};
