const { PromptBuilder } = require('../utils/PromptBuilder');
const { SchemaValidator } = require('../utils/SchemaValidator');
const { v4: uuidv4 } = require('uuid');

class Phase2_OutlineDrafting {
  constructor({ stateManager, agentDispatcher, chapterOperations, contentValidator, promptBuilder, config }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.chapterOperations = chapterOperations;
    this.contentValidator = contentValidator;
    this.promptBuilder = promptBuilder || PromptBuilder;
    this.config = config || {};
    this.artifactManager = stateManager.artifactManager;
    this.maxRevisionAttempts = this.config.MAX_OUTLINE_REVISION_ATTEMPTS || 5;
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

    // 检查是否已有已确认的大纲，直接跳到内容生成
    const existingOutline = story.phase2?.outline;
    const userConfirmed = story.phase2?.userConfirmed;
    const hasValidOutline = existingOutline && 
                           existingOutline.chapters && 
                           existingOutline.chapters.length > 0 &&
                           existingOutline.chapters.some(c => c.coreEvent && c.coreEvent.trim() !== '');
    
    if (userConfirmed && hasValidOutline) {
      console.log(`[Phase2] Using confirmed outline with ${existingOutline.chapters.length} chapters, skipping to content production`);
      
      // 更新状态为 running，但保留现有大纲
      await this.stateManager.updateStory(storyId, {
        status: 'phase2_running',
        phase2: {
          ...story.phase2,
          status: 'running',
          checkpointId: null,  // 清除检查点ID
          currentChapter: 0
        }
      });
      
      // 直接跳到阶段B: 正文生产
      const contentResult = await this._produceContent(storyId);
      
      return {
        status: contentResult.status,
        phase: 'phase2',
        nextAction: contentResult.status === 'completed' ? 'phase3_ready' : 'content_in_progress',
        checkpointId: contentResult.checkpointId,
        checkpointType: contentResult.checkpointType,
        data: {
          chaptersCompleted: contentResult.chaptersCompleted,
          totalWordCount: contentResult.totalWordCount,
          chapterResults: contentResult.chapterResults
        }
      };
    }

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

    if (outlineResult.status === 'needs_retry') {
      return outlineResult;
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
    const phase2Status = story.phase2?.status;
    console.log(`[Phase2] Continuing from checkpoint: ${checkpointId}, decision: ${decision}, status: ${phase2Status}`);

    if (phase2Status === 'content_pending_confirmation') {
      if (decision === 'approve') {
        await this.stateManager.updatePhase2(storyId, {
          userConfirmed: true,
          checkpointId: null,
          status: 'completed'
        });
        await this.stateManager.updateStory(storyId, {
          status: 'phase2_completed'
        });
        return {
          status: 'completed',
          phase: 'phase2',
          nextAction: 'phase3_ready',
          data: {
            chaptersCompleted: story.phase2.chapters?.length || 0,
            totalWordCount: story.phase2.totalWordCount || 0
          }
        };
      } else {
        return {
          status: 'failed',
          phase: 'phase2',
          error: 'Content approval rejected'
        };
      }
    }

    if (decision === 'approve') {
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
        checkpointId: contentResult.checkpointId,
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
    const targetWordCount = typeof config.targetWordCount === 'number'
      ? { min: Math.floor(config.targetWordCount * 0.8), max: config.targetWordCount }
      : (config.targetWordCount || { min: 2500, max: 3500 });
    const storyLength = targetWordCount.min || 2500;
    const estimatedChapters = Math.max(3, Math.min(15, Math.ceil(storyLength / 3000)));

    console.log(`[Phase2] Generating outline, estimated ${estimatedChapters} chapters`);

    let schemaFeedback = '';
    const lastError = story.workflow?.retryContext?.lastError;
    if (lastError && lastError.includes('Schema validation failed')) {
      schemaFeedback = lastError.replace('Schema validation failed: ', '');
    }

    const outlinePrompt = this.promptBuilder.buildOutlinePrompt({
      storyPrompt: config.storyPrompt,
      storyBible,
      targetWordCount,
      targetChapterCount: estimatedChapters,
      schemaFeedback
    });

    const outlineResult = await this.agentDispatcher.delegate('plotArchitect', outlinePrompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    // 1.5 保存原始响应和提示词为 artifacts
    let rawResponsePath = null;
    let promptPath = null;
    try {
      const rawArtifact = await this.artifactManager.saveArtifact(storyId, 'raw_response', outlineResult.content, 'txt');
      const promptArtifact = await this.artifactManager.saveArtifact(storyId, 'prompt', outlinePrompt, 'txt');
      rawResponsePath = rawArtifact.filePath;
      promptPath = promptArtifact.filePath;
    } catch (artifactError) {
      console.warn('[Phase2] Failed to save artifacts:', artifactError.message);
    }

    const attemptId = this.stateManager.repository.createPhaseAttempt({
      story_id: storyId,
      phase_name: 'phase2',
      attempt_kind: 'initial_generation',
      trigger_source: 'agent',
      raw_prompt_path: promptPath,
      raw_response_path: rawResponsePath,
      parse_status: 'parsed',
      repair_used: false,
      schema_valid: false,
      business_valid: false
    });

    // 2. 解析大纲
    const outline = this._parseOutline(outlineResult.content, estimatedChapters);
    console.log(`[Phase2] Outline generated with ${outline.chapters?.length || 0} chapters`);

    const schemaValidation = SchemaValidator.validateOutline(outline);
    if (!schemaValidation.valid) {
      const allIssues = [...schemaValidation.errors, ...schemaValidation.warnings];
      console.log(`[Phase2] Outline schema invalid: ${allIssues.join(', ')}`);
      this.stateManager.repository.updatePhaseAttempt(attemptId, {
        schema_valid: false,
        error_message: allIssues.join('; '),
        completed_at: new Date().toISOString()
      });
      try {
        await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
          stage: 'schema_validation',
          source: 'generateOutline',
          verdict: 'FAIL',
          errors: schemaValidation.errors,
          warnings: schemaValidation.warnings,
          parsedOutline: outline,
          rawContentPreview: (outlineResult.content || '').substring(0, 2000)
        }, null, 2), 'json');
      } catch (_) {}
      return {
        status: 'needs_retry',
        error: 'Schema validation failed: ' + allIssues.join('; ')
      };
    }

    this.stateManager.repository.updatePhaseAttempt(attemptId, {
      schema_valid: true
    });

    // 3. 调用 logicValidator 验证大纲
    const validationResult = await this._validateOutline(storyId, outline);

    // 3.5 处理 PASS_WITH_WARNINGS - 创建 checkpoint 供人工复核，不自动放行
    if (validationResult.verdict === 'PASS_WITH_WARNINGS') {
      console.log(`[Phase2] Outline validation passed with warnings, creating checkpoint for human review`);
      await this.stateManager.updatePhase2(storyId, {
        outline,
        status: 'pending_confirmation'
      }, { snapshotType: 'validated' });

      try {
        await this.artifactManager.saveArtifact(storyId, 'outline_approved', JSON.stringify({
          source: 'generateOutline_pass_with_warnings',
          validationResult,
          outline,
          chapterCount: outline.chapters?.length || 0,
          schemaValidation: {
            valid: true,
            errors: [],
            warnings: schemaValidation.warnings || []
          }
        }, null, 2), 'json');
      } catch (_) {}

      const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
      await this.stateManager.updatePhase2(storyId, {
        checkpointId
      }, { snapshotType: 'validated' });

      const headRow = this.stateManager.repository.getStory(storyId);
      if (headRow) {
        this.stateManager.repository.updatePhaseAttempt(attemptId, {
          business_valid: true,
          candidate_snapshot_id: headRow.current_phase2_snapshot_id,
          completed_at: new Date().toISOString()
        });
      }

      return {
        status: 'waiting_checkpoint',
        checkpointId,
        checkpointType: 'phase2_outline_confirmation',
        outline,
        validationResult
      };
    }

    if (validationResult.verdict === 'FAIL') {
      console.log(`[Phase2] Outline validation failed, attempting revision`);
      try {
        await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
          stage: 'logic_validation',
          source: 'generateOutline',
          verdict: validationResult.verdict,
          blockingIssues: validationResult.blockingIssues || [],
          nonBlockingIssues: validationResult.nonBlockingIssues || [],
          issues: validationResult.issues || [],
          suggestions: validationResult.suggestions || [],
          outline: outline
        }, null, 2), 'json');
      } catch (_) {}
      const revisionResult = await this._attemptOutlineRevision(storyId, outline, validationResult, 1, attemptId);

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
    }, { snapshotType: 'validated' });

    // 4.5 保存成功大纲到 artifacts
    try {
      await this.artifactManager.saveArtifact(storyId, 'outline_approved', JSON.stringify({
        source: 'generateOutline',
        validationResult,
        outline,
        chapterCount: outline.chapters?.length || 0,
        schemaValidation: {
          valid: true,
          errors: [],
          warnings: schemaValidation.warnings || []
        }
      }, null, 2), 'json');
    } catch (_) {}

    // 5. 创建检查点
    const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
    await this.stateManager.updatePhase2(storyId, {
      checkpointId
    }, { snapshotType: 'validated' });

    const headRow = this.stateManager.repository.getStory(storyId);
    if (headRow) {
      this.stateManager.repository.updatePhaseAttempt(attemptId, {
        business_valid: true,
        candidate_snapshot_id: headRow.current_phase2_snapshot_id,
        completed_at: new Date().toISOString()
      });
    }

    return {
      status: 'waiting_checkpoint',
      checkpointId,
      checkpointType: 'phase2_outline_confirmation',
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
      timeoutMs: 300000,
      temporaryContact: true
    });

    return this._parseOutlineValidationResult(result.content);
  }

  /**
   * 尝试修订大纲
   */
  async _attemptOutlineRevision(storyId, outline, validationResult, attemptNumber, parentAttemptId) {
    if (attemptNumber > this.maxRevisionAttempts) {
      if (parentAttemptId) {
        this.stateManager.repository.updatePhaseAttempt(parentAttemptId, {
          business_valid: false,
          error_message: 'Max revision attempts exceeded',
          completed_at: new Date().toISOString()
        });
      }
      return { status: 'failed' };
    }

    console.log(`[Phase2] Outline revision attempt ${attemptNumber}`);

    const revisionAttemptId = this.stateManager.repository.createPhaseAttempt({
      story_id: storyId,
      phase_name: 'phase2',
      attempt_kind: 'revision',
      trigger_source: 'agent',
      source_checkpoint_id: null,
      parse_status: 'parsed',
      repair_used: false,
      schema_valid: false,
      business_valid: false
    });

    // 构建修订提示词
    const chapterCount = outline.chapters?.length || 5;
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

=== 输出格式（必须严格遵循，禁止偏离，禁止使用JSON）===

<<<OUTLINE_RESULT开始>>>
章节总数: ${chapterCount}

【Chapter 1】
标题: [精确的章节标题]
核心事件: [一句话描述本章唯一核心事件，不超过25字]
场景:
  1. [场景1]
  2. [场景2]
出场人物:
  1. [人物名] - [角色]
故事功能: [setup | escalation | climax | resolution]

[继续至 Chapter ${chapterCount}]

【关键转折点】
1. [转折描述]

【伏笔与回收计划】
- 伏笔X（第A章埋设）→ 回收于第B章：[回收方式]
<<<OUTLINE_RESULT结束>>>
`;

    const revisionResult = await this.agentDispatcher.delegate('plotArchitect', revisionPrompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    // 保存修订版本的 raw response
    let rawPath = null;
    try {
      const art = await this.artifactManager.saveArtifact(storyId, 'raw_response', revisionResult.content, 'txt');
      rawPath = art.filePath;
    } catch (e) {}

    this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
      raw_response_path: rawPath
    });

    const revisedOutline = this._parseOutline(revisionResult.content, outline.chapters?.length || 5);

    const schemaValidation = SchemaValidator.validateOutline(revisedOutline);
    if (!schemaValidation.valid) {
      const allIssues = [...schemaValidation.errors, ...schemaValidation.warnings];
      console.log(`[Phase2] Revised outline schema invalid: ${allIssues.join(', ')}, retrying`);
      this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
        schema_valid: false,
        error_message: allIssues.join('; '),
        completed_at: new Date().toISOString()
      });
      try {
        await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
          stage: 'schema_validation',
          source: `attemptOutlineRevision_attempt${attemptNumber}`,
          verdict: 'FAIL',
          errors: schemaValidation.errors,
          warnings: schemaValidation.warnings,
          parsedOutline: revisedOutline,
          rawContentPreview: (revisionResult.content || '').substring(0, 2000)
        }, null, 2), 'json');
      } catch (_) {}
      const schemaErrorFeedback = {
        verdict: 'FAIL',
        issues: allIssues,
        suggestions: ['请严格遵循输出格式要求，确保每个章节都有标题和核心事件']
      };
      return this._attemptOutlineRevision(storyId, revisedOutline, schemaErrorFeedback, attemptNumber + 1, parentAttemptId);
    }

    this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
      schema_valid: true
    });

    // 重新验证
    const reValidation = await this._validateOutline(storyId, revisedOutline);

    // PASS_WITH_WARNINGS after revision creates checkpoint for human review
    if (reValidation.verdict === 'PASS_WITH_WARNINGS') {
      this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
        business_valid: true,
        completed_at: new Date().toISOString()
      });

      await this.stateManager.updatePhase2(storyId, {
        outline: revisedOutline,
        status: 'pending_confirmation'
      }, { snapshotType: 'validated' });

      try {
        await this.artifactManager.saveArtifact(storyId, 'outline_approved', JSON.stringify({
          source: `attemptOutlineRevision_attempt${attemptNumber}_pass_with_warnings`,
          validationResult: reValidation,
          outline: revisedOutline,
          chapterCount: revisedOutline.chapters?.length || 0,
          revisionAttempt: attemptNumber
        }, null, 2), 'json');
      } catch (_) {}

      const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
      await this.stateManager.updatePhase2(storyId, {
        checkpointId
      }, { snapshotType: 'validated' });

      const headRow = this.stateManager.repository.getStory(storyId);
      if (headRow) {
        this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
          candidate_snapshot_id: headRow.current_phase2_snapshot_id
        });
      }

      if (parentAttemptId) {
        this.stateManager.repository.updatePhaseAttempt(parentAttemptId, {
          business_valid: true,
          candidate_snapshot_id: headRow ? headRow.current_phase2_snapshot_id : null,
          completed_at: new Date().toISOString()
        });
      }

      return {
        status: 'waiting_checkpoint',
        checkpointId,
        outline: revisedOutline,
        validationResult: reValidation,
        revisionNumber: attemptNumber
      };
    }

    if (reValidation.verdict === 'FAIL') {
      this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
        business_valid: false,
        error_message: `Validation failed: ${reValidation.verdict}`,
        completed_at: new Date().toISOString()
      });
      try {
        await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
          stage: 'logic_validation',
          source: `attemptOutlineRevision_attempt${attemptNumber}_revalidation`,
          verdict: reValidation.verdict,
          blockingIssues: reValidation.blockingIssues || [],
          nonBlockingIssues: reValidation.nonBlockingIssues || [],
          issues: reValidation.issues || [],
          suggestions: reValidation.suggestions || [],
          outline: revisedOutline
        }, null, 2), 'json');
      } catch (_) {}
      return this._attemptOutlineRevision(storyId, revisedOutline, reValidation, attemptNumber + 1, parentAttemptId);
    }

    await this.stateManager.updatePhase2(storyId, {
      outline: revisedOutline,
      status: 'pending_confirmation'
    }, { snapshotType: 'validated' });

    try {
      await this.artifactManager.saveArtifact(storyId, 'outline_approved', JSON.stringify({
        source: `attemptOutlineRevision_attempt${attemptNumber}_pass`,
        validationResult: reValidation,
        outline: revisedOutline,
        chapterCount: revisedOutline.chapters?.length || 0,
        revisionAttempt: attemptNumber
      }, null, 2), 'json');
    } catch (_) {}

    const checkpointId = `cp-outline-${uuidv4().substring(0, 8)}`;
    await this.stateManager.updatePhase2(storyId, {
      checkpointId
    }, { snapshotType: 'validated' });

    const headRow = this.stateManager.repository.getStory(storyId);
    if (headRow) {
      this.stateManager.repository.updatePhaseAttempt(revisionAttemptId, {
        business_valid: true,
        candidate_snapshot_id: headRow.current_phase2_snapshot_id,
        completed_at: new Date().toISOString()
      });
    }

    if (parentAttemptId) {
      this.stateManager.repository.updatePhaseAttempt(parentAttemptId, {
        business_valid: true,
        candidate_snapshot_id: headRow ? headRow.current_phase2_snapshot_id : null,
        completed_at: new Date().toISOString()
      });
    }

    return {
      status: 'waiting_checkpoint',
      checkpointId,
      outline: revisedOutline,
      validationResult: reValidation,
      revisionNumber: attemptNumber
    };
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

    const chapterCount = currentOutline.chapters?.length || 5;
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

=== 输出格式（必须严格遵循，禁止偏离，禁止使用JSON）===

<<<OUTLINE_RESULT开始>>>
章节总数: ${chapterCount}

【Chapter 1】
标题: [精确的章节标题]
核心事件: [一句话描述本章唯一核心事件，不超过25字]
场景:
  1. [场景1]
  2. [场景2]
出场人物:
  1. [人物名] - [角色]
故事功能: [setup | escalation | climax | resolution]

[继续至 Chapter ${chapterCount}]

【关键转折点】
1. [转折描述]

【伏笔与回收计划】
- 伏笔X（第A章埋设）→ 回收于第B章：[回收方式]
<<<OUTLINE_RESULT结束>>>
`;

    const revisionResult = await this.agentDispatcher.delegate('plotArchitect', revisionPrompt, {
      timeoutMs: 300000,
      temporaryContact: true
    });

    // 保存修订版本的 raw response
    await this.artifactManager.saveArtifact(storyId, 'raw_response', revisionResult.content, 'txt');

    const revisedOutline = this._parseOutline(revisionResult.content, currentOutline.chapters?.length || 5);

    // Schema 验证
    const schemaValidation = SchemaValidator.validateOutline(revisedOutline);
    if (!schemaValidation.valid) {
      console.log(`[Phase2] User revision outline schema invalid: ${schemaValidation.errors.join(', ')}`);
      try {
        await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
          stage: 'schema_validation',
          source: 'reviseOutlineWithFeedback',
          verdict: 'FAIL',
          errors: schemaValidation.errors,
          warnings: schemaValidation.warnings,
          parsedOutline: revisedOutline,
          rawContentPreview: (revisionResult.content || '').substring(0, 2000)
        }, null, 2), 'json');
      } catch (_) {}
      return {
        status: 'error',
        error: 'Outline schema invalid after user revision: ' + schemaValidation.errors.join(', ')
      };
    }

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

      let chapterResult;
      try {
        chapterResult = await this._produceChapter(storyId, chapterNum, chapters[i]);
      } catch (err) {
        console.error(`[Phase2] Chapter ${chapterNum} production failed: ${err.message}`);
        try {
          await this.artifactManager.saveArtifact(storyId, 'validation_failure', JSON.stringify({
            stage: 'content_production',
            source: `produceChapter_chapter${chapterNum}`,
            error: err.message,
            stack: err.stack,
            chapterOutline: chapters[i]
          }, null, 2), 'json');
        } catch (_) {}
        chapterResult = {
          status: 'failed',
          error: err.message,
          chapterNum
        };
      }

      chapterResults.push({
        chapterNum,
        ...chapterResult
      });

      if (chapterResult.status === 'completed' || chapterResult.status === 'completed_with_warnings') {
        totalWordCount += chapterResult.wordCount || 0;
      }

      // 保存章节到 state
      await this._saveChapterToState(storyId, chapterNum, chapterResult);

      console.log(`[Phase2] Chapter ${chapterNum} ${chapterResult.status}`);
    }

    const completedChapters = chapterResults.filter(
      r => r.status === 'completed' || r.status === 'completed_with_warnings'
    ).length;

    if (completedChapters === 0) {
      const failedChapters = chapterResults.filter(r => r.status === 'failed');
      const errors = failedChapters.map(r => `Ch${r.chapterNum}: ${r.error}`).join('; ');
      return {
        status: 'error',
        error: `All chapters failed to produce: ${errors}`,
        chapterResults
      };
    }

    const checkpointId = `cp-phase2-content-${storyId}-${Date.now()}`;

    await this.stateManager.updatePhase2(storyId, {
      status: 'content_pending_confirmation',
      checkpointId: checkpointId,
      chapters: chapterResults,
      totalWordCount: totalWordCount
    });

    await this.stateManager.updateStory(storyId, {
      status: 'phase2_content_pending_confirmation'
    });

    return {
      status: 'waiting_checkpoint',
      checkpointType: 'phase2_content_confirmation',
      checkpointId: checkpointId,
      chaptersCompleted: completedChapters,
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

    const targetWordCount = typeof config.targetWordCount === 'number'
      ? { min: Math.floor(config.targetWordCount * 0.8), max: config.targetWordCount }
      : (config.targetWordCount || { min: 2500, max: 3500 });

    // 1. 调用 chapterOperations.createChapterDraft()
    console.log(`[Phase2] Creating draft for chapter ${chapterNum}`);
    let draftResult = await this.chapterOperations.createChapterDraft(storyId, chapterNum, {
      targetWordCount: targetWordCount,
      stylePreference: config.stylePreference
    });
    try {
      await this.artifactManager.saveArtifact(storyId, 'chapter_draft', JSON.stringify({
        chapterNum,
        contentLength: draftResult.content?.length || 0,
        metrics: draftResult.metrics,
        wasExpanded: draftResult.wasExpanded
      }, null, 2), 'json');
    } catch (_) {}

    let content = draftResult.content;
    let metrics = draftResult.metrics;

    // 2. 并行调用 detailFiller Agent 进行细节填充
    console.log(`[Phase2] Filling details for chapter ${chapterNum}`);
    const detailResult = await this.chapterOperations.fillDetails(storyId, chapterNum, content, {
      focusAreas: ['场景', '感官', '情绪', '心理']
    });
    try {
      await this.artifactManager.saveArtifact(storyId, 'chapter_detail', JSON.stringify({
        chapterNum,
        originalLength: content.length,
        detailedLength: detailResult.detailedContent?.length || 0
      }, null, 2), 'json');
    } catch (_) {}

    // 3. 合并内容（简单实现：先用 detailFiller 结果，如果变化不大则保留）
    if (detailResult.detailedContent && detailResult.detailedContent.length > content.length) {
      const detailMetrics = this.chapterOperations.countChapterLength(
        detailResult.detailedContent,
        targetWordCount.min || 2500,
        targetWordCount.max || 3500,
        { lengthPolicy: 'min_only' }
      );

      // 只有 detail 版本也达标才替换
      if (detailMetrics.validation.isQualified) {
        content = detailResult.detailedContent;
        metrics = detailMetrics;
      }
    }

    // 4. 字数检查（不达标则自动扩充）
    const targetMin = targetWordCount.min || 2500;
    const targetMax = targetWordCount.max || 3500;

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
      try {
        await this.artifactManager.saveArtifact(storyId, 'chapter_expand', JSON.stringify({
          chapterNum,
          deficit: metrics.validation.deficit,
          expandedLength: content.length
        }, null, 2), 'json');
      } catch (_) {}

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
      try {
        await this.artifactManager.saveArtifact(storyId, 'chapter_revise', JSON.stringify({
          chapterNum,
          revisedLength: revisionResult.revisedContent?.length || 0,
          changeSummary: revisionResult.changeSummary
        }, null, 2), 'json');
      } catch (_) {}

      if (revisionResult.revisedContent && revisionResult.revisedContent.length > 100) {
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

    if (!content || content.length < 100) {
      return {
        status: 'failed',
        error: 'Chapter content generation failed: output too short or empty',
        content: content || '',
        wordCount: 0,
        metrics,
        validation,
        wasRevised: false,
        revisionAttempts: 0
      };
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
      // 策略1：尝试匹配 "【Chapter N】" 格式（PromptBuilder 输出格式）
      const chapterHeaderRegexCN = /【\s*Chapter\s+(\d+)\s*】/gi;
      const chapterMatchesCN = content.match(chapterHeaderRegexCN) || [];

      if (chapterMatchesCN.length > 0) {
        // 用 【Chapter N】 分割，提取各章节内容
        const sections = content.split(/【\s*Chapter\s+\d+\s*】/i);
        // sections[0] 是第一个 【Chapter】 之前的内容，跳过
        for (let i = 1; i < sections.length && i <= 20; i++) {
          const chapterNum = i;
          const chapterInfo = this._parseChapterSectionStructured(sections[i], chapterNum);
          if (chapterInfo) {
            outline.chapters.push(chapterInfo);
          }
        }
      }

      // 策略2：如果策略1未提取到章节，尝试匹配 "第N章" 格式
      if (outline.chapters.length === 0) {
        const chapterMatchesLegacy = content.match(/第\s*\d+\s*章[^\n]*/gi) || [];

        if (chapterMatchesLegacy.length > 0) {
          const sections = content.split(/第\s*\d+\s*章/);
          for (let i = 1; i < sections.length && i <= 20; i++) {
            const chapterInfo = this._parseChapterSection(sections[i], i);
            if (chapterInfo) {
              outline.chapters.push(chapterInfo);
            }
          }
        }
      }

      // 策略3：尝试从 ```json 代码块中解析 JSON 格式
      if (outline.chapters.length === 0) {
        const jsonParsed = this._tryParseJsonOutline(content);
        if (jsonParsed) {
          outline.chapters = jsonParsed.chapters;
          outline.structure = jsonParsed.structure || outline.structure;
          outline.keyTurningPoints = jsonParsed.keyTurningPoints || outline.keyTurningPoints;
          outline.foreshadowing = jsonParsed.foreshadowing || outline.foreshadowing;
        }
      }

      if (outline.chapters.length === 0) {
        console.warn('[Phase2] _parseOutline: failed to extract any chapters from content, returning empty outline');
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
   * 尝试从内容中提取并解析 JSON 格式的大纲
   * 处理 ```json 代码块包裹的响应以及裸 JSON 对象
   */
  _tryParseJsonOutline(content) {
    let jsonStr = null;

    const codeBlockMatch = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    if (!jsonStr) {
      const braceMatch = content.match(/(\{[\s\S]*"chapters"[\s\S]*\})/);
      if (braceMatch) {
        jsonStr = braceMatch[1];
      }
    }

    if (!jsonStr) return null;

    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed.chapters || !Array.isArray(parsed.chapters) || parsed.chapters.length === 0) {
        return null;
      }

      const normalizedChapters = parsed.chapters.map((ch, idx) => ({
        number: ch.number || ch.chapterNumber || (idx + 1),
        title: ch.title || `第${idx + 1}章`,
        coreEvent: ch.coreEvent || ch.core_event || '',
        scenes: Array.isArray(ch.scenes)
          ? ch.scenes.map(s => typeof s === 'string' ? s : (s.action || s.content || JSON.stringify(s)))
          : [],
        characters: Array.isArray(ch.characters)
          ? ch.characters.map(c => typeof c === 'string' ? c : (c.name || String(c)))
          : [],
        wordCountTarget: ch.wordCountTarget || ch.wordCount || ch.word_count || 2500,
        storyFunction: ch.storyFunction || ch.function || ch['function'] || ''
      }));

      return {
        chapters: normalizedChapters,
        structure: parsed.structure || null,
        keyTurningPoints: parsed.keyTurningPoints || [],
        foreshadowing: parsed.foreshadowing || []
      };
    } catch (e) {
      console.warn('[Phase2] _tryParseJsonOutline: JSON parse failed:', e.message);
      return null;
    }
  }

  /**
   * 解析 【Chapter N】 结构化格式的章节段落
   * 匹配 PromptBuilder.buildOutlinePrompt() 输出的格式：
   *   标题: xxx
   *   核心事件: xxx
   *   场景: ...
   *   出场人物: ...
   *   故事功能: xxx
   */
  _parseChapterSectionStructured(section, chapterNum) {
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
    if (titleMatch) {
      chapter.title = titleMatch[1].trim();
    }

    const eventMatch = section.match(/核心事件[：:]\s*([^\n]+)/i);
    if (eventMatch) {
      chapter.coreEvent = eventMatch[1].trim();
    }

    const sceneBlock = section.match(/场景[：:]\s*\n([\s\S]*?)(?=\n出场人物|\n故事功能|\n【|$)/i);
    if (sceneBlock) {
      chapter.scenes = sceneBlock[1]
        .split('\n')
        .map(line => line.replace(/^\s*\d+\.\s*/, '').trim())
        .filter(s => s.length > 0);
    }

    const charBlock = section.match(/出场人物[：:]\s*\n([\s\S]*?)(?=\n故事功能|\n【|$)/i);
    if (charBlock) {
      chapter.characters = charBlock[1]
        .split('\n')
        .map(line => {
          const clean = line.replace(/^\s*\d+\.\s*/, '').trim();
          const parts = clean.split(/\s*[-–—]\s*/);
          return parts[0].trim();
        })
        .filter(c => c.length > 0);
    }

    const funcMatch = section.match(/故事功能[：:]\s*(setup|escalation|climax|resolution)/i);
    if (funcMatch) {
      chapter.storyFunction = funcMatch[1].toLowerCase();
    }

    return chapter;
  }

  /**
   * 解析单个章节段落（第N章 格式）
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
   * 解析大纲验证结果（支持JSON和文本格式）
   */
  _parseOutlineValidationResult(content) {
    const result = {
      passed: true,
      verdict: 'PASS',
      confidence: 5,
      blockingIssues: [],
      nonBlockingIssues: [],
      issues: [],
      suggestions: [],
      revisionPriorities: []
    };

    // 策略1: 尝试解析JSON格式
    const jsonMatch = content.match(/<<<VALIDATION_RESULT开始>>>([\s\S]*?)<<<VALIDATION_RESULT结束>>>/);
    if (jsonMatch) {
      try {
        const jsonContent = jsonMatch[1].trim();
        const parsed = JSON.parse(jsonContent);
        
        result.verdict = parsed.verdict || 'PASS';
        result.passed = parsed.verdict !== 'FAIL';
        result.confidence = parsed.confidence || 5;
        result.blockingIssues = parsed.blocking_issues || [];
        result.nonBlockingIssues = parsed.non_blocking_issues || [];
        result.revisionPriorities = parsed.revision_priorities || [];
        
        // 向后兼容
        result.issues = [...result.blockingIssues, ...result.nonBlockingIssues];
        result.suggestions = result.revisionPriorities;
        
        console.log('[OutlineValidation] Parsed JSON result:', {
          verdict: result.verdict,
          passed: result.passed,
          blockingCount: result.blockingIssues.length,
          nonBlockingCount: result.nonBlockingIssues.length
        });
        
        return result;
      } catch (e) {
        console.log('[OutlineValidation] JSON parse failed, falling back to text parsing');
      }
    }

    // 策略2: 文本格式回退解析
    const normalized = content.toLowerCase();
    
    // 提取Verdict
    if (content.includes('不通过') || content.includes('失败') || normalized.includes('fail')) {
      result.verdict = 'FAIL';
      result.passed = false;
    } else if (content.includes('有条件通过') || content.includes('警告') || normalized.includes('warning')) {
      result.verdict = 'PASS_WITH_WARNINGS';
      result.passed = true;
    } else if (content.includes('通过') || normalized.includes('pass')) {
      result.verdict = 'PASS';
      result.passed = true;
    }

    // 提取问题（带编号或符号的列表项）
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // 匹配列表项格式：1. xxx, - xxx, * xxx
      if (/^\s*(?:\d+[\.\)]\s+|[-*]\s+)/.test(trimmed)) {
        const cleanLine = trimmed.replace(/^\s*(?:\d+[\.\)]\s+|[-*]\s+)/, '');
        if (cleanLine.length > 5) {
          // 判断是问题还是建议
          if (/(?:问题|冲突|不符|错误|矛盾|失败|阻塞|blocking)/i.test(cleanLine)) {
            result.blockingIssues.push(cleanLine);
          } else if (/(?:建议|修正|改进|优化|增强|warning)/i.test(cleanLine)) {
            result.nonBlockingIssues.push(cleanLine);
          } else {
            // 默认归类为非阻塞问题
            result.nonBlockingIssues.push(cleanLine);
          }
        }
      }
    }

    // 向后兼容
    result.issues = [...result.blockingIssues, ...result.nonBlockingIssues];
    result.suggestions = result.nonBlockingIssues;
    result.revisionPriorities = result.blockingIssues.length > 0 
      ? result.blockingIssues 
      : result.nonBlockingIssues;

    console.log('[OutlineValidation] Parsed text result:', {
      verdict: result.verdict,
      passed: result.passed,
      blockingCount: result.blockingIssues.length,
      nonBlockingCount: result.nonBlockingIssues.length
    });

    return result;
  }
}

module.exports = { Phase2_OutlineDrafting };
