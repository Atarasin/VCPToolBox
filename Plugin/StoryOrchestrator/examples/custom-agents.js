/**
 * StoryOrchestrator - Custom Agents Configuration Example
 * 
 * ⚠️  DEMONSTRATION FILE - WILL NOT RUN WITHOUT REAL API KEYS ⚠️
 * 
 * Demonstrates configuring custom agents but uses mock model IDs.
 * See quick-start.js header for production setup instructions.
 * 
 * Run: node examples/custom-agents.js
 */

const StoryOrchestrator = require('../core/StoryOrchestrator');

/**
 * Custom agent configurations with different models and settings
 * Each agent can have its own model, temperature, and system prompt
 */
const customAgentConfigs = {
  AGENT_ORCHESTRATOR_MODEL_ID: 'gpt-4-turbo',
  AGENT_ORCHESTRATOR_TEMPERATURE: 0.3,
  AGENT_ORCHESTRATOR_MAX_OUTPUT_TOKENS: 4000,
  AGENT_ORCHESTRATOR_SYSTEM_PROMPT: 'You are a meticulous story coordinator...',

  AGENT_WORLD_BUILDER_MODEL_ID: 'gpt-4-turbo',
  AGENT_WORLD_BUILDER_TEMPERATURE: 0.85,
  AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS: 3500,

  AGENT_CHARACTER_DESIGNER_MODEL_ID: 'gpt-4-turbo',
  AGENT_CHARACTER_DESIGNER_TEMPERATURE: 0.8,
  AGENT_CHARACTER_DESIGNER_MAX_OUTPUT_TOKENS: 3000,

  AGENT_PLOT_ARCHITECT_MODEL_ID: 'gpt-4-turbo',
  AGENT_PLOT_ARCHITECT_TEMPERATURE: 0.75,
  AGENT_PLOT_ARCHITECT_MAX_OUTPUT_TOKENS: 4000,

  AGENT_CHAPTER_WRITER_MODEL_ID: 'gpt-4',
  AGENT_CHAPTER_WRITER_TEMPERATURE: 0.7,
  AGENT_CHAPTER_WRITER_MAX_OUTPUT_TOKENS: 8000,

  AGENT_DETAIL_FILLER_MODEL_ID: 'gpt-4',
  AGENT_DETAIL_FILLER_TEMPERATURE: 0.65,
  AGENT_DETAIL_FILLER_MAX_OUTPUT_TOKENS: 5000,

  AGENT_LOGIC_VALIDATOR_MODEL_ID: 'gpt-4-turbo',
  AGENT_LOGIC_VALIDATOR_TEMPERATURE: 0.2,
  AGENT_LOGIC_VALIDATOR_MAX_OUTPUT_TOKENS: 2500,

  AGENT_STYLE_POLISHER_MODEL_ID: 'claude-3-sonnet',
  AGENT_STYLE_POLISHER_TEMPERATURE: 0.6,
  AGENT_STYLE_POLISHER_MAX_OUTPUT_TOKENS: 6000,

  AGENT_FINAL_EDITOR_MODEL_ID: 'gpt-4-turbo',
  AGENT_FINAL_EDITOR_TEMPERATURE: 0.25,
  AGENT_FINAL_EDITOR_MAX_OUTPUT_TOKENS: 4000,

  ORCHESTRATOR_DEBUG_MODE: true,
  MAX_PHASE_ITERATIONS: 5,
  QUALITY_THRESHOLD: 8.5,
  DEFAULT_TARGET_WORD_COUNT_MIN: 3000,
  DEFAULT_TARGET_WORD_COUNT_MAX: 5000,
};

const customAgentBehaviors = {
  worldBuilderOverrides: {
    style: 'hard_sci-fi',
    includeScience: true,
    includeTechnology: true,
    worldComplexity: 'high'
  },
  characterDesignerOverrides: {
    focus: 'psychological',
    includeBackstory: true,
    includeMotivations: true,
    complexityLevel: 'deep'
  },
  chapterWriterOverrides: {
    pacingControl: true,
    sceneBreakdown: true,
    dialogueRatio: 0.3,
    descriptionRatio: 0.4,
    actionRatio: 0.3
  },
  stylePolisherOverrides: {
    proseStyle: 'concise',
    sentenceVariation: 'moderate',
    vocabularyLevel: 'literate',
    avoidFillerWords: true
  }
};

/**
 * Temperature presets for different creative needs
 */
const temperaturePresets = {
  highlyCreative: { temperature: 0.9, description: 'Maximum creativity, unexpected ideas' },
  balanced: { temperature: 0.7, description: 'Balanced creativity and coherence' },
  focused: { temperature: 0.5, description: 'More focused, less random' },
  precise: { temperature: 0.3, description: 'Precise, consistent output' },
  exact: { temperature: 0.1, description: 'Near-deterministic output' }
};

// mockDependencies shown for documentation - NOT used by initialize()
const mockDependencies = {
  agentDispatcher: { async dispatch() {} },
  stateStorage: new Map(),
  webSocketPusher: { push() {} }
};

async function initializeWithCustomAgents() {
  console.log('='.repeat(60));
  console.log('CUSTOM AGENTS CONFIGURATION EXAMPLE');
  console.log('='.repeat(60));
  
  console.log();
  console.log('-'.repeat(60));
  console.log('CUSTOM AGENT CONFIGURATIONS');
  console.log('-'.repeat(60));
  
  console.log();
  console.log('Temperature Presets:');
  Object.entries(temperaturePresets).forEach(([name, config]) => {
    console.log(`  ${name}: ${config.temperature} - ${config.description}`);
  });
  
  console.log();
  console.log('Agent Temperature Mapping:');
  console.log('  Creative (WorldBuilder, CharacterDesigner, PlotArchitect): 0.75-0.85');
  console.log('  Writing (ChapterWriter, DetailFiller): 0.65-0.70');
  console.log('  Quality (LogicValidator, FinalEditor): 0.2-0.25');
  console.log('  Polish (StylePolisher): 0.6');
  
  const mergedConfig = { ...customAgentConfigs };
  
  await StoryOrchestrator.initialize(mergedConfig);
}

async function demonstrateCustomAgentDispatch() {
  console.log();
  console.log('-'.repeat(60));
  console.log('DEMONSTRATING CUSTOM AGENT DISPATCH');
  console.log('-'.repeat(60));
  
  const storyId = await startStory();
  
  console.log();
  console.log('Custom agent settings would be used in production via AgentDispatcher:');
  
  const agentConfigs = [
    { agent: 'WorldBuilder', temp: 0.85, model: 'gpt-4-turbo' },
    { agent: 'CharacterDesigner', temp: 0.8, model: 'gpt-4-turbo' },
    { agent: 'LogicValidator', temp: 0.2, model: 'gpt-4-turbo' },
    { agent: 'StylePolisher', temp: 0.6, model: 'claude-3-sonnet' }
  ];
  
  for (const config of agentConfigs) {
    console.log(`  ${config.agent}: model=${config.model}, temp=${config.temp}`);
  }
  
  return storyId;
}

async function startStory() {
  const result = await StoryOrchestrator.processToolCall({
    command: 'StartStoryProject',
    story_prompt: 'A literary fiction piece about memory and identity, exploring how our memories define who we are.',
    genre: 'literary-fiction',
    target_word_count: 4000,
    style_preference: ' lyrical prose, introspective narrative'
  });
  
  if (result.status === 'success') {
    console.log('Story started:', result.result.story_id.substring(0, 8) + '...');
    return result.result.story_id;
  }
  throw new Error('Failed to start story');
}

async function demonstrateBehaviorOverrides() {
  console.log();
  console.log('-'.repeat(60));
  console.log('BEHAVIOR OVERRIDES');
  console.log('-'.repeat(60));
  
  console.log();
  console.log('WorldBuilder Overrides:');
  console.log(JSON.stringify(customAgentBehaviors.worldBuilderOverrides, null, 2));
  
  console.log();
  console.log('ChapterWriter Overrides:');
  console.log(JSON.stringify(customAgentBehaviors.chapterWriterOverrides, null, 2));
  
  console.log();
  console.log('StylePolisher Overrides:');
  console.log(JSON.stringify(customAgentBehaviors.stylePolisherOverrides, null, 2));
}

async function demonstrateModelRouting() {
  console.log();
  console.log('-'.repeat(60));
  console.log('MODEL ROUTING STRATEGY');
  console.log('-'.repeat(60));
  console.log();
  console.log('GPT-4 Turbo: Used for high-level reasoning (Orchestrator, PlotArchitect)');
  console.log('GPT-4: Used for long-form content (ChapterWriter, DetailFiller)');
  console.log('Claude-3-Sonnet: Used for style/polish tasks');
  console.log();
  console.log('Model Selection Criteria:');
  console.log('  - Context window size needed');
  console.log('  - Creative vs analytical task');
  console.log('  - Output length requirements');
  console.log('  - Cost efficiency for task type');
}

async function demonstrateRetryBehavior() {
  console.log();
  console.log('-'.repeat(60));
  console.log('RETRY BEHAVIOR WITH CUSTOM AGENTS');
  console.log('-'.repeat(60));
  console.log();
  console.log('Retry Strategy:');
  console.log('  - LogicValidator failures: Low temp retry (0.1)');
  console.log('  - Style failures: Medium temp retry (0.5)');
  console.log('  - Creative failures: High temp retry (0.9)');
  console.log();
  console.log('Backoff Delays:');
  console.log('  - Attempt 1: Immediate');
  console.log('  - Attempt 2: 250ms delay');
  console.log('  - Attempt 3: 1000ms delay');
}

async function main() {
  try {
    await initializeWithCustomAgents();
    
    const storyId = await demonstrateCustomAgentDispatch();
    await demonstrateBehaviorOverrides();
    await demonstrateModelRouting();
    await demonstrateRetryBehavior();
    
    console.log();
    console.log('='.repeat(60));
    console.log('CUSTOM AGENTS EXAMPLE COMPLETE');
    console.log('='.repeat(60));
    console.log();
    console.log('Key Takeaways:');
    console.log('1. Different agents benefit from different temperatures');
    console.log('2. Model selection should match task requirements');
    console.log('3. Behavior overrides allow per-agent specialization');
    console.log('4. Retry strategies should account for agent purpose');
    
  } catch (error) {
    console.error('[Fatal Error]', error);
  }
}

if (require.main === module) {
  main();
}

module.exports = { 
  main, 
  customAgentConfigs, 
  temperaturePresets,
  customAgentBehaviors 
};
