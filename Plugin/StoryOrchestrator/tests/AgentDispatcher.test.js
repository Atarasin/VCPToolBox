const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const http = require('http');

const { AgentDispatcher, COMPLETION_MARKERS } = require('../agents/AgentDispatcher');
const { AGENT_TYPES } = require('../agents/AgentDefinitions');

function createConfig(overrides = {}) {
  return {
    PORT: 6789,
    VCP_Key: 'config-key',
    AGENT_ASSISTANT_URL: 'http://127.0.0.1:6789',
    AGENT_WORLD_BUILDER_MODEL_ID: 'model-world',
    AGENT_WORLD_BUILDER_SYSTEM_PROMPT: 'You are the world builder.',
    AGENT_WORLD_BUILDER_CHINESE_NAME: '世界观设定',
    AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS: '3200',
    AGENT_WORLD_BUILDER_TEMPERATURE: '0.8',
    AGENT_CHARACTER_DESIGNER_MODEL_ID: 'model-character',
    AGENT_CHARACTER_DESIGNER_CHINESE_NAME: '人物塑造',
    AGENT_CHARACTER_DESIGNER_MAX_OUTPUT_TOKENS: '2800',
    AGENT_CHARACTER_DESIGNER_TEMPERATURE: '0.6',
    ...overrides
  };
}

function installHttpRequestMock(handler) {
  return mock.method(http, 'request', (options, callback) => {
    const req = new EventEmitter();
    let body = '';
    let timeoutMs;

    req.write = (chunk) => {
      body += chunk;
    };

    req.setTimeout = (ms, onTimeout) => {
      timeoutMs = ms;
      req.__onTimeout = onTimeout;
    };

    req.destroy = () => {
      req.destroyed = true;
    };

    req.end = () => {
      Promise.resolve(handler({ options, body, timeoutMs, req }))
        .then((response) => {
          if (response?.error) {
            req.emit('error', response.error);
            return;
          }

          if (response?.timeout) {
            req.__onTimeout?.();
            return;
          }

          const res = new EventEmitter();
          callback(res);

          if (response?.chunks) {
            for (const chunk of response.chunks) {
              res.emit('data', chunk);
            }
          } else if (response?.body !== undefined) {
            res.emit('data', response.body);
          }

          res.emit('end');
        })
        .catch((error) => req.emit('error', error));
    };

    return req;
  });
}

describe('AgentDispatcher', () => {
  let originalPort;
  let originalVcpKey;
  let originalKey;
  let logMock;
  let errorMock;

  beforeEach(() => {
    originalPort = process.env.PORT;
    originalVcpKey = process.env.VCP_Key;
    originalKey = process.env.Key;
    delete process.env.PORT;
    delete process.env.VCP_Key;
    delete process.env.Key;
    logMock = mock.method(console, 'log', () => {});
    errorMock = mock.method(console, 'error', () => {});
  });

  afterEach(() => {
    logMock.mock.restore();
    errorMock.mock.restore();

    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;

    if (originalVcpKey === undefined) delete process.env.VCP_Key;
    else process.env.VCP_Key = originalVcpKey;

    if (originalKey === undefined) delete process.env.Key;
    else process.env.Key = originalKey;
  });

  describe('constructor()', () => {
    test('initializes with provided agent definitions and config values', () => {
      const dispatcher = new AgentDispatcher(createConfig(), { state: true });

      assert.strictEqual(dispatcher.config.AGENT_WORLD_BUILDER_MODEL_ID, 'model-world');
      assert.strictEqual(dispatcher.stateManager.state, true);
      assert.strictEqual(dispatcher.agentAssistantUrl, 'http://127.0.0.1:6789');
      assert.strictEqual(dispatcher.vcpKey, 'config-key');
    });

    test('falls back to PORT and env keys when explicit values are absent', () => {
      process.env.PORT = '7123';
      process.env.VCP_Key = 'env-key';

      const dispatcher = new AgentDispatcher(createConfig({ PORT: undefined, AGENT_ASSISTANT_URL: undefined, VCP_Key: undefined }), {});

      assert.strictEqual(dispatcher.agentAssistantUrl, 'http://127.0.0.1:7123');
      assert.strictEqual(dispatcher.vcpKey, 'env-key');
    });

    test('falls back to Key env when VCP_Key is absent', () => {
      process.env.Key = 'legacy-key';

      const dispatcher = new AgentDispatcher(createConfig({ VCP_Key: undefined }), {});

      assert.strictEqual(dispatcher.vcpKey, 'legacy-key');
    });
  });

  describe('initialize()', () => {
    test('logs initialization message', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await dispatcher.initialize();

      assert.strictEqual(logMock.mock.calls.at(-1).arguments[0], '[AgentDispatcher] Initialized');
    });
  });

  describe('delegate(agentType, prompt)', () => {
    test('dispatches a sync task to the selected agent with correct payload', async () => {
      let captured;
      const requestMock = installHttpRequestMock(({ options, body, timeoutMs }) => {
        captured = { options, payload: JSON.parse(body), timeoutMs };
        return {
          body: JSON.stringify({
            choices: [{ message: { content: `done ${COMPLETION_MARKERS.COMPLETE}` } }]
          })
        };
      });

      const dispatcher = new AgentDispatcher(createConfig(), {});
      const result = await dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'outline the work');

      requestMock.mock.restore();

      assert.strictEqual(captured.options.hostname, '127.0.0.1');
      assert.strictEqual(captured.options.port, '6789');
      assert.strictEqual(captured.options.path, '/v1/chat/completions');
      assert.strictEqual(captured.options.method, 'POST');
      assert.strictEqual(captured.options.headers.Authorization, 'Bearer config-key');
      assert.strictEqual(captured.timeoutMs, 600000);
      assert.strictEqual(captured.payload.model, 'model-world');
      assert.strictEqual(captured.payload.messages[0].content, 'You are the world builder.');
      assert.strictEqual(captured.payload.messages[1].content, 'outline the work');
      assert.strictEqual(captured.payload.temperature, 0.8);
      assert.strictEqual(captured.payload.max_tokens, 3200);
      assert.strictEqual(result.content, `done ${COMPLETION_MARKERS.COMPLETE}`);
      assert.deepStrictEqual(result.markers, {
        isComplete: true,
        isFailed: false,
        hasHeartbeat: false
      });
    });

    test('uses selected agent definition for model, name fallback, and defaults', async () => {
      let payload;
      const requestMock = installHttpRequestMock(({ body }) => {
        payload = JSON.parse(body);
        return {
          body: JSON.stringify({
            choices: [{ message: { content: 'world created' } }]
          })
        };
      });

      const dispatcher = new AgentDispatcher(
        createConfig({
          AGENT_WORLD_BUILDER_SYSTEM_PROMPT: undefined,
          AGENT_WORLD_BUILDER_CHINESE_NAME: undefined,
          AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS: undefined,
          AGENT_WORLD_BUILDER_TEMPERATURE: undefined
        }),
        {}
      );

      await dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'build the setting');
      requestMock.mock.restore();

      assert.strictEqual(payload.model, 'model-world');
      assert.strictEqual(payload.messages[0].content, '你是世界观设定Agent。');
      assert.strictEqual(payload.max_tokens, 4000);
      assert.strictEqual(payload.temperature, 0.7);
    });

    test('supports async task delegation and returns polling handle', async () => {
      let captured;
      const requestMock = installHttpRequestMock(({ options, body, timeoutMs }) => {
        captured = { options, payload: JSON.parse(body), timeoutMs };
        return {
          body: JSON.stringify({
            result: { delegation_id: 'delegation-1' }
          })
        };
      });

      const dispatcher = new AgentDispatcher(createConfig(), {});
      const result = await dispatcher.delegate(AGENT_TYPES.CHARACTER_DESIGNER, 'design the cast', {
        taskDelegation: true,
        timeoutMs: 45000,
        temporaryContact: false
      });

      requestMock.mock.restore();

      assert.strictEqual(captured.options.path, '/v1/human/tool');
      assert.strictEqual(captured.timeoutMs, 30000);
      assert.strictEqual(captured.payload.command, 'delegate_task');
      assert.strictEqual(captured.payload.temporary_contact, false);
      assert.strictEqual(captured.payload.timeout_ms, 45000);
      assert.strictEqual(captured.payload.payload.model, 'model-character');
      assert.strictEqual(result.delegationId, 'delegation-1');
      assert.strictEqual(result.status, 'delegated');
      assert.strictEqual(typeof result.poll, 'function');
    });

    test('throws when selected agent has no configured model id', async () => {
      const dispatcher = new AgentDispatcher(createConfig({ AGENT_WORLD_BUILDER_MODEL_ID: '' }), {});

      await assert.rejects(
        () => dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'do work'),
        /missing MODEL_ID/
      );
    });

    test('surfaces request errors when agent call fails', async () => {
      const requestMock = installHttpRequestMock(() => ({ error: new Error('socket hang up') }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'do work'),
        /socket hang up/
      );

      requestMock.mock.restore();
      assert.match(errorMock.mock.calls.at(-1).arguments[0], /Delegation failed/);
    });

    test('surfaces parse errors when agent returns invalid json', async () => {
      const requestMock = installHttpRequestMock(() => ({ body: '{not-json' }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'do work'),
        /Failed to parse response/
      );

      requestMock.mock.restore();
    });

    test('rejects async delegation when delegation id is missing', async () => {
      const requestMock = installHttpRequestMock(() => ({ body: JSON.stringify({ result: {} }) }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'do work', { taskDelegation: true }),
        /No delegation ID returned/
      );

      requestMock.mock.restore();
    });

    test('rejects sync requests that time out', async () => {
      const requestMock = installHttpRequestMock(() => ({ timeout: true }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate(AGENT_TYPES.WORLD_BUILDER, 'do work', { timeoutMs: 1234 }),
        /Request timeout after 1234ms/
      );

      requestMock.mock.restore();
    });
  });

  describe('delegateParallel(tasks)', () => {
    test('dispatches multiple tasks in parallel and groups successes and failures', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const delegateMock = mock.method(dispatcher, 'delegate', async (agentType) => {
        if (agentType === AGENT_TYPES.WORLD_BUILDER) {
          return { content: 'world ok' };
        }

        throw new Error('character failed');
      });

      const result = await dispatcher.delegateParallel([
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 'task-a' },
        { agentType: AGENT_TYPES.CHARACTER_DESIGNER, prompt: 'task-b' }
      ]);

      delegateMock.mock.restore();

      assert.strictEqual(result.succeeded.length, 1);
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.succeeded[0].agentType, AGENT_TYPES.WORLD_BUILDER);
      assert.strictEqual(result.failed[0].agentType, AGENT_TYPES.CHARACTER_DESIGNER);
      assert.strictEqual(result.failed[0].error, 'character failed');
    });
  });

  describe('pollDelegation()', () => {
    test('returns completed result with parsed markers', async () => {
      const requestMock = installHttpRequestMock(() => ({
        body: JSON.stringify({
          result: {
            status: 'completed',
            response: `finished ${COMPLETION_MARKERS.COMPLETE} ${COMPLETION_MARKERS.HEARTBEAT}`
          }
        })
      }));

      const dispatcher = new AgentDispatcher(createConfig(), {});
      const result = await dispatcher.pollDelegation('delegation-2', 1000);

      requestMock.mock.restore();

      assert.strictEqual(result.status, 'completed');
      assert.strictEqual(result.content, `finished ${COMPLETION_MARKERS.COMPLETE} ${COMPLETION_MARKERS.HEARTBEAT}`);
      assert.deepStrictEqual(result.markers, {
        isComplete: true,
        isFailed: false,
        hasHeartbeat: true
      });
    });

    test('returns failed result when delegated agent fails', async () => {
      const requestMock = installHttpRequestMock(() => ({
        body: JSON.stringify({
          result: {
            status: 'failed',
            error: 'delegate failed hard'
          }
        })
      }));

      const dispatcher = new AgentDispatcher(createConfig(), {});
      const result = await dispatcher.pollDelegation('delegation-3', 1000);

      requestMock.mock.restore();

      assert.strictEqual(result.status, 'failed');
      assert.strictEqual(result.error, 'delegate failed hard');
      assert.deepStrictEqual(result.markers, {
        isComplete: false,
        isFailed: true,
        hasHeartbeat: false
      });
    });
  });

  describe('parseResponse(response)', () => {
    test('parses TaskComplete, TaskFailed, and NextHeartbeat markers', () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const markers = dispatcher._parseMarkers(
        `${COMPLETION_MARKERS.COMPLETE} ${COMPLETION_MARKERS.FAILED} ${COMPLETION_MARKERS.HEARTBEAT}`
      );

      assert.deepStrictEqual(markers, {
        isComplete: true,
        isFailed: true,
        hasHeartbeat: true
      });
    });

    test('extracts content after a marker', () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const content = dispatcher.extractContentAfterMarker(
        `prefix ${COMPLETION_MARKERS.COMPLETE}\nfinal answer`
      );

      assert.strictEqual(content, 'final answer');
    });
  });
});
