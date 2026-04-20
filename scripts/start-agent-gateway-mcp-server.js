#!/usr/bin/env node

const path = require('node:path');
const util = require('node:util');

function writeToStderr(message) {
    process.stderr.write(`${message}\n`);
}

function installStderrConsoleBridge() {
    const originalError = console.error.bind(console);

    function redirect(method) {
        console[method] = (...args) => {
            writeToStderr(util.format(...args));
        };
    }

    redirect('log');
    redirect('info');
    redirect('warn');
    redirect('debug');
    console.error = (...args) => {
        originalError(...args);
    };
}

installStderrConsoleBridge();

const {
    startStdioMcpServer,
    initializeDefaultAgentGatewayMcpRuntime,
    shutdownDefaultAgentGatewayMcpRuntime
} = require('../modules/agentGateway/mcpStdioServer');

async function resolveRuntimeHooks() {
    const factoryPath = process.env.VCP_MCP_TRANSPORT_FACTORY;
    if (!factoryPath) {
        return {
            initializeRuntime: initializeDefaultAgentGatewayMcpRuntime,
            shutdownRuntime: shutdownDefaultAgentGatewayMcpRuntime
        };
    }

    const resolvedFactoryPath = path.resolve(process.cwd(), factoryPath);
    const factory = require(resolvedFactoryPath);

    if (!factory || typeof factory.initializeRuntime !== 'function') {
        throw new Error(`Invalid transport factory at ${resolvedFactoryPath}: missing initializeRuntime().`);
    }

    return {
        initializeRuntime: factory.initializeRuntime,
        shutdownRuntime: typeof factory.shutdownRuntime === 'function'
            ? factory.shutdownRuntime
            : async () => {}
    };
}

async function main() {
    const runtimeHooks = await resolveRuntimeHooks();
    const server = await startStdioMcpServer({
        initializeRuntime: runtimeHooks.initializeRuntime,
        shutdownRuntime: runtimeHooks.shutdownRuntime
    });

    async function shutdownAndExit(exitCode) {
        try {
            await server.close();
            process.exit(exitCode);
        } catch (error) {
            console.error('[MCPTransport] Failed during shutdown:', error);
            process.exit(1);
        }
    }

    process.on('SIGINT', () => {
        shutdownAndExit(0);
    });
    process.on('SIGTERM', () => {
        shutdownAndExit(0);
    });

    await server.finished;
}

main().catch((error) => {
    console.error('[MCPTransport] Failed to start Agent Gateway MCP server:', error);
    process.exit(1);
});
