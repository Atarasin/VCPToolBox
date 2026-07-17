const { getGatewayServiceBundle } = require('./createGatewayServiceBundle');
const { assertVcpHostReady, bindVcpPorts } = require('./vcpPortBindings');

const AUDIT_FLUSH_HOOK = Symbol.for('vcp.agentGateway.auditFlushHook');

function registerAuditFlush(auditLogger) {
    if (process[AUDIT_FLUSH_HOOK] || typeof auditLogger?.flush !== 'function') return;
    process[AUDIT_FLUSH_HOOK] = true;
    process.once('beforeExit', () => auditLogger.flush());
}

function bootstrapGateway({ app, pluginManager, mountPath = '/agent_gateway', createRoutes, ports } = {}) {
    if (!app || typeof app.use !== 'function') {
        throw new Error('[AgentGatewayBootstrap] Express app is required');
    }
    assertVcpHostReady(pluginManager);
    const boundPorts = ports || bindVcpPorts(pluginManager);
    const bundle = getGatewayServiceBundle(pluginManager, { ports: boundPorts });
    registerAuditFlush(bundle.auditLogger);
    const routeFactory = createRoutes || require('../../../routes/agentGatewayRoutes');
    const router = routeFactory(pluginManager);
    app.use(mountPath, router);
    return Object.freeze({ bundle, ports: boundPorts, router, mountPath });
}

module.exports = { bootstrapGateway, registerAuditFlush };
