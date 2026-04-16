const AGENT_TYPES = {
  WORLD_BUILDER: 'worldBuilder',
  CHARACTER_DESIGNER: 'characterDesigner',
  PLOT_ARCHITECT: 'plotArchitect',
  CHAPTER_WRITER: 'chapterWriter',
  DETAIL_FILLER: 'detailFiller',
  LOGIC_VALIDATOR: 'logicValidator',
  STYLE_POLISHER: 'stylePolisher',
  FINAL_EDITOR: 'finalEditor'
};

const AGENT_CONFIG_MAP = {
  [AGENT_TYPES.WORLD_BUILDER]: {
    configPrefix: 'AGENT_WORLD_BUILDER',
    defaultName: '世界观设定'
  },
  [AGENT_TYPES.CHARACTER_DESIGNER]: {
    configPrefix: 'AGENT_CHARACTER_DESIGNER',
    defaultName: '人物塑造'
  },
  [AGENT_TYPES.PLOT_ARCHITECT]: {
    configPrefix: 'AGENT_PLOT_ARCHITECT',
    defaultName: '情节架构'
  },
  [AGENT_TYPES.CHAPTER_WRITER]: {
    configPrefix: 'AGENT_CHAPTER_WRITER',
    defaultName: '章节执笔'
  },
  [AGENT_TYPES.DETAIL_FILLER]: {
    configPrefix: 'AGENT_DETAIL_FILLER',
    defaultName: '细节填充'
  },
  [AGENT_TYPES.LOGIC_VALIDATOR]: {
    configPrefix: 'AGENT_LOGIC_VALIDATOR',
    defaultName: '逻辑校验'
  },
  [AGENT_TYPES.STYLE_POLISHER]: {
    configPrefix: 'AGENT_STYLE_POLISHER',
    defaultName: '文笔润色'
  },
  [AGENT_TYPES.FINAL_EDITOR]: {
    configPrefix: 'AGENT_FINAL_EDITOR',
    defaultName: '终校定稿'
  }
};

function getAgentConfig(agentType, globalConfig = {}) {
  const mapping = AGENT_CONFIG_MAP[agentType];
  if (!mapping) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }

  const prefix = mapping.configPrefix;
  
  return {
    modelId: globalConfig[`${prefix}_MODEL_ID`],
    chineseName: globalConfig[`${prefix}_CHINESE_NAME`] || mapping.defaultName,
    systemPrompt: globalConfig[`${prefix}_SYSTEM_PROMPT`],
    maxOutputTokens: parseInt(globalConfig[`${prefix}_MAX_OUTPUT_TOKENS`]) || 4000,
    temperature: parseFloat(globalConfig[`${prefix}_TEMPERATURE`]) || 0.7
  };
}

function getAllAgentConfigs(globalConfig = {}) {
  const configs = {};
  for (const type of Object.keys(AGENT_CONFIG_MAP)) {
    configs[type] = getAgentConfig(type, globalConfig);
  }
  return configs;
}

module.exports = {
  AGENT_TYPES,
  AGENT_CONFIG_MAP,
  getAgentConfig,
  getAllAgentConfigs
};
