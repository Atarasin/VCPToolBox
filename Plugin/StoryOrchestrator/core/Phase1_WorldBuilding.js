/**
 * Phase1_WorldBuilding - 世界观与人设并行搭建
 * 
 * 职责:
 * 1. 并行运行 world-builder 和 character-designer agents
 * 2. 逻辑校验审查
 * 3. 校验失败时自动修订一次
 * 4. 创建 checkpoint 1
 */

const { AGENT_TYPES } = require('../agents/AgentDefinitions');

class Phase1_WorldBuilding {
  constructor({ stateManager, agentDispatcher, promptBuilder, config }) {
    this.stateManager = stateManager;
    this.agentDispatcher = agentDispatcher;
    this.promptBuilder = promptBuilder;
    this.config = config || {};
    this.maxRevisionAttempts = this.config.MAX_PHASE_ITERATIONS || 2;
  }

  /**
   * 执行 Phase 1 世界观与人设搭建
   * @param {string} storyId - 故事ID
   * @param {Object} options - 选项
   * @returns {Object} 执行结果
   */
  async run(storyId, options = {}) {
    console.log(`[Phase1_WorldBuilding] Starting for story: ${storyId}`);
    
    try {
      // 1. 获取故事配置
      const story = await this.stateManager.getStory(storyId);
      if (!story) {
        return {
          status: 'failed',
          phase: 'phase1',
          nextAction: 'retry',
          checkpointId: null,
          data: { error: 'Story not found' }
        };
      }

      const { storyPrompt, genre, stylePreference, targetWordCount } = story.config;
      const targetWords = targetWordCount || { min: 2500, max: 3500 };

      // 2. 并行执行世界观和人物设计 agents
      const parallelResult = await this._executeParallelAgents({
        storyPrompt,
        genre,
        stylePreference,
        targetWords
      });

      if (parallelResult.status === 'failed') {
        return {
          status: 'failed',
          phase: 'phase1',
          nextAction: 'retry',
          checkpointId: null,
          data: { error: 'Agent execution failed', details: parallelResult.errors }
        };
      }

      const { worldview, characters } = parallelResult;

      // 3. 保存初始结果
      await this.stateManager.updatePhase1(storyId, {
        worldview: worldview.parsed,
        characters: characters.parsed,
        status: 'validating'
      });

      // 4. 记录工作流历史
      await this._appendWorkflowHistory(storyId, {
        step: 'initial_generation',
        worldviewGenerated: true,
        charactersGenerated: true,
        worldviewQuality: worldview.quality,
        charactersQuality: characters.quality
      });

      // 5. 逻辑校验
      const validationResult = await this._validateResults(storyId, worldview.parsed, characters.parsed);

      if (!validationResult.passed) {
        console.log(`[Phase1_WorldBuilding] Initial validation failed, attempting revision`);

        // 6. 修订并重新验证 (最多一次)
        const revisionResult = await this._reviseAndReValidate(
          storyId,
          worldview.parsed,
          characters.parsed,
          validationResult
        );

        if (!revisionResult.success) {
          return {
            status: 'needs_retry',
            phase: 'phase1',
            nextAction: 'retry',
            checkpointId: null,
            data: {
              error: 'Validation failed after revision',
              issues: validationResult.issues,
              revisionAttempts: 1
            }
          };
        }

        // 使用修订后的结果
        const { revisedWorldview, revisedCharacters } = revisionResult;
        await this.stateManager.updatePhase1(storyId, {
          worldview: revisedWorldview,
          characters: revisedCharacters,
          validation: validationResult
        });

        await this._appendWorkflowHistory(storyId, {
          step: 'revision',
          revisionAttempt: 1,
          passed: true
        });
      } else {
        // 校验通过
        await this.stateManager.updatePhase1(storyId, {
          validation: validationResult
        });

        await this._appendWorkflowHistory(storyId, {
          step: 'validation',
          passed: true
        });
      }

      // 7. 创建检查点
      const checkpointId = await this._createCheckpoint(storyId);

      // 8. 更新状态为等待确认
      await this.stateManager.updatePhase1(storyId, {
        status: 'pending_confirmation',
        checkpointId: checkpointId
      });

      await this.stateManager.updateStory(storyId, {
        status: 'phase1_waiting_checkpoint'
      });

      console.log(`[Phase1_WorldBuilding] Completed for story: ${storyId}, checkpoint: ${checkpointId}`);

      return {
        status: 'waiting_checkpoint',
        phase: 'phase1',
        nextAction: 'phase2',
        checkpointId: checkpointId,
        data: {
          worldview: (await this.stateManager.getStory(storyId)).phase1.worldview,
          characters: (await this.stateManager.getStory(storyId)).phase1.characters,
          validation: validationResult
        }
      };

    } catch (error) {
      console.error(`[Phase1_WorldBuilding] Error for story ${storyId}:`, error);
      return {
        status: 'failed',
        phase: 'phase1',
        nextAction: 'retry',
        checkpointId: null,
        data: { error: error.message }
      };
    }
  }

  /**
   * 并行执行世界观和人物设计 agents
   * @param {Object} params - 参数
   * @returns {Object} 执行结果
   */
  async _executeParallelAgents(params) {
    const { storyPrompt, genre, stylePreference, targetWords } = params;

    // 构建提示词
    const worldviewPrompt = this._buildWorldviewPrompt({
      storyPrompt,
      genre,
      stylePreference,
      targetWords
    });

    const charactersPrompt = this._buildCharacterPrompt({
      storyPrompt,
      genre,
      stylePreference,
      targetWords
    });

    // 并行执行
    const results = await this.agentDispatcher.delegateParallel([
      {
        agentType: AGENT_TYPES.WORLD_BUILDER,
        prompt: worldviewPrompt,
        options: {
          timeoutMs: 120000,
          temporaryContact: true
        }
      },
      {
        agentType: AGENT_TYPES.CHARACTER_DESIGNER,
        prompt: charactersPrompt,
        options: {
          timeoutMs: 120000,
          temporaryContact: true
        }
      }
    ]);

    // 检查失败
    if (results.failed.length > 0) {
      return {
        status: 'failed',
        errors: results.failed.map(f => f.error)
      };
    }

    // 解析结果
    const worldviewResult = results.succeeded.find(s => s.agentType === AGENT_TYPES.WORLD_BUILDER);
    const charactersResult = results.succeeded.find(s => s.agentType === AGENT_TYPES.CHARACTER_DESIGNER);

    if (!worldviewResult || !charactersResult) {
      return {
        status: 'failed',
        errors: ['Missing agent results']
      };
    }

    return {
      status: 'success',
      worldview: {
        raw: worldviewResult.result.content,
        parsed: this._parseWorldview(worldviewResult.result.content)
      },
      characters: {
        raw: charactersResult.result.content,
        parsed: this._parseCharacters(charactersResult.result.content)
      }
    };
  }

  /**
   * 构建世界观提示词
   * @param {Object} params - 参数
   * @returns {string} 提示词
   */
  _buildWorldviewPrompt(params) {
    const { storyPrompt, genre, stylePreference, targetWords } = params;

    return `【世界观设定任务】

请基于以下故事梗概，构建一个完整的世界观设定。

=== 故事梗概 ===
${storyPrompt}

=== 题材类型 ===
${genre || '通用'}

=== 文风要求 ===
${stylePreference || '保持叙事流畅，注重逻辑严谨'}

=== 创作参数 ===
目标字数：约 ${targetWords.min}-${targetWords.max} 字

=== 输出要求 ===
请构建包含以下方面的完整世界观：

1. **时代背景与地理环境**
   - 时间设定（时代、年代）
   - 地理环境（地点、空间布局）
   - 社会结构

2. **物理规则与核心设定**
   - 世界运行的基本规则
   - 特殊能力/技术/魔法体系（如有）
   - 限制与代价

3. **势力体系**
   - 主要势力/组织
   - 势力之间的关系
   - 权力结构

4. **关键历史与冲突**
   - 世界形成以来的关键事件
   - 核心矛盾与冲突源
   - 隐藏的秘密/伏笔

5. **场景规范**
   - 故事发生的主要场景
   - 场景氛围与视觉规范

请以JSON格式输出，结构如下：
{
  "setting": "时代背景与地理环境描述",
  "rules": {
    "physical": "物理规则描述",
    "special": "特殊设定描述（如有）",
    "limitations": "限制与代价描述"
  },
  "factions": [
    {
      "name": "势力名称",
      "description": "势力描述",
      "relationships": ["与其他势力的关系"]
    }
  ],
  "history": {
    "keyEvents": ["关键历史事件"],
    "coreConflicts": ["核心矛盾"]
  },
  "sceneNorms": ["场景规范列表"],
  "secrets": ["隐藏秘密/伏笔"]
}`;
  }

  /**
   * 构建人物提示词
   * @param {Object} params - 参数
   * @returns {string} 提示词
   */
  _buildCharacterPrompt(params) {
    const { storyPrompt, genre, stylePreference, targetWords } = params;

    return `【人物塑造任务】

请基于以下故事梗概，构建详细的人物档案。

=== 故事梗概 ===
${storyPrompt}

=== 题材类型 ===
${genre || '通用'}

=== 文风要求 ===
${stylePreference || '保持叙事流畅，注重人物刻画'}

=== 创作参数 ===
目标字数：约 ${targetWords.min}-${targetWords.max} 字

=== 输出要求 ===
请构建包含以下方面的完整人物档案：

1. **主要人物**（2-4人）
   - 姓名与身份
   - 外貌特征
   - 性格特质（MBTI/核心关键词）
   - 背景故事
   - 核心动机与目标
   - 内在矛盾/挣扎
   - 成长弧线

2. **配角**（根据需要）
   - 姓名与身份
   - 与主要人物的关系
   - 功能定位（导师/对手/盟友等）

3. **人物关系网络**
   - 人物之间的直接关系
   - 隐藏关系/秘密联系
   - 关系发展线索

4. **OOC防护规则**
   - 每个角色的行为边界
   - 角色不会做的事
   - 一致性维护要点

请以JSON格式输出，结构如下：
{
  "protagonists": [
    {
      "name": "人物姓名",
      "identity": "身份描述",
      "appearance": "外貌特征",
      "personality": ["性格关键词"],
      "background": "背景故事",
      "motivation": "核心动机",
      "innerConflict": "内在矛盾",
      "growthArc": "成长弧线"
    }
  ],
  "supportingCharacters": [
    {
      "name": "配角姓名",
      "identity": "身份描述", 
      "role": "功能定位",
      "relationship": "与主角的关系"
    }
  ],
  "relationshipNetwork": {
    "direct": [{"from": "人物A", "to": "人物B", "type": "关系类型"}],
    "hidden": [{"from": "人物A", "to": "人物B", "secret": "隐藏关系"}]
  },
  "oocRules": {
    "角色名": ["行为边界描述"]
  }
}`;
  }

  /**
   * 解析世界观结果
   * @param {string} content - 原始输出
   * @returns {Object} 解析后的世界观
   */
  _parseWorldview(content) {
    try {
      const parsed = this._extractStructuredJson(content);
      if (parsed) {
        return parsed;
      }
    } catch (e) {
      console.warn('[Phase1_WorldBuilding] Failed to parse worldview JSON:', e.message);
    }

    // 返回原始内容作为setting
    return {
      setting: content,
      raw: content
    };
  }

  /**
   * 解析人物结果
   * @param {string} content - 原始输出
   * @returns {Object} 解析后的人物列表
   */
  _parseCharacters(content) {
    try {
      const parsed = this._extractStructuredJson(content);
      if (parsed) {
        return parsed;
      }
    } catch (e) {
      console.warn('[Phase1_WorldBuilding] Failed to parse characters JSON:', e.message);
    }

    // 返回原始内容
    return {
      characters: content,
      raw: content
    };
  }

  _extractStructuredJson(content) {
    if (!content || typeof content !== 'string') {
      return null;
    }

    const startIndex = content.indexOf('{');
    if (startIndex === -1) {
      return null;
    }

    const candidate = content.slice(startIndex).trim();

    try {
      return JSON.parse(candidate);
    } catch (error) {
      const repaired = this._repairTruncatedJson(candidate);
      if (repaired) {
        try {
          return JSON.parse(repaired);
        } catch (repairError) {
          console.warn('[Phase1_WorldBuilding] Failed to repair JSON output:', repairError.message);
        }
      }
    }

    const endIndex = content.lastIndexOf('}');
    if (endIndex > startIndex) {
      const boundedCandidate = content.slice(startIndex, endIndex + 1);
      try {
        return JSON.parse(boundedCandidate);
      } catch (boundedError) {
        const repaired = this._repairTruncatedJson(boundedCandidate);
        if (repaired) {
          try {
            return JSON.parse(repaired);
          } catch (repairError) {
            console.warn('[Phase1_WorldBuilding] Failed to repair bounded JSON output:', repairError.message);
          }
        }
      }
    }

    return null;
  }

  _repairTruncatedJson(input) {
    if (!input || typeof input !== 'string') {
      return null;
    }

    let result = '';
    let inString = false;
    let escaped = false;
    let squareDepth = 0;
    let braceDepth = 0;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      result += char;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === '{') braceDepth++;
      if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      if (char === '[') squareDepth++;
      if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
    }

    result = result.replace(/,\s*$/, '');

    if (inString) {
      result += '"';
    }

    while (squareDepth > 0) {
      result = result.replace(/,\s*$/, '');
      result += ']';
      squareDepth--;
    }

    while (braceDepth > 0) {
      result = result.replace(/,\s*$/, '');
      result += '}';
      braceDepth--;
    }

    result = result.replace(/,\s*([}\]])/g, '$1');
    return result;
  }

  /**
   * 验证世界观和人物的一致性
   * @param {string} storyId - 故事ID
   * @param {Object} worldview - 世界观
   * @param {Object} characters - 人物
   * @returns {Object} 验证结果
   */
  async _validateResults(storyId, worldview, characters) {
    const validationPrompt = `【世界观与人设一致性验证】

请对生成的世界观和人物档案进行严格的一致性审查。

=== 世界观 ===
${JSON.stringify(worldview, null, 2)}

=== 人物档案 ===
${JSON.stringify(characters, null, 2)}

=== 审查维度 ===

**世界观一致性**:
1. 物理规则是否自洽
2. 势力体系是否完整且无冲突
3. 历史事件与当前设定是否一致
4. 场景规范是否合理

**人物一致性**:
1. 人物动机是否与世界观的设定匹配
2. 人物能力是否受世界观规则约束
3. 人物关系是否符合势力体系
4. 是否有OOC风险

**整体一致性**:
1. 世界观与故事类型是否匹配
2. 人物数量与故事规模是否适配
3. 是否存在明显的逻辑漏洞

=== 输出格式 ===
【验证结论】
通过 / 有条件通过 / 不通过

【发现的问题】（如有）
- 问题描述（严重度：关键/重要/轻微）

【修正建议】（如有）
- 建议描述`;
    try {
      const result = await this.agentDispatcher.delegate(
        AGENT_TYPES.LOGIC_VALIDATOR,
        validationPrompt,
        {
          timeoutMs: 90000,
          temporaryContact: true
        }
      );

      return this._parseValidationResult(result.content);
    } catch (error) {
      console.error('[Phase1_WorldBuilding] Validation error:', error);
      return {
        passed: false,
        issues: [{ description: `验证过程出错: ${error.message}`, severity: 'critical' }],
        suggestions: ['请检查Agent服务是否正常运行'],
        rawReport: ''
      };
    }
  }

  /**
   * 解析验证结果
   * @param {string} content - 原始输出
   * @returns {Object} 解析后的验证结果
   */
  _parseValidationResult(content) {
    const result = {
      passed: true,
      hasWarnings: false,
      issues: [],
      suggestions: [],
      rawReport: content
    };

    // 检查是否通过
    if (content.includes('不通过') || content.includes('失败')) {
      result.passed = false;
    } else if (content.includes('有条件通过') || content.includes('警告')) {
      result.hasWarnings = true;
    }

    // 提取问题
    const issueMatches = content.match(/[-*•]\s*([^\n]*(?:问题|冲突|矛盾|不符|错误)[^\n]*)/gi) || [];
    result.issues = issueMatches
      .map(line => line.replace(/^[-*•]\s*/, '').trim())
      .filter(line => line.length > 5)
      .map(issue => ({
        description: issue,
        severity: this._determineSeverity(issue)
      }));

    // 提取建议
    const suggestionMatches = content.match(/[-*•]\s*([^\n]*(?:建议|修正|改进|调整)[^\n]*)/gi) || [];
    result.suggestions = suggestionMatches
      .map(line => line.replace(/^[-*•]\s*/, '').trim())
      .filter(line => line.length > 5);

    return result;
  }

  /**
   * 确定问题严重度
   * @param {string} issue - 问题描述
   * @returns {string} 严重度
   */
  _determineSeverity(issue) {
    const lower = issue.toLowerCase();
    if (lower.includes('严重') || lower.includes('关键') || lower.includes('致命')) {
      return 'critical';
    }
    if (lower.includes('重要') || lower.includes('较大')) {
      return 'major';
    }
    return 'minor';
  }

  /**
   * 修订并重新验证
   * @param {string} storyId - 故事ID
   * @param {Object} worldview - 当前世界观
   * @param {Object} characters - 当前人物
   * @param {Object} validationResult - 验证结果
   * @returns {Object} 修订结果
   */
  async _reviseAndReValidate(storyId, worldview, characters, validationResult) {
    console.log(`[Phase1_WorldBuilding] Starting revision with issues:`, validationResult.issues);

    // 构建修订提示词
    const revisionPrompt = `【世界观与人设修订任务】

请根据验证反馈修订以下世界观和人物档案。

=== 当前世界观 ===
${JSON.stringify(worldview, null, 2)}

=== 当前人物档案 ===
${JSON.stringify(characters, null, 2)}

=== 验证反馈 ===
问题清单：
${validationResult.issues.map((i, idx) => `${idx + 1}. ${i.description} (${i.severity})`).join('\n')}

修正建议：
${validationResult.suggestions.map((s, idx) => `${idx + 1}. ${s}`).join('\n')}

=== 修订要求 ===
1. 解决所有关键(critical)和重要(major)问题
2. 保持已通过部分的完整性
3. 确保修订后各部分相互自洽
4. 输出完整的修订后内容（不仅是修改的部分）

=== 输出格式 ===
请输出修订后的完整内容，使用相同的JSON结构`;
    
    try {
      // 并行重新调用两个 agents 进行修订
      const revisionResults = await this.agentDispatcher.delegateParallel([
        {
          agentType: AGENT_TYPES.WORLD_BUILDER,
          prompt: `【世界观修订】\n\n${revisionPrompt}\n\n只输出世界观部分的修订结果。`,
          options: { timeoutMs: 90000, temporaryContact: true }
        },
        {
          agentType: AGENT_TYPES.CHARACTER_DESIGNER,
          prompt: `【人物档案修订】\n\n${revisionPrompt}\n\n只输出人物档案部分的修订结果。`,
          options: { timeoutMs: 90000, temporaryContact: true }
        }
      ]);

      // 检查失败
      if (revisionResults.failed.length > 0) {
        return {
          success: false,
          error: 'Revision agents failed'
        };
      }

      const worldviewResult = revisionResults.succeeded.find(s => s.agentType === AGENT_TYPES.WORLD_BUILDER);
      const charactersResult = revisionResults.succeeded.find(s => s.agentType === AGENT_TYPES.CHARACTER_DESIGNER);

      const revisedWorldview = this._parseWorldview(worldviewResult.result.content);
      const revisedCharacters = this._parseCharacters(charactersResult.result.content);

      // 重新验证
      const reValidationResult = await this._validateResults(storyId, revisedWorldview, revisedCharacters);

      if (!reValidationResult.passed) {
        return {
          success: false,
          error: 'Re-validation failed',
          issues: reValidationResult.issues
        };
      }

      return {
        success: true,
        revisedWorldview,
        revisedCharacters,
        reValidationResult
      };

    } catch (error) {
      console.error('[Phase1_WorldBuilding] Revision error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 创建检查点
   * @param {string} storyId - 故事ID
   * @returns {string} 检查点ID
   */
  async _createCheckpoint(storyId) {
    const checkpointId = `cp-phase1-${storyId}-${Date.now()}`;
    
    // 使用 stateManager 的 setActiveCheckpoint 方法（如果存在）
    if (this.stateManager.setActiveCheckpoint) {
      await this.stateManager.setActiveCheckpoint(storyId, {
        type: 'worldview_confirmation',
        checkpointId,
        phase: 'phase1',
        createdAt: new Date().toISOString()
      });
    } else {
      // 降级：直接更新状态
      await this.stateManager.updatePhase1(storyId, {
        checkpointId
      });
    }

    return checkpointId;
  }

  /**
   * 追加工作流历史记录
   * @param {string} storyId - 故事ID
   * @param {Object} entry - 历史条目
   */
  async _appendWorkflowHistory(storyId, entry) {
    const timestamp = new Date().toISOString();
    
    if (this.stateManager.appendWorkflowHistory) {
      await this.stateManager.appendWorkflowHistory(storyId, {
        ...entry,
        timestamp,
        phase: 'phase1'
      });
    }
  }
}

module.exports = { Phase1_WorldBuilding };
