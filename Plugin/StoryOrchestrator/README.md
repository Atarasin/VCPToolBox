# StoryOrchestrator 插件使用指南

## 概述

StoryOrchestrator 是一个多智能体协作短文小说创作插件，通过 8 个专业化 Agent 的分工协作与代码工作流编排，实现 1-5 万字小说的自动化创作流程。

## 安装配置

### 1. 插件安装

将插件目录复制到 VCP 插件目录：
```bash
cp -r StoryOrchestrator /path/to/VCPToolBox/Plugin/
```

### 2. 配置 Agent

在 `config.env` 中配置 8 个执行 Agent：

```bash
# 创意生成层
AGENT_WORLD_BUILDER_MODEL_ID=your-model-id
AGENT_WORLD_BUILDER_CHINESE_NAME=世界观设定
AGENT_WORLD_BUILDER_SYSTEM_PROMPT=你是专业的世界观设定师...

AGENT_CHARACTER_DESIGNER_MODEL_ID=your-model-id
AGENT_CHARACTER_DESIGNER_CHINESE_NAME=人物塑造
AGENT_CHARACTER_DESIGNER_SYSTEM_PROMPT=你是专业的人物设计师...

AGENT_PLOT_ARCHITECT_MODEL_ID=your-model-id
AGENT_PLOT_ARCHITECT_CHINESE_NAME=情节架构
AGENT_PLOT_ARCHITECT_SYSTEM_PROMPT=你是专业的情节架构师...

# 内容生产层
AGENT_CHAPTER_WRITER_MODEL_ID=your-model-id
AGENT_CHAPTER_WRITER_CHINESE_NAME=章节执笔
AGENT_CHAPTER_WRITER_SYSTEM_PROMPT=你是专业的章节撰写师...

AGENT_DETAIL_FILLER_MODEL_ID=your-model-id
AGENT_DETAIL_FILLER_CHINESE_NAME=细节填充
AGENT_DETAIL_FILLER_SYSTEM_PROMPT=你是专业的场景描写师...

# 质量保障层
AGENT_LOGIC_VALIDATOR_MODEL_ID=your-model-id
AGENT_LOGIC_VALIDATOR_CHINESE_NAME=逻辑校验
AGENT_LOGIC_VALIDATOR_SYSTEM_PROMPT=你是严格的逻辑校验员...

AGENT_STYLE_POLISHER_MODEL_ID=your-model-id
AGENT_STYLE_POLISHER_CHINESE_NAME=文笔润色
AGENT_STYLE_POLISHER_SYSTEM_PROMPT=你是专业的文笔润色师...

AGENT_FINAL_EDITOR_MODEL_ID=your-model-id
AGENT_FINAL_EDITOR_CHINESE_NAME=终校定稿
AGENT_FINAL_EDITOR_SYSTEM_PROMPT=你是严谨的终校编辑...
```

### 3. 启用插件

在主 `config.env` 中启用：
```bash
StoryOrchestrator_ENABLED=true
```

重启 VCP 服务器：
```bash
pm2 restart server
```

## 基本使用流程

### 第一步：启动故事项目

使用 `StartStoryProject` 命令启动新的创作项目：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于AI觉醒的科幻故事，主角是一个家用机器人，在一次意外中获得了自我意识，开始探索人类与AI共存的伦理边界「末」,
target_word_count:「始」3000「末」,
genre:「始」科幻「末」,
style_preference:「始」硬科幻风格，注重逻辑和细节描写「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明**：
- `story_prompt` (必需): 故事梗概或开头
- `target_word_count` (可选): 目标字数，默认3000
- `genre` (可选): 故事类型（科幻、奇幻、现实等）
- `style_preference` (可选): 文风偏好

**返回示例**：
```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123",
    "status": "phase1_running",
    "message": "故事项目已启动，正在执行第一阶段：世界观与人设搭建",
    "estimated_completion": "2026-01-15T12:00:00Z"
  }
}
```

### 第二步：查询项目状态

使用 `QueryStoryStatus` 查看创作进度：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」story-abc123「末」
<<<[END_TOOL_REQUEST]>>>
```

**返回示例**：
```json
{
  "status": "success",
  "result": {
    "story_id": "story-abc123",
    "phase": 1,
    "phase_name": "世界观与人设搭建",
    "status": "world_building_complete",
    "progress_percent": 45,
    "checkpoint_pending": true,
    "checkpoint_id": "cp-1-worldview",
    "agents_active": ["世界观设定", "人物塑造"],
    "message": "世界观和人物档案已生成，等待用户确认"
  }
}
```

### 第三步：用户确认检查点

当系统显示 `checkpoint_pending: true` 时，查看生成的内容并决定是否继续：

**批准继续**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」story-abc123「末」,
checkpoint_id:「始」cp-1-worldview「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

**要求修改**（提供反馈）：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」story-abc123「末」,
checkpoint_id:「始」cp-1-worldview「末」,
approval:「始」false「末」,
feedback:「始」世界观设定很好，但主角的人设需要调整：1. 增加更多内心矛盾的描写 2. 背景故事需要更丰富「末」
<<<[END_TOOL_REQUEST]>>>
```

## 工作流状态机

StoryOrchestrator 采用有限状态机（FSM）管理整个创作生命周期，状态转换如下：

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
     │ Phase1完成          │ 重试
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (checkpoint_id:   │
│  cp-1-worldview)  │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│  running    │◄──────────┐
│  (phase2)   │            │
└────┬────────┘            │
     │ Phase2完成          │ 重试
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (checkpoint_id:   │
│  cp-2-outline)    │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│  running    │◄──────────┐
│  (phase3)   │            │
└────┬────────┘            │
     │ Phase3完成          │ 重试
     ▼                     │
┌──────────────────┐       │
│ waiting_checkpoint│──────┘
│ (checkpoint_id:   │
│  cp-3-final)      │
└────┬──────────────┘
     │ UserConfirmCheckpoint(approval=true)
     ▼
┌─────────────┐
│ completed   │ ───► idle (新项目)
└─────────────┘
```

### 状态说明

| 状态 | 描述 | 可转换至 |
|------|------|---------|
| `idle` | 空闲状态，等待启动 | `running(phase1)` |
| `running(phase1)` | 第一阶段：世界观与人设搭建 | `waiting_checkpoint` |
| `running(phase2)` | 第二阶段：大纲与正文生产 | `waiting_checkpoint` |
| `running(phase3)` | 第三阶段：润色校验与终稿 | `waiting_checkpoint` |
| `waiting_checkpoint` | 等待用户确认 | `running(对应phase)` 或 `completed` |
| `completed` | 工作流完成 | `idle` |
| `error` | 错误状态（未在图中显示） | `waiting_checkpoint` 或 `idle` |

### 拒绝分支

当用户拒绝检查点时（`approval=false`）：
```
waiting_checkpoint → running(对应phase) → waiting_checkpoint
```

## 三阶段工作流程详解

### 第一阶段：世界观与人设搭建（并行）

**执行逻辑**：
```
┌─────────────────────────────────────────────────────────────┐
│                      Phase 1 并行执行流程                    │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌──────────────┐         ┌──────────────┐               │
│   │ 世界观设定    │         │ 人物塑造      │               │
│   │ Agent        │         │ Agent        │               │
│   └──────┬───────┘         └──────┬───────┘               │
│          │                         │                        │
│          └───────────┬─────────────┘                        │
│                      ▼                                      │
│            ┌─────────────────┐                              │
│            │ 逻辑校验 Agent   │                              │
│            │ 审查一致性       │                              │
│            └────────┬────────┘                              │
│                     ▼                                       │
│            ┌─────────────────┐                              │
│            │  等待用户确认    │ ◄── 检查点1: cp-1-worldview │
│            │ (checkpoint)    │                              │
│            └─────────────────┘                              │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**详细步骤**：
1. **并行触发**：世界观设定Agent 和 人物塑造Agent 同时开始工作
2. **交叉验证**：逻辑校验Agent 并行审查两者的输出，检查设定一致性
3. **冲突处理**：工作流根据逻辑校验结果触发修订或等待人工确认，避免设定冲突直接进入后续阶段
4. **用户确认**：生成世界观文档和人物档案，等待用户确认（检查点1）

**确认内容**：
- 世界观文档（背景、规则、势力体系）
- 人物档案（主角、配角、关系网络）

**超时行为**：检查点默认24小时自动批准（`USER_CHECKPOINT_TIMEOUT_MS`）

### 第二阶段：大纲与正文生产（串行+并行混合）

**执行逻辑**：
```
┌─────────────────────────────────────────────────────────────┐
│                    Phase 2 混合执行流程                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  【串行：大纲阶段】                                          │
│  ┌─────────────────┐                                        │
│  │ 情节架构 Agent  │                                        │
│  │ 生成分章大纲    │                                        │
│  └────────┬────────┘                                        │
│           ▼                                                 │
│  ┌─────────────────┐                                        │
│  │ 逻辑校验 Agent   │                                        │
│  │ 审查大纲        │                                        │
│  └────────┬────────┘                                        │
│           ▼                                                  │
│  ┌─────────────────┐    ┌─────────────────┐                │
│  │ 等待用户确认     │ ◄──│ 用户可调整大纲   │                │
│  │ cp-2-outline    │    └─────────────────┘                │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                  │
│  【并行：正文阶段】                                          │
│           │                                                  │
│  ┌────────┴────────┐                                        │
│  ▼                 ▼                                        │
│ ┌────────┐   ┌────────────┐  ┌────────────┐               │
│ │ 第1章   │──►│ 第2章       │──►│ 第N章       │               │
│ │ 执笔    │   │ 执笔        │   │ 执笔        │               │
│ └────────┘   └────────────┘  └────────────┘               │
│      │                                                    │
│      │ 细节填充Agent并行渲染场景                          │
│      ▼                                                    │
│ ┌─────────────────┐                                        │
│ │ 逻辑校验Agent    │                                        │
│ │ 实时跟进        │                                        │
│ └─────────────────┘                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**详细步骤**：
1. **串行大纲生成**：情节架构Agent 生成分章大纲
2. **大纲审查**：逻辑校验Agent 审查大纲逻辑完整性
3. **用户确认**：等待用户确认大纲（检查点2）
4. **串行正文生产**：章节执笔Agent **逐章撰写**（第N章定稿后才开始N+1章）
5. **并行场景渲染**：细节填充Agent **并行**渲染各章场景
6. **实时校验**：每章完成后逻辑校验Agent 实时跟进

**确认内容**：
- 分章大纲（章节标题、核心事件、字数分配）
- 各章节正文（可选逐章确认）

### 第三阶段：润色校验与终稿（迭代循环）

**执行逻辑**：
```
┌─────────────────────────────────────────────────────────────┐
│                   Phase 3 迭代执行流程                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│            ┌─────────────────┐                              │
│            │ 质量评估        │                              │
│            │ (达到阈值？)     │                              │
│            └────────┬────────┘                              │
│                     │                                       │
│          ┌──────────┴──────────┐                           │
│          ▼                     ▼                            │
│     ┌─────────┐          ┌─────────────┐                  │
│     │ 质量达标 │          │ 迭代循环    │                  │
│     │ (退出)   │          │             │                  │
│     └────┬────┘          └──────┬──────┘                  │
│          │                      │                           │
│          │                      ▼                           │
│          │            ┌─────────────────┐                  │
│          │            │ 文笔润色 Agent   │                  │
│          │            └────────┬────────┘                  │
│          │                      │                           │
│          │                      ▼                           │
│          │            ┌─────────────────┐                  │
│          │            │ 逻辑校验 Agent  │                  │
│          │            └────────┬────────┘                  │
│          │                      │                           │
│          │                      └───────────────────────────┘
│          │                                                   │
│          ▼                                                   │
│  ┌─────────────────┐                                        │
│  │ 终校定稿 Agent  │                                        │
│  └────────┬────────┘                                        │
│           ▼                                                  │
│  ┌─────────────────┐                                        │
│  │ 等待用户验收     │ ◄── 检查点3: cp-3-final              │
│  │ cp-3-final      │                                        │
│  └─────────────────┘                                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**详细步骤**：
1. **迭代循环**：
   - 文笔润色Agent 优化表达
   - 逻辑校验Agent 复核一致性
   - 质量评分 ≥ `QUALITY_THRESHOLD` 时退出循环
   - 达到 `MAX_PHASE_ITERATIONS` 时强制退出
2. **终校定稿**：终校定稿Agent 进行最终编辑
3. **用户验收**：等待用户验收（检查点3）

**迭代退出条件**：
- 质量评分达到 `QUALITY_THRESHOLD`（默认8.0）
- 迭代次数达到 `MAX_PHASE_ITERATIONS`（默认5次）

## 检查点机制

### 检查点类型

| 检查点ID | 阶段 | 类型 | 确认内容 | 超时默认行为 |
|---------|------|------|---------|-------------|
| `cp-1-worldview` | Phase1 | `worldview_confirmation` | 世界观文档 + 人物档案 | 24小时后自动批准 |
| `cp-2-outline` | Phase2 | `outline_confirmation` | 分章大纲 | 24小时后自动批准 |
| `cp-3-final` | Phase3 | `final_acceptance` | 完整故事终稿 | 24小时后自动批准 |

### 超时行为

```
USER_CHECKPOINT_TIMEOUT_MS = 86400000 (24小时)
```

当检查点等待超时时：
- **auto-approve**: 系统自动批准当前阶段，用户可在完成后审阅
- **日志记录**: 记录超时自动批准事件到工作流日志
- **可恢复**: 用户仍可使用 `UserConfirmCheckpoint` 拒绝并要求修改

### 拒绝处理

当用户拒绝检查点（`approval=false`）时：

1. **记录反馈**：将用户反馈存储到工作流状态
2. **重新运行**：自动重新运行对应Phase
3. **参数传递**：将反馈作为上下文传递给相关Agent
4. **迭代计数**：如果因拒绝触发重试，计入 `retry_count`

**反馈示例**：
```json
{
  "checkpoint_id": "cp-1-worldview",
  "approval": false,
  "feedback": "主角人设需要更深的内心矛盾描写",
  "retry_count": 1,
  "timestamp": "2026-01-15T10:30:00Z"
}
```

## 错误恢复

### 崩溃后自动恢复

StoryOrchestrator 内置自动恢复机制：

1. **状态持久化**：每个关键操作后保存工作流状态到 `state/` 目录
2. **启动检测**：重启时检测未完成的工作流
3. **自动续接**：从最后一个检查点继续执行

**状态文件结构**：
```
Plugin/StoryOrchestrator/state/
└── stories/                        # 故事状态文件目录
    ├── story-abc123.json          # 单个 JSON 文件，包含完整状态
    ├── story-def456.json
    └── index.json                 # 故事索引（可选）
```

**注意**：状态存储为扁平文件结构（`state/stories/*.json`），各阶段上下文、章节内容和检查点历史均包含在单个 JSON 文件中，而非子目录结构。

### 手动恢复命令

**RecoverStoryWorkflow** - 手动恢复卡住的工作流：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」story-abc123「末」,
recovery_action:「始」continue「末」,
target_phase:「始」phase2「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明**：
- `recovery_action`: 恢复动作
  - `continue`: 从当前状态继续
  - `restart_phase`: 重新运行指定阶段
  - `rollback`: 回滚到上一个检查点
- `target_phase`: 目标阶段（当 `recovery_action=restart_phase` 时使用）

### 重试机制

```
┌─────────────────────────────────────────────────────────────┐
│                      重试机制流程                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  执行失败                                                    │
│     │                                                       │
│     ▼                                                       │
│  ┌─────────────────┐                                        │
│  │ retry_count < 3? │                                        │
│  └────────┬────────┘                                        │
│           │                                                 │
│     ┌─────┴─────┐                                           │
│     ▼           ▼                                           │
│   Yes          No                                            │
│     │           │                                           │
│     ▼           ▼                                           │
│  ┌─────────┐  ┌─────────────────┐                           │
│  │ 退避等待 │  │ 标记为error     │                           │
│  │ 2^n 秒   │  │ 等待人工干预    │                           │
│  └────┬────┘  └─────────────────┘                           │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────┐                                        │
│  │ 重试执行        │                                        │
│  │ (retry_count++) │                                        │
│  └────────┬────────┘                                        │
│           │                                                  │
│           ▼                                                   │
│     ┌─────────┐                                              │
│     │ 成功？  │                                              │
│     └────┬────┘                                              │
│          │                                                   │
│    ┌─────┴─────┐                                             │
│    ▼           ▼                                             │
│   Yes          No                                            │
│    │           │                                             │
│    ▼           └──► [回到 retry_count < 3? 检查]            │
│  继续执行                                                 │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**退避策略**：
- 第1次重试：等待 2^1 = 2 秒
- 第2次重试：等待 2^2 = 4 秒
- 第3次重试：等待 2^3 = 8 秒
- 最大重试次数：3次

**重试触发条件**：
- Agent 调用超时
- 网络请求失败
- 临时性系统错误

**不重试条件**：
- 用户主动取消
- 永久性配置错误
- 资源耗尽（如API余额不足）

## WebSocket 通知

StoryOrchestrator 支持 WebSocket 实时通知，客户端可以订阅工作流事件。

### 连接方式

```javascript
// 连接到 VCP WebSocket 服务器
const ws = new WebSocket('ws://localhost:5890');

// 订阅 StoryOrchestrator 事件
ws.send(JSON.stringify({
  type: 'subscribe',
  channel: 'StoryOrchestrator',
  story_id: 'story-abc123'  // 可选，订阅特定项目
}));
```

### 事件类型

| 事件类型 | 描述 | 触发时机 |
|---------|------|---------|
| `workflow_started` | 工作流启动 | 调用 `StartStoryProject` 成功 |
| `phase_started` | 阶段开始 | 进入新的 Phase |
| `phase_completed` | 阶段完成 | 一个 Phase 执行完成 |
| `checkpoint_pending` | 检查点待确认 | 等待用户确认时 |
| `checkpoint_approved` | 检查点已批准 | 用户批准检查点 |
| `checkpoint_rejected` | 检查点已拒绝 | 用户拒绝检查点 |
| `iteration_completed` | 迭代完成 | Phase3 中一次迭代完成 |
| `quality_assessed` | 质量评估 | 每次质量评分后 |
| `workflow_completed` | 工作流完成 | 所有阶段完成 |
| `workflow_error` | 工作流错误 | 发生不可恢复错误 |

### 通知格式示例

**workflow_started**:
```json
{
  "type": "workflow_started",
  "story_id": "story-abc123",
  "timestamp": "2026-01-15T10:00:00Z",
  "data": {
    "phase": 1,
    "phase_name": "世界观与人设搭建",
    "agents_active": ["世界观设定", "人物塑造"]
  }
}
```

**checkpoint_pending**:
```json
{
  "type": "checkpoint_pending",
  "story_id": "story-abc123",
  "timestamp": "2026-01-15T10:30:00Z",
  "data": {
    "checkpoint_id": "cp-1-worldview",
    "checkpoint_type": "worldview_confirmation",
    "phase": 1,
    "content_summary": {
      "worldview_doc": "科幻世界观设定（12个势力、3条历史主线）",
      "character_profiles": "5个主要人物、12个配角"
    },
    "timeout_at": "2026-01-16T10:30:00Z"
  }
}
```

**phase_completed**:
```json
{
  "type": "phase_completed",
  "story_id": "story-abc123",
  "timestamp": "2026-01-15T11:00:00Z",
  "data": {
    "phase": 1,
    "phase_name": "世界观与人设搭建",
    "duration_seconds": 3600,
    "output": {
      "worldview_doc": "已生成",
      "character_profiles": "已生成"
    }
  }
}
```

**iteration_completed** (Phase3):
```json
{
  "type": "iteration_completed",
  "story_id": "story-abc123",
  "timestamp": "2026-01-15T14:00:00Z",
  "data": {
    "phase": 3,
    "iteration": 2,
    "max_iterations": 5,
    "quality_score": 7.5,
    "quality_threshold": 8.0,
    "issues_found": ["对话节奏略显拖沓", "第三章场景描写不足"]
  }
}
```

**workflow_completed**:
```json
{
  "type": "workflow_completed",
  "story_id": "story-abc123",
  "timestamp": "2026-01-15T16:00:00Z",
  "data": {
    "total_duration_seconds": 21600,
    "phases_completed": [1, 2, 3],
    "final_quality_score": 8.2,
    "word_count": 3250,
    "chapter_count": 5,
    "export_format": "markdown"
  }
}
```

## 配置参考

### 核心配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `MAX_PHASE_ITERATIONS` | 5 | Phase3 最大迭代次数 |
| `QUALITY_THRESHOLD` | 8.0 | 质量达标阈值（0-10分） |
| `USER_CHECKPOINT_TIMEOUT_MS` | 86400000 | 检查点超时（24小时） |
| `DEFAULT_TARGET_WORD_COUNT_MIN` | 2500 | 默认目标字数下限 |
| `DEFAULT_TARGET_WORD_COUNT_MAX` | 3500 | 默认目标字数上限 |
| `STORY_STATE_RETENTION_DAYS` | 30 | 状态文件保留天数 |
| `ORCHESTRATOR_DEBUG_MODE` | false | 调试模式开关 |

### Agent 配置参数

每个 Agent 支持以下配置：

| 参数 | 说明 | 示例 |
|------|------|------|
| `AGENT_*_MODEL_ID` | 使用的模型ID | `gpt-4`, `claude-3-opus` |
| `AGENT_*_CHINESE_NAME` | 中文显示名称 | `世界观设定` |
| `AGENT_*_SYSTEM_PROMPT` | 系统提示词 | 见上方配置示例 |
| `AGENT_*_MAX_OUTPUT_TOKENS` | 最大输出Token数 | `4000` |
| `AGENT_*_TEMPERATURE` | 生成温度 | `0.7` |

### 质量评分标准

Phase3 迭代循环使用以下评分维度：

| 维度 | 权重 | 评分标准 |
|------|------|---------|
| 逻辑一致性 | 30% | 情节逻辑、人物动机、时间线 |
| 文笔表达 | 25% | 句式流畅度、用词准确性 |
| 场景描写 | 20% | 氛围营造、细节真实感 |
| 人物塑造 | 15% | 性格一致、对话自然 |
| 整体可读性 | 10% | 节奏把控、阅读体验 |

## 高级功能

### 1. 创建章节草稿（手动调用）

如需手动生成某一章：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CreateChapterDraft「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」3「末」,
outline_context:「始」第三章：主角发现真相。场景：废弃实验室。核心事件：主角在旧实验室中找到创造者留下的日记，了解到自己被设计的真正目的。情绪：震惊、困惑、愤怒「末」,
target_word_count:「始」3000「末」
<<<[END_TOOL_REQUEST]>>>
```

### 2. 审查章节

对已完成章节进行质量审查：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ReviewChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」2「末」,
chapter_content:「始」[粘贴完整章节正文]「末」,
review_focus:「始」重点检查人物动机是否合理，情节转折是否突兀「末」
<<<[END_TOOL_REQUEST]>>>
```

**返回示例**：
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

### 3. 修订章节

根据审查结果进行定向修订：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ReviseChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」2「末」,
chapter_content:「始」[粘贴完整章节正文]「末」,
revision_instructions:「始」修复人物A的反应与性格不符的问题，增加第二幕转折的铺垫「末」,
issues:「始」["人物A反应OOC", "转折缺乏铺垫"]「末」,
max_rewrite_ratio:「始」0.3「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明**：
- `revision_instructions`: 修订指令
- `issues`: 问题清单
- `max_rewrite_ratio`: 最大改写比例（0-1），防止过度修改

### 4. 润色章节

优化章节文笔表达：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」PolishChapter「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」1「末」,
chapter_content:「始」[粘贴完整章节正文]「末」,
polish_focus:「始」统一文风，优化对话节奏，提升场景描写质感「末」
<<<[END_TOOL_REQUEST]>>>
```

### 5. 字数统计

精确统计章节字数：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CountChapterMetrics「末」,
chapter_content:「始」[粘贴完整章节正文]「末」,
target_min:「始」2500「末」,
target_max:「始」3500「末」,
count_mode:「始」cn_chars「末」,
length_policy:「始」min_only「末」
<<<[END_TOOL_REQUEST]>>>
```

**参数说明**：
- `count_mode`: `cn_chars`（中文字符）或 `non_whitespace`（非空白字符）
- `length_policy`: `range`（范围）或 `min_only`（仅下限）

**返回示例**：
```json
{
  "status": "success",
  "result": {
    "counts": {
      "actualCount": 2876,
      "chineseChars": 2876,
      "nonWhitespaceChars": 3124,
      "paragraphCount": 15
    },
    "validation": {
      "isQualified": true,
      "rangeStatus": "within_range",
      "suggestion": "字数达标"
    }
  }
}
```

### 6. 导出故事

项目完成后导出成品：

```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ExportStory「末」,
story_id:「始」story-abc123「末」,
format:「始」markdown「末」
<<<[END_TOOL_REQUEST]>>>
```

**支持格式**：`markdown`, `txt`, `json`

## 完整使用示例

### 示例1：全自动模式（最小干预）

```
用户: 我想写一个故事

AI: 我来帮您启动故事创作项目。请告诉我您想写什么类型的故事？

用户: 科幻，关于时间旅行的

AI: [调用 StartStoryProject]

[系统自动执行Phase1]

AI: 世界观和人物设定已完成！我为您构建了一个时间旅行者的世界，主角是一位物理学家。
    是否继续生成大纲？

用户: 继续

AI: [调用 UserConfirmCheckpoint approval=true]

[系统自动执行Phase2和Phase3]

AI: 故事创作完成！全文约3200字，共5章。是否导出？

用户: 导出

AI: [调用 ExportStory]
```

### 示例2：精细控制模式（逐章确认）

```
用户: 启动创作项目，故事梗概：[详细描述]

AI: [调用 StartStoryProject]

[Phase1完成]

AI: 世界观设定：[展示详细设定]
    人物档案：[展示人物设定]
    您是否满意？需要调整什么？

用户: 世界观很好，但主角年龄改为25岁

AI: [使用 UserConfirmCheckpoint 拒绝并提供反馈]
    反馈：主角年龄修改为25岁，已调整，确认继续？

用户: 确认

AI: [调用 UserConfirmCheckpoint approval=true]

[Phase2 - 大纲生成]

AI: 分章大纲：
    第1章：xxx
    第2章：xxx
    ...
    是否按此大纲创作？

用户: 第3章内容合并到第2章

AI: [调整大纲]
    已调整，确认继续？

用户: 确认

[逐章创作]

AI: 第1章已完成（2850字），内容预览：[前500字]
    是否继续下一章？

用户: 这一章结尾不够有力，重新写

AI: [调用 ReviseChapter 修改结尾]
    已修订，请查看。

用户: 好，继续

AI: [继续后续章节...]
```

### 示例3：修改已完成的章节

```
用户: 查看第3章

AI: [调用 QueryStoryStatus 获取第3章内容]
    第3章内容：[展示]

用户: 这一章字数不够，需要扩充

AI: [调用 CountChapterMetrics 检查字数]
    当前字数：1800字，低于目标2500字，缺少700字。
    是否自动扩充？

用户: 是

AI: [调用 CreateChapterDraft 重新生成章节]
    已扩充至2600字，新增内容包括：[说明]
```

## 系统提示词占位符

在系统提示词中可以使用以下占位符：

```
当前故事状态：{{StoryOrchestratorStatus}}
故事设定：{{StoryBible}}
```

这允许AI在对话中了解当前活跃的故事项目和其设定。

## 故障排除

### 1. 工作流卡住不动

**排查步骤**：

1. 查询当前状态：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」story-xxx「末」
<<<[END_TOOL_REQUEST]>>>
```

2. 根据返回状态判断：
   - `checkpoint_pending: true` → 等待用户确认，检查超时时间
   - `status: running` → Agent 正在执行，等待或检查日志
   - `status: error` → 发生错误，需要恢复

**解决方法**：

- **检查点卡住**：调用 `UserConfirmCheckpoint` 批准或拒绝
- **Phase执行卡住**：等待超时自动重试，或手动调用 `RecoverStoryWorkflow`
- **长时间无响应**：检查 VCP 服务器日志确认 Agent 调用情况

### 2. 检查点超时如何恢复

检查点超时会自动批准，但如果需要人工干预：

1. **查看超时状态**：
```json
{
  "checkpoint_pending": true,
  "checkpoint_id": "cp-2-outline",
  "auto_approved_at": "2026-01-16T10:30:00Z"
}
```

2. **拒绝并重新确认**（如需修改）：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」story-abc123「末」,
checkpoint_id:「始」cp-2-outline「末」,
approval:「始」false「末」,
feedback:「始」大纲需要调整：[具体修改意见]「末」
<<<[END_TOOL_REQUEST]>>>
```

3. **手动恢复工作流**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」story-abc123「末」,
recovery_action:「始」continue「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3. 如何手动重试 Phase

**重启指定阶段**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」story-abc123「末」,
recovery_action:「始」restart_phase「末」,
target_phase:「始」phase2「末」,
feedback:「始」上一版本大纲不够详细，需要更丰富的情节设定「末」
<<<[END_TOOL_REQUEST]>>>
```

**回滚到上一个检查点**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」story-abc123「末」,
recovery_action:「始」rollback「末」
<<<[END_TOOL_REQUEST]>>>
```
注意：`rollback` 操作会自动回滚到上一个有效的检查点，无需指定 target_checkpoint。

### 4. Agent 超时处理

某些章节可能因复杂度过高导致 Agent 超时：

**解决方法**：
1. 重新调用相同命令重试（系统自动退避）
2. 简化 `outline_context` 的描述，减少约束
3. 增加 `timeoutMs` 参数（如插件支持）

**手动触发重试**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CreateChapterDraft「末」,
story_id:「始」story-abc123「末」,
chapter_number:「始」3「末」,
outline_context:「始」第三章核心情节：...「末」,
target_word_count:「始」2500「末」,
timeoutMs:「始」120000「末」
<<<[END_TOOL_REQUEST]>>>
```

### 5. 字数不达标

如果章节字数始终不达标：

1. 检查 `target_word_count` 设置是否合理
2. 在 `CreateChapterDraft` 中明确指定字数要求
3. 使用 `CountChapterMetrics` 精确统计
4. 调用 `ReviseChapter` 进行定向扩充

### 6. 状态文件损坏恢复

如果状态文件损坏（如磁盘满、进程崩溃）：

1. **检查状态目录**：
```bash
ls -la Plugin/StoryOrchestrator/state/stories/
```

2. **清理并重建**：
```
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」story-abc123「末」,
recovery_action:「始」restart_phase「末」,
target_phase:「始」phase1「末」
<<<[END_TOOL_REQUEST]>>>
```

3. **完全重置**（最后手段）：
   - 删除 `state/stories/story-xxx.json` 文件
   - 重新调用 `StartStoryProject`

## 最佳实践

1. **详细的故事梗概**：提供越详细的故事梗概，生成的世界观和人物越符合预期
2. **及时确认检查点**：及时查看和确认检查点内容，避免 workflow 长时间暂停
3. **善用反馈**：拒绝检查点时提供具体修改意见，系统会根据反馈进行调整
4. **分阶段审查**：在Phase2可以逐章确认，确保每章质量
5. **保留修订历史**：系统会自动保存状态，可以随时查询之前版本
6. **监控质量评分**：Phase3 迭代时关注质量评分，低于阈值时及时调整
7. **WebSocket 监控**：生产环境建议使用 WebSocket 监控实时状态

## 配置文件示例

完整的 `config.env` 示例：

```bash
# StoryOrchestrator Plugin Configuration
ORCHESTRATOR_DEBUG_MODE=false
MAX_PHASE_ITERATIONS=5
QUALITY_THRESHOLD=8.0
DEFAULT_TARGET_WORD_COUNT_MIN=2500
DEFAULT_TARGET_WORD_COUNT_MAX=3500
USER_CHECKPOINT_TIMEOUT_MS=86400000
STORY_STATE_RETENTION_DAYS=30

# 8个Agent配置（示例）
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4
AGENT_WORLD_BUILDER_CHINESE_NAME=世界观设定
AGENT_WORLD_BUILDER_SYSTEM_PROMPT=你是专业的世界观设定师。构建故事的背景架构：1)时代背景与地理环境 2)物理规则 3)势力体系 4)关键历史。输出必须具体、一致、可扩展。
AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS=3000
AGENT_WORLD_BUILDER_TEMPERATURE=0.8

# ... 其他6个Agent配置
```

---

**如有问题，请查阅插件日志或联系管理员。**
