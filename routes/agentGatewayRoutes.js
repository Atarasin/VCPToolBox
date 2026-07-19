'use strict';

const express = require('express');
const { NATIVE_GATEWAY_VERSION } = require('../modules/agentGateway/contracts/protocolGovernance');
const { getGatewayServiceBundle } = require('../modules/agentGateway/createGatewayServiceBundle');
const {
    createAdminGatewaySessionStore,
    createInMemoryAdminSessionBackend
} = require('../modules/agentGateway/policy/adminGatewaySessionStore');
const { readMigrationSwitches } = require('../modules/agentGateway/policy/builtinCredentials');
const { parseBoolean } = require('../modules/agentGateway/policy/shared/normalize');
const { createAuthInjectionMiddleware } = require('./agentGateway/authInjection');
const systemRoutes = require('./agentGateway/systemRoutes');
const agentRoutes = require('./agentGateway/agentRoutes');
const memoryRoutes = require('./agentGateway/memoryRoutes');
const runtimeRoutes = require('./agentGateway/runtimeRoutes');
const { registerAdminSessionRoutes } = require('./agentGateway/authSessionRoutes');

const ROUTE_REGISTRARS = [
    ...Object.values(systemRoutes),
    ...Object.values(agentRoutes),
    ...Object.values(memoryRoutes),
    ...Object.values(runtimeRoutes),
    registerAdminSessionRoutes
];

function resolveAdminSessionStore(pluginManager) {
    // 多 worker 生产部署必须注入共享 backend；仓库内存 backend 仅限显式
    // 开发开关（§3.3：无生产 store 时 session 创建返回 503，不回退进程内 Map）。
    const injectedBackend = pluginManager.agentGatewayAdminSessionBackend || null;
    const allowDevStore = parseBoolean(process.env.AGENT_GATEWAY_ADMIN_SESSION_DEV_STORE, false);
    if (!injectedBackend && !allowDevStore) {
        return null;
    }
    return createAdminGatewaySessionStore({
        backend: injectedBackend || createInMemoryAdminSessionBackend()
    });
}

module.exports = function createAgentGatewayRoutes(pluginManager) {
    if (!pluginManager) throw new Error('[AgentGatewayRoutes] pluginManager is required');
    const router = express.Router();
    const services = getGatewayServiceBundle(pluginManager, { gatewayVersion: NATIVE_GATEWAY_VERSION });
    const context = {
        ...services,
        protocolConfig: services.ports?.configuration?.protocol || {},
        healthSnapshot: services.ports?.configuration?.health || {},
        adminGatewaySessionStore: resolveAdminSessionStore(pluginManager),
        builtinCredentialSwitches: readMigrationSwitches()
    };
    // 单一认证注入点：显式最先挂载，消除 registrar 顺序依赖（M1.S3.T7）
    router.use(createAuthInjectionMiddleware(context));
    ROUTE_REGISTRARS.forEach((register) => register(router, context));
    return router;
};
