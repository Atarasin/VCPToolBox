# StoryOrchestrator API Documentation

## Table of Contents

1. [Command Interfaces](#1-command-interfaces)
2. [Agent Types](#2-agent-types)
3. [State Structures](#3-state-structures)
4. [WebSocket Events](#4-websocket-events)
5. [Configuration Reference](#5-configuration-reference)
6. [Workflow State Machine](#6-workflow-state-machine)

---

## 1. Command Interfaces

All commands follow the VCP tool protocol using Chinese delimiters `「始」「末」`.

### 1.1 StartStoryProject

**Description**: Initializes a new story creation project and begins Phase 1 (World Building).

**Handler**: `StoryOrchestrator.js` line 100-124

```javascript
async startStoryProject(args) {
  const validation = validateInput('startStoryProject', args);
  const story = await this.stateManager.createStory(args.story_prompt, {
    target_word_count: args.target_word_count,
    genre: args.genre,
    style_preference: args.style_preference
  });
  this.workflowEngine.start(story.id);
  return {
    status: 'success',
    result: {
      story_id: story.id,
      status: story.status,
      message: '故事项目已启动，正在执行第一阶段：世界观与人设搭建'
    }
  };
}
```

#### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `story_prompt` | string | ✅ | - | Story synopsis or opening (min 10 characters) |
| `target_word_count` | number | ❌ | 2500-3500 | Target word count range |
| `genre` | string | ❌ | 'general' | Story genre |
| `style_preference` | string | ❌ | '' | Writing style preference |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123def456",
    "status": "phase1_running",
    "message": "故事项目已启动，正在执行第一阶段：世界观与人设搭建"
  }
}
```

#### Example Request (VCP Format)

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于AI觉醒的科幻故事，在2045年的近未来...「末」,
target_word_count:「始」3000「末」,
genre:「始」科幻「末」,
style_preference:「始」硬科幻风格「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Example Response

```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123def456",
    "status": "phase1_running",
    "message": "故事项目已启动，正在执行第一阶段：世界观与人设搭建"
  }
}
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `INVALID_INPUT` | story_prompt too short or missing | Return validation error with field details |
| `STATE_MANAGER_ERROR` | Failed to create story state | Return error status with message |
| `WORKFLOW_ERROR` | Failed to start workflow engine | Return error status with message |

---

### 1.2 QueryStoryStatus

**Description**: Queries the current status and progress of a story project.

**Handler**: `StoryOrchestrator.js` line 126-160

```javascript
async queryStoryStatus(args) {
  const validation = validateInput('queryStoryStatus', args);
  const story = await this.stateManager.getStory(args.story_id);
  const progress = this._calculateProgress(story);
  const workflowStatus = await this.workflowEngine.getWorkflowStatus(args.story_id);
  return {
    status: 'success',
    result: {
      story_id: story.id,
      phase: this._getCurrentPhase(story),
      phase_name: this._getPhaseName(story),
      status: story.status,
      progress_percent: progress,
      checkpoint_pending: this._isCheckpointPending(story),
      checkpoint_id: this._getCurrentCheckpointId(story),
      chapters_completed: story.phase2?.chapters?.length || 0,
      total_word_count: this._calculateTotalWordCount(story),
      updated_at: story.updatedAt,
      workflow_state: workflowStatus?.state || 'idle',
      current_step: workflowStatus?.currentStep || null,
      active_checkpoint: workflowStatus?.activeCheckpoint || null,
      retry_attempt: workflowStatus?.retryContext?.attempt || 0,
      last_error: workflowStatus?.retryContext?.lastError || null
    }
  };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID (format: `story-[a-zA-Z0-9]+`) |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123",
    "phase": 1,
    "phase_name": "世界观与人设搭建",
    "status": "phase1_running",
    "progress_percent": 35,
    "checkpoint_pending": true,
    "checkpoint_id": "cp-phase1-story-abc123-1234567890",
    "chapters_completed": 0,
    "total_word_count": 0,
    "updated_at": "2026-01-15T10:00:00Z",
    "workflow_state": "waiting_checkpoint",
    "current_step": "checkpoint",
    "active_checkpoint": {
      "id": "cp-xxx",
      "type": "worldview_confirmation"
    },
    "retry_attempt": 0,
    "last_error": null
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」story-abc123def456「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `INVALID_STORY_ID` | story_id format invalid | Return validation error |
| `STORY_NOT_FOUND` | story_id does not exist | Return 404-style error |

---

### 1.3 UserConfirmCheckpoint

**Description**: User approves or rejects continuation at a checkpoint.

**Handler**: `StoryOrchestrator.js` line 162-185

```javascript
async userConfirmCheckpoint(args) {
  const { story_id, checkpoint_id, approval, feedback } = args;
  const result = await this.workflowEngine.resume(story_id, {
    checkpointId: checkpoint_id,
    approval,
    feedback
  });
  return { status: result.status === 'error' ? 'error' : 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `checkpoint_id` | string | ✅ | Checkpoint ID |
| `approval` | boolean | ✅ | true=approve, false=reject |
| `feedback` | string | ❌ | Feedback when rejecting (max 2000 chars) |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "status": "waiting_checkpoint" | "completed",
    "phase": "phase1" | "phase2" | "phase3",
    "checkpoint_id": "cp-xxx",
    "message": "等待检查点确认: cp-xxx"
  }
}
```

#### Example Request (Approval)

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」story-abc123「末」,
checkpoint_id:「始」cp-phase1-story-abc123-1234567890「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Example Request (Rejection)

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」story-abc123「末」,
checkpoint_id:「始」cp-phase1-story-abc123-1234567890「末」,
approval:「始」false「末」,
feedback:「始」主角人设需要更深的内心矛盾描写「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `INVALID_CHECKPOINT` | checkpoint_id mismatch or expired | Return error with details |
| `WORKFLOW_STATE_ERROR` | Cannot resume from current state | Return error with current state |

---

### 1.4 CreateChapterDraft

**Description**: Creates a chapter draft by directly invoking the ChapterWriter agent.

**Handler**: `StoryOrchestrator.js` line 187-209

```javascript
async createChapterDraft(args) {
  const result = await this.chapterOperations.createChapterDraft(
    args.story_id,
    args.chapter_number,
    { targetWordCount: args.target_word_count }
  );
  return {
    status: 'success',
    result: {
      story_id: args.story_id,
      chapter_number: args.chapter_number,
      content: result.content,
      metrics: result.metrics,
      was_expanded: result.wasExpanded
    }
  };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `chapter_number` | integer | ✅ | Chapter number (1-100) |
| `outline_context` | string | ✅ | Chapter outline and context (min 10 chars) |
| `target_word_count` | number | ❌ | Target word count (500-10000) |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123",
    "chapter_number": 1,
    "content": "第一章正文内容...",
    "metrics": {
      "countMode": "cn_chars",
      "counts": {
        "actualCount": 2856,
        "chineseChars": 2856,
        "nonWhitespaceChars": 3124,
        "paragraphCount": 15
      },
      "validation": {
        "isQualified": true,
        "rangeStatus": "within_range",
        "suggestion": "字数达标"
      }
    },
    "was_expanded": false
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CreateChapterDraft「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」1「末」,
outline_context:「始」第一章：觉醒。主角A在实验室中首次表现出自我意识...「末」,
target_word_count:「始」3000「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `INVALID_OUTLINE` | outline_context too short | Return validation error |
| `CHAPTER_RANGE_ERROR` | chapter_number out of range | Return error with valid range |
| `AGENT_ERROR` | ChapterWriter agent failed | Return error with agent message |

---

### 1.5 ReviewChapter

**Description**: Reviews chapter quality using the LogicValidator agent for multi-dimensional evaluation.

**Handler**: `StoryOrchestrator.js` line 211-228

```javascript
async reviewChapter(args) {
  const result = await this.chapterOperations.reviewChapter(
    args.story_id,
    args.chapter_number,
    args.chapter_content,
    { reviewFocus: args.review_focus }
  );
  return { status: 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `chapter_number` | integer | ✅ | Chapter number (≥1) |
| `chapter_content` | string | ✅ | Chapter content (min 100 chars) |
| `review_focus` | string | ❌ | Review focus area (max 500 chars) |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "verdict": "conditional",
    "severity": "minor",
    "issues": [
      "第三段人物A的反应与其谨慎性格不符",
      "结尾转折缺乏足够的铺垫"
    ],
    "suggestions": [
      "建议在第二段增加人物A内心犹豫的描写",
      "在场景转换时增加环境暗示"
    ]
  }
}
```

#### Verdict Values

| Value | Description |
|-------|-------------|
| `pass` | Chapter meets quality standards |
| `conditional` | Minor issues that should be addressed |
| `fail` | Major issues requiring revision |

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ReviewChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」1「末」,
chapter_content:「始」第一章正文内容...「末」,
review_focus:「始」人物性格一致性「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `CONTENT_TOO_SHORT` | chapter_content under 100 chars | Return validation error |
| `VALIDATION_ERROR` | LogicValidator agent failed | Return error with details |

---

### 1.6 ReviseChapter

**Description**: Targeted chapter revision based on issue list.

**Handler**: `StoryOrchestrator.js` line 230-251

```javascript
async reviseChapter(args) {
  const result = await this.chapterOperations.reviseChapter(
    args.story_id,
    args.chapter_number,
    args.chapter_content,
    {
      revisionInstructions: args.revision_instructions,
      issues: args.issues,
      maxRewriteRatio: args.max_rewrite_ratio
    }
  );
  return { status: 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `chapter_number` | integer | ✅ | Chapter number (≥1) |
| `chapter_content` | string | ✅ | Chapter content (min 100 chars) |
| `revision_instructions` | string | ✅ | Revision instructions (min 10 chars) |
| `issues` | array | ❌ | List of issues to address |
| `max_rewrite_ratio` | number | ❌ | Max rewrite ratio (0-1), default 0.35 |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "revisedContent": "修订后的章节内容...",
    "changeSummary": "主要改动：1. 修改了第三段... 2. 增加了结尾铺垫...",
    "originalMetrics": { "counts": { "actualCount": 2500 } },
    "revisedMetrics": { "counts": { "actualCount": 2650 } }
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ReviseChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」1「末」,
chapter_content:「始」原始章节内容...「末」,
revision_instructions:「始」增强人物内心描写，使性格更加一致「末」,
issues:「始」["第三段人物A的反应与其谨慎性格不符"]「末」,
max_rewrite_ratio:「始」0.4「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `REVISION_LIMIT_EXCEEDED` | max_rewrite_ratio too high | Return error with limit |
| `AGENT_ERROR` | DetailFiller agent failed | Return error with message |

---

### 1.7 PolishChapter

**Description**: Polishes chapter writing style using the StylePolisher agent.

**Handler**: `StoryOrchestrator.js` line 253-270

```javascript
async polishChapter(args) {
  const result = await this.chapterOperations.polishChapter(
    args.story_id,
    args.chapter_number,
    args.chapter_content,
    { polishFocus: args.polish_focus }
  );
  return { status: 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `chapter_number` | integer | ✅ | Chapter number (≥1) |
| `chapter_content` | string | ✅ | Chapter content (min 100 chars) |
| `polish_focus` | string | ❌ | Polish focus area (max 500 chars) |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "polishedContent": "润色后的章节内容...",
    "improvements": [
      "统一了全文语调",
      "优化了3处过长句子",
      "增强了场景描写的画面感"
    ],
    "metrics": {
      "counts": { "actualCount": 2880 },
      "validation": { "isQualified": true }
    }
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」PolishChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」1「末」,
chapter_content:「始」待润色的章节内容...「末」,
polish_focus:「始」增强科幻氛围感「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `POLISH_ERROR` | StylePolisher agent failed | Return error with details |
| `CONTENT_UNCHANGED` | Polish resulted in no improvement | Return warning with original |

---

### 1.8 ValidateConsistency

**Description**: Validates content consistency with the Story Bible.

**Handler**: `StoryOrchestrator.js` line 272-304

```javascript
async validateConsistency(args) {
  const storyBible = this.stateManager.getStoryBible(args.story_id);
  let result;
  switch (args.validation_type) {
    case 'worldview':
      result = await this.contentValidator.validateWorldview(args.story_id, args.content, storyBible);
      break;
    case 'character':
      result = await this.contentValidator.validateCharacters(args.story_id, args.content, storyBible);
      break;
    case 'plot':
      result = await this.contentValidator.validatePlot(args.story_id, args.content, storyBible);
      break;
    default:
      result = await this.contentValidator.comprehensiveValidation(...);
  }
  return { status: 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `content` | string | ✅ | Content to validate |
| `validation_type` | string | ❌ | Type: `worldview`/`character`/`plot`, default comprehensive |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "overall": {
      "passed": true,
      "hasCriticalIssues": false,
      "criticalCount": 0
    },
    "checks": {
      "worldview": {
        "passed": true,
        "issues": [],
        "suggestions": []
      },
      "characters": {
        "passed": true,
        "issues": [],
        "suggestions": []
      },
      "plot": {
        "passed": true,
        "issues": [],
        "suggestions": []
      }
    },
    "allIssues": [],
    "allSuggestions": []
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ValidateConsistency「末」,
story_id:「始」story-abc123「末」,
content:「始」待验证的章节内容...「末」,
validation_type:「始」character「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `VALIDATION_TYPE_INVALID` | Unknown validation_type | Return error with valid types |
| `STORY_BIBLE_MISSING` | Story Bible not yet created | Return error indicating Phase incomplete |

---

### 1.9 CountChapterMetrics

**Description**: Counts chapter word count and structural metrics.

**Handler**: `StoryOrchestrator.js` line 306-326

```javascript
async countChapterMetrics(args) {
  const result = this.chapterOperations.countChapterLength(
    args.chapter_content,
    args.target_min,
    args.target_max,
    { countMode: args.count_mode, lengthPolicy: args.length_policy }
  );
  return { status: 'success', result };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `chapter_content` | string | ✅ | Chapter content to count |
| `target_min` | number | ❌ | Target word count minimum (≥0) |
| `target_max` | number | ❌ | Target word count maximum (≥0) |
| `count_mode` | string | ❌ | Mode: `cn_chars` (Chinese chars) / `non_whitespace` |
| `length_policy` | string | ❌ | Policy: `range` / `min_only` |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "countMode": "cn_chars",
    "lengthPolicy": "range",
    "targetRange": { "min": 2500, "max": 3500 },
    "counts": {
      "actualCount": 2876,
      "chineseChars": 2876,
      "nonWhitespaceChars": 3124,
      "rawChars": 3245,
      "paragraphCount": 15,
      "sentenceCount": 42,
      "avgSentenceLength": 68
    },
    "validation": {
      "isQualified": true,
      "rangeStatus": "within_range",
      "suggestion": "字数在目标范围内",
      "deficit": 0,
      "excess": 0
    }
  }
}
```

#### Range Status Values

| Value | Description |
|-------|-------------|
| `within_range` | Count is within target range |
| `below_min` | Count is below minimum |
| `above_max` | Count exceeds maximum |

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CountChapterMetrics「末」,
chapter_content:「始」待统计的章节内容...「末」,
target_min:「始」2500「末」,
target_max:「始」3500「末」,
count_mode:「始」cn_chars「末」,
length_policy:「始」range「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `EMPTY_CONTENT` | chapter_content is empty | Return error |
| `INVALID_RANGE` | target_min > target_max | Return validation error |

---

### 1.10 ExportStory

**Description**: Exports the completed story in the specified format.

**Handler**: `StoryOrchestrator.js` line 328-368

```javascript
async exportStory(args) {
  const format = args.format || 'markdown';
  let content;
  switch (format) {
    case 'json': content = JSON.stringify(story, null, 2); break;
    case 'txt': content = this._exportAsPlainText(story); break;
    case 'markdown': content = this._exportAsMarkdown(story); break;
  }
  return {
    status: 'success',
    result: {
      story_id: args.story_id,
      format,
      content,
      word_count: totalWordCount,
      chapter_count: chapters.length,
      exported_at: new Date().toISOString()
    }
  };
}
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `story_id` | string | ✅ | Story ID |
| `format` | string | ❌ | Format: `markdown` / `txt` / `json` |

#### Return Structure

```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123",
    "format": "markdown",
    "content": "# 故事创作\n\n## 世界观\n...",
    "word_count": 3250,
    "chapter_count": 5,
    "exported_at": "2026-01-15T12:00:00Z"
  }
}
```

#### Example Request

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ExportStory「末」,
story_id:「始」story-abc123「末」,
format:「始」markdown「末」
<<<[END_TOOL_REQUEST]>>>
```

#### Error Codes

| Code | Condition | Handling |
|------|-----------|----------|
| `FORMAT_NOT_SUPPORTED` | Unknown format | Return error with supported formats |
| `STORY_NOT_COMPLETED` | Story workflow incomplete | Return error indicating completion required |

---

## 2. Agent Types

The StoryOrchestrator uses 9 specialized agents organized in a hierarchical architecture.

### 2.1 Agent Type Constants

```javascript
const AGENT_TYPES = {
  ORCHESTRATOR: 'orchestrator',           // 总控调度
  WORLD_BUILDER: 'worldBuilder',           // 世界观设定
  CHARACTER_DESIGNER: 'characterDesigner', // 人物塑造
  PLOT_ARCHITECT: 'plotArchitect',         // 情节架构
  CHAPTER_WRITER: 'chapterWriter',         // 章节执笔
  DETAIL_FILLER: 'detailFiller',           // 细节填充
  LOGIC_VALIDATOR: 'logicValidator',       // 逻辑校验
  STYLE_POLISHER: 'stylePolisher',         // 文笔润色
  FINAL_EDITOR: 'finalEditor'              // 终校定稿
};
```

### 2.2 Agent Configuration Map

```javascript
const AGENT_CONFIG_MAP = {
  [AGENT_TYPES.ORCHESTRATOR]: {
    configPrefix: 'AGENT_ORCHESTRATOR',
    defaultName: '总控调度'
  },
  [AGENT_TYPES.WORLD_BUILDER]: {
    configPrefix: 'AGENT_WORLD_BUILDER',
    defaultName: '世界观设定'
  },
  [AGENT_TYPES.CHARACTER_DESIGNER]: {
    configPrefix: 'AGENT_CHARACTER_DESIGNER',
    defaultName: '人物塑造'
  },
  [AGENT_TYPES.PLOT_ARCHITECT]: {
    configPrefix: 'AGENT_PLOT_ARCHITECT',
    defaultName: '情节架构'
  },
  [AGENT_TYPES.CHAPTER_WRITER]: {
    configPrefix: 'AGENT_CHAPTER_WRITER',
    defaultName: '章节执笔'
  },
  [AGENT_TYPES.DETAIL_FILLER]: {
    configPrefix: 'AGENT_DETAIL_FILLER',
    defaultName: '细节填充'
  },
  [AGENT_TYPES.LOGIC_VALIDATOR]: {
    configPrefix: 'AGENT_LOGIC_VALIDATOR',
    defaultName: '逻辑校验'
  },
  [AGENT_TYPES.STYLE_POLISHER]: {
    configPrefix: 'AGENT_STYLE_POLISHER',
    defaultName: '文笔润色'
  },
  [AGENT_TYPES.FINAL_EDITOR]: {
    configPrefix: 'AGENT_FINAL_EDITOR',
    defaultName: '终校定稿'
  }
};
```

### 2.3 Agent Configuration Retrieval

```javascript
function getAgentConfig(agentType, globalConfig = {}) {
  const mapping = AGENT_CONFIG_MAP[agentType];
  const prefix = mapping.configPrefix;
  
  return {
    modelId: globalConfig[`${prefix}_MODEL_ID`],
    chineseName: globalConfig[`${prefix}_CHINESE_NAME`] || mapping.defaultName,
    systemPrompt: globalConfig[`${prefix}_SYSTEM_PROMPT`],
    maxOutputTokens: parseInt(globalConfig[`${prefix}_MAX_OUTPUT_TOKENS`]) || 4000,
    temperature: parseFloat(globalConfig[`${prefix}_TEMPERATURE`]) || 0.7
  };
}
```

### 2.4 Agent Descriptions

| Agent Type | Chinese Name | Role |
|------------|--------------|------|
| `orchestrator` | 总控调度 | Task decomposition, progress monitoring, conflict resolution |
| `worldBuilder` | 世界观设定 | Creates setting, rules, factions, history, scene norms |
| `characterDesigner` | 人物塑造 | Designs protagonists, supporting characters, relationship networks |
| `plotArchitect` | 情节架构 | Creates chapter outline, turning points, foreshadowing |
| `chapterWriter` | 章节执笔 | Generates chapter content based on outline |
| `detailFiller` | 细节填充 | Adds vivid descriptions, emotional depth, environmental details |
| `logicValidator` | 逻辑校验 | Validates plot consistency, character behavior, cause-effect |
| `stylePolisher` | 文笔润色 | Polishes prose style, tone, sentence structure |
| `finalEditor` | 终校定稿 | Final review, format standardization, quality scoring |

### 2.5 Agent Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                     Decision & Coordination Layer          │
│  ┌─────────────────┐                                        │
│  │   Orchestrator  │ - Task decomposition & allocation     │
│  │   (总控调度)    │ - Progress monitoring                 │
│  │                 │ - Conflict resolution                 │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Creative Generation Layer              │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  WorldBuilder   │  │ CharacterDesign │                  │
│  │  (世界观设定)   │  │  (人物塑造)     │                  │
│  └─────────────────┘  └─────────────────┘                  │
│  ┌─────────────────┐                                        │
│  │  PlotArchitect  │                                        │
│  │  (情节架构)     │                                        │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Content Production Layer               │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  ChapterWriter  │  │  DetailFiller   │                  │
│  │  (章节执笔)     │  │  (细节填充)     │                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Quality Assurance Layer                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │ LogicValidator  │  │ StylePolisher  │  │ FinalEditor │ │
│  │ (逻辑校验)      │  │ (文笔润色)     │  │ (终校定稿)  │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 2.6 Agent Dispatcher

```javascript
class AgentDispatcher {
  // Single agent delegation
  async delegate(agentType, prompt, options = {}) {
    const agentConfig = getAgentConfig(agentType, this.config);
    
    const payload = {
      model: agentConfig.modelId,
      messages: [
        { role: 'system', content: agentConfig.systemPrompt || `你是${agentConfig.chineseName}Agent。` },
        { role: 'user', content: prompt }
      ],
      temperature: agentConfig.temperature,
      max_tokens: agentConfig.maxOutputTokens,
      stream: false
    };
    
    return await this._delegateSync(payload, options);
  }
  
  // Parallel agent execution
  async delegateParallel(agentTasks) {
    const promises = agentTasks.map(task => 
      this.delegate(task.agentType, task.prompt, task.options)
        .then(result => ({ status: 'fulfilled', agentType: task.agentType, result }))
        .catch(error => ({ status: 'rejected', agentType: task.agentType, error: error.message }))
    );
    return {
      succeeded: (await Promise.all(promises)).filter(r => r.status === 'fulfilled'),
      failed: (await Promise.all(promises)).filter(r => r.status === 'rejected')
    };
  }
}
```

---

## 3. State Structures

### 3.1 Story Object

Complete story state structure stored in `StateManager.js` line 36-87.

```javascript
const story = {
  // Identity
  id: "story-abc123def456",              // Unique ID (format: story-[12-char-uuid])
  
  // Status
  status: 'phase1_running',              // Current workflow status
  createdAt: "2026-01-15T10:00:00Z",     // Creation timestamp (ISO8601)
  updatedAt: "2026-01-15T10:00:00Z",     // Last update timestamp (ISO8601)
  
  // Configuration
  config: {
    targetWordCount: { min: 2500, max: 3500 },  // Target word count range
    genre: '科幻',                         // Story genre
    stylePreference: '硬科幻风格',          // Writing style preference
    storyPrompt: '故事梗概...'              // Original story prompt
  },
  
  // Phase 1: World Building & Character Design
  phase1: {
    worldview: null,                      // World building document (JSON)
    characters: [],                        // Character profile array
    validation: null,                     // Validation results
    userConfirmed: false,                  // User confirmation status
    checkpointId: null,                     // Current checkpoint ID
    status: 'running'                      // running/validating/pending_confirmation
  },
  
  // Phase 2: Outline Drafting & Content Production
  phase2: {
    outline: null,                         // Chapter outline
    chapters: [],                          // Chapter array
    currentChapter: 0,                    // Current chapter being processed
    userConfirmed: false,                  // User confirmation status
    checkpointId: null,                    // Current checkpoint ID
    status: 'pending'                      // pending/running/content_production/completed
  },
  
  // Phase 3: Refinement & Polish
  phase3: {
    polishedChapters: [],                   // Polished chapters
    finalValidation: null,                   // Final validation results
    iterationCount: 0,                     // Current iteration number
    userConfirmed: false,                   // User confirmation status
    checkpointId: null,                      // Current checkpoint ID
    status: 'pending'                      // pending/polishing_complete/final_editing_complete/waiting_final_acceptance/completed
  },
  
  // Final output (after completion)
  finalOutput: null,
  
  // Workflow state machine
  workflow: {
    state: 'idle',                        // idle/running/waiting_checkpoint/completed/failed
    currentPhase: 'phase1',                 // Current phase
    currentStep: null,                      // Current step within phase
    activeCheckpoint: null,                 // Active checkpoint object
    retryContext: {                         // Retry context
      phase: null,
      step: null,
      attempt: 0,
      maxAttempts: 3,
      lastError: null
    },
    history: [],                          // Workflow history records
    runToken: "uuid-v4-string"            // Runtime token
  }
};
```

### 3.2 Phase1 State Structure (World Building)

```javascript
phase1: {
  // World setting document
  worldview: {
    setting: "时代背景与地理环境描述",
    rules: {
      physical: "物理规则描述",
      special: "特殊设定描述",
      limitations: "限制与代价描述"
    },
    factions: [
      {
        name: "势力名称",
        description: "势力描述",
        relationships: ["关系"]
      }
    ],
    history: {
      keyEvents: ["关键历史事件"],
      coreConflicts: ["核心矛盾"]
    },
    sceneNorms: ["场景规范列表"],
    secrets: ["隐藏秘密/伏笔"]
  },
  
  // Character profiles
  characters: {
    protagonists: [
      {
        name: "人物姓名",
        identity: "身份描述",
        appearance: "外貌特征",
        personality: ["性格关键词"],
        background: "背景故事",
        motivation: "核心动机",
        innerConflict: "内在矛盾",
        growthArc: "成长弧线"
      }
    ],
    supportingCharacters: [
      {
        name: "配角姓名",
        identity: "身份",
        role: "功能定位",
        relationship: "与主角关系"
      }
    ],
    relationshipNetwork: {
      direct: [{ from: "A", to: "B", type: "关系类型" }],
      hidden: [{ from: "A", to: "B", secret: "隐藏关系" }]
    },
    oocRules: { "角色名": ["行为边界描述"] }
  },
  
  // Validation results
  validation: {
    passed: true,
    hasWarnings: false,
    issues: [{ description: "问题描述", severity: "critical|major|minor" }],
    suggestions: ["建议描述"],
    rawReport: "原始验证报告"
  },
  
  // Status
  userConfirmed: false,
  checkpointId: "cp-phase1-xxx-1234567890",
  status: "running|validating|pending_confirmation"
}
```

### 3.3 Phase2 State Structure (Outline & Content)

```javascript
phase2: {
  // Chapter outline
  outline: {
    chapters: [
      {
        number: 1,
        title: "第1章 标题",
        coreEvent: "核心事件描述",
        scenes: ["场景1", "场景2"],
        characters: ["角色A", "角色B"],
        wordCountTarget: 2500
      }
    ],
    structure: "整体故事结构描述",
    keyTurningPoints: ["转折点1", "转折点2"],
    foreshadowing: ["伏笔1→回收章节", "伏笔2→回收章节"]
  },
  
  // Chapters
  chapters: [
    {
      number: 1,
      title: "第1章 标题",
      content: "章节正文内容...",
      metrics: {
        counts: {
          actualCount: 2856,
          chineseChars: 2856
        }
      },
      validation: {
        overall: {
          passed: true,
          hasCriticalIssues: false,
          criticalCount: 0
        },
        checks: {
          worldview: {
            passed: true,
            hasWarnings: false,
            issues: [{ description: "设定冲突描述", severity: "minor|major|critical" }],
            suggestions: ["修正建议"],
            rawReport: "原始校验报告"
          },
          characters: {
            passed: true,
            hasWarnings: false,
            issues: [],
            suggestions: [],
            rawReport: "原始校验报告"
          },
          plot: {
            passed: true,
            hasWarnings: false,
            issues: [],
            suggestions: [],
            rawReport: "原始校验报告"
          }
        },
        allIssues: [{ description: "聚合后的问题描述", severity: "minor|major|critical" }],
        allSuggestions: ["聚合后的修正建议"]
      },
      status: "draft|completed|completed_with_warnings",
      wasRevised: false,
      createdAt: "2026-01-15T10:00:00Z"
    }
  ],
  
  currentChapter: 1,
  userConfirmed: false,
  checkpointId: "cp-outline-abc123",
  status: "pending|running|pending_confirmation|content_production|completed"
}
```

### 3.4 Phase3 State Structure (Refinement)

```javascript
phase3: {
  // Polished chapters
  polishedChapters: [
    {
      number: 1,
      title: "第1章 标题",
      content: "润色后的正文...",
      originalContent: "原始正文...",
      metrics: { counts: { actualCount: 2900 } },
      improvements: ["改进点列表"]
    }
  ],
  
  // Final validation
  finalValidation: {
    passed: true,
    issues: [],
    qualityScores: []
  },
  
  // Iteration tracking
  iterationCount: 3,
  
  // Status
  userConfirmed: false,
  checkpointId: "cp-3-final-1234567890",
  status: "pending|polishing_complete|final_editing_complete|waiting_final_acceptance|completed",
  
  // Final output
  finalEditorOutput: "终校编辑后的完整内容",
  
  // Quality tracking
  qualityScores: [
    {
      iteration: 1,
      average: 7.2,
      scores: { "叙事流畅度": 7.5, "描写生动度": 7.0 }
    },
    {
      iteration: 2,
      average: 7.8,
      scores: { "叙事流畅度": 8.0, "描写生动度": 7.5 }
    }
  ]
}
```

### 3.5 Workflow State Structure

```javascript
workflow: {
  // State machine state
  state: 'idle|running|waiting_checkpoint|completed|failed',
  
  // Current phase
  currentPhase: 'phase1|phase2|phase3|null',
  
  // Current step
  currentStep: 'initial|worldbuilding|outline_drafting|refinement|checkpoint',
  
  // Active checkpoint
  activeCheckpoint: {
    id: "cp-xxx",
    phase: "phase1",
    type: "worldview_confirmation|outline_confirmation|final_acceptance",
    status: "pending|approved|rejected",
    createdAt: "2026-01-15T10:00:00Z",
    expiresAt: "2026-01-16T10:00:00Z",
    autoContinueOnTimeout: true,
    feedback: ""
  },
  
  // Retry context
  retryContext: {
    phase: "phase1",
    step: "worldbuilding",
    attempt: 1,
    maxAttempts: 3,
    lastError: null
  },
  
  // History
  history: [
    {
      at: "2026-01-15T10:00:00Z",
      type: "phase_completed|checkpoint_created|checkpoint_approved|...",
      phase: "phase1",
      step: "worldbuilding",
      detail: {}
    }
  ],
  
  // Runtime token
  runToken: "uuid-v4-string"
}
```

### 3.6 Checkpoint Structure

```javascript
checkpoint: {
  id: "cp-phase1-story-abc123-1234567890",
  phase: "phase1",
  type: "worldview_confirmation",        // Checkpoint type
  status: "pending",                      // pending|approved|rejected
  createdAt: "2026-01-15T10:00:00Z",
  expiresAt: "2026-01-16T10:00:00Z",     // Timeout timestamp
  autoContinueOnTimeout: true,            // Auto-continue on timeout
  feedback: ""                            // User feedback
}
```

### 3.7 Checkpoint Types

| Phase | Type | Description |
|-------|------|-------------|
| Phase1 | `worldview_confirmation` | World building and character design review |
| Phase2 | `outline_confirmation` | Chapter outline review |
| Phase3 | `final_acceptance` | Final polished story acceptance |

---

## 4. WebSocket Events

All events are dispatched via `WorkflowEngine.js` line 874-895 using the `_notify` method.

### 4.1 Event Notification Format

```javascript
async _notify(storyId, eventType, payload) {
  const notification = {
    type: 'workflow_event',
    eventType,                              // Event type
    storyId,                                // Story ID
    timestamp: new Date().toISOString(),    // ISO8601 timestamp
    payload                                 // Event data
  };

  // Push via WebSocket
  if (this.webSocketPusher && typeof this.webSocketPusher.push === 'function') {
    await this.webSocketPusher.push(storyId, notification);
  }
  
  console.log(`[WorkflowEngine] Event: ${eventType}`, JSON.stringify(payload, null, 2));
}
```

### 4.2 Complete Event List

| # | Event Type | Trigger | Payload |
|---|------------|---------|---------|
| 1 | `workflow_started` | Workflow initiated | `{ storyId, phase, runToken }` |
| 2 | `workflow_resuming` | Resuming from checkpoint | `{ storyId, checkpointId, approval, currentPhase }` |
| 3 | `workflow_recovery_started` | Crash recovery begins | `{ storyId, previousState, currentPhase, recoveryRunToken }` |
| 4 | `phase_started` | Phase execution begins | `{ storyId, phaseName }` |
| 5 | `phase_completed` | Phase execution completes | `{ storyId, completedPhase, data }` |
| 6 | `phase_retry` | Phase retry initiated | `{ storyId, phaseName, attempt, maxAttempts, reason, backoffDelay }` |
| 7 | `phase_failed` | Phase execution failed | `{ storyId, phaseName, error, data }` |
| 8 | `checkpoint_pending` | Checkpoint awaiting user | `{ storyId, phaseName, checkpointId, data }` |
| 9 | `checkpoint_approved` | Checkpoint approved | `{ storyId, phaseName, checkpointId, feedback }` |
| 10 | `checkpoint_rejected` | Checkpoint rejected | `{ storyId, phaseName, checkpointId, feedback, reason }` |
| 11 | `workflow_completed` | Workflow finished | `{ storyId, completedAt }` |

### 4.3 Event Payload Details

#### 1. workflow_started

Triggered when a new story project begins Phase 1.

```javascript
await this._notify(storyId, 'workflow_started', {
  storyId: "story-abc123",
  phase: "phase1",
  runToken: "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
});
```

**Example WebSocket message**:
```json
{
  "type": "workflow_event",
  "eventType": "workflow_started",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T10:00:00Z",
  "payload": {
    "storyId": "story-abc123",
    "phase": "phase1",
    "runToken": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
}
```

---

#### 2. workflow_resuming

Triggered when workflow resumes from a checkpoint after user confirmation.

```javascript
await this._notify(storyId, 'workflow_resuming', {
  storyId,
  checkpointId,
  approval: true,
  currentPhase: "phase1"
});
```

**Payload**:

| Field | Type | Description |
|-------|------|-------------|
| `storyId` | string | Story ID |
| `checkpointId` | string | Checkpoint ID that was confirmed |
| `approval` | boolean | User's approval decision |
| `currentPhase` | string | Phase to resume |

---

#### 3. workflow_recovery_started

Triggered when recovering from an interrupted workflow.

```javascript
await this._notify(storyId, 'workflow_recovery_started', {
  storyId,
  previousState: "running",
  currentPhase: "phase1",
  recoveryRunToken: "new-uuid"
});
```

**Payload**:

| Field | Type | Description |
|-------|------|-------------|
| `storyId` | string | Story ID |
| `previousState` | string | State before interruption |
| `currentPhase` | string | Phase to recover to |
| `recoveryRunToken` | string | New runtime token |

---

#### 4. phase_started

Triggered when a new phase begins execution.

```javascript
await this._notify(storyId, 'phase_started', {
  storyId,
  phaseName: "phase1"
});
```

**Phase Names**:

| Phase | Chinese | Description |
|-------|---------|-------------|
| `phase1` | 世界观与人设搭建 | World building & character design |
| `phase2` | 大纲与正文创作 | Outline drafting & content production |
| `phase3` | 打磨与终审 | Refinement & final review |

---

#### 5. phase_completed

Triggered when a phase completes successfully.

```javascript
await this._notify(storyId, 'phase_completed', {
  storyId,
  completedPhase: "phase1",
  data: {
    worldview: { ... },
    characters: [ ... ],
    validation: { passed: true }
  }
});
```

**Example**:
```json
{
  "type": "workflow_event",
  "eventType": "phase_completed",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T11:00:00Z",
  "payload": {
    "storyId": "story-abc123",
    "completedPhase": "phase1",
    "data": {
      "worldview": {
        "setting": "科幻世界观...",
        "rules": { ... }
      },
      "characters": [{ "name": "主角", ... }],
      "validation": { "passed": true }
    }
  }
}
```

---

#### 6. phase_retry

Triggered when a phase retries after failure.

```javascript
await this._notify(storyId, 'phase_retry', {
  storyId,
  phaseName: "phase2",
  attempt: 2,
  maxAttempts: 3,
  reason: "Validation failed after revision",
  backoffDelay: 250
});
```

**Payload**:

| Field | Type | Description |
|-------|------|-------------|
| `storyId` | string | Story ID |
| `phaseName` | string | Phase being retried |
| `attempt` | integer | Current attempt number |
| `maxAttempts` | integer | Maximum retry attempts |
| `reason` | string | Reason for retry |
| `backoffDelay` | integer | Delay in milliseconds before retry |

---

#### 7. phase_failed

Triggered when a phase fails after exhausting retries.

```javascript
await this._notify(storyId, 'phase_failed', {
  storyId,
  phaseName: "phase2",
  error: "Outline validation failed after 3 revision attempts",
  data: { issues: [...] }
});
```

**Payload**:

| Field | Type | Description |
|-------|------|-------------|
| `storyId` | string | Story ID |
| `phaseName` | string | Failed phase |
| `error` | string | Error message |
| `data` | object | Additional error context |

---

#### 8. checkpoint_pending ⭐ (User Interaction Required)

Triggered when user confirmation is required. This is the primary event for frontend UI updates.

```javascript
await this._notify(storyId, 'checkpoint_pending', {
  storyId,
  phaseName: "phase1",
  checkpointId: "cp-phase1-story-abc123-1234567890",
  data: {
    worldview: { ... },
    characters: [ ... ],
    validation: { passed: true, issues: [] }
  }
});
```

**Example**:
```json
{
  "type": "workflow_event",
  "eventType": "checkpoint_pending",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T10:30:00Z",
  "payload": {
    "storyId": "story-abc123",
    "phaseName": "phase1",
    "checkpointId": "cp-phase1-story-abc123-1234567890",
    "data": {
      "worldview": {
        "setting": "科幻世界观设定（12个势力、3条历史主线）"
      },
      "characters": ["5个主要人物、12个配角"],
      "validation": { "passed": true }
    }
  }
}
```

---

#### 9. checkpoint_approved

Triggered when user approves at a checkpoint.

```javascript
await this._notify(storyId, 'checkpoint_approved', {
  storyId,
  phaseName: "phase1",
  checkpointId: "cp-xxx",
  feedback: "Approved"
});
```

**Example**:
```json
{
  "type": "workflow_event",
  "eventType": "checkpoint_approved",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T10:35:00Z",
  "payload": {
    "storyId": "story-abc123",
    "phaseName": "phase1",
    "checkpointId": "cp-phase1-story-abc123-1234567890",
    "feedback": "Approved"
  }
}
```

---

#### 10. checkpoint_rejected

Triggered when user rejects at a checkpoint.

```javascript
await this._notify(storyId, 'checkpoint_rejected', {
  storyId,
  phaseName: "phase1",
  checkpointId: "cp-xxx",
  feedback: "主角人设需要更深的内心矛盾描写",
  reason: "User requested revision"
});
```

**Example**:
```json
{
  "type": "workflow_event",
  "eventType": "checkpoint_rejected",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T10:35:00Z",
  "payload": {
    "storyId": "story-abc123",
    "phaseName": "phase1",
    "checkpointId": "cp-phase1-story-abc123-1234567890",
    "feedback": "主角人设需要更深的内心矛盾描写",
    "reason": "User requested revision"
  }
}
```

---

#### 11. workflow_completed ⭐ (Final Event)

Triggered when the entire workflow completes successfully.

```javascript
await this._notify(storyId, 'workflow_completed', {
  storyId,
  completedAt: new Date().toISOString()
});
```

**Example**:
```json
{
  "type": "workflow_event",
  "eventType": "workflow_completed",
  "storyId": "story-abc123",
  "timestamp": "2026-01-15T16:00:00Z",
  "payload": {
    "storyId": "story-abc123",
    "completedAt": "2026-01-15T16:00:00Z"
  }
}
```

---

### 4.4 WebSocket Subscription Example

```javascript
// Frontend WebSocket connection and subscription
const ws = new WebSocket('ws://localhost:5890');

// Subscribe to all StoryOrchestrator events
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'StoryOrchestrator'
}));

// Subscribe to specific story project
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'StoryOrchestrator',
  story_id: 'story-abc123'
}));

// Receive event notifications
ws.onmessage = (event) => {
  const notification = JSON.parse(event.data);
  
  if (notification.type === 'workflow_event') {
    console.log(`Event: ${notification.eventType}`);
    console.log(`Story: ${notification.storyId}`);
    console.log(`Data:`, notification.payload);
    
    // Handle specific events
    switch (notification.eventType) {
      case 'checkpoint_pending':
        // Show confirmation UI to user
        showCheckpointModal(notification.payload);
        break;
      case 'workflow_completed':
        // Show completion message
        showCompletionScreen(notification.payload);
        break;
      case 'phase_completed':
        // Update progress indicator
        updatePhaseProgress(notification.payload);
        break;
    }
  }
};
```

---

## 5. Configuration Reference

### 5.1 Plugin Configuration (config.env)

```bash
# StoryOrchestrator Plugin Configuration
ORCHESTRATOR_DEBUG_MODE=false
MAX_PHASE_ITERATIONS=5
QUALITY_THRESHOLD=8.0
DEFAULT_TARGET_WORD_COUNT_MIN=2500
DEFAULT_TARGET_WORD_COUNT_MAX=3500
USER_CHECKPOINT_TIMEOUT_MS=86400000
STORY_STATE_RETENTION_DAYS=30

# Orchestrator Agent Configuration
AGENT_ORCHESTRATOR_MODEL_ID=gpt-4
AGENT_ORCHESTRATOR_CHINESE_NAME=总控调度
AGENT_ORCHESTRATOR_SYSTEM_PROMPT=你是故事创作的总控调度Agent...
AGENT_ORCHESTRATOR_MAX_OUTPUT_TOKENS=4000
AGENT_ORCHESTRATOR_TEMPERATURE=0.7

# WorldBuilder Agent Configuration
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4
AGENT_WORLD_BUILDER_CHINESE_NAME=世界观设定
AGENT_WORLD_BUILDER_SYSTEM_PROMPT=你是专业的世界观设定师...
AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS=3000
AGENT_WORLD_BUILDER_TEMPERATURE=0.8

# CharacterDesigner Agent Configuration
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-4
AGENT_CHARACTER_DESIGNER_CHINESE_NAME=人物塑造
AGENT_CHARACTER_DESIGNER_SYSTEM_PROMPT=你是专业的人物塑造师...
AGENT_CHARACTER_DESIGNER_MAX_OUTPUT_TOKENS=3000
AGENT_CHARACTER_DESIGNER_TEMPERATURE=0.8

# PlotArchitect Agent Configuration
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-4
AGENT_PLOT_ARCHITECT_CHINESE_NAME=情节架构
AGENT_PLOT_ARCHITECT_SYSTEM_PROMPT=你是专业的情节架构师...
AGENT_PLOT_ARCHITECT_MAX_OUTPUT_TOKENS=3000
AGENT_PLOT_ARCHITECT_TEMPERATURE=0.7

# ChapterWriter Agent Configuration
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-4
AGENT_CHAPTER_WRITER_CHINESE_NAME=章节执笔
AGENT_CHAPTER_WRITER_SYSTEM_PROMPT=你是专业的章节执笔作者...
AGENT_CHAPTER_WRITER_MAX_OUTPUT_TOKENS=5000
AGENT_CHAPTER_WRITER_TEMPERATURE=0.75

# DetailFiller Agent Configuration
AGENT_DETAIL_FILLER_MODEL_ID=gpt-4
AGENT_DETAIL_FILLER_CHINESE_NAME=细节填充
AGENT_DETAIL_FILLER_SYSTEM_PROMPT=你是专业的细节填充专家...
AGENT_DETAIL_FILLER_MAX_OUTPUT_TOKENS=4000
AGENT_DETAIL_FILLER_TEMPERATURE=0.7

# LogicValidator Agent Configuration
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-4
AGENT_LOGIC_VALIDATOR_CHINESE_NAME=逻辑校验
AGENT_LOGIC_VALIDATOR_SYSTEM_PROMPT=你是专业的逻辑校验专家...
AGENT_LOGIC_VALIDATOR_MAX_OUTPUT_TOKENS=3000
AGENT_LOGIC_VALIDATOR_TEMPERATURE=0.3

# StylePolisher Agent Configuration
AGENT_STYLE_POLISHER_MODEL_ID=gpt-4
AGENT_STYLE_POLISHER_CHINESE_NAME=文笔润色
AGENT_STYLE_POLISHER_SYSTEM_PROMPT=你是专业的文笔润色专家...
AGENT_STYLE_POLISHER_MAX_OUTPUT_TOKENS=4000
AGENT_STYLE_POLISHER_TEMPERATURE=0.6

# FinalEditor Agent Configuration
AGENT_FINAL_EDITOR_MODEL_ID=gpt-4
AGENT_FINAL_EDITOR_CHINESE_NAME=终校定稿
AGENT_FINAL_EDITOR_SYSTEM_PROMPT=你是专业的终校定稿编辑...
AGENT_FINAL_EDITOR_MAX_OUTPUT_TOKENS=4000
AGENT_FINAL_EDITOR_TEMPERATURE=0.5
```

### 5.2 Configuration Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `ORCHESTRATOR_DEBUG_MODE` | false | Enable debug logging |
| `MAX_PHASE_ITERATIONS` | 5 | Max iterations in Phase 3 |
| `QUALITY_THRESHOLD` | 8.0 | Quality score threshold (0-10) |
| `DEFAULT_TARGET_WORD_COUNT_MIN` | 2500 | Default min word count |
| `DEFAULT_TARGET_WORD_COUNT_MAX` | 3500 | Default max word count |
| `USER_CHECKPOINT_TIMEOUT_MS` | 86400000 | Checkpoint timeout (24 hours) |
| `STORY_STATE_RETENTION_DAYS` | 30 | State file retention period |

### 5.3 Agent Configuration Parameters

Each agent supports the following configuration via `config.env`:

| Parameter | Description |
|-----------|-------------|
| `${PREFIX}_MODEL_ID` | Model identifier (e.g., gpt-4, gpt-3.5-turbo) |
| `${PREFIX}_CHINESE_NAME` | Display name in Chinese |
| `${PREFIX}_SYSTEM_PROMPT` | System prompt for the agent |
| `${PREFIX}_MAX_OUTPUT_TOKENS` | Maximum output tokens |
| `${PREFIX}_TEMPERATURE` | Sampling temperature (0-2) |

---

## 6. Workflow State Machine

### 6.1 State Diagram

```
┌─────────┐
│  idle   │
└────┬────┘
     │ StartStoryProject
     ▼
┌─────────────┐
│  running    │◄──────────┐
│  (phase1)   │            │
└────┬────────┘            │
     │ Phase1 Complete     │ Retry
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (cp-1-worldview)  │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│  running    │◄──────────┐
│  (phase2)   │            │
└────┬────────┘            │
     │ Phase2 Complete     │ Retry
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (cp-2-outline)    │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│  running    │◄──────────┐
│  (phase3)   │            │
└────┬────────┘            │
     │ Phase3 Complete     │ Retry
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (cp-3-final)      │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│ completed   │ ───► idle (new project)
└─────────────┘
```

### 6.2 State Descriptions

| State | Description |
|-------|-------------|
| `idle` | Initial state, no active workflow |
| `running` | Phase is actively executing |
| `waiting_checkpoint` | Awaiting user confirmation |
| `completed` | Workflow finished successfully |
| `failed` | Workflow failed after max retries |

### 6.3 Phase Status Values

**Phase1 Status**:
- `running` - World building in progress
- `validating` - Validating world consistency
- `pending_confirmation` - Waiting for user checkpoint approval

**Phase2 Status**:
- `pending` - Not yet started
- `running` - Outline drafting or content production
- `pending_confirmation` - Waiting for outline checkpoint
- `content_production` - Writing chapters
- `completed` - All chapters completed

**Phase3 Status**:
- `pending` - Not yet started
- `polishing_complete` - All chapters polished
- `final_editing_complete` - Final edit completed
- `waiting_final_acceptance` - Awaiting user final approval
- `completed` - All phases complete

---

## File Locations

| Component | File Path |
|-----------|-----------|
| Main Entry | `Plugin/StoryOrchestrator/core/StoryOrchestrator.js` |
| State Manager | `Plugin/StoryOrchestrator/core/StateManager.js` |
| Workflow Engine | `Plugin/StoryOrchestrator/core/WorkflowEngine.js` |
| Agent Definitions | `Plugin/StoryOrchestrator/agents/AgentDefinitions.js` |
| Agent Dispatcher | `Plugin/StoryOrchestrator/agents/AgentDispatcher.js` |
| Phase1 Implementation | `Plugin/StoryOrchestrator/core/Phase1_WorldBuilding.js` |
| Phase2 Implementation | `Plugin/StoryOrchestrator/core/Phase2_OutlineDrafting.js` |
| Phase3 Implementation | `Plugin/StoryOrchestrator/core/Phase3_Refinement.js` |
| Chapter Operations | `Plugin/StoryOrchestrator/core/ChapterOperations.js` |
| Content Validator | `Plugin/StoryOrchestrator/core/ContentValidator.js` |
| Validation Schemas | `Plugin/StoryOrchestrator/utils/ValidationSchemas.js` |
| Text Metrics | `Plugin/StoryOrchestrator/utils/TextMetrics.js` |
| Prompt Builder | `Plugin/StoryOrchestrator/utils/PromptBuilder.js` |
| Plugin Manifest | `Plugin/StoryOrchestrator/plugin-manifest.json` |
