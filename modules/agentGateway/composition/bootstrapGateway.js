const { getGatewayServiceBundle } = require('./createGatewayServiceBundle');
const { assertVcpHostReady, bindVcpPorts } = require('./vcpPortBindings');

function bootstrapGateway({ app, pluginManager, mountPath = '/agent_gateway', createRoutes, ports } = {}) {
    if (!app || typeof app.use !== 'function') {
        throw new Error('[AgentGatewayBootstrap] Express app is required');
    }
    assertVcpHostReady(pluginManager);
    const boundPorts = ports || bindVcpPorts(pluginManager);
    const bundle = getGatewayServiceBundle(pluginManager, { ports: boundPorts });
    const routeFactory = createRoutes || require('../../../routes/agentGatewayRoutes');
    const router = routeFactory(pluginManager);
    app.use(mountPath, router);
    return Object.freeze({ bundle, ports: boundPorts, router, mountPath });
}

module.exports = { bootstrapGateway };
