'use strict';

const { getGatewayServiceBundle } = require('./createGatewayServiceBundle');

function createLazyGatewayCredentialService(pluginManager) {
    if (!pluginManager) {
        throw new Error('[LazyGatewayCredentialService] pluginManager is required');
    }

    const resolveService = () => {
        const service = getGatewayServiceBundle(pluginManager).gatewayCredentialService;
        if (!service) {
            throw new Error('[LazyGatewayCredentialService] gateway credential service is unavailable');
        }
        return service;
    };

    return Object.freeze({
        get adminSessionStore() { return resolveService().adminSessionStore; },
        get credentialResolver() { return resolveService().credentialResolver; },
        get builtinCredentialResolver() { return resolveService().builtinCredentialResolver; },
        get authMigrationMetrics() { return resolveService().authMigrationMetrics; },
        get switches() { return resolveService().switches; },
        buildGatewayRequestContext(...args) {
            const service = resolveService();
            return service.buildGatewayRequestContext(...args);
        },
        authorizeTarget(...args) {
            const service = resolveService();
            return service.authorizeTarget(...args);
        }
    });
}

module.exports = { createLazyGatewayCredentialService };
