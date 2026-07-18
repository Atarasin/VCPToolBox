/**
 * Agent Gateway Core 基础导出入口。
 * 当前按里程碑逐步补齐 services，后续再继续扩展 policy 和 adapters。
 */
module.exports = {
    adapters: require('./adapters'),
    contracts: require('./contracts'),
    infra: require('./infra'),
    mcpHttpServer: require('./mcpHttpServer'),
    mcpWebSocketServer: require('./mcpWebSocketServer'),
    protocols: {
        mcp: require('./protocols/mcp')
    },
    policy: require('./policy'),
    services: require('./services')
};
