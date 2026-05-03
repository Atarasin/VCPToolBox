const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const http = require('http');

const { AgentDispatcher, COMPLETION_MARKERS } = require('../../modules/agentDispatcher');

function createConfig(overrides = {}) {
  return {
    PORT: 6789,
    VCP_Key: 'config-key',
    AGENT_ASSISTANT_URL: 'http://127.0.0.1:6789',
    AGENT_GENERIC_WORKER_MODEL_ID: 'model-generic',
    AGENT_GENERIC_WORKER_SYSTEM_PROMPT: 'You are a generic worker.',
    AGENT_GENERIC_WORKER_MAX_OUTPUT_TOKENS: '3200',
    AGENT_GENERIC_WORKER_TEMPERATURE: '0.8',
    AGENT_SECONDARY_MODEL_ID: 'model-secondary',
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

describe('AgentDispatcher (standalone)', () => {
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
    test('initializes with legacy signature (globalConfig, stateManager)', () => {
      const dispatcher = new AgentDispatcher(createConfig(), { state: true });

      assert.strictEqual(dispatcher.config.AGENT_GENERIC_WORKER_MODEL_ID, 'model-generic');
      assert.strictEqual(dispatcher.stateManager.state, true);
      assert.strictEqual(dispatcher.agentAssistantUrl, 'http://127.0.0.1:6789');
      assert.strictEqual(dispatcher.vcpKey, 'config-key');
      assert.strictEqual(dispatcher.agentResolver, null);
    });

    test('initializes with decoupled signature { agentAssistantUrl, vcpKey, agentResolver }', () => {
      const customResolver = (type) => ({ modelId: `custom-${type}` });
      const dispatcher = new AgentDispatcher({
        agentAssistantUrl: 'http://custom:9999',
        vcpKey: 'custom-key',
        agentResolver: customResolver
      });

      assert.strictEqual(dispatcher.agentAssistantUrl, 'http://custom:9999');
      assert.strictEqual(dispatcher.vcpKey, 'custom-key');
      assert.strictEqual(dispatcher.agentResolver, customResolver);
      assert.strictEqual(dispatcher.stateManager, null);
    });

    test('falls back to PORT and env keys when explicit values are absent', () => {
      process.env.PORT = '7123';
      process.env.VCP_Key = 'env-key';

      const dispatcher = new AgentDispatcher(
        createConfig({ PORT: undefined, AGENT_ASSISTANT_URL: undefined, VCP_Key: undefined }),
        {}
      );

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
    test('dispatches a sync task with generic agent type and correct payload', async () => {
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
      const result = await dispatcher.delegate('genericWorker', 'do some work');

      requestMock.mock.restore();

      assert.strictEqual(captured.options.hostname, '127.0.0.1');
      assert.strictEqual(captured.options.port, '6789');
      assert.strictEqual(captured.options.path, '/v1/chat/completions');
      assert.strictEqual(captured.options.method, 'POST');
      assert.strictEqual(captured.options.headers.Authorization, 'Bearer config-key');
      assert.strictEqual(captured.timeoutMs, 600000);
      assert.strictEqual(captured.payload.model, 'model-generic');
      assert.strictEqual(captured.payload.messages[0].content, 'You are a generic worker.');
      assert.strictEqual(captured.payload.messages[1].content, 'do some work');
      assert.strictEqual(captured.payload.temperature, 0.8);
      assert.strictEqual(captured.payload.max_tokens, 3200);
      assert.strictEqual(result.content, `done ${COMPLETION_MARKERS.COMPLETE}`);
      assert.deepStrictEqual(result.markers, {
        isComplete: true,
        isFailed: false,
        hasHeartbeat: false
      });
    });

    test('uses agentResolver when provided in decoupled mode', async () => {
      let captured;
      const requestMock = installHttpRequestMock(({ body }) => {
        captured = JSON.parse(body);
        return {
          body: JSON.stringify({
            choices: [{ message: { content: 'resolved' } }]
          })
        };
      });

      const dispatcher = new AgentDispatcher({
        agentAssistantUrl: 'http://127.0.0.1:6789',
        vcpKey: 'config-key',
        agentResolver: (type) => ({
          modelId: `resolver-${type}`,
          systemPrompt: 'Custom prompt.',
          maxOutputTokens: 2000,
          temperature: 0.5
        })
      });

      await dispatcher.delegate('myCustomAgent', 'task');
      requestMock.mock.restore();

      assert.strictEqual(captured.model, 'resolver-myCustomAgent');
      assert.strictEqual(captured.messages[0].content, 'Custom prompt.');
      assert.strictEqual(captured.max_tokens, 2000);
      assert.strictEqual(captured.temperature, 0.5);
    });

    test('falls back to generic English prompt when chineseName and systemPrompt are absent', async () => {
      let captured;
      const requestMock = installHttpRequestMock(({ body }) => {
        captured = JSON.parse(body);
        return {
          body: JSON.stringify({
            choices: [{ message: { content: 'ok' } }]
          })
        };
      });

      const dispatcher = new AgentDispatcher(
        createConfig({
          AGENT_GENERIC_WORKER_SYSTEM_PROMPT: undefined,
          AGENT_GENERIC_WORKER_CHINESE_NAME: undefined
        }),
        {}
      );

      await dispatcher.delegate('genericWorker', 'do work');
      requestMock.mock.restore();

      assert.strictEqual(captured.messages[0].content, 'You are the genericWorker agent.');
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
      const result = await dispatcher.delegate('secondary', 'async task', {
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
      assert.strictEqual(captured.payload.payload.model, 'model-secondary');
      assert.strictEqual(result.delegationId, 'delegation-1');
      assert.strictEqual(result.status, 'delegated');
      assert.strictEqual(typeof result.poll, 'function');
    });

    test('throws when agent has no configured model id', async () => {
      const dispatcher = new AgentDispatcher(createConfig({ AGENT_GENERIC_WORKER_MODEL_ID: '' }), {});

      await assert.rejects(
        () => dispatcher.delegate('genericWorker', 'do work'),
        /missing MODEL_ID/
      );
    });

    test('surfaces request errors when agent call fails', async () => {
      const requestMock = installHttpRequestMock(() => ({ error: new Error('socket hang up') }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate('genericWorker', 'do work'),
        /socket hang up/
      );

      requestMock.mock.restore();
      assert.match(errorMock.mock.calls.at(-1).arguments[0], /Delegation failed/);
    });

    test('surfaces parse errors when agent returns invalid json', async () => {
      const requestMock = installHttpRequestMock(() => ({ body: '{not-json' }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate('genericWorker', 'do work'),
        /Failed to parse response/
      );

      requestMock.mock.restore();
    });

    test('rejects async delegation when delegation id is missing', async () => {
      const requestMock = installHttpRequestMock(() => ({ body: JSON.stringify({ result: {} }) }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate('genericWorker', 'do work', { taskDelegation: true }),
        /No delegation ID returned/
      );

      requestMock.mock.restore();
    });

    test('rejects sync requests that time out', async () => {
      const requestMock = installHttpRequestMock(() => ({ timeout: true }));
      const dispatcher = new AgentDispatcher(createConfig(), {});

      await assert.rejects(
        () => dispatcher.delegate('genericWorker', 'do work', { timeoutMs: 1234 }),
        /Request timeout after 1234ms/
      );

      requestMock.mock.restore();
    });
  });

  describe('delegateParallel(tasks)', () => {
    test('dispatches multiple tasks in parallel and groups successes and failures', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const delegateMock = mock.method(dispatcher, 'delegate', async (agentType) => {
        if (agentType === 'genericWorker') {
          return { content: 'world ok' };
        }

        throw new Error('secondary failed');
      });

      const result = await dispatcher.delegateParallel([
        { agentType: 'genericWorker', prompt: 'task-a' },
        { agentType: 'secondary', prompt: 'task-b' }
      ]);

      delegateMock.mock.restore();

      assert.strictEqual(result.succeeded.length, 1);
      assert.strictEqual(result.failed.length, 1);
      assert.strictEqual(result.succeeded[0].agentType, 'genericWorker');
      assert.strictEqual(result.failed[0].agentType, 'secondary');
      assert.strictEqual(result.failed[0].error, 'secondary failed');
    });
  });

  describe('delegateSerial(tasks, onProgress)', () => {
    test('dispatches tasks serially and reports progress', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const delegateMock = mock.method(dispatcher, 'delegate', async (agentType) => {
        return { content: `result-${agentType}` };
      });

      const progressCalls = [];
      const result = await dispatcher.delegateSerial([
        { agentType: 'genericWorker', prompt: 'task-a' },
        { agentType: 'secondary', prompt: 'task-b' }
      ], (current, total, agentType) => {
        progressCalls.push({ current, total, agentType });
      });

      delegateMock.mock.restore();

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].status, 'success');
      assert.strictEqual(result[1].status, 'success');
      assert.deepStrictEqual(progressCalls, [
        { current: 1, total: 2, agentType: 'genericWorker' },
        { current: 2, total: 2, agentType: 'secondary' }
      ]);
    });

    test('stops on first error when stopOnError is true', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const delegateMock = mock.method(dispatcher, 'delegate', async (agentType) => {
        if (agentType === 'genericWorker') throw new Error('first failed');
        return { content: 'ok' };
      });

      const result = await dispatcher.delegateSerial([
        { agentType: 'genericWorker', prompt: 'task-a' },
        { agentType: 'secondary', prompt: 'task-b' }
      ]);

      delegateMock.mock.restore();

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].status, 'error');
      assert.strictEqual(result[0].error, 'first failed');
    });

    test('continues after error when stopOnError is false', async () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const delegateMock = mock.method(dispatcher, 'delegate', async (agentType) => {
        if (agentType === 'genericWorker') throw new Error('first failed');
        return { content: 'ok' };
      });

      const result = await dispatcher.delegateSerial([
        { agentType: 'genericWorker', prompt: 'task-a', stopOnError: false },
        { agentType: 'secondary', prompt: 'task-b', stopOnError: false }
      ]);

      delegateMock.mock.restore();

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0].status, 'error');
      assert.strictEqual(result[1].status, 'success');
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

    test('throws when polling exceeds timeout', async () => {
      const requestMock = installHttpRequestMock(() => ({
        body: JSON.stringify({
          result: { status: 'pending' }
        })
      }));

      const dispatcher = new AgentDispatcher(createConfig(), {});
      await assert.rejects(
        () => dispatcher.pollDelegation('delegation-4', 100),
        /Delegation timeout/
      );

      requestMock.mock.restore();
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

    test('returns original content when marker is absent', () => {
      const dispatcher = new AgentDispatcher(createConfig(), {});
      const content = dispatcher.extractContentAfterMarker('no marker here');

      assert.strictEqual(content, 'no marker here');
    });
  });
});
