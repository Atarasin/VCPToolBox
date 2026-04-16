/**
 * StoryOrchestrator - Full Workflow Example
 * 
 * ⚠️  DEMONSTRATION FILE - WILL NOT RUN WITHOUT REAL API KEYS ⚠️
 * 
 * Demonstrates complete workflow but uses mock model IDs.
 * See quick-start.js header for production setup instructions.
 * 
 * Run: node examples/full-workflow.js
 */

const StoryOrchestrator = require('../core/StoryOrchestrator');

const mockConfig = {
  ORCHESTRATOR_DEBUG_MODE: true,
  MAX_PHASE_ITERATIONS: 5,
  QUALITY_THRESHOLD: 8.0,
  DEFAULT_TARGET_WORD_COUNT_MIN: 2500,
  DEFAULT_TARGET_WORD_COUNT_MAX: 3500,
  USER_CHECKPOINT_TIMEOUT_MS: 86400000,
  STORY_STATE_RETENTION_DAYS: 30,
  MAX_PHASE_RETRY_ATTEMPTS: 3,
  // MOCK - replace with real model IDs
  AGENT_WORLD_BUILDER_MODEL_ID: 'mock-model',
  AGENT_CHARACTER_DESIGNER_MODEL_ID: 'mock-model',
  AGENT_PLOT_ARCHITECT_MODEL_ID: 'mock-model',
  AGENT_CHAPTER_WRITER_MODEL_ID: 'mock-model',
  AGENT_DETAIL_FILLER_MODEL_ID: 'mock-model',
  AGENT_LOGIC_VALIDATOR_MODEL_ID: 'mock-model',
  AGENT_STYLE_POLISHER_MODEL_ID: 'mock-model',
  AGENT_FINAL_EDITOR_MODEL_ID: 'mock-model',
};
const mockDependencies = {
  agentDispatcher: { dispatch() {} },
  stateStorage: new Map(),
  webSocketPusher: { push() {} }
};

class InteractiveSimulator {
  constructor() {
    this.approvedCheckpoints = new Set();
  }

  async simulateCheckpoint(storyId, checkpointId, phase) {
    console.log();
    console.log('='.repeat(60));
    console.log(`CHECKPOINT ${phase}: ${checkpointId}`);
    console.log('='.repeat(60));
    
    this.approvedCheckpoints.add(checkpointId);
    return { approval: true, feedback: 'Approved - content looks good' };
  }
}

async function initializeOrchestrator() {
  console.log('='.repeat(60));
  console.log('FULL WORKFLOW EXAMPLE');
  console.log('='.repeat(60));
  await StoryOrchestrator.initialize(mockConfig);
}

async function startStoryWithFullConfig() {
  console.log();
  console.log('-'.repeat(60));
  console.log('STARTING STORY WITH FULL CONFIGURATION');
  console.log('-'.repeat(60));
  
  const fullConfig = {
    command: 'StartStoryProject',
    story_prompt: 'A detective noir story set in 1940s Shanghai. The protagonist is a former police inspector turned private eye who takes on a case involving a missing actress. The case uncovers a conspiracy involving the Japanese occupation forces. The tone should be atmospheric with moral ambiguity.',
    target_word_count: 5000,
    genre: 'detective-noir',
    style_preference: 'Hardboiled prose, vivid descriptions, morally complex characters'
  };
  
  console.log('Starting story with:');
  console.log(`  Genre: ${fullConfig.genre}`);
  console.log(`  Target: ${fullConfig.target_word_count} words`);
  console.log(`  Style: ${fullConfig.style_preference}`);
  console.log();
  
  const result = await StoryOrchestrator.processToolCall(fullConfig);
  
  if (result.status === 'success') {
    console.log('Story started:', result.result);
    return result.result.story_id;
  } else {
    console.error('Failed to start story:', result.error);
    return null;
  }
}

async function handleAllCheckpoints(storyId) {
  const simulator = new InteractiveSimulator();
  
  console.log();
  console.log('-'.repeat(60));
  console.log('HANDLING ALL 3 CHECKPOINTS');
  console.log('-'.repeat(60));
  
  let currentStatus = await queryStatus(storyId);
  let maxIterations = 10;
  let iteration = 0;
  
  while (!currentStatus?.status?.includes('completed') && iteration < maxIterations) {
    iteration++;
    console.log();
    console.log(`[Iteration ${iteration}] Checking status...`);
    
    if (currentStatus?.checkpoint_pending) {
      const checkpointId = currentStatus.checkpoint_id;
      const phase = currentStatus.phase || 1;
      
      const decision = await simulator.simulateCheckpoint(
        storyId, checkpointId, `phase${phase}`
      );
      
      console.log(`Decision: ${decision.approval ? 'APPROVE' : 'REJECT'}`);
      
      const result = await StoryOrchestrator.processToolCall({
        command: 'UserConfirmCheckpoint',
        story_id: storyId,
        checkpoint_id: checkpointId,
        approval: decision.approval,
        feedback: decision.feedback
      });
      
      console.log('Checkpoint response:', result.status);
    }
    
    await new Promise(r => setTimeout(r, 200));
    currentStatus = await queryStatus(storyId);
  }
  
  return currentStatus;
}

async function demonstrateErrorHandling(storyId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('DEMONSTRATING ERROR HANDLING');
  console.log('-'.repeat(60));
  
  const errorScenarios = [
    {
      name: 'Invalid story ID',
      args: { command: 'QueryStoryStatus', story_id: 'non-existent-id' }
    },
    {
      name: 'Missing required parameter',
      args: { command: 'StartStoryProject' }
    },
    {
      name: 'Invalid checkpoint',
      args: {
        command: 'UserConfirmCheckpoint',
        story_id: storyId,
        checkpoint_id: 'invalid-checkpoint',
        approval: true
      }
    }
  ];
  
  for (const scenario of errorScenarios) {
    console.log();
    console.log(`Testing: ${scenario.name}`);
    const result = await StoryOrchestrator.processToolCall(scenario.args);
    console.log(`Result: ${result.status} - ${result.error || 'OK'}`);
  }
}

async function demonstrateRecovery(storyId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('DEMONSTRATING RECOVERY FROM SAVED STATE');
  console.log('-'.repeat(60));
  
  console.log();
  console.log(`Story: ${storyId}`);
  console.log('In production, state is persisted to: Plugin/StoryOrchestrator/state/');
  console.log('If the process crashes, call RecoverStoryWorkflow to resume');
  
  const recoverResult = await StoryOrchestrator.processToolCall({
    command: 'RecoverStoryWorkflow',
    story_id: storyId,
    recovery_action: 'continue'
  });
  
  console.log('Recovery result:', recoverResult.status);
}

async function queryStatus(storyId) {
  const result = await StoryOrchestrator.processToolCall({
    command: 'QueryStoryStatus',
    story_id: storyId
  });
  return result.result;
}

async function exportFinalStory(storyId) {
  console.log();
  console.log('-'.repeat(60));
  console.log('EXPORTING FINAL STORY');
  console.log('-'.repeat(60));
  
  const formats = ['markdown', 'txt', 'json'];
  
  for (const format of formats) {
    const result = await StoryOrchestrator.processToolCall({
      command: 'ExportStory',
      story_id: storyId,
      format
    });
    
    if (result.status === 'success') {
      console.log(`[${format}] Exported ${result.result.word_count} words, ${result.result.chapter_count} chapters`);
    } else {
      console.log(`[${format}] Export skipped/failed: ${result.error}`);
    }
  }
}

async function main() {
  try {
    await initializeOrchestrator();
    
    const storyId = await startStoryWithFullConfig();
    if (!storyId) {
      console.error('Cannot proceed without story ID');
      return;
    }
    
    await handleAllCheckpoints(storyId);
    await demonstrateErrorHandling(storyId);
    await demonstrateRecovery(storyId);
    
    const finalStatus = await queryStatus(storyId);
    if (finalStatus?.status === 'completed') {
      await exportFinalStory(storyId);
    }
    
    console.log();
    console.log('='.repeat(60));
    console.log('FULL WORKFLOW EXAMPLE COMPLETE');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('[Fatal Error]', error);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
