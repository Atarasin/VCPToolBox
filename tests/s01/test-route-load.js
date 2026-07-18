const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const createAgentGatewayRoutes = require('../../routes/agentGatewayRoutes');

function createMockPluginManager() {
    return {
        messagePreprocessors: new Map(),
        plugins: new Map(),
        getPlugin: function(name) {
            return this.plugins.get(name);
        },
        agentManager: {
            getAgentMap: () => ({})
        },
        agentRegistryRenderPrompt: () => '',
        vectorDBManager: {
            listDiaryNames: () => [],
            search: async () => []
        }
    };
}

function makeRequest({ port, method, path, body }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : '';
        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : {};
                    resolve({ status: res.statusCode, body: parsed, headers: res.headers });
                } catch (error) {
                    resolve({ status: res.statusCode, body: data, headers: res.headers });
                }
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('AgentGatewayRoutes /recall/run', () => {
    let server;
    let port;
    let pluginManager;

    before(async () => {
        pluginManager = createMockPluginManager();
        const app = express();
        app.use(express.json());
        app.use('/gateway', createAgentGatewayRoutes(pluginManager));

        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                port = server.address().port;
                resolve();
            });
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('registers POST /recall/run and returns 400 when agentId is missing', async () => {
        const response = await makeRequest({
            port,
            method: 'POST',
            path: '/gateway/recall/run',
            body: { query: 'test query' }
        });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.success, false);
        assert.strictEqual(response.body.error, 'agentId is required');
        assert.strictEqual(response.body.code, 'AGW_INVALID_REQUEST');
    });

    it('registers POST /recall/run and returns 400 when query is missing', async () => {
        const response = await makeRequest({
            port,
            method: 'POST',
            path: '/gateway/recall/run',
            body: { agentId: 'TestAgent' }
        });

        assert.strictEqual(response.status, 400);
        assert.strictEqual(response.body.success, false);
        assert.strictEqual(response.body.error, 'query is required');
        assert.strictEqual(response.body.code, 'AGW_INVALID_REQUEST');
    });

    it('registers POST /recall/run and returns 404 when no recall profile exists', async () => {
        const response = await makeRequest({
            port,
            method: 'POST',
            path: '/gateway/recall/run',
            body: { agentId: 'UnknownAgent', query: 'test query' }
        });

        assert.strictEqual(response.status, 404);
        assert.strictEqual(response.body.success, false);
        assert.strictEqual(response.body.code, 'AGW_RECALL_NO_PROFILE');
    });

    it('returns structured result with diagnostics when profile resolves', async () => {
        // Set up a mock pluginManager with a recall profile
        // We need to inject a profile into the resolver cache.
        // The simplest way is to write a temp config file and point the resolver at it.
        const fs = require('fs');
        const path = require('path');
        const tempConfigPath = path.join(__dirname, 'temp_recall_profiles.json');
        fs.writeFileSync(tempConfigPath, JSON.stringify({
            agents: {
                TestAgent: {
                    defaultProfile: 'default',
                    profiles: {
                        default: {
                            rules: [
                                { type: 'rag', diaries: ['TestDiary'], modifiers: {} }
                            ]
                        }
                    }
                }
            }
        }));

        // Force a fresh pluginManager and bundle with the temp config path
        const freshPluginManager = createMockPluginManager();
        const freshApp = express();
        freshApp.use(express.json());

        // Monkey-patch the bundle creation to use our temp config
        const { getGatewayServiceBundle } = require('../../modules/agentGateway/createGatewayServiceBundle');
        const { RecallProfileResolver } = require('../../modules/agentGateway/policy/recallProfileResolver');

        // Pre-populate the bundle cache with a custom resolver
        const resolver = new RecallProfileResolver({ configPath: tempConfigPath });
        const { createRecallRuntimeService } = require('../../modules/agentGateway/services/recallRuntimeService');
        const { createRecallProjectionService } = require('../../modules/agentGateway/services/recallProjectionService');

        // We need to set up enough of the bundle for routes to work
        // Get the base bundle first
        const baseBundle = getGatewayServiceBundle(freshPluginManager, {
            gatewayVersion: 'v1'
        });

        // Then override the recall services
        freshPluginManager.__agentGatewayServiceBundle = {
            ...baseBundle,
            recallProfileResolver: resolver,
            recallRuntimeService: createRecallRuntimeService({
                ports: baseBundle.ports,
                ragRetrieverPort: baseBundle.ports.ragRetriever,
                ragConfig: baseBundle.ports.configuration.rag,
                contextRuntimeService: baseBundle.contextRuntimeService,
                recallProfileResolver: resolver
            }),
            recallProjectionService: createRecallProjectionService()
        };

        freshApp.use('/gateway', createAgentGatewayRoutes(freshPluginManager));

        const freshServer = await new Promise((resolve, reject) => {
            const s = freshApp.listen(0, '127.0.0.1', () => resolve(s));
            s.on('error', reject);
        });
        const freshPort = freshServer.address().port;

        try {
            const response = await makeRequest({
                port: freshPort,
                method: 'POST',
                path: '/gateway/recall/run',
                body: { agentId: 'TestAgent', query: 'test query' }
            });

            assert.strictEqual(response.status, 200);
            assert.strictEqual(response.body.success, true);
            assert.ok(response.body.data, 'response should have data');
            assert.ok(Array.isArray(response.body.data.items), 'data.items should be an array');
            assert.ok(response.body.data.diagnostics, 'data.diagnostics should be present');
            assert.strictEqual(response.body.data.agentId, 'TestAgent');
            assert.strictEqual(response.body.data.profileName, 'default');
        } finally {
            await new Promise((resolve) => freshServer.close(resolve));
            try { fs.unlinkSync(tempConfigPath); } catch {}
        }
    });
});
