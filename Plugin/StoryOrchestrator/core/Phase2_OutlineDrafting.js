const { PromptBuilder } = require('../utils/PromptBuilder');
const { v4: uuidv4 } = require('uuid');

class Phase2_OutlineDrafting {
  constructor({ stateManager, agentDispatcher, chapterOperations, contentValidator, promptBuilder, config }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.chapterOperations = chapterOperations;
    this.contentValidator = contentValidator;
    this.promptBuilder = promptBuilder || PromptBuilder;
    this.config = config || {};
    this.maxRevisionAttempts = this.config.MAX_OUTLINE_REVISION_ATTEMPTS || 2;
    this.maxChapterRevisions = this.config.MAX_CHAPTER_REVISION_ATTEMPTS || 1;
  }

  /**
   * 主执行入口
   * @param {string} storyId - 故事ID
   * @param {Object} options - 选项
   * @returns {Object} { status, phase, nextAction, checkpointId, data }
   */
  async run(storyId, options = {}) {
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    console.log(`[Phase2] Starting for story: ${storyId}`);

    // 更新状态为 phase2_running
    await this.stateManager.updateStory(storyId, {
      status: 'phase2_running',
      phase2: {
        ...story.phase2,
        status: 'running',
        outline: null,
        chapters: [],
        currentChapter: 0
      }
    });

    // 阶段A: 大纲生成
    const outlineResult = await this._generateOutline(storyId);
    
    if (outlineResult.status === 'waiting_checkpoint') {
      return {
        status: 'waiting_checkpoint',
        phase: 'phase2',
        nextAction: 'outline_confirmation',
        checkpointId: outlineResult.checkpointId,
        data: {
          outline: outlineResult.outline,
          validationResult: outlineResult.validationResult
        }
      };
    }

    if (outlineResult.status === 'error') {
      return {
        status: 'error',
        phase: 'phase2',
        error: outlineResult.error
      };
    }

    // 阶段B: 正文生产 (如果大纲已确认或跳过)
    const contentResult = await this._produceContent(storyId);
    
    return {
      status: contentResult.status,
      phase: 'phase2',
      nextAction: contentResult.status === 'completed' ? 'phase3_ready' : 'content_in_progress',
      checkpointId: null,
      data: {
        chaptersCompleted: contentResult.chaptersCompleted,
        totalWordCount: contentResult.totalWordCount,
        chapterResults: contentResult.chapterResults
      }
    };
  }

  /**
   * 从检查点继续执行
   * @param {string} storyId - 故事ID
   * @param {string} decision - 决策: 'approve' | 'reject'
   * @param {string|Object} feedback - 反馈信息
   * @returns {Object}
   */
  async continueFromCheckpoint(storyId, decision, feedback) {
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    const checkpointId = story.phase2?.checkpointId;
    console.log(`[Phase2] Continuing from checkpoint: ${checkpointId}, decision: ${decision}`);

    if (decision === 'approve') {
      // 批准后继续正文生产
      await this.stateManager.updatePhase2(storyId, {
        userConfirmed: true,
        checkpointId: null,
        status: 'content_production'
      });

      const contentResult = await this._produceContent(storyId);

      return {
        status: contentResult.status,
        phase: 'phase2',
        nextAction: contentResult.status === 'completed' ? 'phase3_ready' : 'content_in_progress',
        checkpointId: null,
        data: {
          chaptersCompleted: contentResult.chaptersCompleted,
          totalWordCount: contentResult.totalWordCount,
          chapterResults: contentResult.chapterResults
        }
      };
    } else {
      // 拒绝 - 需要修订大纲
      const revisedResult = await this._reviseOutlineWithFeedback(storyId, feedback);

      if (revisedResult.status === 'waiting_checkpoint') {
        return {
          status: 'waiting_checkpoint',
          phase: 'phase2',
          nextAction: 'outline_revision_confirmation',
          checkpointId: revisedResult.checkpointId,
          data: {
            outline: revisedResult.outline,
            revisionNumber: revisedResult.revisionNumber,
            validationResult: revisedResult.validationResult
          }
        };
      }

      // 修订后直接继续正文生产
      await this.stateManager.updatePhase2(storyId, {
        userConfirmed: true,
        checkpointId: null,
        status: 'content_production'
      });

      const contentResult = await this._produceContent(storyId);

      return {
        status: contentResult.status,
        phase: 'phase2',
        nextAction: contentResult.status === 'completed' ? 'phase3_ready' : 'content_in_progress',
        checkpointId: null,
        data: {
          chaptersCompleted: contentResult.chaptersCompleted,
          totalWordCount: contentResult.totalWordCount,
          chapterResults: contentResult.chapterResults
        }
      };
    }
  }

  // ==================== 私有方法 ====================

  /**
   * 大纲生成阶段
   */
  async _generateOutline(storyId) {
    const story = await this.stateManager.getStory(storyId);
    const config = story.config;
    const storyBible = {
      worldview: story.phase1?.worldview,
      characters: story.phase1?.characters
    };

    // 计算目标章节数
    const targetWordCount = config.targetWordCount || { min: 2500, max: 3500 };
    const storyLength = targetWordCount.min || 2500;
    const estimatedChapters = Math.max(3, Math.min(15, Math.ceil(storyLength / 3000)));

    console.log(`[Phase2] Generating outline, estimated ${estimatedChapters} chapters`);

    // 1. 调用 plotArchitect 生成分章大纲
    const outlinePrompt = this.promptBuilder.buildOutlinePrompt({
      storyPrompt: config.storyPrompt,
      storyBible,
      targetWordCount,
      targetChapterCount: estimatedChapters
    });

    const outlineResult = await this.agentDispatcher.delegate('plotArchitect', outlinePrompt, {
      timeoutMs: 120000,
      temporaryContact: true
    });

    // 2. 解析大纲
    const outline = this._parseOutline(outlineResult.content, estimatedChapters);
    console.log(`[Phase2] Outline generated with ${outline.chapters?.length || 0} chapters`);

    // 3. 调用 logicValidator 验证大纲
    const validationResult = await this._validateOutline(storyId, outline);

    if (!validationResult.passed && validationResult.issues.length > 0) {
      // 验证失败，尝试修订
      console.log(`[Phase2] Outline validation failed, attempting revision`);
      const revisionResult = await this._attemptOutlineRevision(storyId, outline, validationResult, 1);
      
      if (revisionResult.status === 'failed') {
        return {
          status: 'error',
          error: `Outline validation failed after ${this.maxRevisionAttempts} revision attempts`
        };
      }

      return revisionResult;
    }

    // 4. 保存到 phase2.outline
    await this.stateManager.updatePhase2(storyId, {
      outline,
      status: 'pending_confirmation'
    });

    // 5. 创建检查点
    const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
    await this.stateManager.updatePhase2(storyId, {
      checkpointId
    });

    return {
      status: 'waiting_checkpoint',
      checkpointId,
      outline,
      validationResult
    };
  }

  /**
   * 验证大纲
   */
  async _validateOutline(storyId, outline) {
    const story = await this.stateManager.getStory(storyId);
    const storyBible = {
      worldview: story.phase1?.worldview,
      characters: story.phase1?.characters
    };

    const validationPrompt = `
【大纲逻辑验证】

请验证以下分章大纲是否符合要求。

=== 世界观 ===
${JSON.stringify(storyBible.worldview || {}, null, 2)}

=== 人物设定 ===
${JSON.stringify(storyBible.characters || [], null, 2)}

=== 待验证大纲 ===
${JSON.stringify(outline, null, 2)}

=== 验证维度 ===
1. 章节数量是否合理（根据目标字数）
2. 章节划分是否符合叙事结构（起承转合）
3. 人物出场安排是否合理
4. 关键事件是否完整覆盖故事主线
5. 各章节之间的逻辑衔接是否通顺
6. 字数分配是否均衡

=== 输出格式 ===
【验证结论】
通过 / 有条件通过 / 不通过

【问题清单】（如有）
- 问题描述...

【修正建议】（如有）
`;

    const result = await this.agentDispatcher.delegate('logicValidator', validationPrompt, {
      timeoutMs: 90000,
      temporaryContact: true
    });

    return this._parseOutlineValidationResult(result.content);
  }

  /**
   * 尝试修订大纲
   */
  async _attemptOutlineRevision(storyId, outline, validationResult, attemptNumber) {
    if (attemptNumber > this.maxRevisionAttempts) {
      return { status: 'failed' };
    }

    console.log(`[Phase2] Outline revision attempt ${attemptNumber}`);

    // 构建修订提示词
    const revisionPrompt = `
【大纲修订任务】

请根据以下验证反馈修订大纲。

=== 原始大纲 ===
${JSON.stringify(outline, null, 2)}

=== 验证反馈 ===
问题清单：
${validationResult.issues.map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

修正建议：
${validationResult.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}

=== 修订要求 ===
1. 保持故事主线和核心情节不变
2. 重点解决验证反馈中的问题
3. 确保各章节之间逻辑通顺
4. 字数分配合理均衡

请输出修订后的完整大纲。
`;

    const revisionResult = await this.agentDispatcher.delegate('plotArchitect', revisionPrompt, {
      timeoutMs: 120000,
      temporaryContact: true
    });

    const revisedOutline = this._parseOutline(revisionResult.content, outline.chapters?.length || 5);

    // 重新验证
    const reValidation = await this._validateOutline(storyId, revisedOutline);

    if (reValidation.passed || reValidation.issues.length === 0) {
      // 修订成功
      await this.stateManager.updatePhase2(storyId, {
        outline: revisedOutline,
        status: 'pending_confirmation'
      });

      const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
      await this.stateManager.updatePhase2(storyId, {
        checkpointId
      });

      return {
        status: 'waiting_checkpoint',
        checkpointId,
        outline: revisedOutline,
        validationResult: reValidation,
        revisionNumber: attemptNumber
      };
    }

    // 再次失败，递归尝试
    return this._attemptOutlineRevision(storyId, revisedOutline, reValidation, attemptNumber + 1);
  }

  /**
   * 根据反馈修订大纲
   */
  async _reviseOutlineWithFeedback(storyId, feedback) {
    const story = await this.stateManager.getStory(storyId);
    const currentOutline = story.phase2?.outline;

    if (!currentOutline) {
      throw new Error('No outline to revise');
    }

    console.log(`[Phase2] Revising outline with user feedback`);

    const revisionPrompt = `
【大纲修订任务 - 用户反馈】

请根据用户反馈修订大纲。

=== 当前大纲 ===
${JSON.stringify(currentOutline, null, 2)}

=== 用户反馈 ===
${typeof feedback === 'string' ? feedback : JSON.stringify(feedback, null, 2)}

=== 修订要求 ===
1. 充分理解用户反馈意图
2. 在保持故事整体质量的前提下进行修改
3. 确保修订后的各章节之间逻辑通顺
4. 字数分配合理均衡

请输出修订后的完整大纲。
`;

    const revisionResult = await this.agentDispatcher.delegate('plotArchitect', revisionPrompt, {
      timeoutMs: 120000,
      temporaryContact: true
    });

    const revisedOutline = this._parseOutline(revisionResult.content, currentOutline.chapters?.length || 5);

    // 验证修订后的大纲
    const validation = await this._validateOutline(storyId, revisedOutline);

    // 保存修订后的大纲
    await this.stateManager.updatePhase2(storyId, {
      outline: revisedOutline,
      status: 'pending_confirmation'
    });

    const checkpointId = `cp-outline-revised-${uuidv4().substring(0, 8)}`;
    await this.stateManager.updatePhase2(storyId, {
      checkpointId
    });

    return {
      status: 'waiting_checkpoint',
      checkpointId,
      outline: revisedOutline,
      revisionNumber: (currentOutline._revisionNumber || 0) + 1,
      validationResult: validation
    };
  }

  /**
   * 正文生产阶段
   */
  async _produceContent(storyId) {
    const story = await this.stateManager.getStory(storyId);
    const outline = story.phase2?.outline;
    const chapters = outline?.chapters || [];

    if (chapters.length === 0) {
      return {
        status: 'error',
        error: 'No chapters in outline'
      };
    }

    console.log(`[Phase2] Starting content production for ${chapters.length} chapters`);

    const chapterResults = [];
    let totalWordCount = 0;

    // 更新状态为内容生产中
    await this.stateManager.updatePhase2(storyId, {
      status: 'content_production'
    });

    // 逐章撰写（串行）
    for (let i = 0; i < chapters.length; i++) {
      const chapterNum = i + 1;
      console.log(`[Phase2] Producing chapter ${chapterNum}/${chapters.length}`);

      // 更新当前章节
      await this.stateManager.updatePhase2(storyId, {
        currentChapter: chapterNum
      });

      const chapterResult = await this._produceChapter(storyId, chapterNum, chapters[i]);

      chapterResults.push({
        chapterNum,
        ...chapterResult
      });

      if (chapterResult.status === 'completed') {
        totalWordCount += chapterResult.wordCount;
      }

      // 保存章节到 state
      await this._saveChapterToState(storyId, chapterNum, chapterResult);

      console.log(`[Phase2] Chapter ${chapterNum} ${chapterResult.status}`);
    }

    // 标记 phase2 完成
    await this.stateManager.updatePhase2(storyId, {
      status: 'completed',
      userConfirmed: true
    });

    await this.stateManager.updateStory(storyId, {
      status: 'phase2_completed'
    });

    return {
      status: 'completed',
      chaptersCompleted: chapterResults.filter(r => r.status === 'completed').length,
      totalWordCount,
      chapterResults
    };
  }

  /**
   * 生产单个章节
   */
  async _produceChapter(storyId, chapterNum, chapterOutline) {
    const story = await this.stateManager.getStory(storyId);
    const config = story.config;

    // 1. 调用 chapterOperations.createChapterDraft()
    console.log(`[Phase2] Creating draft for chapter ${chapterNum}`);
    let draftResult = await this.chapterOperations.createChapterDraft(storyId, chapterNum, {
      targetWordCount: config.targetWordCount,
      stylePreference: config.stylePreference
    });

    let content = draftResult.content;
    let metrics = draftResult.metrics;

    // 2. 并行调用 detailFiller Agent 进行细节填充
    console.log(`[Phase2] Filling details for chapter ${chapterNum}`);
    const detailResult = await this.chapterOperations.fillDetails(storyId, chapterNum, content, {
      focusAreas: ['场景', '感官', '情绪', '心理']
    });

    // 3. 合并内容（简单实现：先用 detailFiller 结果，如果变化不大则保留）
    if (detailResult.detailedContent && detailResult.detailedContent.length > content.length) {
      const detailMetrics = this.chapterOperations.countChapterLength(
        detailResult.detailedContent,
        config.targetWordCount?.min || 2500,
        config.targetWordCount?.max || 3500,
        { lengthPolicy: 'min_only' }
      );

      // 只有 detail 版本也达标才替换
      if (detailMetrics.validation.isQualified) {
        content = detailResult.detailedContent;
        metrics = detailMetrics;
      }
    }

    // 4. 字数检查（不达标则自动扩充）
    const targetMin = config.targetWordCount?.min || 2500;
    const targetMax = config.targetWordCount?.max || 3500;
    
    metrics = this.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });

    if (!metrics.validation.isQualified && metrics.validation.deficit > 200) {
      console.log(`[Phase2] Chapter ${chapterNum} word count insufficient, auto-expanding`);
      const expanded = await this.chapterOperations._expandChapter(
        storyId,
        content,
        metrics.validation.deficit,
        chapterOutline
      );
      content = expanded.content;
      
      metrics = this.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });
    }

    // 5. 调用 contentValidator 校验
    console.log(`[Phase2] Validating chapter ${chapterNum}`);
    const previousChapters = story.phase2?.chapters || [];
    const validation = await this.contentValidator.comprehensiveValidation(
      storyId,
      chapterNum,
      content,
      { worldview: story.phase1?.worldview, characters: story.phase1?.characters },
      previousChapters
    );

    // 6. 校验失败则调用 chapterOperations.reviseChapter() 自动修订一次
    if (!validation.overall.passed || validation.overall.hasCriticalIssues) {
      console.log(`[Phase2] Chapter ${chapterNum} validation failed, auto-revising`);

      const revisionResult = await this.chapterOperations.reviseChapter(
        storyId,
        chapterNum,
        content,
        {
          revisionInstructions: '根据验证反馈进行修订',
          issues: validation.allIssues.map(i => i.description),
          maxRewriteRatio: 0.35
        }
      );

      if (revisionResult.revisedContent) {
        content = revisionResult.revisedContent;
        metrics = this.chapterOperations.countChapterLength(content, targetMin, targetMax, { lengthPolicy: 'range' });

        // 修订后再次验证
        const reValidation = await this.contentValidator.comprehensiveValidation(
          storyId,
          chapterNum,
          content,
          { worldview: story.phase1?.worldview, characters: story.phase1?.characters },
          previousChapters
        );

        return {
          status: reValidation.overall.passed ? 'completed' : 'completed_with_warnings',
          content,
          wordCount: metrics.counts?.actualCount || 0,
          metrics,
          validation: reValidation,
          wasRevised: true,
          revisionAttempts: 1
        };
      }
    }

    return {
      status: 'completed',
      content,
      wordCount: metrics.counts?.actualCount || 0,
      metrics,
      validation,
      wasRevised: false,
      revisionAttempts: 0
    };
  }

  /**
   * 保存章节到 state
   */
  async _saveChapterToState(storyId, chapterNum, chapterResult) {
    const story = await this.stateManager.getStory(storyId);
    const chapters = [...(story.phase2?.chapters || [])];

    // 确保数组有足够长度
    while (chapters.length < chapterNum) {
      chapters.push({});
    }

    chapters[chapterNum - 1] = {
      number: chapterNum,
      title: chapterResult.title || `第${chapterNum}章`,
      content: chapterResult.content,
      metrics: chapterResult.metrics,
      validation: chapterResult.validation,
      status: chapterResult.status,
      wasRevised: chapterResult.wasRevised,
      createdAt: new Date().toISOString()
    };

    await this.stateManager.updatePhase2(storyId, {
      chapters
    });
  }

  /**
   * 解析大纲内容
   */
  _parseOutline(content, defaultChapterCount = 5) {
    const outline = {
      chapters: [],
      structure: null,
      keyTurningPoints: [],
      foreshadowing: []
    };

    try {
      // 尝试提取章节列表
      const chapterMatches = content.match(/第\s*\d+\s*章[^\n]*/gi) || [];
      
      if (chapterMatches.length > 0) {
        // 提取各章节的详细信息
        const sections = content.split(/第\s*\d+\s*章/);
        
        for (let i = 1; i < sections.length && i <= 20; i++) {
          const section = sections[i];
          const chapterInfo = this._parseChapterSection(section, i);
          if (chapterInfo) {
            outline.chapters.push(chapterInfo);
          }
        }
      }

      // 如果没有找到章节，使用默认数量
      if (outline.chapters.length === 0) {
        for (let i = 1; i <= defaultChapterCount; i++) {
          outline.chapters.push({
            number: i,
            title: `第${i}章`,
            coreEvent: '待填充',
            scenes: [],
            characters: [],
            wordCountTarget: 2500
          });
        }
      }

      // 提取整体结构
      const structureMatch = content.match(/【整体故事结构】([\s\S]*?)(?=【|伏笔|$)/i);
      if (structureMatch) {
        outline.structure = structureMatch[1].trim();
      }

      // 提取关键转折点
      const turningPointsMatch = content.match(/【关键转折点】([\s\S]*?)(?=【|伏笔|修正|$)/i);
      if (turningPointsMatch) {
        outline.keyTurningPoints = turningPointsMatch[1]
          .split('\n')
          .filter(line => line.trim().match(/^\d+\./))
          .map(line => line.replace(/^\d+\.\s*/, '').trim());
      }

      // 提取伏笔计划
      const foreshadowMatch = content.match(/【伏笔与回收计划】([\s\S]*?)(?=【|$)/i);
      if (foreshadowMatch) {
        outline.foreshadowing = foreshadowMatch[1]
          .split('\n')
          .filter(line => line.trim().includes('→') || line.trim().includes('伏笔'))
          .map(line => line.trim());
      }

    } catch (error) {
      console.error('[Phase2] Error parsing outline:', error);
    }

    return outline;
  }

  /**
   * 解析单个章节段落
   */
  _parseChapterSection(section, chapterNum) {
    const lines = section.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const title = lines[0].trim().replace(/^[^\w\d]*/, '');
    
    const chapter = {
      number: chapterNum,
      title: title || `第${chapterNum}章`,
      coreEvent: '',
      scenes: [],
      characters: [],
      wordCountTarget: 2500
    };

    // 提取核心事件
    const eventMatch = section.match(/核心事件[：:]\s*([^\n]+)/i);
    if (eventMatch) {
      chapter.coreEvent = eventMatch[1].trim();
    }

    // 提取场景
    const sceneMatch = section.match(/场景[：:]\s*([^\n]+)/i);
    if (sceneMatch) {
      chapter.scenes = sceneMatch[1].split(/[、，,]/).map(s => s.trim()).filter(s => s);
    }

    // 提取人物
    const charMatch = section.match(/人物[：:]\s*([^\n]+)/i);
    if (charMatch) {
      chapter.characters = charMatch[1].split(/[、，,]/).map(s => s.trim()).filter(s => s);
    }

    // 提取字数
    const wordMatch = section.match(/字数[分配]*[：:]\s*约?\s*(\d+)/i);
    if (wordMatch) {
      chapter.wordCountTarget = parseInt(wordMatch[1], 10);
    }

    return chapter;
  }

  /**
   * 解析大纲验证结果
   */
  _parseOutlineValidationResult(content) {
    const result = {
      passed: true,
      issues: [],
      suggestions: []
    };

    if (content.includes('不通过') || content.includes('失败')) {
      result.passed = false;
    }

    // 提取问题
    const issueMatches = content.match(/[-\d\.\s]*([^\n]*(?:问题|冲突|不符|错误)[^\n]*)/gi) || [];
    result.issues = issueMatches
      .map(line => line.replace(/^[-\d\.\s]+/, '').trim())
      .filter(line => line.length > 5);

    // 提取建议
    const suggestMatches = content.match(/[-\d\.\s]*([^\n]*(?:建议|修正|改进)[^\n]*)/gi) || [];
    result.suggestions = suggestMatches
      .map(line => line.replace(/^[-\d\.\s]+/, '').trim())
      .filter(line => line.length > 5);

    return result;
  }
}

module.exports = { Phase2_OutlineDrafting };
