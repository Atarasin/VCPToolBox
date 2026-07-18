'use strict';

const express = require('express');
const { NATIVE_GATEWAY_VERSION } = require('../modules/agentGateway/contracts/protocolGovernance');
const { getGatewayServiceBundle } = require('../modules/agentGateway/createGatewayServiceBundle');
const systemRoutes = require('./agentGateway/systemRoutes');
const agentRoutes = require('./agentGateway/agentRoutes');
const memoryRoutes = require('./agentGateway/memoryRoutes');
const runtimeRoutes = require('./agentGateway/runtimeRoutes');

const ROUTE_REGISTRARS = [
    ...Object.values(systemRoutes),
    ...Object.values(agentRoutes),
    ...Object.values(memoryRoutes),
    ...Object.values(runtimeRoutes)
];

module.exports = function createAgentGatewayRoutes(pluginManager) {
    if (!pluginManager) throw new Error('[AgentGatewayRoutes] pluginManager is required');
    const router = express.Router();
    const services = getGatewayServiceBundle(pluginManager, { gatewayVersion: NATIVE_GATEWAY_VERSION });
    const context = {
        ...services,
        protocolConfig: services.ports?.configuration?.protocol || {},
        healthSnapshot: services.ports?.configuration?.health || {}
    };
    ROUTE_REGISTRARS.forEach((register) => register(router, context));
    return router;
};
