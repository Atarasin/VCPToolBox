/**
 * StoryOrchestrator custom workflow step implementations.
 *
 * Each export is a factory function that accepts the StoryOrchestratorKernelAdapter
 * instance and returns a step handler compatible with WorkflowKernel.stepRegistry.
 *
 * This module intentionally mixes two layers that structural convergence now
 * needs to keep visible:
 * 1. Reusable orchestration skeletons such as extraction / parse / validate
 * 2. Story-domain rules such as outline normalization and chapter production
 */

const { resolveInput } = require('../../../modules/workflowKernel/steps/AgentCallStep');
const {
  DEFAULT_EXTRACTION_PARSER_ORDER,
  createParseStructuredDataStepHandler,
  createStructuredValidationStepHandler,
  runExtractionStep,
  parseStructuredValidationResult
} = require('../../../modules/workflowKernel/pluginSdk');
const { PromptBuilder } = require('../utils/PromptBuilder');
const { AGENT_TYPES } = require('../agents/AgentDefinitions');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function recordExtractionMetrics(adapter, stepId, meta, success) {
  if (!adapter || typeof adapter._recordExtractionMetrics !== 'function') return;
  adapter._recordExtractionMetrics(stepId, meta, success);
}

function createAdapterMetricRecorder(adapter) {
  return (stepId, meta, success) => {
    recordExtractionMetrics(adapter, stepId, meta, success);
  };
}

function runExtraction(adapter, result, step) {
  return runExtractionStep(result, step, {
    logger: { log: console.log, error: console.error, warn: console.warn },
    onMetrics: createAdapterMetricRecorder(adapter)
  });
}

function normalizeOutline(data) {
  const outline = {
    chapters: [],
    structure: data.structure || null,
    keyTurningPoints: data.keyTurningPoints || [],
    foreshadowing: data.foreshadowing || []
  };
  if (Array.isArray(data.chapters)) {
    outline.chapters = data.chapters.map((ch, idx) => normalizeOutlineChapter(ch, idx));
  }
  return outline;
}

function normalizeOutlineChapter(chapter, index) {
  return {
    number: chapter.number || chapter.chapterNumber || (index + 1),
    title: chapter.title || `第${index + 1}章`,
    coreEvent: chapter.coreEvent || chapter.core_event || '',
    scenes: Array.isArray(chapter.scenes)
      ? chapter.scenes.map((scene) => typeof scene === 'string' ? scene : (scene.action || scene.content || JSON.stringify(scene)))
      : [],
    characters: Array.isArray(chapter.characters)
      ? chapter.characters.map((character) => typeof character === 'string' ? character : (character.name || String(character)))
      : [],
    wordCountTarget: chapter.wordCountTarget || chapter.wordCount || chapter.word_count || 2500,
    storyFunction: chapter.storyFunction || chapter.function || ''
  };
}

function parseOutline(content) {
  const outline = { chapters: [], structure: null, keyTurningPoints: [], foreshadowing: [] };
  if (!content || typeof content !== 'string') return outline;
  try {
    const chapterHeaderRegexCN = /【\s*Chapter\s+(\d+)\s*】/gi;
    const chapterMatchesCN = content.match(chapterHeaderRegexCN) || [];
    if (chapterMatchesCN.length > 0) {
      const sections = content.split(/【\s*Chapter\s+\d+\s*】/i);
      for (let i = 1; i < sections.length && i <= 20; i++) {
        const chapterInfo = parseChapterSectionStructured(sections[i], i);
        if (chapterInfo) outline.chapters.push(chapterInfo);
      }
    }
    if (outline.chapters.length === 0) {
      const jsonParsed = tryParseJsonOutline(content);
      if (jsonParsed) {
        outline.chapters = jsonParsed.chapters;
        outline.structure = jsonParsed.structure;
        outline.keyTurningPoints = jsonParsed.keyTurningPoints;
        outline.foreshadowing = jsonParsed.foreshadowing;
      }
    }
    const structureMatch = content.match(/【整体故事结构】([\s\S]*?)(?=【|伏笔|$)/i);
    if (structureMatch) outline.structure = structureMatch[1].trim();
    const turningPointsMatch = content.match(/【关键转折点】([\s\S]*?)(?=【|伏笔|修正|$)/i);
    if (turningPointsMatch) {
      outline.keyTurningPoints = turningPointsMatch[1].split('\n').filter(line => line.trim().match(/^\d+\./)).map(line => line.replace(/^\d+\.\s*/, '').trim());
    }
    const foreshadowMatch = content.match(/【伏笔与回收计划】([\s\S]*?)(?=【|$)/i);
    if (foreshadowMatch) {
      outline.foreshadowing = foreshadowMatch[1].split('\n').filter(line => line.trim().includes('→') || line.trim().includes('伏笔')).map(line => line.trim());
    }
  } catch (error) {
    console.error('[StoryOrchestratorKernelAdapter] Error parsing outline:', error.message);
  }
  return outline;
}

function parseChapterSectionStructured(section, chapterNum) {
  const chapter = {
    number: chapterNum,
    title: `第${chapterNum}章`,
    coreEvent: '',
    scenes: [],
    characters: [],
    wordCountTarget: 2500,
    storyFunction: ''
  };
  const titleMatch = section.match(/标题[：:]\s*([^\n]+)/i);
  if (titleMatch) chapter.title = titleMatch[1].trim();
  const eventMatch = section.match(/核心事件[：:]\s*([^\n]+)/i);
  if (eventMatch) chapter.coreEvent = eventMatch[1].trim();
  const sceneBlock = section.match(/场景[：:]\s*\n([\s\S]*?)(?=\n出场人物|\n故事功能|\n【|$)/i);
  if (sceneBlock) {
    chapter.scenes = sceneBlock[1].split('\n').map(line => line.replace(/^\s*\d+\.\s*/, '').trim()).filter(s => s.length > 0);
  }
  const charBlock = section.match(/出场人物[：:]\s*\n([\s\S]*?)(?=\n故事功能|\n【|$)/i);
  if (charBlock) {
    chapter.characters = charBlock[1].split('\n').map(line => line.replace(/^\s*\d+\.\s*/, '').trim()).filter(c => c.length > 0);
  }
  const funcMatch = section.match(/故事功能[：:]\s*(setup|escalation|climax|resolution)/i);
  if (funcMatch) chapter.storyFunction = funcMatch[1].toLowerCase();
  return chapter;
}

function tryParseJsonOutline(content) {
  let jsonStr = null;
  const codeBlockMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
  if (!jsonStr) {
    const braceMatch = content.match(/(\{[\s\S]*"chapters"[\s\S]*\})/);
    if (braceMatch) jsonStr = braceMatch[1];
  }
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed.chapters || !Array.isArray(parsed.chapters) || parsed.chapters.length === 0) return null;
    const normalizedChapters = parsed.chapters.map((ch, idx) => normalizeOutlineChapter(ch, idx));
    return {
      chapters: normalizedChapters,
      structure: parsed.structure || null,
      keyTurningPoints: parsed.keyTurningPoints || [],
      foreshadowing: parsed.foreshadowing || []
    };
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step factories
// ---------------------------------------------------------------------------

function createParseAgentJsonStep(adapter) {
  return createParseStructuredDataStepHandler({
    getRaw: (input) => input.raw || '',
    getExtractionOptions: (input, step) => step.extraction || {
      parserOrder: DEFAULT_EXTRACTION_PARSER_ORDER,
      throwOnFailure: false,
      defaultValue: { raw: input.raw || '' }
    },
    logger: { log: console.log, error: console.error, warn: console.warn },
    onMetrics: createAdapterMetricRecorder(adapter)
  });
}

function createStoryValidateStep(adapter) {
  return createStructuredValidationStepHandler({
    agentDispatcher: adapter.agentDispatcher,
    getAgentType: () => AGENT_TYPES.LOGIC_VALIDATOR,
    buildPrompt: ({ validationType, worldview, characters, outline, storyPrompt }) => {
      if (validationType === 'phase1') {
        const content = JSON.stringify({ storyPrompt, worldview, characters }, null, 2);
        return PromptBuilder.buildWorldviewValidationPrompt({ content, worldview, characters });
      }

      if (validationType === 'outline') {
        return PromptBuilder.buildOutlineValidationPrompt(outline, { worldview, characters });
      }

      throw new Error(`Unknown validationType: ${validationType}`);
    },
    parseResult: parseStructuredValidationResult
  });
}

function createGenerateOutlineStep(adapter) {
  return async (step, stepContext) => {
    const { storyPrompt, worldview, characters, targetWordCount } = resolveInput(step.input, stepContext.context);
    const storyBible = { worldview, characters };
    const storyLength = targetWordCount?.min || 2500;
    const estimatedChapters = Math.max(3, Math.min(15, Math.ceil(storyLength / 3000)));
    const prompt = PromptBuilder.buildOutlinePrompt({
      storyPrompt,
      storyBible,
      targetWordCount: targetWordCount || { min: 2500, max: 3500 },
      targetChapterCount: estimatedChapters
    });
    try {
      const result = await adapter.agentDispatcher.delegate(AGENT_TYPES.PLOT_ARCHITECT, prompt, {
        timeoutMs: 300000,
        temporaryContact: true
      });
      if (step.extraction) {
        return runExtraction(adapter, result, step);
      }
      return { status: 'completed', output: { content: result.content } };
    } catch (error) {
      return { status: 'failed', error: new Error(`Outline generation failed: ${error.message}`) };
    }
  };
}

function createParseOutlineStep(adapter) {
  return createParseStructuredDataStepHandler({
    getRaw: (input) => input.raw || '',
    getExtractionOptions: (_input, step) => step.extraction || {
      parserOrder: DEFAULT_EXTRACTION_PARSER_ORDER,
      throwOnFailure: false,
      defaultValue: null
    },
    normalizeOutput: ({ extracted, raw }) => {
      if (extracted && extracted.data && Array.isArray(extracted.data.chapters) && extracted.data.chapters.length > 0) {
        const normalized = normalizeOutline(extracted.data);
        return { ...normalized, _extractionMeta: extracted.meta };
      }

      return parseOutline(raw);
    },
    logger: { log: console.log, error: console.error, warn: console.warn },
    onMetrics: createAdapterMetricRecorder(adapter)
  });
}

function createProduceChaptersStep(adapter) {
  return async (step, stepContext) => {
    const { storyId, outline, worldview, characters, targetWordCount } = resolveInput(step.input, stepContext.context);
    const chapters = outline?.chapters || [];
    const results = [];
    let totalWordCount = 0;
    const targetMin = targetWordCount?.min || 2500;
    const targetMax = targetWordCount?.max || 3500;
    for (let i = 0; i < chapters.length; i++) {
      const chapterNum = i + 1;
      const chapterOutline = chapters[i];
      console.log(`[produceChapters] Producing chapter ${chapterNum}/${chapters.length}`);
      try {
        let draftResult = await adapter.chapterOperations.createChapterDraft(storyId, chapterNum, {
          targetWordCount: { min: targetMin, max: targetMax },
          outlineContext: chapterOutline
        });
        let content = draftResult.content;
        let metrics = draftResult.metrics;
        const detailResult = await adapter.chapterOperations.fillDetails(storyId, chapterNum, content, {
          focusAreas: ['场景', '感官', '情绪', '心理']
        });
        if (detailResult.detailedContent && detailResult.detailedContent.length > content.length) {
          const detailMetrics = adapter.chapterOperations.countChapterLength(
            detailResult.detailedContent, targetMin, targetMax, { lengthPolicy: 'min_only' }
          );
          if (detailMetrics.validation.isQualified) {
            content = detailResult.detailedContent;
            metrics = detailMetrics;
          }
        }
        metrics = adapter.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });
        if (!metrics.validation.isQualified && metrics.validation.deficit > 200) {
          console.log(`[produceChapters] Chapter ${chapterNum} word count insufficient, auto-expanding`);
          const expanded = await adapter.chapterOperations._expandChapter(storyId, content, metrics.validation.deficit, chapterOutline);
          content = expanded.content;
          metrics = adapter.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });
        }
        const storyBible = { worldview, characters };
        const previousChapters = results.map(r => ({ number: r.chapterNum, content: r.content, metrics: r.metrics }));
        const validation = await adapter.contentValidator.comprehensiveValidation(storyId, chapterNum, content, storyBible, previousChapters);
        if (!validation.overall.passed || validation.overall.hasCriticalIssues) {
          console.log(`[produceChapters] Chapter ${chapterNum} validation failed, auto-revising`);
          const revisionResult = await adapter.chapterOperations.reviseChapter(
            storyId, chapterNum, content,
            { revisionInstructions: '根据验证反馈进行修订', issues: validation.allIssues.map(i => i.description), maxRewriteRatio: 0.35 }
          );
          if (revisionResult.revisedContent && revisionResult.revisedContent.length > 100) {
            content = revisionResult.revisedContent;
            metrics = adapter.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });
          }
        }
        results.push({
          chapterNum,
          number: chapterNum,
          title: chapterOutline.title || `第${chapterNum}章`,
          content,
          metrics,
          validation,
          status: 'completed'
        });
        totalWordCount += metrics.counts?.actualCount || 0;
      } catch (error) {
        console.error(`[produceChapters] Chapter ${chapterNum} failed:`, error.message);
        results.push({
          chapterNum,
          number: chapterNum,
          title: chapterOutline.title || `第${chapterNum}章`,
          content: '',
          metrics: {},
          status: 'failed',
          error: error.message
        });
      }
    }
    const completedCount = results.filter(r => r.status === 'completed').length;
    return {
      status: completedCount > 0 ? 'completed' : 'failed',
      output: { chapters: results, totalWordCount, completedCount }
    };
  };
}

function createPolishChaptersStep(adapter) {
  return async (step, stepContext) => {
    const { storyId, chapters, worldview, characters } = resolveInput(step.input, stepContext.context);
    const maxIterations = adapter.config.MAX_PHASE_ITERATIONS || 5;
    const qualityThreshold = adapter.config.QUALITY_THRESHOLD || 8.0;
    const storyBible = { worldview, characters };
    let currentChapters = chapters.map((ch, idx) => ({
      number: ch.number || idx + 1,
      title: ch.title || `第${idx + 1}章`,
      content: ch.content || ''
    }));
    const qualityScores = [];
    let iterationCount = 0;
    for (iterationCount = 1; iterationCount <= maxIterations; iterationCount++) {
      console.log(`[polishChapters] Polish iteration ${iterationCount}/${maxIterations}`);
      for (let i = 0; i < currentChapters.length; i++) {
        const chapter = currentChapters[i];
        try {
          const polishResult = await adapter.chapterOperations.polishChapter(
            storyId, chapter.number, chapter.content,
            { polishFocus: '文风统一、句式优化、节奏控制、描写生动' }
          );
          currentChapters[i] = {
            ...chapter,
            content: polishResult.polishedContent || chapter.content,
            metrics: polishResult.metrics,
            improvements: polishResult.improvements
          };
        } catch (error) {
          console.error(`[polishChapters] Polish chapter ${chapter.number} failed:`, error.message);
        }
      }
      const fullContent = currentChapters.map(ch => ch.content).join('\n\n');
      let validation = { overall: { passed: true, hasCriticalIssues: false, criticalCount: 0 }, allIssues: [] };
      try {
        validation = await adapter.contentValidator.comprehensiveValidation(storyId, 0, fullContent, storyBible);
      } catch (error) {
        console.error('[polishChapters] Comprehensive validation failed:', error.message);
      }
      let qualityResult = { average: 0, scores: {}, rawReport: '' };
      try {
        qualityResult = await adapter.contentValidator.qualityScore(fullContent);
      } catch (error) {
        console.error('[polishChapters] Quality scoring failed:', error.message);
      }
      qualityScores.push({ iteration: iterationCount, ...qualityResult });
      const avgScore = qualityResult.average || 0;
      console.log(`[polishChapters] Iteration ${iterationCount} - Avg Quality Score: ${avgScore}, Critical Issues: ${validation.overall.criticalCount || 0}`);
      if (avgScore >= qualityThreshold && !validation.overall.hasCriticalIssues) {
        console.log(`[polishChapters] Quality threshold met (${avgScore} >= ${qualityThreshold}), breaking loop`);
        break;
      }
      if (iterationCount === maxIterations) {
        console.log(`[polishChapters] Max iterations reached`);
        break;
      }
    }
    const avgScore = qualityScores.length > 0
      ? Math.round((qualityScores.reduce((sum, q) => sum + (q.average || 0), 0) / qualityScores.length) * 10) / 10
      : 0;
    return {
      status: 'completed',
      output: {
        chapters: currentChapters,
        iterationCount,
        qualityScores,
        averageQualityScore: avgScore
      }
    };
  };
}

function createFinalEditStep(adapter) {
  return async (step, stepContext) => {
    const { chapters } = resolveInput(step.input, stepContext.context);
    const fullContent = chapters.map(ch => `=== 第${ch.number}章 ${ch.title || ''} ===\n\n${ch.content}`).join('\n\n');
    const prompt = PromptBuilder.buildFinalEditorPrompt(fullContent);
    try {
      const result = await adapter.agentDispatcher.delegate(AGENT_TYPES.FINAL_EDITOR, prompt, {
        timeoutMs: 300000,
        temporaryContact: true
      });
      return {
        status: 'completed',
        output: {
          content: result.content,
          report: result.content.substring(0, 500)
        }
      };
    } catch (error) {
      return { status: 'failed', error: new Error(`Final editor failed: ${error.message}`) };
    }
  };
}

module.exports = {
  createParseAgentJsonStep,
  createStoryValidateStep,
  createGenerateOutlineStep,
  createParseOutlineStep,
  createProduceChaptersStep,
  createPolishChaptersStep,
  createFinalEditStep
};
