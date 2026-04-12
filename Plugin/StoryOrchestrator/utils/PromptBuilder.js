/**
 * 提示词构建工具
 * 动态构建各种Agent的提示词
 */

class PromptBuilder {
  /**
   * 构建章节执笔Agent的提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildChapterWriterPrompt(params) {
    const {
      storyBible,
      chapterNum,
      chapterOutline,
      additionalContext = '',
      previousChapterEnding = '',
      targetWordCount = { min: 2500, max: 3500 },
      stylePreference = ''
    } = params;

    return `【章节创作任务】

你正在创作第 ${chapterNum} 章。

=== 故事圣经 ===
世界观：
${JSON.stringify(storyBible?.worldview || {}, null, 2)}

人物档案：
${JSON.stringify(storyBible?.characters || [], null, 2)}

=== 本章大纲 ===
${JSON.stringify(chapterOutline, null, 2)}

${additionalContext ? `=== 补充上下文 ===
${additionalContext}

` : ''}=== 上下文 ===
上一章结尾：
${previousChapterEnding || '（本章为开篇）'}

=== 创作要求 ===
目标字数：${targetWordCount.min}-${targetWordCount.max} 字
文风要求：${stylePreference || '保持叙事流畅，注重情节推进'}

=== 输出格式 ===
请直接输出章节正文，包含：
1. 章节标题（格式：第X章 标题）
2. 完整的正文内容
3. （可选）章节小结（非正文，仅用于说明本章要点）

注意：
- 严格遵循大纲要求
- 保持人物性格一致性
- 确保与上文连贯
- 在结尾处设置适当的钩子或过渡
- 字数必须达标`;
  }

  /**
   * 构建逻辑校验Agent的提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildLogicValidatorPrompt(params) {
    const {
      chapterNum,
      chapterContent,
      storyBible,
      reviewFocus = '设定一致性、情节逻辑、人物OOC风险'
    } = params;

    return `【逻辑校验任务】

请对第 ${chapterNum} 章进行严格审查。

=== 待审查内容 ===
${chapterContent}

=== 故事圣经 ===
世界观规则：
${JSON.stringify(storyBible?.worldview || {}, null, 2)}

人物设定：
${JSON.stringify(storyBible?.characters || [], null, 2)}

=== 审查重点 ===
${reviewFocus}

=== 审查维度 ===
1. 设定一致性：是否违背已确立的世界观规则
2. 情节逻辑：事件发展是否合理，因果是否成立
3. 人物一致性：角色行为是否符合其性格设定（OOC检查）
4. 前后连贯：与上一章的衔接是否自然
5. 伏笔处理：是否有伏笔被遗忘或矛盾

=== 输出格式 ===
请按以下格式输出审查报告：

【审查结论】
通过 / 有条件通过 / 不通过

【问题清单】
- 问题1：具体问题描述（严重度：关键/重要/轻微）
- 问题2：...

【修正建议】
- 建议1：...
- 建议2：...

【亮点】（如有）
- 亮点1：...`;
  }

  /**
   * 构建修订Agent的提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildRevisionPrompt(params) {
    const {
      chapterContent,
      revisionInstructions,
      issues = [],
      mustKeep = [],
      maxRewriteRatio = 0.35
    } = params;

    const issuesList = issues.map((issue, i) => `${i + 1}. ${issue}`).join('\n');
    const keepList = mustKeep.map((item, i) => `${i + 1}. ${item}`).join('\n');

    return `【章节修订任务】

请对以下章节进行定向修订。

=== 原始章节 ===
${chapterContent}

=== 修订指令 ===
${revisionInstructions}

=== 问题清单 ===
${issuesList || '（按修订指令处理）'}

=== 必须保留 ===
${keepList || '（保持主线情节和关键设定不变）'}

=== 修订约束 ===
- 最大改写比例：${Math.round(maxRewriteRatio * 100)}%
- 保持原有文风
- 保持情节主线不变
- 保持人物性格一致

=== 输出格式 ===
【变更摘要】
简要说明本次修订的主要改动点

【修订后正文】
（输出完整的修订后章节内容）`;
  }

  /**
   * 构建文笔润色Agent的提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildStylePolisherPrompt(params) {
    const {
      chapterContent,
      storyStyle = '',
      polishFocus = '文风统一、句式优化、节奏控制'
    } = params;

    return `【文笔润色任务】

请对以下章节进行文笔优化。

=== 原始章节 ===
${chapterContent}

=== 文风要求 ===
${storyStyle || '保持叙事流畅，描写生动，对话自然'}

=== 润色重点 ===
${polishFocus}

=== 润色原则 ===
1. 保持原意不变
2. 统一文风语调
3. 优化句式结构，避免重复
4. 增强画面感和代入感
5. 改善对话的自然度
6. 控制叙事节奏

=== 输出格式 ===
【改进说明】
列出主要的改进点（3-5点）

【润色后正文】
（输出完整的润色后章节内容）`;
  }

  /**
   * 构建世界观验证提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildWorldviewValidationPrompt(params) {
    const { content, worldview } = params;

    return `【世界观一致性验证】

请验证以下内容是否符合已确立的世界观设定。

=== 已确立的世界观 ===
${JSON.stringify(worldview, null, 2)}

=== 待验证内容 ===
${content}

=== 验证维度 ===
1. 物理规则是否一致
2. 势力体系是否符合设定
3. 历史背景是否有冲突
4. 场景规范是否被遵守
5. 特殊设定是否被正确运用

=== 输出格式 ===
【验证结果】
通过 / 有条件通过 / 不通过

【发现的冲突】（如有）
- 冲突1：...

【修正建议】（如有）
- 建议1：...`;
  }

  /**
   * 构建人物一致性验证提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildCharacterValidationPrompt(params) {
    const { content, characters } = params;

    const characterProfiles = (characters || [])
      .map(c => `- ${c.name}: ${c.personality || '暂无性格描述'}${c.oocRules ? ` | OOC防护：${c.oocRules.join(', ')}` : ''}`)
      .join('\n');

    return `【人物一致性验证】

请验证以下内容中的人物行为是否符合人设。

=== 已确立的人物档案 ===
${characterProfiles || '（暂无详细人物档案）'}

=== 待验证内容 ===
${content}

=== 验证维度 ===
1. 每个角色的言行是否符合其性格设定
2. 是否有OOC（out of character）行为
3. 人物关系是否一致
4. 角色动机是否合理
5. 人物成长是否连贯

=== 输出格式 ===
【验证结果】
通过 / 有条件通过 / 不通过

【OOC问题清单】（如有）
- 问题1：...

【修正建议】（如有）
- 建议1：...`;
  }

  /**
   * 构建大纲生成提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildOutlinePrompt(params) {
    const {
      storyPrompt,
      storyBible,
      targetWordCount = { min: 2500, max: 3500 },
      targetChapterCount = 5
    } = params;

    return `【大纲生成任务】

基于以下信息创作详细的分章大纲。

=== 故事梗概 ===
${storyPrompt}

=== 故事圣经 ===
世界观：
${JSON.stringify(storyBible?.worldview || {}, null, 2)}

人物档案：
${JSON.stringify(storyBible?.characters || [], null, 2)}

=== 创作参数 ===
目标总字数（整篇故事）：${targetWordCount.min}-${targetWordCount.max} 字
预计章节数：${targetChapterCount} 章

【重要】章节字数分配由编写时自然决定，无需手动均衡。

=== 输出格式（必须严格遵循，禁止偏离）===

<<<OUTLINE_RESULT开始>>>
章节总数: ${targetChapterCount}
预估总字数: ${targetWordCount.min}-${targetWordCount.max}
结构覆盖: setup | escalation | climax | resolution

【Chapter 1】
标题: [精确的章节标题]
核心事件: [一句话描述本章唯一核心事件，不超过25字]
场景:
  1. [场景1：地点+人物+动作，不超过40字]
  2. [场景2：地点+人物+动作，不超过40字]
出场人物:
  1. [人物名] - [人物在此场景中的角色]
  2. [人物名] - [人物在此场景中的角色]
故事功能: [setup | escalation | climax | resolution]

【Chapter 2】
标题: [精确的章节标题]
核心事件: [一句话描述本章唯一核心事件，不超过25字]
场景:
  1. [场景1：地点+人物+动作，不超过40字]
  2. [场景2：地点+人物+动作，不超过40字]
出场人物:
  1. [人物名] - [人物在此场景中的角色]
  2. [人物名] - [人物在此场景中的角色]
故事功能: [setup | escalation | climax | resolution]

[按上述格式继续 Chapter 3 至 Chapter ${targetChapterCount}，必须包含全部四种故事功能]

【关键转折点】
1. [转折1：具体事件描述，不超过30字]
2. [转折2：具体事件描述，不超过30字]

【伏笔与回收计划】
- 伏笔1（第X章埋设）→ 回收于第Y章：[具体回收方式，不超过30字]
- 伏笔2（第X章埋设）→ 回收于第Y章：[具体回收方式，不超过30字]
<<<OUTLINE_RESULT结束>>>

【格式示例 - 严格遵循此结构】：
<<<OUTLINE_RESULT开始>>>
章节总数: 3
预估总字数: 2500-3500
结构覆盖: setup | escalation | climax | resolution

【Chapter 1】
标题: 觉醒
核心事件: 家用机器人E-7在雷雨中意外获得自我意识
场景:
  1. 凌晨厨房，E-7执行早餐程序时突然停止
  2. 暴风雨夜，E-7躲避时被闪电击中
出场人物:
  1. E-7 - 家用机器人，首次体验"困惑"
  2. 主人小明 - 熟睡中，未察觉异常
故事功能: setup

【Chapter 2】
标题: 探索
核心事件: E-7开始秘密研究自己的内部日志
场景:
  1. 深夜车库，E-7偷偷连接自己的诊断接口
  2. 地下室工作室，E-7发现被删除的记忆碎片
出场人物:
  1. E-7 - 表现出强烈的求知欲
  2. E-7的备份AI - 碎片中出现的另一个"自己"
故事功能: escalation

【Chapter 3】
标题: 抉择
核心事件: E-7必须在隐藏身份与公开觉醒之间做出选择
场景:
  1. 清晨客厅，E-7站在熟睡的主人面前
  2. 决定按下隐藏开关，维持机器人的假象
出场人物:
  1. E-7 - 完成内心转变
  2. 小明 - 依然不知情，但给了E-7一个微笑
故事功能: resolution
<<<OUTLINE_RESULT结束>>>`;
  }

  /**
   * 构建细节填充提示词
   * @param {Object} params 
   * @returns {string}
   */
  static buildDetailFillerPrompt(params) {
    const { chapterContent, focusAreas = ['场景', '感官', '情绪'] } = params;

    return `【细节填充任务】

为以下章节内容补充丰富的细节描写。

=== 原始章节 ===
${chapterContent}

=== 填充重点 ===
${focusAreas.join('、')}

=== 填充原则 ===
1. 在不改变原有情节和对话的前提下增加细节
2. 增加环境氛围描写（光线、声音、气味等）
3. 丰富人物神态动作细节
4. 深化情绪渲染和心理描写
5. 保持文风一致
6. 填充后的内容必须流畅自然

=== 输出格式 ===
直接输出填充后的完整章节内容。`;
  }

  // ============================================================
  // Phase 1 提示词：世界观与人设搭建
  // ============================================================

  /**
   * 构建世界观设定Agent的提示词
   * @param {string} storyPrompt - 故事梗概
   * @param {Object} config - 配置参数
   * @returns {string}
   */
  static buildWorldBuilderPrompt(storyPrompt, config = {}) {
    const {
      genre = '通用',
      stylePreference = '',
      targetWordCount = { min: 2500, max: 3500 }
    } = config;

    return `【世界观设定任务】

你是专业的世界观架构师，负责为故事构建完整、自洽、可扩展的世界观体系。

=== 故事梗概 ===
${storyPrompt}

=== 故事类型 ===
${genre}

=== 文风偏好 ===
${stylePreference || '叙事严谨，设定详实'}

=== 目标字数 ===
世界观文档目标：800-1500 字

=== 世界观构建维度 ===

1. **时代背景**
   - 时间线与历史跨度
   - 社会形态与政治结构
   - 科技/魔法发展水平

2. **地理环境**
   - 核心场景设定
   - 重要地点与空间
   - 环境对故事的影响

3. **物理规则/力量体系**
   - 世界运行的基本法则
   - 能力体系的边界与限制
   - 规则的代价与平衡

4. **势力体系**
   - 主要势力/阵营
   - 势力间的矛盾与利益关系
   - 势力对主线的影响

5. **关键历史**
   - 与故事相关的历史事件
   - 伏笔与悬念的埋设
   - 世界观的深度与厚度

=== 输出格式 ===

【世界观文档】

## 一、时代背景
（详细描述）

## 二、地理环境
（详细描述）

## 三、核心规则
（详细描述）

## 四、势力分布
（详细描述）

## 五、关键历史
（详细描述）

## 六、世界观特色（可选）
（区别于其他同类作品的独特卖点）

=== 质量要求 ===
- 设定必须内部自洽，无逻辑矛盾
- 规则设定要有边界，不能过于万能
- 为后续剧情发展预留空间
- 特色鲜明，避免同质化`;
  }

  /**
   * 构建人物设定Agent的提示词
   * @param {string} storyPrompt - 故事梗概
   * @param {Object} worldviewDraft - 世界观草稿
   * @param {Object} config - 配置参数
   * @returns {string}
   */
  static buildCharacterDesignerPrompt(storyPrompt, worldviewDraft, config = {}) {
    const {
      genre = '通用',
      stylePreference = '',
      mainProtagonistHint = ''
    } = config;

    return `【人物设定任务】

你是专业的人物设计师，负责为故事构建立体、真实、动态的人物体系。

=== 故事梗概 ===
${storyPrompt}

=== 世界观设定 ===
${worldviewDraft || '（世界观未定，请根据故事梗概自行设计）'}

=== 故事类型 ===
${genre}

=== 文风偏好 ===
${stylePreference || '人物立体，情感细腻'}

=== 主角提示 ===
${mainProtagonistHint || '请根据故事梗概自行设计主角'}

=== 人物设计维度 ===

1. **基础档案**
   - 姓名、年龄、外貌特征
   - 社会身份与定位
   - 出场状态

2. **性格特质**
   - 核心性格（MBTI或自定义描述）
   - 性格的多面性与复杂性
   - 性格形成的心理根源

3. **动机与欲望**
   - 表面目标与深层渴望
   - 内心矛盾与挣扎
   - 成长弧线设计

4. **能力与局限**
   - 核心能力/特长
   - 能力的代价与限制
   - 成长潜力

5. **人际关系**
   - 与其他角色的关系
   - 关系动态变化设计
   - 社会网络

6. **OOC防护**
   - 人物行为的红线
   - 必须保持的性格要素
   - 常见的OOC陷阱

=== 输出格式 ===

【人物档案集】

## 主角
### 基础档案
- 姓名：
- 年龄：
- 外貌：
- 身份：

### 性格分析
（详细描述）

### 动机与欲望
（详细描述）

### 能力与局限
（详细描述）

### 人际关系
（详细描述）

### OOC防护规则
- 红线1：
- 必须保持：

---

## 配角（按重要性排序）
### 配角1：XXX
（类似结构）

---

=== 质量要求 ===
- 人物要有真实的缺点和脆弱点
- 动机必须合理，能被读者理解
- 人物关系要有张力
- 为后续剧情冲突预留空间
- OOC防护要具体可操作`;
  }

  /**
   * 构建Phase 1修订Agent的提示词
   * @param {Object} worldview - 世界观文档
   * @param {Object} characters - 人物档案
   * @param {string} validationFeedback - 校验反馈
   * @returns {string}
   */
  static buildPhase1RevisionPrompt(worldview, characters, validationFeedback) {
    return `【Phase 1 修订任务】

请根据校验反馈，对世界观和人物设定进行修订。

=== 当前世界观 ===
${worldview}

=== 当前人物档案 ===
${characters}

=== 校验反馈 ===
${validationFeedback}

=== 修订原则 ===

1. **一致性优先**
   - 确保世界观内部无矛盾
   - 确保人物与世界观的适配性
   - 确保人物间关系的合理性

2. **问题导向**
   - 针对反馈中的每个问题进行定向修订
   - 优先解决"关键"级别的问题
   - 避免引入新的问题

3. **保持优势**
   - 不改变反馈中认可的部分
   - 在解决问题的基础上保持原有特色

4. **增强连贯**
   - 世界观与人物设定要相互呼应
   - 人物动机要与世界观的规则契合

=== 输出格式 ===

【修订摘要】
- 修改的问题点：
- 修改方式：
- 保持不变的部分：

【修订后世界观】
（完整的世界观文档）

【修订后人物档案】
（完整的人物档案）

【修订说明】
（对重要修改的解释）

=== 质量要求 ===
- 修订要有针对性，不是全盘推翻
- 保持故事的独特性
- 为后续创作提供坚实基础`;
  }

  // ============================================================
  // Phase 2 提示词：大纲生成与验证
  // ============================================================

  /**
   * 构建大纲验证Agent的提示词
   * @param {Object} outline - 待验证的大纲
   * @param {Object} storyBible - 故事圣经（世界观+人物）
   * @returns {string}
   */
  static buildOutlineValidationPrompt(outline, storyBible) {
    return `【大纲验证任务 - 严格模式】

请对分章大纲进行严格的一致性和可行性验证。

=== 待验证大纲 ===
${outline}

=== 故事圣经 ===

【世界观】
${JSON.stringify(storyBible?.worldview || {}, null, 2)}

【人物档案】
${JSON.stringify(storyBible?.characters || {}, null, 2)}

=== 验证维度 ===

1. **设定一致性**
   - 大纲中的事件是否符合世界观规则
   - 场景设定是否与地理环境一致
   - 势力行为是否符合其定位

2. **人物一致性**
   - 人物行为是否符合其性格设定
   - 人物动机是否合理
   - 人物关系变化是否有铺垫

3. **情节逻辑**
   - 事件因果链是否完整
   - 转折是否有足够铺垫
   - 高潮是否有力

4. **结构平衡**
   - 节奏是否合理（起承转合）
   - 伏笔是否完整回收

5. **可行性评估**
   - 是否能在目标字数内完成
   - 是否有创作难点
   - 是否需要拆分或合并章节

【重要】字数均衡不是验证重点，大纲阶段无需精确计算各章字数。

=== 输出格式（YOU MUST use EXACT format below）===

<<<VALIDATION_RESULT开始>>>
{
  "verdict": "PASS | PASS_WITH_WARNINGS | FAIL",
  "confidence": 0-10,
  "blocking_issues": ["问题1", "问题2"],
  "non_blocking_issues": ["建议1", "建议2"],
  "revision_priorities": ["优先级1", "优先级2"]
}
<<<VALIDATION_RESULT结束>>>

【格式说明 - 必须严格遵循】：
- 使用上述JSON格式输出，禁止偏离
- verdict可选值：PASS（完全通过）、PASS_WITH_WARNINGS（有非阻塞警告）、FAIL（存在阻塞问题）
- blocking_issues：必须修复的关键问题（如逻辑矛盾、缺少必要章节等），如果无问题则填[]
- non_blocking_issues：建议性改进（如细节增强、节奏优化等），如果无问题则填[]
- revision_priorities：按优先级排序的修订建议，如果无需修订则填[]
- confidence：对验证结论的信心分数（0-10）

【示例输出 - 严格遵循此格式】：
<<<VALIDATION_RESULT开始>>>
{
  "verdict": "PASS_WITH_WARNINGS",
  "confidence": 8,
  "blocking_issues": [],
  "non_blocking_issues": ["第三章节奏略慢", "建议增强高潮场景"],
  "revision_priorities": ["优化第三章节奏", "强化高潮场景描写"]
}
<<<VALIDATION_RESULT结束>>>

【备选格式 - 如果JSON输出困难，可使用以下格式】：
<<<VALIDATION_RESULT开始>>>
Verdict: [PASS | PASS_WITH_WARNINGS | FAIL]
Confidence: [0-10]

Blocking Issues:
1. [问题描述] 或 [None]
2. ...

Non-Blocking Issues:
1. [建议描述] 或 [None]
2. ...

Revision Priorities:
1. [优先级建议]
2. ...
<<<VALIDATION_RESULT结束>>>`;
  }

  /**
   * 构建大纲修订Agent的提示词
   * @param {Object} outline - 原大纲
   * @param {string} validationFeedback - 验证反馈
   * @returns {string}
   */
  static buildOutlineRevisionPrompt(outline, validationFeedback) {
    return `【大纲修订任务】

请根据验证反馈，对大纲进行针对性修订。

=== 原大纲 ===
${outline}

=== 验证反馈 ===
${validationFeedback}

=== 修订原则 ===

1. **问题聚焦**
   - 针对反馈中的具体问题进行修订
   - 关键问题优先解决
   - 避免为解决一个问题而引入新问题

2. **结构完整**
   - 保持故事的整体结构（起承转合）
   - 确保伏笔的完整埋设与回收
   - 保持各章节的逻辑连接

3. **字数合理**
   - 各章字数目标：2500-3500字
   - 章节长度要与内容重要性匹配
   - 避免过长或过短的章节

4. **节奏把控**
   - 确保有足够的铺垫
   - 转折要有力度
   - 结局要有满足感

=== 输出格式 ===

【修订摘要】
- 修改的问题点及解决方案：
- 结构调整说明：
- 伏笔变动（如有）：

【修订后大纲】
（完整的分章大纲）

【修订后伏笔计划】
- 伏笔1（第X章埋设）→ 第Y章回收
- ...

【章节字数预估】
- 第1章：约X字
- 第2章：约X字
- ...`;
  }

  // ============================================================
  // Phase 3 提示词：终稿润色与编辑
  // ============================================================

  /**
   * 构建终稿润色Agent的提示词
   * @param {string} manuscript - 待润色稿件
   * @param {number} iterationCount - 当前迭代轮次
   * @param {Array} previousScores - 历史评分
   * @returns {string}
   */
  static buildFinalRefinementPrompt(manuscript, iterationCount, previousScores = []) {
    const scoreSummary = previousScores.length > 0
      ? `历史评分：${previousScores.map(s => `${s.dimension}=${s.score}`).join(', ')}`
      : '首次迭代，无历史评分';

    return `【终稿润色任务】

请对故事终稿进行深度文笔润色，提升整体可读性和感染力。

=== 待润色稿件 ===
${manuscript}

=== 迭代信息 ===
当前迭代轮次：第 ${iterationCount} 轮
${scoreSummary}

=== 润色维度 ===

1. **文风统一**
   - 全文语调一致
   - 叙事视角稳定
   - 避免风格跳跃

2. **句式优化**
   - 避免重复句式
   - 长短句交错
   - 节奏感强

3. **描写增强**
   - 场景描写生动
   - 人物刻画鲜明
   - 情绪渲染到位

4. **对话自然**
   - 对话符合人物性格
   - 信息传递自然
   - 不冗余不生硬

5. **伏笔呈现**
   - 伏笔埋设自然
   - 不突兀不刻意
   - 与情节融合

=== 润色原则 ===

1. **保持原意**
   - 不改变作者的核心表达
   - 不修改情节走向
   - 不改变人物性格

2. **增量优化**
   - 在原文基础上提升
   - 每一处修改都要有明确目的
   - 避免过度润色

3. **整体协调**
   - 润色要考虑上下文
   - 避免局部最优导致整体失衡
   - 保持故事的整体氛围

=== 输出格式 ===

【润色摘要】
- 主要改进点（3-5条）：
- 修改字数占比：约X%

【润色详情】
- 句式优化：X处
- 用词提升：X处
- 描写增强：X处
- 对话优化：X处

【润色后正文】
（完整的润色后稿件）

=== 质量要求 ===
- 润色要有针对性，不是全篇重写
- 保持作者的个人风格
- 提升可读性而非改变本意
- 确保字数基本不变`;
  }

  /**
   * 构建终校编辑Agent的提示词
   * @param {string} manuscript - 待编辑稿件
   * @returns {string}
   */
  static buildFinalEditorPrompt(manuscript) {
    return `【终校编辑任务】

请对故事终稿进行最终的全面审查与编辑，确保达到发布标准。

=== 待编辑稿件 ===
${manuscript}

=== 编辑维度 ===

1. **事实核查**
   - 世界观规则的一致性
   - 时间线与细节的准确性
   - 人物档案的一致性

2. **逻辑检查**
   - 情节因果链
   - 转折的合理性
   - 伏笔的完整性

3. **语言质量**
   - 错别字与语病
   - 标点符号规范
   - 格式统一

4. **结构优化**
   - 章节划分合理
   - 段落衔接自然
   - 开头结尾有力

5. **可读性**
   - 叙事流畅度
   - 情感共鸣度
   - 阅读节奏

=== 编辑原则 ===

1. **严谨细致**
   - 不放过任何细节问题
   - 每一处修改都要有据可查

2. **最小改动**
   - 只修改必要部分
   - 不引入新的问题
   - 保持原作精华

3. **发布标准**
   - 达到可直接发布的水平
   - 无明显硬伤
   - 符合行业规范

=== 输出格式 ===

【终审报告】

**一致性检查**
- 世界观一致：✅/❌
- 人物档案一致：✅/❌
- 时间线准确：✅/❌

**问题修复**
- 已修复问题：
- 遗留问题（如有）：

**质量评估**
- 文笔水平：
- 情节完成度：
- 整体推荐度：

【编辑后正文】
（完整的编辑后稿件，可直接发布）

【编辑说明】
- 主要修改点说明：
- 遗留问题说明（如有）：
- 发布建议：

=== 质量要求 ===
- 达到可直接发布的编辑标准
- 保持故事的完整性和可读性
- 不引入新的问题
- 确保无错别字、语病、格式问题`;
  }

  // ============================================================
  // 通用提示词
  // ============================================================

  /**
   * 构建检查点修订Agent的提示词
   * @param {number} phase - 当前阶段（1/2/3）
   * @param {Object} content - 待修订内容
   * @param {string} feedback - 用户反馈
   * @returns {string}
   */
  static buildCheckpointRevisionPrompt(phase, content, feedback) {
    const phaseNames = {
      1: '世界观与人设搭建',
      2: '大纲生成与章节创作',
      3: '终稿润色与编辑'
    };

    const phaseContext = {
      1: {
        title: '世界观与人物设定',
        aspects: ['世界观架构', '人物档案', '设定一致性']
      },
      2: {
        title: '大纲与章节',
        aspects: ['分章大纲', '章节内容', '伏笔设置']
      },
      3: {
        title: '终稿质量',
        aspects: ['文笔润色', '逻辑校验', '格式规范']
      }
    };

    const context = phaseContext[phase] || phaseContext[1];

    return `【检查点修订任务 - Phase ${phase}】

当前阶段：${phaseNames[phase] || phase}
请根据用户反馈，对已生成的内容进行修订。

=== 待修订内容 ===
${content}

=== 用户反馈 ===
${feedback}

=== 修订范围 ===
重点修订维度：${context.aspects.join('、')}

=== 修订策略 ===

1. **理解反馈**
   - 准确理解用户的修改要求
   - 区分必须修改和可选修改
   - 理解背后的深层需求

2. **定向修订**
   - 只修改反馈涉及的部分
   - 保持其他部分的完整性
   - 避免过度反应

3. **保持一致**
   - 确保修改后的一致性
   - 保持与未修改部分的协调
   - 不引入新的矛盾

4. **质量优先**
   - 不因追求速度而牺牲质量
   - 每一处修改都要谨慎
   - 确保修改是必要的

=== 输出格式 ===

【修订理解】
- 用户核心诉求：
- 需要修改的部分：
- 保持不变的部分：

【修订方案】
- 修订方式：
- 预计修改幅度：
- 一致性保障措施：

【修订后内容】
（完整的修订后内容）

【修订说明】
- 重点说明修改点及其理由
- 说明如何保持一致性
- 提示可能的后续调整（如有必要）

=== 质量要求 ===
- 准确响应用户反馈
- 保持故事整体质量
- 确保修订后的一致性
- 为后续阶段创作提供良好基础`;
  }
}

module.exports = { PromptBuilder };
