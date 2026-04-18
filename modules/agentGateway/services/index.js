/**
 * Gateway Core service 层导出入口。
 * M3 起补齐 tool runtime，继续让 adapter 只负责协议适配。
 */
module.exports = {
    capabilityService: require('./capabilityService'),
    agentRegistryService: require('./agentRegistryService'),
    jobRuntimeService: require('./jobRuntimeService'),
    memoryRuntimeService: require('./memoryRuntimeService'),
    contextRuntimeService: require('./contextRuntimeService'),
    toolRuntimeService: require('./toolRuntimeService')
};
