/**
 * StoryOrchestrator - Batch Processing Example
 * 
 * ⚠️  DEMONSTRATION FILE - WILL NOT RUN WITHOUT REAL API KEYS ⚠️
 * 
 * Demonstrates handling multiple stories concurrently but uses mock model IDs.
 * See quick-start.js header for production setup instructions.
 * 
 * Run: node examples/batch-processing.js
 */

const StoryOrchestrator = require('../core/StoryOrchestrator');

const mockConfig = {
  ORCHESTRATOR_DEBUG_MODE: true,
  MAX_PHASE_ITERATIONS: 5,
  DEFAULT_TARGET_WORD_COUNT_MIN: 2500,
  DEFAULT_TARGET_WORD_COUNT_MAX: 3500,
  USER_CHECKPOINT_TIMEOUT_MS: 86400000,
  STORY_STATE_RETENTION_DAYS: 30,
  MAX_PHASE_RETRY_ATTEMPTS: 3,
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

// mockDependencies shown for documentation - NOT used by initialize()
const mockDependencies = {
  agentDispatcher: { dispatch() {} },
  stateStorage: new Map(),
  webSocketPusher: { push() {} }
};

const storyTemplates = [
  {
    prompt: 'A space opera about a generation ship that discovers an alien artifact',
    genre: 'sci-fi',
    targetWordCount: 8000
  },
  {
    prompt: 'Cozy mystery set in a small English village during the 1950s',
    genre: 'mystery',
    targetWordCount: 4500
  },
  {
    prompt: 'Fantasy adventure about a young baker who discovers magical powers',
    genre: 'fantasy',
    targetWordCount: 6000
  },
  {
    prompt: 'Cyberpunk tale of a hacker who must infiltrate a megacorporation',
    genre: 'cyberpunk',
    targetWordCount: 5000
  }
];

class StoryTracker {
  constructor() {
    this.stories = new Map();
    this.completedCount = 0;
    this.failedCount = 0;
  }

  addStory(storyId, template) {
    this.stories.set(storyId, {
      id: storyId,
      template,
      status: 'started',
      phase: 0,
      checkpointsHandled: 0,
      startedAt: new Date()
    });
  }

  updateStatus(storyId, status) {
    const story = this.stories.get(storyId);
    if (story) {
      story.status = status.status || story.status;
      story.phase = status.phase || story.phase;
      story.progress = status.progress_percent || story.progress;
      story.lastUpdate = new Date();
    }
  }

  getActiveStories() {
    return Array.from(this.stories.values()).filter(s => 
      s.status !== 'completed' && s.status !== 'failed'
    );
  }

  getSummary() {
    const active = this.getActiveStories();
    const phases = { phase1: 0, phase2: 0, phase3: 0, completed: 0, pending: 0 };
    
    for (const story of this.stories.values()) {
      if (story.status === 'completed') phases.completed++;
      else if (story.status === 'pending_checkpoint') phases[`phase${story.phase}`]++;
      else phases.pending++;
    }
    
    return {
      total: this.stories.size,
      active: active.length,
      completed: this.completedCount,
      failed: this.failedCount,
      byPhase: phases
    };
  }
}

async function initializeOrchestrator() {
  console.log('='.repeat(60));
  console.log('BATCH PROCESSING EXAMPLE');
  console.log('='.repeat(60));
  
  await StoryOrchestrator.initialize(mockConfig);
}

async function startMultipleStories(templates) {
  console.log();
  console.log('-'.repeat(60));
  console.log(`STARTING ${templates.length} STORIES CONCURRENTLY`);
  console.log('-'.repeat(60));
  
  const tracker = new StoryTracker();
  const startPromises = templates.map(async (template, index) => {
    console.log(`Starting story ${index + 1}/${templates.length}: ${template.genre}`);
    
    const result = await StoryOrchestrator.processToolCall({
      command: 'StartStoryProject',
      story_prompt: template.prompt,
      genre: template.genre,
      target_word_count: template.targetWordCount
    });
    
    if (result.status === 'success') {
      const storyId = result.result.story_id;
      tracker.addStory(storyId, template);
      console.log(`  -> Created: ${storyId.substring(0, 8)}...`);
      return storyId;
    } else {
      console.error(`  -> Failed: ${result.error}`);
      return null;
    }
  });
  
  const storyIds = (await Promise.all(startPromises)).filter(id => id !== null);
  console.log();
  console.log(`Successfully started ${storyIds.length} stories`);
  return { storyIds, tracker };
}

async function monitorAndProgressStories(tracker, storyIds) {
  console.log();
  console.log('-'.repeat(60));
  console.log('MONITORING STORIES AND HANDLING CHECKPOINTS');
  console.log('-'.repeat(60));
  
  const maxCycles = 15;
  let cycle = 0;
  
  while (cycle < maxCycles) {
    cycle++;
    console.log();
    console.log(`=== Cycle ${cycle}/${maxCycles} ===`);
    
    const summary = tracker.getSummary();
    console.log(`Status: ${summary.completed} completed, ${summary.active} active`);
    console.log(`Phases: P1:${summary.byPhase.phase1} P2:${summary.byPhase.phase2} P3:${summary.byPhase.phase3}`);
    
    if (summary.active === 0 && summary.completed > 0) {
      console.log('All stories completed!');
      break;
    }
    
    const statusPromises = storyIds.map(async (storyId) => {
      const result = await StoryOrchestrator.processToolCall({
        command: 'QueryStoryStatus',
        story_id: storyId
      });
      
      if (result.status === 'success') {
        const status = result.result;
        tracker.updateStatus(storyId, status);
        
        if (status.checkpoint_pending) {
          console.log(`  [${storyId.substring(0,8)}] Checkpoint: ${status.checkpoint_id}`);
          
          const approvalResult = await StoryOrchestrator.processToolCall({
            command: 'UserConfirmCheckpoint',
            story_id: storyId,
            checkpoint_id: status.checkpoint_id,
            approval: true,
            feedback: 'Auto-approved for batch demo'
          });
          
          if (approvalResult.status === 'success') {
            console.log(`  [${storyId.substring(0,8)}] Checkpoint approved`);
          }
        }
        
        if (status.status === 'completed') {
          tracker.completedCount++;
        }
      }
    });
    
    await Promise.all(statusPromises);
    await new Promise(r => setTimeout(r, 300));
  }
  
  return tracker;
}

async function exportBatchResults(tracker, storyIds) {
  console.log();
  console.log('-'.repeat(60));
  console.log('EXPORTING ALL COMPLETED STORIES');
  console.log('-'.repeat(60));
  
  const exportPromises = storyIds.map(async (storyId) => {
    const result = await StoryOrchestrator.processToolCall({
      command: 'ExportStory',
      story_id: storyId,
      format: 'markdown'
    });
    
    if (result.status === 'success') {
      const info = tracker.stories.get(storyId);
      console.log(`[${info?.template.genre}] ${result.result.word_count} words, ${result.result.chapter_count} chapters`);
      return result.result;
    } else {
      console.log(`[${storyId.substring(0,8)}] Export failed: ${result.error}`);
      return null;
    }
  });
  
  const results = (await Promise.all(exportPromises)).filter(r => r !== null);
  console.log();
  console.log(`Exported ${results.length} stories successfully`);
  return results;
}

async function demonstrateParallelPhases(tracker) {
  console.log();
  console.log('-'.repeat(60));
  console.log('PARALLEL PHASE BEHAVIOR');
  console.log('-'.repeat(60));
  console.log('Phase 1: WorldBuilding + CharacterDesign run PARALLEL');
  console.log('Phase 2: Outline SERIAL per chapter, chapters PARALLEL');
  console.log('Phase 3: Polish + Validate iterate until quality threshold');
  console.log();
  
  const phaseBehavior = {
    phase1: {
      agents: ['WorldBuilder', 'CharacterDesigner'],
      execution: 'parallel',
      checkpoint: 'worldview_confirmation'
    },
    phase2: {
      agents: ['PlotArchitect', 'ChapterWriter', 'DetailFiller'],
      execution: 'serial_outline_then_parallel_chapters',
      checkpoint: 'outline_confirmation'
    },
    phase3: {
      agents: ['StylePolisher', 'LogicValidator', 'FinalEditor'],
      execution: 'iterative_loop',
      checkpoint: 'final_acceptance',
      maxIterations: 5
    }
  };
  
  console.log(JSON.stringify(phaseBehavior, null, 2));
}

async function main() {
  try {
    await initializeOrchestrator();
    
    const { storyIds, tracker } = await startMultipleStories(storyTemplates);
    
    if (storyIds.length === 0) {
      console.error('No stories started, exiting');
      return;
    }
    
    await monitorAndProgressStories(tracker, storyIds);
    await demonstrateParallelPhases(tracker);
    await exportBatchResults(tracker, storyIds);
    
    console.log();
    console.log('='.repeat(60));
    console.log('BATCH PROCESSING COMPLETE');
    console.log('='.repeat(60));
    
    const summary = tracker.getSummary();
    console.log(`Final: ${summary.completed} completed, ${summary.failed} failed out of ${summary.total}`);
    
  } catch (error) {
    console.error('[Fatal Error]', error);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, StoryTracker };
