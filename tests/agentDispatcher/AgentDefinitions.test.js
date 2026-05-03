const { describe, test } = require('node:test');
const assert = require('node:assert');
const { toConfigPrefix, getAgentConfig, getAllAgentConfigs } = require('../../modules/agentDispatcher/AgentDefinitions');

describe('AgentDefinitions (generic)', () => {
  describe('toConfigPrefix()', () => {
    test('converts camelCase to AGENT_SNAKE_CASE', () => {
      assert.strictEqual(toConfigPrefix('worldBuilder'), 'AGENT_WORLD_BUILDER');
      assert.strictEqual(toConfigPrefix('characterDesigner'), 'AGENT_CHARACTER_DESIGNER');
      assert.strictEqual(toConfigPrefix('codeReviewer'), 'AGENT_CODE_REVIEWER');
      assert.strictEqual(toConfigPrefix('myAgent'), 'AGENT_MY_AGENT');
    });

    test('handles single-word agent types', () => {
      assert.strictEqual(toConfigPrefix('reviewer'), 'AGENT_REVIEWER');
    });

    test('handles consecutive capitals gracefully', () => {
      assert.strictEqual(toConfigPrefix('XMLParser'), 'AGENT_X_M_L_PARSER');
    });
  });

  describe('getAgentConfig()', () => {
    test('resolves configuration using convention-based keys', () => {
      const globalConfig = {
        AGENT_WORLD_BUILDER_MODEL_ID: 'gpt-4',
        AGENT_WORLD_BUILDER_CHINESE_NAME: '世界观设定',
        AGENT_WORLD_BUILDER_SYSTEM_PROMPT: 'Build worlds.',
        AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS: '3200',
        AGENT_WORLD_BUILDER_TEMPERATURE: '0.8'
      };

      const config = getAgentConfig('worldBuilder', globalConfig);

      assert.strictEqual(config.modelId, 'gpt-4');
      assert.strictEqual(config.chineseName, '世界观设定');
      assert.strictEqual(config.systemPrompt, 'Build worlds.');
      assert.strictEqual(config.maxOutputTokens, 3200);
      assert.strictEqual(config.temperature, 0.8);
    });

    test('returns undefined for missing optional fields', () => {
      const globalConfig = {
        AGENT_CODE_REVIEWER_MODEL_ID: 'claude-3'
      };

      const config = getAgentConfig('codeReviewer', globalConfig);

      assert.strictEqual(config.modelId, 'claude-3');
      assert.strictEqual(config.chineseName, undefined);
      assert.strictEqual(config.systemPrompt, undefined);
    });

    test('applies numeric defaults for missing tokens and temperature', () => {
      const globalConfig = {
        AGENT_GENERIC_MODEL_ID: 'model-x'
      };

      const config = getAgentConfig('generic', globalConfig);

      assert.strictEqual(config.maxOutputTokens, 4000);
      assert.strictEqual(config.temperature, 0.7);
    });

    test('parses numeric strings correctly', () => {
      const globalConfig = {
        AGENT_TEST_MODEL_ID: 'model-y',
        AGENT_TEST_MAX_OUTPUT_TOKENS: '8192',
        AGENT_TEST_TEMPERATURE: '0.25'
      };

      const config = getAgentConfig('test', globalConfig);

      assert.strictEqual(config.maxOutputTokens, 8192);
      assert.strictEqual(config.temperature, 0.25);
    });

    test('works with empty globalConfig', () => {
      const config = getAgentConfig('anyAgent', {});

      assert.strictEqual(config.modelId, undefined);
      assert.strictEqual(config.maxOutputTokens, 4000);
      assert.strictEqual(config.temperature, 0.7);
    });

    test('does not throw for unknown agent types', () => {
      assert.doesNotThrow(() => getAgentConfig('totallyUnknownAgent', {}));
    });
  });

  describe('getAllAgentConfigs()', () => {
    test('resolves multiple agent configs at once', () => {
      const globalConfig = {
        AGENT_BUILDER_MODEL_ID: 'builder-model',
        AGENT_REVIEWER_MODEL_ID: 'reviewer-model'
      };

      const configs = getAllAgentConfigs(['builder', 'reviewer'], globalConfig);

      assert.strictEqual(configs.builder.modelId, 'builder-model');
      assert.strictEqual(configs.reviewer.modelId, 'reviewer-model');
    });

    test('returns empty object for empty agent types array', () => {
      const configs = getAllAgentConfigs([], { AGENT_X_MODEL_ID: 'y' });
      assert.deepStrictEqual(configs, {});
    });
  });
});
