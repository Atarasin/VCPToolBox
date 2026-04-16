/**
 * StoryOrchestrator - Quick Start Example
 * 
 * ⚠️  DEMONSTRATION FILE - WILL NOT RUN WITHOUT REAL API KEYS ⚠️
 * 
 * This file demonstrates the StoryOrchestrator API patterns.
 * It uses mock model IDs which will fail on actual API calls.
 * 
 * To run this plugin in production:
 * 1. Configure real AGENT_*_MODEL_ID values in config.env
 * 2. Ensure VCP AgentAssistant plugin is running
 * 3. Use proper VCP tool call syntax (<<<[TOOL_REQUEST]>>>)
 * 
 * Run: node examples/quick-start.js
 * 
 * EXPECTED BEHAVIOR:
 * - This example will fail on actual API calls (using mock model IDs)
 * - It demonstrates the correct API call pattern
 * - To run fully, configure real Agent model IDs in config.env
 */

const StoryOrchestrator = require('../core/StoryOrchestrator');

/**
 * Configuration for StoryOrchestrator
 * In production, these come from config.env - this example shows the structure
 */
const mockConfig = {
  ORCHESTRATOR_DEBUG_MODE: true,
  MAX_PHASE_ITERATIONS: 5,
  DEFAULT_TARGET_WORD_COUNT_MIN: 2500,
  DEFAULT_TARGET_WORD_COUNT_MAX: 3500,
  USER_CHECKPOINT_TIMEOUT_MS: 86400000,
  STORY_STATE_RETENTION_DAYS: 30,
  
  // IMPORTANT: These are MOCK values for example purposes
  // In production, set these to real model IDs from your AI provider
  AGENT_WORLD_BUILDER_MODEL_ID: 'mock-model',
  AGENT_CHARACTER_DESIGNER_MODEL_ID: 'mock-model',
  AGENT_PLOT_ARCHITECT_MODEL_ID: 'mock-model',
  AGENT_CHAPTER_WRITER_MODEL_ID: 'mock-model',
  AGENT_DETAIL_FILLER_MODEL_ID: 'mock-model',
  AGENT_LOGIC_VALIDATOR_MODEL_ID: 'mock-model',
  AGENT_STYLE_POLISHER_MODEL_ID: 'mock-model',
  AGENT_FINAL_EDITOR_MODEL_ID: 'mock-model',
};

async function initializeOrchestrator() {
  console.log('='.repeat(60));
  console.log('StoryOrchestrator Quick Start Example');
  console.log('='.repeat(60));
  console.log();
  console.log('NOTE: Using mock model IDs - will fail on real API calls');
  console.log('      Configure real model IDs in config.env for production');
  console.log();
  
  await StoryOrchestrator.initialize(mockConfig);
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
    // CORRECT: Use processToolCall with command as first parameter
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
 * Step 3: Handle checkpoint approval
 * 
 * In real usage, this is called when the workflow reaches a checkpoint
 * and needs user confirmation to proceed.
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
    // Step 1: Initialize (just config, dependencies are ignored)
    await initializeOrchestrator();
    
    // Step 2: Start project
    const storyId = await startStoryProject();
    if (!storyId) {
      console.error('[Fatal] Could not start story project');
      console.log('NOTE: This is expected if using mock model IDs');
      process.exit(1);
    }
    
    // Step 3: Query initial status
    let status = await queryStoryStatus(storyId);
    
    // The workflow runs asynchronously in background
    // In production, you would receive WebSocket notifications
    console.log();
    console.log('[Info] In production, the workflow runs asynchronously');
    console.log('[Info] WebSocket notifications would alert you to checkpoint changes');
    console.log();
    
    // Simulate polling for status changes
    // NOTE: In a real scenario, don't poll like this - use WebSocket events
    console.log('[Demo] Simulating workflow progression...');
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      status = await queryStoryStatus(storyId);
      
      if (status?.checkpoint_pending) {
        console.log('[Info] Checkpoint reached:', status.checkpoint_id);
        // In production, this would be triggered by user confirmation
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
    console.log();
    console.log('To run this example fully:');
    console.log('1. Copy config.env.example to config.env');
    console.log('2. Configure real AGENT_*_MODEL_ID values');
    console.log('3. Ensure VCP AgentAssistant is running');
    
  } catch (error) {
    console.error('[Fatal Error]', error);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { main, initializeOrchestrator };
