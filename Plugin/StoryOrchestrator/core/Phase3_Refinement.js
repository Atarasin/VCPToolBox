const { AGENT_TYPES } = require('../agents/AgentDefinitions');

/**
 * Phase3_Refinement - 润色校验迭代与终校定稿
 * 
 * 职责：
 * 1. 逐章润色
 * 2. 整体校验
 * 3. 润色-校验循环 (最多 MAX_PHASE_ITERATIONS 次)
 * 4. 质量评分
 * 5. 终校定稿
 * 6. 创建 checkpoint 3 (终稿验收)
 */
class Phase3_Refinement {
  constructor({ stateManager, agentDispatcher, chapterOperations, contentValidator, promptBuilder, config }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.chapterOperations = chapterOperations;
    this.contentValidator = contentValidator;
    this.promptBuilder = promptBuilder;
    
    // 配置参数
    this.MAX_PHASE_ITERATIONS = config?.MAX_PHASE_ITERATIONS || 5;
    this.QUALITY_THRESHOLD = config?.QUALITY_THRESHOLD || 8.0;
    this.CRITICAL_ISSUE_THRESHOLD = config?.CRITICAL_ISSUE_THRESHOLD || 0;
  }

  /**
   * 执行 Phase 3 润色校验流程
   * @param {string} storyId - 故事ID
   * @param {Object} options - 可选参数
   * @returns {Promise<{status, phase, nextAction, checkpointId, data}>}
   */
  async run(storyId, options = {}) {
    console.log(`[Phase3_Refinement] Starting for story: ${storyId}`);
    
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    // 确保 phase3 状态存在
    if (!story.phase3) {
      story.phase3 = {
        polishedChapters: [],
        finalValidation: null,
        iterationCount: 0,
        userConfirmed: false,
        checkpointId: null,
        status: 'pending',
        finalEditorOutput: null,
        qualityScores: []
      };
    }

    const storyBible = {
      worldview: story.phase1?.worldview,
      characters: story.phase1?.characters,
      plotSummary: story.phase2?.outline
    };

    const chapters = story.phase2?.chapters || [];
    if (chapters.length === 0) {
      return {
        status: 'error',
        error: 'No chapters found in phase2'
      };
    }

    // ===== 润色循环 =====
    const polishResult = await this._runPolishLoop(storyId, chapters, storyBible, options);
    
    if (polishResult.error) {
      return {
        status: 'error',
        error: polishResult.error
      };
    }

    // 保存润色后的章节
    await this.stateManager.updatePhase3(storyId, {
      polishedChapters: polishResult.polishedChapters,
      qualityScores: polishResult.qualityScores,
      iterationCount: polishResult.iterationCount,
      status: 'polishing_complete'
    });

    // ===== 终校阶段 =====
    const finalEditorResult = await this._runFinalEditor(storyId, polishResult.polishedChapters, storyBible);
    
    if (finalEditorResult.error) {
      return {
        status: 'error',
        error: finalEditorResult.error
      };
    }

    // 保存终校输出
    await this.stateManager.updatePhase3(storyId, {
      finalEditorOutput: finalEditorResult.output,
      status: 'final_editing_complete'
    });

    // ===== 创建终稿验收检查点 =====
    const checkpointId = await this._createFinalAcceptanceCheckpoint(storyId, finalEditorResult.output);

    return {
      status: 'waiting_checkpoint',
      phase: 'phase3',
      nextAction: 'user_confirm_final_acceptance',
      checkpointId: checkpointId,
      data: {
        iterationCount: polishResult.iterationCount,
        qualityScores: polishResult.qualityScores,
        averageQualityScore: this._calculateAverageScore(polishResult.qualityScores),
        finalEditorOutput: finalEditorResult.output,
        message: '润色校验完成，请验收终稿'
      }
    };
  }

  /**
   * 从检查点继续执行
   * @param {string} storyId - 故事ID
   * @param {string} decision - 决策：'approve' 或 'reject'
   * @param {string} feedback - 反馈信息（拒绝时）
   * @returns {Promise<{status, phase, nextAction, checkpointId, data}>}
   */
  async continueFromCheckpoint(storyId, decision, feedback = '') {
    console.log(`[Phase3_Refinement] continueFromCheckpoint: ${storyId}, decision: ${decision}`);
    
    const story = await this.stateManager.getStory(storyId);
    if (!story) {
      return {
        status: 'error',
        error: `Story not found: ${storyId}`
      };
    }

    const checkpointId = story.phase3?.checkpointId;
    
    if (decision === 'approve') {
      // ===== 批准：标记完成，生成终稿 =====
      return await this._handleApproval(storyId, checkpointId);
    } else {
      // ===== 拒绝：记录反馈，重新运行 Phase 3 =====
      return await this._handleRejection(storyId, checkpointId, feedback);
    }
  }

  // ===== 私有方法 =====

  /**
   * 运行润色循环
   * @private
   */
  async _runPolishLoop(storyId, chapters, storyBible, options = {}) {
    const polishedChapters = [];
    const qualityScores = [];
    let iterationCount = 0;
    
    // 初始化：复制原始章节作为初始润色目标
    let currentChapters = chapters.map((ch, idx) => ({
      number: ch.number || idx + 1,
      title: ch.title,
      content: ch.content,
      metrics: ch.metrics
    }));

    for (iterationCount = 1; iterationCount <= this.MAX_PHASE_ITERATIONS; iterationCount++) {
      console.log(`[Phase3_Refinement] Polish iteration ${iterationCount}/${this.MAX_PHASE_ITERATIONS}`);
      
      const iterationChapters = [];
      const iterationScores = [];

      // 1. 逐章润色
      for (const chapter of currentChapters) {
        try {
          const polishResult = await this.chapterOperations.polishChapter(
            storyId,
            chapter.number,
            chapter.content,
            { polishFocus: options.polishFocus || '文风统一、句式优化、节奏控制、描写生动' }
          );
          
          iterationChapters.push({
            number: chapter.number,
            title: chapter.title,
            content: polishResult.polishedContent,
            originalContent: chapter.content,
            metrics: polishResult.metrics,
            improvements: polishResult.improvements
          });
        } catch (error) {
          console.error(`[Phase3_Refinement] Polish chapter ${chapter.number} failed:`, error);
          // 如果润色失败，保留原内容
          iterationChapters.push({
            number: chapter.number,
            title: chapter.title,
            content: chapter.content,
            metrics: chapter.metrics,
            polishError: error.message
          });
        }
      }

      // 2. 整体校验
      const allValidation = {
        passed: true,
        hasCriticalIssues: false,
        criticalCount: 0,
        issues: []
      };

      // 对全部内容进行整体校验
      const fullContent = iterationChapters.map(ch => ch.content).join('\n\n');
      
      try {
        const validationResult = await this.contentValidator.comprehensiveValidation(
          storyId,
          0, // 整体校验，不针对特定章节
          fullContent,
          storyBible
        );
        
        allValidation.passed = validationResult.overall.passed;
        allValidation.hasCriticalIssues = validationResult.overall.hasCriticalIssues;
        allValidation.criticalCount = validationResult.overall.criticalCount;
        allValidation.issues = validationResult.allIssues;
      } catch (error) {
        console.error(`[Phase3_Refinement] Comprehensive validation failed:`, error);
      }

      // 3. 质量评分
      try {
        const qualityResult = await this.contentValidator.qualityScore(fullContent);
        iterationScores.push(qualityResult);
      } catch (error) {
        console.error(`[Phase3_Refinement] Quality scoring failed:`, error);
        iterationScores.push({ average: 0, scores: {}, rawReport: '' });
      }

      // 计算平均分
      const avgScore = this._calculateAverageScore(iterationScores);
      qualityScores.push({
        iteration: iterationCount,
        ...iterationScores[iterationScores.length - 1]
      });

      console.log(`[Phase3_Refinement] Iteration ${iterationCount} - Avg Quality Score: ${avgScore}, Critical Issues: ${allValidation.criticalCount}`);

      // 4. 检查是否满足退出条件
      // 条件：平均分 >= QUALITY_THRESHOLD 且无严重问题
      if (avgScore >= this.QUALITY_THRESHOLD && !allValidation.hasCriticalIssues) {
        console.log(`[Phase3_Refinement] Quality threshold met (${avgScore} >= ${this.QUALITY_THRESHOLD}), breaking loop`);
        polishedChapters.push(...iterationChapters);
        break;
      }

      // 如果是最后一次迭代，保存当前结果
      if (iterationCount === this.MAX_PHASE_ITERATIONS) {
        console.log(`[Phase3_Refinement] Max iterations reached, using current result`);
        polishedChapters.push(...iterationChapters);
        
        // 如果质量分数过低，添加警告到状态
        if (avgScore < this.QUALITY_THRESHOLD) {
          console.warn(`[Phase3_Refinement] Quality score ${avgScore} below threshold ${this.QUALITY_THRESHOLD}`);
        }
        break;
      }

      // 否则，将润色后的章节作为下一轮迭代的输入
      currentChapters = iterationChapters;
    }

    return {
      polishedChapters,
      qualityScores,
      iterationCount
    };
  }

  /**
   * 运行终校编辑器
   * @private
   */
  async _runFinalEditor(storyId, polishedChapters, storyBible) {
    console.log(`[Phase3_Refinement] Running final editor for story: ${storyId}`);
    
    try {
      // 合并所有润色后的章节
      const fullContent = polishedChapters
        .map(ch => `=== 第${ch.number}章 ${ch.title || ''} ===\n\n${ch.content}`)
        .join('\n\n');

      const prompt = this.promptBuilder.buildFinalEditorPrompt(fullContent);

      const result = await this.agentDispatcher.delegate('finalEditor', prompt, {
        timeoutMs: 120000,
        temporaryContact: true
      });

      return {
        output: result.content,
        agentResponse: result
      };
    } catch (error) {
      console.error(`[Phase3_Refinement] Final editor failed:`, error);
      return {
        error: `Final editor failed: ${error.message}`,
        output: null
      };
    }
  }

  /**
   * 创建终稿验收检查点
   * @private
   */
  async _createFinalAcceptanceCheckpoint(storyId, finalEditorOutput) {
    const checkpointId = `cp-3-final-${Date.now()}`;
    
    await this.stateManager.updatePhase3(storyId, {
      checkpointId: checkpointId,
      status: 'waiting_final_acceptance',
      checkpointCreatedAt: new Date().toISOString()
    });

    return checkpointId;
  }

  /**
   * 处理批准
   * @private
   */
  async _handleApproval(storyId, checkpointId) {
    console.log(`[Phase3_Refinement] Handling approval for checkpoint: ${checkpointId}`);
    
    const story = await this.stateManager.getStory(storyId);
    
    // 生成最终输出
    const finalOutput = this._generateFinalOutput(story);
    
    // 更新状态
    await this.stateManager.updateStory(storyId, {
      status: 'completed',
      finalOutput: finalOutput,
      completedAt: new Date().toISOString()
    });

    await this.stateManager.updatePhase3(storyId, {
      userConfirmed: true,
      confirmedAt: new Date().toISOString(),
      status: 'completed'
    });

    return {
      status: 'completed',
      phase: 'phase3',
      nextAction: 'story_completed',
      checkpointId: checkpointId,
      data: {
        message: '终稿验收通过，故事创作完成',
        finalOutput: finalOutput,
        wordCount: this._calculateTotalWordCount(finalOutput)
      }
    };
  }

  /**
   * 处理拒绝
   * @private
   */
  async _handleRejection(storyId, checkpointId, feedback) {
    console.log(`[Phase3_Refinement] Handling rejection for checkpoint: ${checkpointId}`);
    console.log(`[Phase3_Refinement] Feedback: ${feedback}`);
    
    // 记录反馈
    await this.stateManager.updatePhase3(storyId, {
      lastRejection: {
        checkpointId: checkpointId,
        feedback: feedback,
        rejectedAt: new Date().toISOString()
      },
      status: 'rejected_awaiting_resume'
    });

    // 重新运行 Phase 3
    console.log(`[Phase3_Refinement] Re-running Phase 3 with feedback`);
    
    return await this.run(storyId, {
      polishFocus: `根据反馈优化：${feedback}`
    });
  }

  /**
   * 生成最终输出
   * @private
   */
  _generateFinalOutput(story) {
    const finalEditorOutput = story.phase3?.finalEditorOutput;
    const polishedChapters = story.phase3?.polishedChapters || [];
    
    // 构建最终输出结构
    const output = {
      metadata: {
        storyId: story.id,
        title: story.config?.storyPrompt?.substring(0, 50) || '未命名故事',
        genre: story.config?.genre || 'general',
        stylePreference: story.config?.stylePreference || '',
        targetWordCount: story.config?.targetWordCount,
        createdAt: story.createdAt,
        completedAt: new Date().toISOString(),
        qualityScores: story.phase3?.qualityScores || [],
        finalEditorOutput: finalEditorOutput
      },
      storyBible: {
        worldview: story.phase1?.worldview,
        characters: story.phase1?.characters
      },
      outline: story.phase2?.outline,
      chapters: polishedChapters.map(ch => ({
        number: ch.number,
        title: ch.title,
        content: ch.content,
        wordCount: ch.metrics?.counts?.chineseChars || 0
      })),
      totalWordCount: this._calculateTotalWordCount({ phase3: { polishedChapters } })
    };

    return output;
  }

  /**
   * 计算总字数
   * @private
   */
  _calculateTotalWordCount(storyOrObj) {
    const chapters = storyOrObj?.phase3?.polishedChapters || [];
    return chapters.reduce((sum, ch) => {
      return sum + (ch.metrics?.counts?.chineseChars || 0);
    }, 0);
  }

  /**
   * 计算平均质量分
   * @private
   */
  _calculateAverageScore(qualityScores) {
    if (!qualityScores || qualityScores.length === 0) {
      return 0;
    }
    
    const scores = qualityScores.map(qs => qs.average || qs.averageScore || 0);
    const validScores = scores.filter(s => s > 0);
    
    if (validScores.length === 0) {
      return 0;
    }
    
    const sum = validScores.reduce((a, b) => a + b, 0);
    return Math.round((sum / validScores.length) * 10) / 10;
  }
}

module.exports = { Phase3_Refinement };
