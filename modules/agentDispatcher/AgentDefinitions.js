/**
 * Generic agent configuration resolver.
 *
 * Derives configuration keys from agentType using the convention:
 *   worldBuilder  → AGENT_WORLD_BUILDER_*
 *   codeReviewer  → AGENT_CODE_REVIEWER_*
 *
 * No story-specific constants remain in this module.
 */

/**
 * Convert a camelCase agent type to its AGENT_SNAKE_CASE prefix.
 * @param {string} agentType - e.g. 'worldBuilder', 'codeReviewer'
 * @returns {string} - e.g. 'AGENT_WORLD_BUILDER', 'AGENT_CODE_REVIEWER'
 */
function toConfigPrefix(agentType) {
  const snake = agentType
    .replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    .replace(/^_/, '');
  return `AGENT_${snake.toUpperCase()}`;
}

/**
 * Resolve agent configuration from globalConfig using convention-based keys.
 *
 * @param {string} agentType - camelCase agent identifier
 * @param {object} globalConfig - flat key/value configuration object
 * @returns {object} - { modelId, chineseName, systemPrompt, maxOutputTokens, temperature }
 */
function getAgentConfig(agentType, globalConfig = {}) {
  const prefix = toConfigPrefix(agentType);

  return {
    modelId: globalConfig[`${prefix}_MODEL_ID`],
    chineseName: globalConfig[`${prefix}_CHINESE_NAME`],
    systemPrompt: globalConfig[`${prefix}_SYSTEM_PROMPT`],
    maxOutputTokens: parseInt(globalConfig[`${prefix}_MAX_OUTPUT_TOKENS`]) || 4000,
    temperature: parseFloat(globalConfig[`${prefix}_TEMPERATURE`]) || 0.7
  };
}

/**
 * Resolve configurations for multiple agent types at once.
 *
 * @param {string[]} agentTypes - array of camelCase agent identifiers
 * @param {object} globalConfig - flat key/value configuration object
 * @returns {object} - map of agentType → config
 */
function getAllAgentConfigs(agentTypes, globalConfig = {}) {
  const configs = {};
  for (const type of agentTypes) {
    configs[type] = getAgentConfig(type, globalConfig);
  }
  return configs;
}

module.exports = {
  toConfigPrefix,
  getAgentConfig,
  getAllAgentConfigs
};
