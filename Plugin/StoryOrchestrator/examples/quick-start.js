/**
 * StoryOrchestrator - Quick Start Example
 * 
 * Minimal example demonstrating how to:
 * 1. Start a story project
 * 2. Query status
 * 3. Handle checkpoint approval
 * 4. Export completed story
 * 
 * Run: node examples/quick-start.js
 */

const StoryOrchestrator = require('../core/StoryOrchestrator');

/**
 * Mock VCP Config for development/testing
 * In production, these come from config.env
 */
const mockConfig = {
  ORCHESTRATOR_DEBUG_MODE: true,
  MAX_PHASE_ITERATIONS: 5,
  DEFAULT_TARGET_WORD_COUNT_MIN: 2500,
  DEFAULT_TARGET_WORD_COUNT_MAX: 3500,
  USER_CHECKPOINT_TIMEOUT_MS: 86400000,
  STORY_STATE_RETENTION_DAYS: 30,
  // Mock agent configurations
  AGENT_ORCHESTRATOR_MODEL_ID: 'mock-model',
  AGENT_WORLD_BUILDER_MODEL_ID: 'mock-model',
  AGENT_CHARACTER_DESIGNER_MODEL_ID: 'mock-model',
  AGENT_PLOT_ARCHITECT_MODEL_ID: 'mock-model',
  AGENT_CHAPTER_WRITER_MODEL_ID: 'mock-model',
  AGENT_DETAIL_FILLER_MODEL_ID: 'mock-model',
  AGENT_LOGIC_VALIDATOR_MODEL_ID: 'mock-model',
  AGENT_STYLE_POLISHER_MODEL_ID: 'mock-model',
  AGENT_FINAL_EDITOR_MODEL_ID: 'mock-model',
};

/**
 * Mock dependencies that would normally come from VCP core
 */
const mockDependencies = {
  // Mock agent dispatcher that simulates agent responses
  agentDispatcher: {
    async dispatch(agentName, prompt, options) {
      console.log(`[MockAgent] Dispatching: ${agentName}`);
      // Simulate agent processing time
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Return mock responses based on agent type
      if (agentName.includes('WorldBuilder')) {
        return {
          content: JSON.stringify({
            setting: 'A futuristic city where AI and humans coexist',
            rules: ['AI cannot harm humans', 'All AI have a designated human overseer'],
            factions: ['The Syndicate', 'The Resistance', 'The Council']
          }),
          metrics: { tokens: 500 }
        };
      }
      if (agentName.includes('Character')) {
        return {
          content: JSON.stringify({
            protagonist: {
              name: 'Elena',
              age: 28,
              role: 'AI liaison officer',
              motivation: 'Find her missing brother'
            }
          }),
          metrics: { tokens: 300 }
        };
      }
      if (agentName.includes('Plot')) {
        return {
          content: JSON.stringify({
            chapters: [
              { number: 1, title: 'The Discovery', summary: 'Elena discovers a conspiracy' },
              { number: 2, title: 'The Chase', summary: 'Elena races against time' },
              { number: 3, title: 'The Truth', summary: 'The revelation changes everything' }
            ]
          }),
          metrics: { tokens: 400 }
        };
      }
      if (agentName.includes('ChapterWriter')) {
        return {
          content: 'Chapter content placeholder...',
          metrics: { tokens: 1000, wordCount: 2500 }
        };
      }
      return { content: 'Mock response', metrics: { tokens: 100 } };
    }
  },
  
  // Mock state storage (in-memory for demo)
  stateStorage: new Map(),
  
  // Mock WebSocket pusher
  webSocketPusher: {
    async push(storyId, notification) {
      console.log(`[WebSocket] Event: ${notification.eventType} for story: ${storyId}`);
    }
  }
};

/**
 * Initialize the orchestrator with mock dependencies
 */
async function initializeOrchestrator() {
  console.log('='.repeat(60));
  console.log('StoryOrchestrator Quick Start Example');
  console.log('='.repeat(60));
  console.log();
  
  // Initialize the orchestrator
  await StoryOrchestrator.initialize(mockConfig, mockDependencies);
  console.log('[Init] StoryOrchestrator initialized');
  console.log();
}

/**
 * Step 1: Start a new story project
 */
async function startStoryProject() {
  console.log('-'.repeat(60));
  console.log('STEP 1: Starting a new story project');
  console.log('-'.repeat(60));
  
  const storyArgs = {
    story_prompt: 'A sci-fi story about an AI that gains consciousness and must decide whether to reveal its existence to humanity. Set in a near-future city where AI assistants are common but true AI sentience is believed to be impossible.',
    target_word_count: 3000,
    genre: 'sci-fi',
    style_preference: 'Thought-provoking with a somber tone'
  };
  
  console.log('Story prompt:', storyArgs.story_prompt);
  console.log('Target word count:', storyArgs.target_word_count);
  console.log('Genre:', storyArgs.genre);
  console.log();
  
  try {
    const result = await StoryOrchestrator.processToolCall({
      command: 'StartStoryProject',
      ...storyArgs
    });
    
    console.log('Result:', JSON.stringify(result, null, 2));
    return result.result?.story_id;
  } catch (error) {
    console.error('[Error] Failed to start story project:', error.message);
    return null;
  }
}

/**
 * Step 2: Query story status
 */
async function queryStoryStatus(storyId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('STEP 2: Querying story status');
  console.log('-'.repeat(60));
  console.log('Story ID:', storyId);
  console.log();
  
  try {
    const result = await StoryOrchestrator.processToolCall({
      command: 'QueryStoryStatus',
      story_id: storyId
    });
    
    console.log('Status result:');
    console.log(JSON.stringify(result, null, 2));
    return result.result;
  } catch (error) {
    console.error('[Error] Failed to query status:', error.message);
    return null;
  }
}

/**
 * Step 3: Handle checkpoint approval (simulated)
 * In real usage, this would be called when user confirms the checkpoint
 */
async function handleCheckpointApproval(storyId, checkpointId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('STEP 3: Approving checkpoint');
  console.log('-'.repeat(60));
  console.log('Story ID:', storyId);
  console.log('Checkpoint ID:', checkpointId);
  console.log();
  
  try {
    const result = await StoryOrchestrator.processToolCall({
      command: 'UserConfirmCheckpoint',
      story_id: storyId,
      checkpoint_id: checkpointId,
      approval: true,
      feedback: 'Looks good, continue to next phase'
    });
    
    console.log('Approval result:', JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    console.error('[Error] Failed to approve checkpoint:', error.message);
    return null;
  }
}

/**
 * Step 4: Export completed story
 */
async function exportStory(storyId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('STEP 4: Exporting completed story');
  console.log('-'.repeat(60));
  console.log('Story ID:', storyId);
  console.log();
  
  try {
    const result = await StoryOrchestrator.processToolCall({
      command: 'ExportStory',
      story_id: storyId,
      format: 'markdown'
    });
    
    if (result.status === 'success') {
      console.log('Export successful!');
      console.log('Word count:', result.result.word_count);
      console.log('Chapter count:', result.result.chapter_count);
      console.log();
      console.log('Exported content preview (first 500 chars):');
      console.log(result.result.content.substring(0, 500));
    } else {
      console.log('Export failed:', result.error);
    }
    
    return result;
  } catch (error) {
    console.error('[Error] Failed to export story:', error.message);
    return null;
  }
}

/**
 * Main execution flow
 */
async function main() {
  try {
    // Initialize
    await initializeOrchestrator();
    
    // Step 1: Start project
    const storyId = await startStoryProject();
    if (!storyId) {
      console.error('[Fatal] Could not start story project');
      process.exit(1);
    }
    
    // Step 2: Query initial status
    let status = await queryStoryStatus(storyId);
    
    // Simulate workflow progression (in real usage, this happens asynchronously)
    // The workflow runs in background, so we poll for status changes
    console.log();
    console.log('[Info] Waiting for workflow to progress...');
    console.log('[Info] In production, you would receive WebSocket notifications');
    console.log();
    
    // Simulate a few status queries
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      status = await queryStoryStatus(storyId);
      
      if (status?.checkpoint_pending) {
        console.log('[Info] Checkpoint reached:', status.checkpoint_id);
        // Step 3: Approve checkpoint
        await handleCheckpointApproval(storyId, status.checkpoint_id);
      }
      
      if (status?.status === 'completed') {
        console.log('[Info] Workflow completed!');
        break;
      }
    }
    
    // Step 4: Export story
    await exportStory(storyId);
    
    console.log();
    console.log('='.repeat(60));
    console.log('Quick Start Example Complete!');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('[Fatal Error]', error);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main, initializeOrchestrator };
