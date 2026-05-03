const assert = require('assert');
const http = require('http');
const { AgentDispatcher, COMPLETION_MARKERS } = require('../../Plugin/StoryOrchestrator/agents/AgentDispatcher');

// Contract tests for AgentDispatcher shared interface.
// These tests verify the decoupled interface without requiring StoryOrchestrator context.

let mockServer;
let mockServerUrl;

function startMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function setup() {
  const { server, url } = await startMockServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: { content: `Test response with ${COMPLETION_MARKERS.COMPLETE}` },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      }));
    });
  });
  mockServer = server;
  mockServerUrl = url;
}

async function teardown() {
  if (mockServer) {
    mockServer.close();
  }
}

// Run tests
async function runTests() {
  console.log('[Contract] AgentDispatcher shared interface tests');

  await setup();

  // Test 1: Can initialize with decoupled agentResolver (no stateManager, no AgentDefinitions)
  {
    const agentResolver = (agentType) => ({
      modelId: 'test-model',
      systemPrompt: `You are ${agentType} agent.`,
      maxOutputTokens: 4000,
      temperature: 0.7
    });

    const dispatcher = new AgentDispatcher({
      agentAssistantUrl: mockServerUrl,
      vcpKey: 'test-key',
      agentResolver
    });

    assert.strictEqual(typeof dispatcher.delegate, 'function', 'delegate must be a function');
    assert.strictEqual(typeof dispatcher.delegateParallel, 'function', 'delegateParallel must be a function');
    assert.strictEqual(typeof dispatcher.delegateSerial, 'function', 'delegateSerial must be a function');

    console.log('  ✓ Test 1: AgentDispatcher initializes with decoupled agentResolver');
  }

  // Test 2: delegate() returns correct Result structure
  {
    const agentResolver = (agentType) => ({
      modelId: 'test-model',
      systemPrompt: 'Test prompt',
      maxOutputTokens: 4000,
      temperature: 0.7
    });

    const dispatcher = new AgentDispatcher({
      agentAssistantUrl: mockServerUrl,
      vcpKey: 'test-key',
      agentResolver
    });

    const result = await dispatcher.delegate('testAgent', 'Hello');

    assert.strictEqual(typeof result.content, 'string', 'Result.content must be a string');
    assert.strictEqual(typeof result.raw, 'object', 'Result.raw must be an object');
    assert.strictEqual(typeof result.markers, 'object', 'Result.markers must be an object');
    assert.strictEqual(typeof result.markers.isComplete, 'boolean', 'Result.markers.isComplete must be a boolean');
    assert.strictEqual(typeof result.markers.isFailed, 'boolean', 'Result.markers.isFailed must be a boolean');
    assert.strictEqual(typeof result.markers.hasHeartbeat, 'boolean', 'Result.markers.hasHeartbeat must be a boolean');

    console.log('  ✓ Test 2: delegate() returns correct Result structure');
  }

  // Test 3: delegateParallel() returns { succeeded, failed }
  {
    const agentResolver = (agentType) => ({
      modelId: 'test-model',
      systemPrompt: 'Test prompt',
      maxOutputTokens: 4000,
      temperature: 0.7
    });

    const dispatcher = new AgentDispatcher({
      agentAssistantUrl: mockServerUrl,
      vcpKey: 'test-key',
      agentResolver
    });

    const result = await dispatcher.delegateParallel([
      { agentType: 'agentA', prompt: 'Task A' },
      { agentType: 'agentB', prompt: 'Task B' }
    ]);

    assert.ok(Array.isArray(result.succeeded), 'delegateParallel.succeeded must be an array');
    assert.ok(Array.isArray(result.failed), 'delegateParallel.failed must be an array');
    assert.strictEqual(result.succeeded.length, 2, 'All parallel tasks should succeed');
    assert.strictEqual(result.failed.length, 0, 'No parallel tasks should fail');

    console.log('  ✓ Test 3: delegateParallel() returns { succeeded, failed }');
  }

  // Test 4: agentResolver is called with correct agentType
  {
    const resolvedTypes = [];
    const agentResolver = (agentType) => {
      resolvedTypes.push(agentType);
      return {
        modelId: 'test-model',
        systemPrompt: 'Test prompt',
        maxOutputTokens: 4000,
        temperature: 0.7
      };
    };

    const dispatcher = new AgentDispatcher({
      agentAssistantUrl: mockServerUrl,
      vcpKey: 'test-key',
      agentResolver
    });

    await dispatcher.delegate('worldBuilder', 'Build a world');
    assert.deepStrictEqual(resolvedTypes, ['worldBuilder'], 'agentResolver must be called with correct agentType');

    console.log('  ✓ Test 4: agentResolver receives correct agentType');
  }

  // Test 5: Throws when agentResolver returns missing modelId
  {
    const agentResolver = () => ({
      modelId: null,
      systemPrompt: 'Test',
      maxOutputTokens: 4000,
      temperature: 0.7
    });

    const dispatcher = new AgentDispatcher({
      agentAssistantUrl: mockServerUrl,
      vcpKey: 'test-key',
      agentResolver
    });

    try {
      await dispatcher.delegate('unknownAgent', 'Test');
      assert.fail('Should have thrown for missing modelId');
    } catch (error) {
      assert.ok(error.message.includes('missing MODEL_ID'), 'Error must mention missing MODEL_ID');
    }

    console.log('  ✓ Test 5: Throws when agentResolver returns missing modelId');
  }

  await teardown();

  console.log('[Contract] All AgentDispatcher interface contract tests passed.\n');
}

runTests().catch(err => {
  console.error('[Contract] Tests failed:', err);
  process.exit(1);
});
