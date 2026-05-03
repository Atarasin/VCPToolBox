/**
 * StoryOrchestrator declarative workflow definition.
 * Custom step types registered by StoryOrchestratorKernelAdapter.
 */
const { extWorldview, extCharacters, extOutline } = require('./extraction-schemas');
const {
  createSchemaValidationStepDefinition,
  createHumanReviewCheckpointStep,
  createPromptRevisionMacro
} = require('../../../modules/workflowKernel/pluginSdk');
const {
  phaseOutputContracts,
  checkpointContracts,
  snapshotContracts,
  artifactContracts
} = require('./workflow-contracts');

const phase1RevisionMacro = createPromptRevisionMacro({
  idPrefix: 'phase1_revision_pattern',
  generatorStep: 'generateWorldAndCharacters',
  parserStep: ['parseWorldview', 'parseCharacters'],
  validationStep: ['schemaValidateWorldview', 'schemaValidateCharacters', 'validatePhase1'],
  guardStep: 'guardPhase1Valid'
});

const phase2OutlineRevisionMacro = createPromptRevisionMacro({
  idPrefix: 'phase2_outline_revision_pattern',
  generatorStep: 'generateOutline',
  parserStep: 'parseOutline',
  validationStep: ['schemaValidateOutline', 'validateOutline'],
  guardStep: 'guardOutlineValid'
});

module.exports = {
  id: 'story-orchestrator-v1',
  version: '1.0.0',
  description: 'Complete StoryOrchestrator workflow: Phase 1 (world building), Phase 2 (outline + content), Phase 3 (polish + final edit)',
  globalRetryPolicy: { maxAttempts: 3, backoffDelays: [0, 250, 1000] },
  onFailure: 'notify_and_halt',
  pluginSdk: {
    phaseOutputs: phaseOutputContracts,
    checkpoints: checkpointContracts,
    snapshots: snapshotContracts,
    artifacts: artifactContracts,
    macros: {
      phase1RevisionMacro,
      phase2OutlineRevisionMacro
    }
  },
  phases: [
    {
      id: 'phase1',
      name: '世界观与人设搭建',
      description: '并行生成世界观和人物设定，进行Schema验证和一致性校验，支持一次自动修订',
      steps: [
        {
          id: 'generateWorldAndCharacters',
          type: 'parallelGroup',
          failurePolicy: 'waitForRest',
          steps: [
            { id: 'generateWorldview', type: 'agentCall', agent: 'worldBuilder', input: { prompt: { $ref: 'ctx.inputs.storyPrompt' }, genre: { $ref: 'ctx.inputs.genre' }, stylePreference: { $ref: 'ctx.inputs.stylePreference' }, targetWords: { $ref: 'ctx.inputs.targetWords' } }, outputKey: 'worldviewRaw', extraction: extWorldview },
            { id: 'generateCharacters', type: 'agentCall', agent: 'characterDesigner', input: { prompt: { $ref: 'ctx.inputs.storyPrompt' }, genre: { $ref: 'ctx.inputs.genre' }, stylePreference: { $ref: 'ctx.inputs.stylePreference' }, targetWords: { $ref: 'ctx.inputs.targetWords' } }, outputKey: 'charactersRaw', extraction: extCharacters }
          ]
        },
        { id: 'parseWorldview', type: 'parseAgentJson', input: { raw: { $ref: 'ctx.outputs.worldviewRaw.content' } }, outputKey: 'worldview' },
        { id: 'parseCharacters', type: 'parseAgentJson', input: { raw: { $ref: 'ctx.outputs.charactersRaw.content' } }, outputKey: 'characters' },
        createSchemaValidationStepDefinition({ id: 'schemaValidateWorldview', dataRef: 'ctx.outputs.worldview.data', schemaType: 'worldview', outputKey: 'worldviewSchema' }),
        createSchemaValidationStepDefinition({ id: 'schemaValidateCharacters', dataRef: 'ctx.outputs.characters.data', schemaType: 'characters', outputKey: 'charactersSchema' }),
        { id: 'guardWorldviewSchema', type: 'guard', condition: 'ctx.outputs.worldviewSchema.valid == true', onFailure: 'fail' },
        { id: 'guardCharactersSchema', type: 'guard', condition: 'ctx.outputs.charactersSchema.valid == true', onFailure: 'fail' },
        { id: 'validatePhase1', type: 'storyValidate', input: { validationType: 'phase1', worldview: { $ref: 'ctx.outputs.worldview.data' }, characters: { $ref: 'ctx.outputs.characters.data' }, storyPrompt: { $ref: 'ctx.inputs.storyPrompt' } }, outputKey: 'phase1Validation' },
        { id: 'guardPhase1Valid', type: 'guard', condition: 'ctx.outputs.phase1Validation.verdict == "PASS" || ctx.outputs.phase1Validation.verdict == "PASS_WITH_WARNINGS"', onFailure: 'fail' },
        createHumanReviewCheckpointStep({
          id: 'checkpointPhase1',
          checkpointType: 'phase1_worldview_confirmation',
          promptTemplate: '世界观与人设已生成并通过验证。请审查世界观设定和人物档案的完整性与一致性。确认后继续进入大纲生成阶段。',
          onCheckpointReject: 'retry',
          contract: checkpointContracts.phase1_worldview_confirmation
        })
      ]
    },
    {
      id: 'phase2',
      name: '大纲与正文生产',
      description: '生成分章大纲，经用户确认后逐章撰写正文',
      steps: [
        { id: 'generateOutline', type: 'generateOutline', input: { storyPrompt: { $ref: 'ctx.inputs.storyPrompt' }, worldview: { $ref: 'ctx.outputs.worldview.data' }, characters: { $ref: 'ctx.outputs.characters.data' }, targetWordCount: { $ref: 'ctx.inputs.targetWordCount' } }, outputKey: 'outlineRaw', extraction: extOutline },
        { id: 'parseOutline', type: 'parseOutline', input: { raw: { $ref: 'ctx.outputs.outlineRaw.content' } }, outputKey: 'outline' },
        createSchemaValidationStepDefinition({ id: 'schemaValidateOutline', dataRef: 'ctx.outputs.outline', schemaType: 'outline', outputKey: 'outlineSchema' }),
        { id: 'guardOutlineSchema', type: 'guard', condition: 'ctx.outputs.outlineSchema.valid == true', onFailure: 'fail' },
        { id: 'validateOutline', type: 'storyValidate', input: { validationType: 'outline', outline: { $ref: 'ctx.outputs.outline' }, worldview: { $ref: 'ctx.outputs.worldview.data' }, characters: { $ref: 'ctx.outputs.characters.data' } }, outputKey: 'outlineValidation' },
        { id: 'guardOutlineValid', type: 'guard', condition: 'ctx.outputs.outlineValidation.verdict != "FAIL"', onFailure: 'fail' },
        createHumanReviewCheckpointStep({
          id: 'checkpointOutline',
          checkpointType: 'phase2_outline_confirmation',
          promptTemplate: '分章大纲已生成并通过验证。请审查章节结构、核心事件分配和故事功能覆盖。确认后开始逐章撰写正文。',
          onCheckpointReject: 'retry',
          contract: checkpointContracts.phase2_outline_confirmation
        }),
        { id: 'produceChapters', type: 'produceChapters', input: { storyId: { $ref: 'ctx.inputs.storyId' }, outline: { $ref: 'ctx.outputs.outline' }, worldview: { $ref: 'ctx.outputs.worldview.data' }, characters: { $ref: 'ctx.outputs.characters.data' }, targetWordCount: { $ref: 'ctx.inputs.targetWordCount' } }, outputKey: 'chaptersResult' },
        createHumanReviewCheckpointStep({
          id: 'checkpointContent',
          checkpointType: 'phase2_content_confirmation',
          promptTemplate: '全部章节已撰写完成。请审查各章节的内容质量、字数达标情况和一致性。确认后进入润色阶段。',
          onCheckpointReject: 'retry',
          contract: checkpointContracts.phase2_content_confirmation
        })
      ]
    },
    {
      id: 'phase3',
      name: '润色与终稿',
      description: '逐章润色、整体校验、终校定稿',
      steps: [
        { id: 'polishChapters', type: 'polishChapters', input: { storyId: { $ref: 'ctx.inputs.storyId' }, chapters: { $ref: 'ctx.outputs.chaptersResult.chapters' }, worldview: { $ref: 'ctx.outputs.worldview.data' }, characters: { $ref: 'ctx.outputs.characters.data' } }, outputKey: 'polishedChapters' },
        { id: 'finalEdit', type: 'finalEdit', input: { chapters: { $ref: 'ctx.outputs.polishedChapters.chapters' } }, outputKey: 'finalEditorOutput' },
        createHumanReviewCheckpointStep({
          id: 'checkpointFinal',
          checkpointType: 'final_acceptance',
          promptTemplate: '故事创作已全部完成，终校编辑已执行。请验收终稿质量，确认后输出最终成品。',
          onCheckpointReject: 'retry',
          contract: checkpointContracts.final_acceptance
        })
      ]
    }
  ]
};
