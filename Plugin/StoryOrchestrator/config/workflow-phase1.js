/**
 * Legacy compatibility definition for StoryOrchestrator Phase 1.
 *
 * WorkflowEngine now derives phase runtime definitions from
 * `workflow-definition.js`, which is the canonical source of truth for
 * WorkflowKernel execution. This file remains as a compatibility artifact and
 * should not receive new primary workflow logic or be treated as the preferred
 * place to evolve StoryOrchestrator behavior.
 */

module.exports = {
  id: 'story-orchestrator-phase1',
  description: 'Phase 1: World building, character design, outline generation',
  phases: [
    {
      id: 'phase1',
      description: 'World building and outline',
      steps: [
        { id: 'generateWorld', type: 'agentCall', agent: 'worldBuildAgent', input: { prompt: { $ref: 'ctx.inputs.storyPrompt' } }, outputKey: 'worldSetting' },
        { id: 'generateCharacters', type: 'agentCall', agent: 'characterAgent', input: { prompt: { $ref: 'ctx.inputs.storyPrompt' }, worldSetting: { $ref: 'ctx.outputs.worldSetting' } }, outputKey: 'characters' },
        { id: 'generateOutline', type: 'agentCall', agent: 'outlineAgent', input: { worldSetting: { $ref: 'ctx.outputs.worldSetting' }, characters: { $ref: 'ctx.outputs.characters' } }, outputKey: 'outline' },
        { id: 'checkpoint1', type: 'checkpoint', promptTemplate: 'Please review the world, characters, and outline. Approve to continue?', onCheckpointReject: 'retry' }
      ]
    }
  ]
};
