/**
 * Shared extraction schemas for StoryOrchestrator workflow agent calls.
 */

const standard = {
  parserOrder: ['jsonBlock', 'jsonObject', 'xml', 'fallbackRaw'],
  maxAttempts: 2,
  throwOnFailure: false,
  defaultValue: null
};

const extWorldview = {
  ...standard,
  schema: {
    type: 'object',
    properties: {
      setting: { type: 'string' },
      rules: { type: 'object' },
      factions: { type: 'array' },
      history: { type: 'object' },
      sceneNorms: { type: 'array' },
      secrets: { type: 'array' }
    }
  }
};

const extCharacters = {
  ...standard,
  schema: {
    type: 'object',
    properties: {
      protagonists: { type: 'array' },
      supportingCharacters: { type: 'array' },
      relationshipNetwork: { type: 'object' },
      oocRules: { type: 'object' }
    }
  }
};

const extOutline = {
  ...standard,
  schema: {
    type: 'object',
    properties: {
      chapters: { type: 'array' },
      structure: { type: 'string' },
      keyTurningPoints: { type: 'array' },
      foreshadowing: { type: 'array' }
    }
  }
};

module.exports = { extWorldview, extCharacters, extOutline };
