'use strict';

const express = require('express');
const { NATIVE_GATEWAY_VERSION } = require('../modules/agentGateway/contracts/protocolGovernance');
const { getGatewayServiceBundle } = require('../modules/agentGateway/createGatewayServiceBundle');
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

module.exports = function createAgentGatewayRoutes(pluginManager) {
    if (!pluginManager) throw new Error('[AgentGatewayRoutes] pluginManager is required');
    const router = express.Router();
    const services = getGatewayServiceBundle(pluginManager, { gatewayVersion: NATIVE_GATEWAY_VERSION });
    const context = {
        ...services,
        protocolConfig: services.ports?.configuration?.protocol || {},
        healthSnapshot: services.ports?.configuration?.health || {},
        adminGatewaySessionStore: services.gatewayCredentialService?.adminSessionStore || null,
        builtinCredentialSwitches: services.gatewayCredentialService?.switches || {}
    };
    // 单一认证注入点：显式最先挂载，消除 registrar 顺序依赖（M1.S3.T7）
    router.use(createAuthInjectionMiddleware(context));
    ROUTE_REGISTRARS.forEach((register) => register(router, context));
    return router;
};
