const { TextMetrics } = require('../utils/TextMetrics');
const { PromptBuilder } = require('../utils/PromptBuilder');

class ChapterOperations {
  constructor(agentDispatcher, stateManager) {
    this.agentDispatcher = agentDispatcher;
    this.stateManager = stateManager;
    this.textMetrics = new TextMetrics();
  }

  countChapterLength(text, targetMin, targetMax, options = {}) {
    const countMode = options.countMode || 'cn_chars';
    const lengthPolicy = options.lengthPolicy || 'range';
    
    const metrics = this.textMetrics.analyze(text);
    
    let actualCount;
    if (countMode === 'cn_chars') {
      actualCount = metrics.chineseChars;
    } else {
      actualCount = metrics.nonWhitespaceChars;
    }

    const validation = this.textMetrics.validateLength(actualCount, targetMin, targetMax, lengthPolicy);

    return {
      countMode,
      lengthPolicy,
      targetRange: { min: targetMin ?? null, max: targetMax ?? null },
      counts: {
        actualCount,
        chineseChars: metrics.chineseChars,
        nonWhitespaceChars: metrics.nonWhitespaceChars,
        rawChars: metrics.rawChars,
        paragraphCount: metrics.paragraphCount,
        sentenceCount: metrics.sentenceCount,
        avgSentenceLength: metrics.avgSentenceLength
      },
      validation
    };
  }

  async createChapterDraft(storyId, chapterNum, options = {}) {
    const storyState = await this.stateManager.getStory(storyId);
    if (!storyState) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const storyBible = storyState.phase1;
    const outline = storyState.phase2?.outline?.chapters?.[chapterNum - 1];
    const config = storyState.config;
    const chapterOutline = outline || (options.outlineContext ? { providedContext: options.outlineContext } : null);

    if (!chapterOutline) {
      throw new Error(`Outline not found for chapter ${chapterNum}`);
    }

    const previousEnding = options.previousEnding || this._getPreviousChapterEnding(storyState, chapterNum);

    const targetWordCount = typeof options.targetWordCount === 'number'
      ? { min: Math.floor(options.targetWordCount * 0.8), max: options.targetWordCount }
      : (options.targetWordCount || { min: 2500, max: 3500 });

    const prompt = PromptBuilder.buildChapterWriterPrompt({
      storyBible,
      chapterNum,
      chapterOutline,
      additionalContext: options.outlineContext || '',
      previousChapterEnding: previousEnding,
      targetWordCount: targetWordCount,
      stylePreference: config.stylePreference
    });

    let result = await this.agentDispatcher.delegate('chapterWriter', prompt, {
      timeoutMs: options.timeoutMs || 300000,
      temporaryContact: true
    });

    if (!result.content || result.content.trim().length < 1000) {
      console.warn(`[ChapterOperations] Chapter ${chapterNum} draft too short (${result.content?.length || 0} chars), retrying once`);
      result = await this.agentDispatcher.delegate('chapterWriter', prompt + '\n\n注意：上一版输出为空或过短，请务必输出完整的章节正文，字数必须达标。', {
        timeoutMs: options.timeoutMs || 300000,
        temporaryContact: true
      });
    }

    const wordCountCheck = this.countChapterLength(
      result.content,
      targetWordCount.min || 2500,
      targetWordCount.max || 3500,
      { lengthPolicy: 'min_only' }
    );

    if (!wordCountCheck.validation.isQualified && wordCountCheck.validation.deficit > 200) {
      const expanded = await this._expandChapter(storyId, result.content, wordCountCheck.validation.deficit, chapterOutline);
      return {
        content: expanded.content,
        originalContent: result.content,
        wasExpanded: true,
        metrics: this.countChapterLength(
          expanded.content,
          config.targetWordCount?.min,
          config.targetWordCount?.max,
          { lengthPolicy: 'min_only' }
        ),
        agentResponse: result
      };
    }

    return {
      content: result.content,
      wasExpanded: false,
      metrics: wordCountCheck,
      agentResponse: result
    };
  }

  async reviewChapter(storyId, chapterNum, chapterContent, options = {}) {
    const storyState = await this.stateManager.getStory(storyId);
    if (!storyState) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const prompt = PromptBuilder.buildLogicValidatorPrompt({
      chapterNum,
      chapterContent,
      storyBible: storyState.phase1,
      reviewFocus: options.reviewFocus || '设定一致性、情节逻辑、人物OOC风险'
    });

    const result = await this.agentDispatcher.delegate('logicValidator', prompt, {
      timeoutMs: options.timeoutMs || 300000,
      temporaryContact: true
    });

    return this._parseReviewReport(result.content);
  }

  async reviseChapter(storyId, chapterNum, chapterContent, revisionOptions) {
    const storyState = await this.stateManager.getStory(storyId);
    if (!storyState) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const {
      revisionInstructions,
      issues = [],
      mustKeep = [],
      maxRewriteRatio = 0.35
    } = revisionOptions;

    const prompt = PromptBuilder.buildRevisionPrompt({
      chapterContent,
      revisionInstructions: revisionInstructions || '根据问题清单进行最小必要修订',
      issues,
      mustKeep: mustKeep.length > 0 ? mustKeep : ['主线情节', '关键设定', '人物核心性格'],
      maxRewriteRatio
    });

    const agentType = maxRewriteRatio > 0.5 ? 'chapterWriter' : 'stylePolisher';
    
    const result = await this.agentDispatcher.delegate(agentType, prompt, {
      timeoutMs: revisionOptions.timeoutMs || 300000,
      temporaryContact: true
    });

    return {
      revisedContent: result.content,
      changeSummary: this._extractChangeSummary(result.content),
      originalMetrics: this.countChapterLength(chapterContent),
      revisedMetrics: this.countChapterLength(result.content),
      agentResponse: result
    };
  }

  async polishChapter(storyId, chapterNum, chapterContent, options = {}) {
    const storyState = await this.stateManager.getStory(storyId);
    if (!storyState) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const polishFocus = options.polishFocus || '文风统一、句式优化、节奏控制';
    const storyStyle = storyState.config.stylePreference;

    if (chapterContent.length <= 3000) {
      const prompt = PromptBuilder.buildStylePolisherPrompt({
        chapterContent,
        storyStyle,
        polishFocus
      });

      const result = await this.agentDispatcher.delegate('stylePolisher', prompt, {
        timeoutMs: options.timeoutMs || 300000,
        temporaryContact: true
      });

      return {
        polishedContent: result.content,
        improvements: this._extractImprovements(result.content),
        metrics: this.countChapterLength(result.content),
        agentResponse: result
      };
    }

    console.log(`[ChapterOperations] polishChapter using segmented polish for ch=${chapterNum}, totalLength=${chapterContent.length}`);

    const segments = this._splitContentIntoSegments(chapterContent, 2500);
    const polishedSegments = [];

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const contextPrefix = i > 0 ? `（接上文）\n\n` : '';
      const contextSuffix = i < segments.length - 1 ? `\n\n（下文待续）` : '';
      const segmentWithContext = contextPrefix + segment + contextSuffix;

      const prompt = PromptBuilder.buildStylePolisherPrompt({
        chapterContent: segmentWithContext,
        storyStyle,
        polishFocus
      });

      const result = await this.agentDispatcher.delegate('stylePolisher', prompt, {
        timeoutMs: options.timeoutMs || 300000,
        temporaryContact: true
      });

      let polishedSegment = result.content || '';
      polishedSegment = polishedSegment.replace(/^（接上文）\s*\n*/i, '');
      polishedSegment = polishedSegment.replace(/\n*\s*（下文待续）\s*$/i, '');

      polishedSegments.push(polishedSegment);
      console.log(`[ChapterOperations] Segment ${i + 1}/${segments.length} polished: ${segment.length} -> ${polishedSegment.length}`);
    }

    const fullPolishedContent = polishedSegments.join('\n\n');

    return {
      polishedContent: fullPolishedContent,
      improvements: this._extractImprovements(fullPolishedContent),
      metrics: this.countChapterLength(fullPolishedContent),
      agentResponse: { content: fullPolishedContent, segmented: true, segmentCount: segments.length }
    };
  }

  _splitContentIntoSegments(content, maxSegmentLength) {
    const paragraphs = content.split(/\n\n+/);
    const segments = [];
    let currentSegment = '';

    for (const paragraph of paragraphs) {
      if (!paragraph.trim()) continue;

      if (currentSegment.length + paragraph.length + 2 <= maxSegmentLength) {
        currentSegment += (currentSegment ? '\n\n' : '') + paragraph;
      } else {
        if (currentSegment) {
          segments.push(currentSegment);
        }
        currentSegment = paragraph;
      }
    }

    if (currentSegment) {
      segments.push(currentSegment);
    }

    return segments;
  }

  async fillDetails(storyId, chapterNum, chapterContent, options = {}) {
    const prompt = PromptBuilder.buildDetailFillerPrompt({
      chapterContent,
      focusAreas: options.focusAreas || ['场景', '感官', '情绪']
    });

    const result = await this.agentDispatcher.delegate('detailFiller', prompt, {
      timeoutMs: options.timeoutMs || 300000,
      temporaryContact: true
    });

    return {
      detailedContent: result.content,
      agentResponse: result
    };
  }

  _getPreviousChapterEnding(storyState, currentChapterNum) {
    if (currentChapterNum <= 1) return '';
    
    const prevChapter = storyState.phase2?.chapters?.[currentChapterNum - 2];
    if (!prevChapter || !prevChapter.content) return '';
    
    const content = prevChapter.content;
    return content.slice(-200);
  }

  async _expandChapter(storyId, currentContent, deficit, outline) {
    const expansionPrompt = `
【字数扩充任务】
当前章节字数不足，需要扩充约 ${deficit} 字。

当前内容：
${currentContent}

本章大纲要求：
${JSON.stringify(outline, null, 2)}

扩充原则：
1. 在不改变主线情节的前提下增加细节描写
2. 可以扩展对话、增加场景描写、深化人物心理
3. 保持文风一致
4. 扩充后的内容必须流畅自然

请输出扩充后的完整章节。
`;

    let result = await this.agentDispatcher.delegate('detailFiller', expansionPrompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    if (!result.content || result.content.trim().length < currentContent.length + 500) {
      console.warn(`[ChapterOperations] Expand result too short (${result.content?.length || 0} chars), retrying once`);
      result = await this.agentDispatcher.delegate('detailFiller', expansionPrompt + '\n\n注意：上一版扩充不足，请大幅增加细节描写、对话和心理活动，确保字数达标。', {
        timeoutMs: 300000,
        temporaryContact: true
      });
    }

    return {
      content: result.content,
      expansionPrompt
    };
  }

  _parseReviewReport(content) {
    const report = {
      verdict: 'pass',
      severity: 'none',
      issues: [],
      suggestions: [],
      rawContent: content
    };

    if (content.includes('不通过') || content.includes('失败')) {
      report.verdict = 'fail';
      report.severity = 'critical';
    } else if (content.includes('有条件通过') || content.includes('警告')) {
      report.verdict = 'conditional';
      report.severity = 'major';
    }

    const issueMatch = content.match(/问题清单[：:]([\s\S]*?)(?=建议|修正|改进|$)/i);
    if (issueMatch) {
      report.issues = issueMatch[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && (line.startsWith('-') || line.match(/^\d+\./)))
        .map(line => line.replace(/^[-\d.\s]+/, '').trim());
    }

    const suggestionMatch = content.match(/(建议|修正建议)[：:]([\s\S]*?)(?=亮点|$)/i);
    if (suggestionMatch) {
      report.suggestions = suggestionMatch[2]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && (line.startsWith('-') || line.match(/^\d+\./)))
        .map(line => line.replace(/^[-\d.\s]+/, '').trim());
    }

    return report;
  }

  _extractChangeSummary(content) {
    const summaryMatch = content.match(/【变更摘要】([\s\S]*?)(?=【|正文|$)/i);
    return summaryMatch ? summaryMatch[1].trim() : '未提供变更摘要';
  }

  _extractImprovements(content) {
    const improvements = [];
    const lines = content.split('\n');
    let inImprovementsSection = false;
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes('改进') || trimmed.includes('优化') || trimmed.includes('提升')) {
        inImprovementsSection = true;
      }
      if (inImprovementsSection && (trimmed.startsWith('-') || trimmed.match(/^\d+\./))) {
        improvements.push(trimmed.replace(/^[-\d.\s]+/, '').trim());
      }
    }
    
    return improvements.length > 0 ? improvements : ['文笔整体优化'];
  }
}

module.exports = { ChapterOperations };
