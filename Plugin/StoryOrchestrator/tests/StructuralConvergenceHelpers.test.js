'use strict';

const { describe, test, mock } = require('node:test');
const assert = require('node:assert/strict');

const { ContentValidator } = require('../core/ContentValidator');
const { ChapterOperations } = require('../core/ChapterOperations');
const {
  STEP_HELPER_BOUNDARY_STATES,
  listStepHelperBoundaries,
  getStepHelperBoundary,
  createStoryValidateStep
} = require('../steps');

function createStoryState() {
  return {
    id: 'story-helpers',
    config: {
      stylePreference: '冷峻克制'
    },
    phase1: {
      worldview: { setting: '环月都市' },
      characters: { protagonists: [{ name: '林澈', role: '调查员' }] }
    },
    phase2: {
      outline: {
        chapters: [
          { title: '第一章', coreEvent: '异常信号出现' }
        ]
      }
    }
  };
}

describe('Structural convergence helper boundaries', () => {
  test('ContentValidator aggregates structured issues as objects while keeping blocking lists intact', async () => {
    const responses = [
      {
        content: JSON.stringify({
          verdict: 'PASS',
          blockingIssues: [],
          nonBlockingIssues: ['世界观表述略密集'],
          suggestions: ['减少术语堆叠']
        })
      },
      {
        content: JSON.stringify({
          verdict: 'FAIL',
          blockingIssues: ['角色动机断裂'],
          nonBlockingIssues: ['配角信息略少'],
          suggestions: ['补充关键动机']
        })
      },
      {
        content: JSON.stringify({
          verdict: 'PASS',
          blockingIssues: [],
          nonBlockingIssues: [],
          suggestions: []
        })
      }
    ];

    const agentDispatcher = {
      delegate: mock.fn(async () => responses.shift())
    };
    const validator = new ContentValidator(agentDispatcher);

    const result = await validator.comprehensiveValidation(
      'story-helpers',
      2,
      '正文内容',
      {
        worldview: { setting: '环月都市' },
        characters: { protagonists: [{ name: '林澈' }] },
        plotSummary: { mainArc: '调查失控实验', keyEvents: ['失控实验'] }
      },
      [{ content: '上一章内容' }]
    );

    assert.equal(result.overall.passed, false);
    assert.equal(result.overall.hasCriticalIssues, true);
    assert.equal(result.overall.canPromoteToValidated, false);
    assert.deepEqual(result.checks.characters.blockingIssues, ['角色动机断裂']);
    assert.deepEqual(
      result.allIssues.map((issue) => issue.description),
      ['世界观表述略密集', '角色动机断裂', '配角信息略少']
    );
    assert.deepEqual(
      result.allIssues.map((issue) => issue.severity),
      ['minor', 'major', 'minor']
    );
  });

  test('ContentValidator normalizes story-domain character collections before prompt construction', async () => {
    const prompts = [];
    const agentDispatcher = {
      delegate: mock.fn(async (_agentType, prompt) => {
        prompts.push(prompt);
        return {
          content: JSON.stringify({
            verdict: 'PASS',
            blockingIssues: [],
            nonBlockingIssues: [],
            suggestions: []
          })
        };
      })
    };
    const validator = new ContentValidator(agentDispatcher);

    await validator.validateCharacters('story-helpers', '章节内容', {
      characters: {
        protagonists: [{ name: '林澈', role: '调查员' }]
      }
    });

    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /林澈/);
  });

  test('ChapterOperations retries short chapter drafts once before continuing the workflow skeleton', async () => {
    const storyState = createStoryState();
    const dispatcher = {
      delegate: mock.fn(async (_agentType, prompt) => {
        if (prompt.includes('上一版输出为空或过短')) {
          return { content: '重试后的章节内容。'.repeat(120) };
        }

        return { content: '过短内容' };
      })
    };
    const chapterOperations = new ChapterOperations(dispatcher, {
      getStory: mock.fn(async () => storyState)
    });

    const result = await chapterOperations.createChapterDraft('story-helpers', 1, {
      targetWordCount: { min: 100, max: 2000 }
    });

    assert.equal(dispatcher.delegate.mock.calls.length, 2);
    assert.match(dispatcher.delegate.mock.calls[1].arguments[1], /上一版输出为空或过短/);
    assert.equal(result.wasExpanded, false);
    assert.equal(result.metrics.validation.isQualified, true);
  });

  test('createStoryValidateStep keeps string issue lists and exposes structured issue objects for downstream reuse', async () => {
    const adapter = {
      agentDispatcher: {
        delegate: mock.fn(async () => ({
          content: JSON.stringify({
            verdict: 'PASS_WITH_WARNINGS',
            blockingIssues: ['主线冲突'],
            nonBlockingIssues: ['节奏偏慢'],
            suggestions: ['提前埋设线索'],
            schemaRisk: false,
            completenessRisk: false
          })
        }))
      }
    };
    const stepHandler = createStoryValidateStep(adapter);

    const result = await stepHandler(
      {
        id: 'validateOutline',
        input: {
          validationType: 'outline',
          outline: { chapters: [{ title: '第一章', coreEvent: '异常信号出现' }] },
          worldview: { setting: '环月都市' },
          characters: { protagonists: [{ name: '林澈' }] }
        }
      },
      { context: {} }
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.output.verdict, 'PASS_WITH_WARNINGS');
    assert.deepEqual(result.output.blockingIssues, ['主线冲突']);
    assert.deepEqual(result.output.nonBlockingIssues, ['节奏偏慢']);
    assert.deepEqual(
      result.output.issues,
      [
        { description: '主线冲突', severity: 'major' },
        { description: '节奏偏慢', severity: 'minor' }
      ]
    );
  });

  test('StoryOrchestrator step helper inventory keeps shared skeleton usage separate from story-domain logic', () => {
    const boundaries = listStepHelperBoundaries();
    const validateStep = getStepHelperBoundary('story-validate-step');
    const outlineParser = getStepHelperBoundary('parse-outline-step');
    const chapterProducer = getStepHelperBoundary('produce-chapters-step');

    assert.ok(Array.isArray(boundaries));
    assert.ok(boundaries.length >= 6);
    assert.equal(validateStep.state, STEP_HELPER_BOUNDARY_STATES.SHARED_SDK_CONSUMER);
    assert.deepEqual(validateStep.usesSharedFamilies, ['structured-validation-orchestration']);
    assert.deepEqual(validateStep.storyOwnedConcerns, ['validation prompts', 'story verdict semantics']);
    assert.equal(outlineParser.state, STEP_HELPER_BOUNDARY_STATES.TRANSITION_GLUE);
    assert.deepEqual(outlineParser.usesSharedFamilies, ['structured-data-extraction']);
    assert.equal(chapterProducer.state, STEP_HELPER_BOUNDARY_STATES.PLUGIN_LOCAL_DOMAIN);
    assert.deepEqual(chapterProducer.usesSharedFamilies, []);
  });
});
