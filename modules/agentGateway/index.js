/**
 * Agent Gateway Core 基础导出入口。
 * 当前按里程碑逐步补齐 services，后续再继续扩展 policy 和 adapters。
 */
module.exports = {
    contracts: require('./contracts'),
    infra: require('./infra'),
    services: require('./services')
};
