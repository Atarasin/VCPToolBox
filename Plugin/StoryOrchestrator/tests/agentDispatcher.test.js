const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const axiosPath = require.resolve('axios');

function clearCache() {
  delete require.cache[require.resolve('../agents/AgentDispatcher')];
  delete require.cache[require.resolve('../agents/AgentDefinitions')];
  delete require.cache[axiosPath];
}

function loadFresh(mockImpl) {
  clearCache();
  require.cache[axiosPath] = {
    id: axiosPath,
    filename: axiosPath,
    loaded: true,
    exports: { post: mockImpl }
  };
  const defs = require('../agents/AgentDefinitions');
  const mod = require('../agents/AgentDispatcher');
  return {
    AgentDispatcher: mod.AgentDispatcher,
    COMPLETION_MARKERS: mod.COMPLETION_MARKERS,
    AGENT_TYPES: defs.AGENT_TYPES,
    getAgentConfig: defs.getAgentConfig
  };
}

const defaultConfig = {
  AGENT_ASSISTANT_URL: 'http://localhost:5890',
  VCP_Key: 'test-api-key',
  AGENT_ORCHESTRATOR_MODEL_ID: 'gpt-4',
  AGENT_ORCHESTRATOR_CHINESE_NAME: '总控调度',
  AGENT_ORCHESTRATOR_SYSTEM_PROMPT: '你是总控调度Agent',
  AGENT_ORCHESTRATOR_MAX_OUTPUT_TOKENS: '4000',
  AGENT_ORCHESTRATOR_TEMPERATURE: '0.7',
  AGENT_WORLD_BUILDER_MODEL_ID: 'gpt-4',
  AGENT_WORLD_BUILDER_CHINESE_NAME: '世界观设定',
  AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS: '3000',
  AGENT_WORLD_BUILDER_TEMPERATURE: '0.8',
  AGENT_CHARACTER_DESIGNER_MODEL_ID: 'gpt-4',
  AGENT_CHARACTER_DESIGNER_CHINESE_NAME: '人物塑造',
  AGENT_CHARACTER_DESIGNER_MAX_OUTPUT_TOKENS: '3000',
  AGENT_CHARACTER_DESIGNER_TEMPERATURE: '0.7',
  AGENT_LOGIC_VALIDATOR_MODEL_ID: 'gpt-4',
  AGENT_LOGIC_VALIDATOR_CHINESE_NAME: '逻辑校验',
  AGENT_LOGIC_VALIDATOR_MAX_OUTPUT_TOKENS: '4000',
  AGENT_LOGIC_VALIDATOR_TEMPERATURE: '0.5'
};

describe('AgentDispatcher', () => {
  describe('initialize', () => {
    test('should log initialization message', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const logs = [];
      const orig = console.log;
      console.log = (m) => logs.push(m);
      new AgentDispatcher(defaultConfig, {}).initialize();
      console.log = orig;
      assert.strictEqual(logs[0], '[AgentDispatcher] Initialized');
    });
  });

  describe('_parseMarkers', () => {
    test('should detect TaskComplete marker', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('内容[[TaskComplete]]更多内容');
      assert.strictEqual(m.isComplete, true);
      assert.strictEqual(m.isFailed, false);
      assert.strictEqual(m.hasHeartbeat, false);
    });

    test('should detect TaskFailed marker', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('内容[[TaskFailed]]更多内容');
      assert.strictEqual(m.isComplete, false);
      assert.strictEqual(m.isFailed, true);
    });

    test('should detect NextHeartbeat marker', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('内容[[NextHeartbeat]]更多内容');
      assert.strictEqual(m.hasHeartbeat, true);
    });

    test('should detect multiple markers', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('内容[[TaskComplete]]其他[[NextHeartbeat]]');
      assert.strictEqual(m.isComplete, true);
      assert.strictEqual(m.hasHeartbeat, true);
    });

    test('should handle no markers', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('普通内容');
      assert.deepStrictEqual(m, { isComplete: false, isFailed: false, hasHeartbeat: false });
    });

    test('should handle empty string', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const m = d._parseMarkers('');
      assert.deepStrictEqual(m, { isComplete: false, isFailed: false, hasHeartbeat: false });
    });
  });

  describe('extractContentAfterMarker', () => {
    test('should extract content after marker', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = d.extractContentAfterMarker('结果如下[[TaskComplete]]这里是实际内容');
      assert.strictEqual(r, '这里是实际内容');
    });

    test('should return full content when marker missing', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = d.extractContentAfterMarker('没有任何标记的内容');
      assert.strictEqual(r, '没有任何标记的内容');
    });

    test('should return empty when marker at end', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = d.extractContentAfterMarker('内容[[TaskComplete]]');
      assert.strictEqual(r, '');
    });

    test('should trim whitespace', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = d.extractContentAfterMarker('结果[[TaskComplete]]   内容   ');
      assert.strictEqual(r, '内容');
    });

    test('should accept custom marker', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = d.extractContentAfterMarker('内容[[CustomMarker]]后续', '[[CustomMarker]]');
      assert.strictEqual(r, '后续');
    });
  });

  describe('COMPLETION_MARKERS', () => {
    test('should have correct values', () => {
      const { COMPLETION_MARKERS } = loadFresh(async () => ({}));
      assert.strictEqual(COMPLETION_MARKERS.COMPLETE, '[[TaskComplete]]');
      assert.strictEqual(COMPLETION_MARKERS.FAILED, '[[TaskFailed]]');
      assert.strictEqual(COMPLETION_MARKERS.HEARTBEAT, '[[NextHeartbeat]]');
    });
  });

  describe('delegate - config validation', () => {
    test('should throw when modelId missing', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({}));
      const cfg = { ...defaultConfig, AGENT_ORCHESTRATOR_MODEL_ID: '' };
      const d = new AgentDispatcher(cfg, {});
      await assert.rejects(
        () => d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test'),
        /missing MODEL_ID/
      );
    });

    test('should throw for unknown agent type', async () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      await assert.rejects(
        () => d.delegate('unknown', 'test'),
        /Unknown agent type/
      );
    });
  });

  describe('delegate - sync', () => {
    test('should delegate successfully', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: '响应内容' } }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.content, '响应内容');
      assert.deepStrictEqual(r.markers, { isComplete: false, isFailed: false, hasHeartbeat: false });
    });

    test('should parse TaskComplete marker', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: '完成[[TaskComplete]]' } }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.markers.isComplete, true);
    });

    test('should parse TaskFailed marker', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: '失败[[TaskFailed]]' } }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.markers.isFailed, true);
    });

    test('should handle empty content', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: '' } }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.content, '');
    });

    test('should handle missing choices', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.content, '');
    });

    test('should handle null message', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: null }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(r.content, '');
    });

    test('should include Bearer auth header', async () => {
      let headers;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async (url, payload, cfg) => {
        headers = cfg.headers;
        return { data: { choices: [{ message: { content: 'x' } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.ok(headers.Authorization.includes('Bearer'));
      assert.strictEqual(headers['Content-Type'], 'application/json');
    });

    test('should use default timeout 120000ms', async () => {
      let timeout;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async (url, payload, cfg) => {
        timeout = cfg.timeout;
        return { data: { choices: [{ message: { content: 'x' } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test');
      assert.strictEqual(timeout, 120000);
    });

    test('should use custom timeout', async () => {
      let timeout;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async (url, payload, cfg) => {
        timeout = cfg.timeout;
        return { data: { choices: [{ message: { content: 'x' } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test', { timeoutMs: 60000 });
      assert.strictEqual(timeout, 60000);
    });

    test('should handle network error', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        throw new Error('Network error');
      });
      const d = new AgentDispatcher(defaultConfig, {});
      await assert.rejects(
        () => d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test'),
        /Network error/
      );
    });
  });

  describe('delegate - async', () => {
    test('should return delegation id', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { result: { delegation_id: 'del-123' } }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test', { taskDelegation: true });
      assert.strictEqual(r.delegationId, 'del-123');
      assert.strictEqual(r.status, 'delegated');
      assert.ok(typeof r.poll === 'function');
    });

    test('should throw when delegation_id missing', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { result: {} }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      await assert.rejects(
        () => d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test', { taskDelegation: true }),
        /No delegation ID/
      );
    });

    test('should pass temporary_contact option', async () => {
      let payload;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async (url, p) => {
        payload = p;
        return { data: { result: { delegation_id: 'id' } } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      await d.delegate(AGENT_TYPES.ORCHESTRATOR, 'test', { taskDelegation: true, temporaryContact: false });
      assert.strictEqual(payload.temporary_contact, false);
    });
  });

  describe('delegateParallel', () => {
    test('should execute multiple agents in parallel', async () => {
      let count = 0;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        count++;
        return { data: { choices: [{ message: { content: `r${count}` } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateParallel([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ]);
      assert.strictEqual(r.succeeded.length, 2);
      assert.strictEqual(r.failed.length, 0);
    });

    test('should handle partial failures', async () => {
      let count = 0;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        count++;
        if (count === 1) return { data: { choices: [{ message: { content: 'ok' } }] } };
        throw new Error('fail');
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateParallel([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ]);
      assert.strictEqual(r.succeeded.length, 1);
      assert.strictEqual(r.failed.length, 1);
    });

    test('should handle all failures', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        throw new Error('all fail');
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateParallel([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ]);
      assert.strictEqual(r.succeeded.length, 0);
      assert.strictEqual(r.failed.length, 2);
    });

    test('should preserve agent type in results', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: 'x' } }] }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateParallel([
        { agentType: AGENT_TYPES.CHARACTER_DESIGNER, prompt: 't1' },
        { agentType: AGENT_TYPES.LOGIC_VALIDATOR, prompt: 't2' }
      ]);
      assert.strictEqual(r.succeeded[0].agentType, AGENT_TYPES.CHARACTER_DESIGNER);
      assert.strictEqual(r.succeeded[1].agentType, AGENT_TYPES.LOGIC_VALIDATOR);
    });
  });

  describe('delegateSerial', () => {
    test('should execute sequentially', async () => {
      let count = 0;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        count++;
        return { data: { choices: [{ message: { content: `r${count}` } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateSerial([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ]);
      assert.strictEqual(r.length, 2);
      assert.strictEqual(r[0].status, 'success');
      assert.strictEqual(r[1].status, 'success');
      assert.strictEqual(count, 2);
    });

    test('should call onProgress callback', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => ({
        data: { choices: [{ message: { content: 'x' } }] }
      }));
      const calls = [];
      const d = new AgentDispatcher(defaultConfig, {});
      await d.delegateSerial([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ], (i, t, at) => calls.push({ i, t, at }));
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(calls[0].at, AGENT_TYPES.ORCHESTRATOR);
      assert.strictEqual(calls[1].at, AGENT_TYPES.WORLD_BUILDER);
    });

    test('should stop on error by default', async () => {
      let count = 0;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        count++;
        if (count === 1) throw new Error('fail');
        return { data: { choices: [{ message: { content: 'x' } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateSerial([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1' },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2' }
      ]);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0].status, 'error');
      assert.strictEqual(count, 1);
    });

    test('should continue on error when stopOnError=false', async () => {
      let count = 0;
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        count++;
        if (count === 1) throw new Error('fail');
        return { data: { choices: [{ message: { content: `r${count}` } }] } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateSerial([
        { agentType: AGENT_TYPES.ORCHESTRATOR, prompt: 't1', stopOnError: false },
        { agentType: AGENT_TYPES.WORLD_BUILDER, prompt: 't2', stopOnError: false }
      ]);
      assert.strictEqual(r.length, 2);
      assert.strictEqual(r[0].status, 'error');
      assert.strictEqual(r[1].status, 'success');
      assert.strictEqual(count, 2);
    });

    test('should include agent type in error', async () => {
      const { AgentDispatcher, AGENT_TYPES } = loadFresh(async () => {
        throw new Error('err');
      });
      const d = new AgentDispatcher(defaultConfig, {});
      const r = await d.delegateSerial([
        { agentType: AGENT_TYPES.LOGIC_VALIDATOR, prompt: 't1' }
      ]);
      assert.strictEqual(r[0].agentType, AGENT_TYPES.LOGIC_VALIDATOR);
      assert.strictEqual(r[0].error, 'err');
    });
  });

  describe('pollDelegation', () => {
    test('should poll until completion', async () => {
      let count = 0;
      const { AgentDispatcher } = loadFresh(async () => {
        count++;
        if (count < 3) return { data: { result: { status: 'running' } } };
        return { data: { result: { status: 'completed', response: 'done[[TaskComplete]]' } } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      d._sleep = async () => {};
      const r = await d.pollDelegation('del-123', 500);
      assert.strictEqual(r.status, 'completed');
      assert.strictEqual(r.content, 'done[[TaskComplete]]');
      assert.strictEqual(r.markers.isComplete, true);
      assert.strictEqual(count, 3);
    });

    test('should return immediately on failed status without retry', async () => {
      let count = 0;
      const { AgentDispatcher } = loadFresh(async () => {
        count++;
        return { data: { result: { status: 'failed', error: 'agent failed' } } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      d._sleep = async () => {};
      const r = await d.pollDelegation('del-123', 10000);
      assert.strictEqual(r.status, 'failed');
      assert.strictEqual(r.error, 'agent failed');
      assert.strictEqual(count, 1);
    });

    test('should throw on 404', async () => {
      const err = new Error('Not found');
      err.response = { status: 404 };
      const { AgentDispatcher } = loadFresh(async () => { throw err; });
      const d = new AgentDispatcher(defaultConfig, {});
      d._sleep = async () => {};
      await assert.rejects(
        () => d.pollDelegation('del-123', 10000),
        /Delegation not found/
      );
    });

    test('should throw timeout', async () => {
      const { AgentDispatcher } = loadFresh(async () => ({
        data: { result: { status: 'running' } }
      }));
      const d = new AgentDispatcher(defaultConfig, {});
      d._sleep = async () => {};
      await assert.rejects(
        () => d.pollDelegation('del-123', 100),
        /Delegation timeout/
      );
    });

    test('should continue on non-404 errors', async () => {
      let count = 0;
      const { AgentDispatcher } = loadFresh(async () => {
        count++;
        if (count === 1) throw new Error('transient');
        return { data: { result: { status: 'completed', response: 'ok' } } };
      });
      const d = new AgentDispatcher(defaultConfig, {});
      d._sleep = async () => {};
      const r = await d.pollDelegation('del-123', 10000);
      assert.strictEqual(r.status, 'completed');
      assert.strictEqual(count, 2);
    });
  });

  describe('_sleep', () => {
    test('should delay', async () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher(defaultConfig, {});
      const start = Date.now();
      await d._sleep(30);
      assert.ok(Date.now() - start >= 25);
    });
  });

  describe('agent config', () => {
    test('should use default chinese name', () => {
      const { getAgentConfig, AGENT_TYPES } = loadFresh(async () => ({}));
      const cfg = getAgentConfig(AGENT_TYPES.ORCHESTRATOR, { AGENT_ORCHESTRATOR_MODEL_ID: 'gpt-4' });
      assert.strictEqual(cfg.chineseName, '总控调度');
    });

    test('should parse temperature as float', () => {
      const { getAgentConfig, AGENT_TYPES } = loadFresh(async () => ({}));
      const cfg = getAgentConfig(AGENT_TYPES.WORLD_BUILDER, defaultConfig);
      assert.strictEqual(typeof cfg.temperature, 'number');
      assert.strictEqual(cfg.temperature, 0.8);
    });

    test('should use default maxOutputTokens', () => {
      const { getAgentConfig, AGENT_TYPES } = loadFresh(async () => ({}));
      const cfg = getAgentConfig(AGENT_TYPES.ORCHESTRATOR, { AGENT_ORCHESTRATOR_MODEL_ID: 'gpt-4' });
      assert.strictEqual(cfg.maxOutputTokens, 4000);
    });

    test('should throw for unknown agent type', () => {
      const { getAgentConfig } = loadFresh(async () => ({}));
      assert.throws(
        () => getAgentConfig('unknown', defaultConfig),
        /Unknown agent type/
      );
    });
  });

  describe('URL configuration', () => {
    test('should use configured URL', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const d = new AgentDispatcher({ ...defaultConfig, AGENT_ASSISTANT_URL: 'http://custom:9090' }, {});
      assert.strictEqual(d.agentAssistantUrl, 'http://custom:9090');
    });

    test('should use default URL when not set', () => {
      const { AgentDispatcher } = loadFresh(async () => ({}));
      const cfg = { VCP_Key: 'k', AGENT_ORCHESTRATOR_MODEL_ID: 'm' };
      const d = new AgentDispatcher(cfg, {});
      assert.strictEqual(d.agentAssistantUrl, 'http://localhost:5890');
    });
  });
});
