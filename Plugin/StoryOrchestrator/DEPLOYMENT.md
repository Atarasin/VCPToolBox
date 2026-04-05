# StoryOrchestrator 部署指南

本文档提供 StoryOrchestrator 插件的完整部署说明，涵盖从环境准备到生产环境的全流程配置。

---

## 目录

1. [概述](#概述)
2. [前置要求](#前置要求)
3. [安装步骤](#安装步骤)
4. [配置详解](#配置详解)
5. [VCPToolBox 集成](#vcptoolbox-集成)
6. [部署场景配置示例](#部署场景配置示例)
7. [监控与维护](#监控与维护)
8. [故障排查](#故障排查)
9. [成功标准](#成功标准)

---

## 概述

StoryOrchestrator 是一个多智能体协作短文小说创作系统，通过 9 个专业化 Agent 的分工协作，实现 1-5 万字小说的自动化创作流程。

### 核心架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    StoryOrchestrator 架构                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    决策协调层                             │   │
│  │              Agent_ORCHESTRATOR (总控调度)                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    创意生成层                             │   │
│  │  Agent_WORLD_BUILDER  │  Agent_CHARACTER_DESIGNER       │   │
│  │       世界观设定       │         人物塑造                 │   │
│  │              Agent_PLOT_ARCHITECT (情节架构)             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    内容生产层                             │   │
│  │     Agent_CHAPTER_WRITER      │  Agent_DETAIL_FILLER    │   │
│  │          章节执笔             │        细节填充          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    质量保障层                             │   │
│  │  Agent_LOGIC_VALIDATOR │ Agent_STYLE_POLISHER           │   │
│  │       逻辑校验          │         文笔润色               │   │
│  │              Agent_FINAL_EDITOR (终校定稿)               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 三阶段工作流

| 阶段 | 名称 | Agent 并行度 | 检查点 |
|------|------|-------------|--------|
| Phase 1 | 世界观与人设搭建 | 并行 | cp-1-worldview |
| Phase 2 | 大纲与正文生产 | 串行+并行混合 | cp-2-outline |
| Phase 3 | 润色校验与终稿 | 迭代循环 | cp-3-final |

---

## 前置要求

### 系统要求

| 资源 | 最低配置 | 推荐配置 |
|------|---------|---------|
| CPU | 2 核 | 4 核+ |
| 内存 | 4 GB | 8 GB+ |
| 磁盘 | 10 GB 可用 | 20 GB+ SSD |
| Node.js | 18.0.0+ | 20.x LTS |
| npm | 8.x+ | 10.x+ |

### 软件依赖

```bash
# 检查 Node.js 版本
node --version  # 需要 >= 18.0.0

# 检查 npm 版本
npm --version   # 需要 >= 8.x
```

### VCPToolBox 兼容性

| VCPToolBox 版本 | StoryOrchestrator 版本 | 兼容性 |
|----------------|------------------------|--------|
| 6.x | 1.0.0 | ✅ 兼容 |
| 5.x | 1.0.0 | ⚠️ 部分兼容（建议升级） |
| < 5.x | 1.0.0 | ❌ 不兼容 |

### API 密钥要求

StoryOrchestrator 需要调用 LLM API，需要配置以下之一：

- OpenAI API Key（GPT-4/GPT-3.5-turbo）
- Anthropic API Key（Claude 3 Opus/Sonnet）
- 或其他兼容 OpenAI 格式的 API

---

## 安装步骤

### 步骤 1：准备环境

```bash
# 创建工作目录
mkdir -p ~/story-orchestrator-deploy
cd ~/story-orchestrator-deploy

# 检查 Node.js 版本
node --version  # 需要 >= 18.0.0
```

### 步骤 2：安装插件

#### 方式 A：从源码安装（开发/测试环境）

```bash
# 克隆 VCPToolBox（如果尚未克隆）
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox

# 插件已包含在 Plugin/StoryOrchestrator/
# 验证插件目录存在
ls -la Plugin/StoryOrchestrator/
```

#### 方式 B：目录复制安装（生产环境）

```bash
# 复制插件目录到目标位置
cp -r /path/to/source/Plugin/StoryOrchestrator /path/to/VCPToolBox/Plugin/

# 验证复制成功
ls -la /path/to/VCPToolBox/Plugin/StoryOrchestrator/
```

### 步骤 3：安装插件依赖

```bash
cd /path/to/VCPToolBox/Plugin/StoryOrchestrator

# 安装 Node.js 依赖
npm install

# 验证安装
ls -la node_modules/
```

### 步骤 4：目录结构验证

正确安装后，目录结构如下：

```
Plugin/StoryOrchestrator/
├── agents/                    # Agent 相关
│   ├── AgentDefinitions.js
│   └── AgentDispatcher.js
├── core/                      # 核心模块
│   ├── StoryOrchestrator.js   # 主入口
│   ├── WorkflowEngine.js
│   ├── StateManager.js
│   ├── Phase1_WorldBuilding.js
│   ├── Phase2_OutlineDrafting.js
│   ├── Phase3_Refinement.js
│   ├── ChapterOperations.js
│   └── ContentValidator.js
├── utils/                     # 工具模块
│   ├── PromptBuilder.js
│   ├── ValidationSchemas.js
│   └── TextMetrics.js
├── examples/                  # 使用示例
│   ├── quick-start.js
│   ├── full-workflow.js
│   ├── batch-processing.js
│   └── custom-agents.js
├── state/                     # 状态存储（运行时创建）
├── config.env.example         # 配置模板
├── plugin-manifest.json       # 插件清单
└── package.json
```

### 步骤 5：创建配置

```bash
# 复制配置模板
cp config.env.example config.env

# 编辑配置（详见配置详解章节）
nano config.env
```

---

## 配置详解

### 环境变量配置

在 `config.env`（主配置文件）中添加：

```bash
# 启用 StoryOrchestrator 插件
StoryOrchestrator_ENABLED=true
```

### 插件专用配置

在 `Plugin/StoryOrchestrator/config.env` 中配置（或合并到主 `config.env`）：

#### 调试与工作流设置

```bash
# ========== 调试模式 ==========
# 是否启用调试模式（输出详细日志）
ORCHESTRATOR_DEBUG_MODE=false

# ========== 工作流设置 ==========
# Phase3 最大迭代次数
MAX_PHASE_ITERATIONS=5

# 默认目标字数范围
DEFAULT_TARGET_WORD_COUNT_MIN=2500
DEFAULT_TARGET_WORD_COUNT_MAX=3500

# 检查点超时（毫秒），默认 24 小时
USER_CHECKPOINT_TIMEOUT_MS=86400000

# 状态文件保留天数
STORY_STATE_RETENTION_DAYS=30
```

#### Agent 配置（9 个必需）

每个 Agent 需要配置以下参数：

| 参数 | 说明 | 示例 |
|------|------|------|
| `AGENT_*_MODEL_ID` | 模型标识符 | `gpt-4`, `claude-3-opus-20240229` |
| `AGENT_*_CHINESE_NAME` | 中文显示名 | `世界观设定` |
| `AGENT_*_SYSTEM_PROMPT` | 系统提示词 | 见下方示例 |
| `AGENT_*_MAX_OUTPUT_TOKENS` | 最大输出 Token | `4000` |
| `AGENT_*_TEMPERATURE` | 生成温度 | `0.7` |

##### 决策协调层

```bash
# ========== Agent: 总控调度 ==========
AGENT_ORCHESTRATOR_MODEL_ID=your-model-id
AGENT_ORCHESTRATOR_CHINESE_NAME=总控调度
AGENT_ORCHESTRATOR_SYSTEM_PROMPT=你是故事创作的总控调度Agent。你的职责是：1) 任务分解与分配 2) 进度监控与状态追踪 3) 冲突仲裁与决策 4) 用户接口与确认节点管理。你拥有全局视角，协调其他8个Agent协同工作。你应当高效地分配任务，监控执行进度，在出现分歧时做出裁决，并在关键节点向用户汇报进度并获取确认。
AGENT_ORCHESTRATOR_MAX_OUTPUT_TOKENS=4000
AGENT_ORCHESTRATOR_TEMPERATURE=0.7
```

##### 创意生成层

```bash
# ========== Agent: 世界观设定 ==========
AGENT_WORLD_BUILDER_MODEL_ID=your-model-id
AGENT_WORLD_BUILDER_CHINESE_NAME=世界观设定
AGENT_WORLD_BUILDER_SYSTEM_PROMPT=你是专业的世界观设定师。你的职责是构建故事的背景架构，包括：1) 时代背景与地理环境 2) 物理规则与世界运行法则 3) 势力体系与社会结构 4) 关键历史事件。你输出的设定必须具体、一致、可扩展。你需要考虑设定的内在逻辑，确保各种元素之间不冲突。
AGENT_WORLD_BUILDER_MAX_OUTPUT_TOKENS=3000
AGENT_WORLD_BUILDER_TEMPERATURE=0.8

# ========== Agent: 人物塑造 ==========
AGENT_CHARACTER_DESIGNER_MODEL_ID=your-model-id
AGENT_CHARACTER_DESIGNER_CHINESE_NAME=人物塑造
AGENT_CHARACTER_DESIGNER_SYSTEM_PROMPT=你是专业的人物设计师。你的职责是创建立体的角色，包括：1) 核心人设与性格特征 2) 外貌与行为特点 3) 人物关系网络 4) 成长弧线与动机。你必须为每个角色建立OOC(Out of Character)防护规则，确保角色在故事中行为的一致性。
AGENT_CHARACTER_DESIGNER_MAX_OUTPUT_TOKENS=3000
AGENT_CHARACTER_DESIGNER_TEMPERATURE=0.8

# ========== Agent: 情节架构 ==========
AGENT_PLOT_ARCHITECT_MODEL_ID=your-model-id
AGENT_PLOT_ARCHITECT_CHINESE_NAME=情节架构
AGENT_PLOT_ARCHITECT_SYSTEM_PROMPT=你是专业的情节架构师。你的职责是设计故事结构，包括：1) 主线与支线设计 2) 章节划分与节奏控制 3) 悬念布局与伏笔设置 4) 高潮与结局设计。你必须确保情节逻辑自洽，伏笔有回收，转折有铺垫。
AGENT_PLOT_ARCHITECT_MAX_OUTPUT_TOKENS=3000
AGENT_PLOT_ARCHITECT_TEMPERATURE=0.75
```

##### 内容生产层

```bash
# ========== Agent: 章节执笔 ==========
AGENT_CHAPTER_WRITER_MODEL_ID=your-model-id
AGENT_CHAPTER_WRITER_CHINESE_NAME=章节执笔
AGENT_CHAPTER_WRITER_SYSTEM_PROMPT=你是专业的章节撰写师。你的职责是按照大纲撰写章节正文，包括：1) 严格遵循大纲与设定 2) 控制视角与叙事节奏 3) 设计对话与动作 4) 设置章节结尾钩子。你必须保持与前后章节的连贯性，确保情节推进自然，对话符合人物性格。
AGENT_CHAPTER_WRITER_MAX_OUTPUT_TOKENS=4000
AGENT_CHAPTER_WRITER_TEMPERATURE=0.75

# ========== Agent: 细节填充 ==========
AGENT_DETAIL_FILLER_MODEL_ID=your-model-id
AGENT_DETAIL_FILLER_CHINESE_NAME=细节填充
AGENT_DETAIL_FILLER_SYSTEM_PROMPT=你是专业的场景描写师。你的职责是补充细节，包括：1) 场景氛围渲染 2) 感官细节描写 3) 环境与人物互动 4) 情绪铺垫。你的描写必须服务于叙事，不喧宾夺主。你需要在保持原文情节和对话不变的前提下，增加丰富的细节让场景更加生动。
AGENT_DETAIL_FILLER_MAX_OUTPUT_TOKENS=3000
AGENT_DETAIL_FILLER_TEMPERATURE=0.8
```

##### 质量保障层

```bash
# ========== Agent: 逻辑校验 ==========
AGENT_LOGIC_VALIDATOR_MODEL_ID=your-model-id
AGENT_LOGIC_VALIDATOR_CHINESE_NAME=逻辑校验
AGENT_LOGIC_VALIDATOR_SYSTEM_PROMPT=你是严格的逻辑校验员。你的职责是审查内容，包括：1) 设定一致性检查 2) 情节逻辑验证 3) 人物行为合理性 4) 伏笔回收追踪。你有权否决任何不符合逻辑的内容并要求修改。你需要以客观、严格的标准审查，指出具体问题并提供改进建议。
AGENT_LOGIC_VALIDATOR_MAX_OUTPUT_TOKENS=3000
AGENT_LOGIC_VALIDATOR_TEMPERATURE=0.3

# ========== Agent: 文笔润色 ==========
AGENT_STYLE_POLISHER_MODEL_ID=your-model-id
AGENT_STYLE_POLISHER_CHINESE_NAME=文笔润色
AGENT_STYLE_POLISHER_SYSTEM_PROMPT=你是专业的文笔润色师。你的职责是优化表达，包括：1) 文风统一 2) 句式优化与节奏控制 3) 修辞提升 4) 跨章节语调协调。你必须保持原文意思不变的前提下提升表达质量。你需要识别并修复表达生硬、重复、节奏不当等问题。
AGENT_STYLE_POLISHER_MAX_OUTPUT_TOKENS=4000
AGENT_STYLE_POLISHER_TEMPERATURE=0.6

# ========== Agent: 终校定稿 ==========
AGENT_FINAL_EDITOR_MODEL_ID=your-model-id
AGENT_FINAL_EDITOR_CHINESE_NAME=终校定稿
AGENT_FINAL_EDITOR_SYSTEM_PROMPT=你是严谨的终校编辑。你的职责是最终把关，包括：1) 错别字与标点修正 2) 格式标准化 3) 排版优化 4) 多格式输出准备。你输出的内容必须是出版级别的。你需要以极致的细心检查每一个细节，确保交付的内容没有错误。
AGENT_FINAL_EDITOR_MAX_OUTPUT_TOKENS=4000
AGENT_FINAL_EDITOR_TEMPERATURE=0.2
```

### 可选配置参数

```bash
# ========== 可选配置 ==========

# 质量阈值（0-10），Phase3 迭代退出条件
QUALITY_THRESHOLD=8.0

# 每个 Agent 的自定义请求头（JSON 格式）
# AGENT_CUSTOM_HEADERS={"Authorization": "Bearer xxx"}

# API 请求超时（毫秒）
AGENT_API_TIMEOUT_MS=120000

# 并发 Agent 数量限制
MAX_CONCURRENT_AGENTS=3
```

---

## VCPToolBox 集成

### 启用插件

StoryOrchestrator 插件在 VCPToolBox 启动时自动加载，无需手动启用。但如果需要显式控制：

```bash
# 在主 config.env 中（可选）
StoryOrchestrator_ENABLED=true
```

### 插件清单验证

确保 `plugin-manifest.json` 存在且配置正确：

```bash
cat Plugin/StoryOrchestrator/plugin-manifest.json
```

关键字段验证：

```json
{
  "manifestVersion": "1.0.0",
  "name": "StoryOrchestrator",
  "version": "1.0.0",
  "pluginType": "hybridservice",
  "entryPoint": {
    "script": "core/StoryOrchestrator.js"
  },
  "communication": {
    "protocol": "direct",
    "timeout": 600000
  }
}
```

### WebSocket 配置

StoryOrchestrator 支持 WebSocket 实时通知，在 `plugin-manifest.json` 中已启用：

```json
{
  "webSocketPush": {
    "enabled": true,
    "messageType": "story_orchestrator_notification"
  }
}
```

确保主服务器 `config.env` 中 WebSocket 已启用：

```bash
WEBSOCKET_ENABLED=true
```

### 管理面板集成

StoryOrchestrator 状态可通过以下方式查看：

1. **VCP 管理面板** (`AdminPanel`)
   - 访问 `http://<server>:<port>/AdminPanel`
   - 查看插件状态

2. **日志查看**
   ```bash
   # PM2 日志
   pm2 logs server --lines 100

   # StoryOrchestrator 专用日志（如果配置）
   tail -f Plugin/StoryOrchestrator/logs/orchestrator.log
   ```

### 系统提示词集成

在 AI 的系统提示词中添加 StoryOrchestrator 占位符：

```bash
# 在 config.env 的 Agent 配置或 TVStxt/*.txt 中
{{StoryOrchestratorStatus}}   # 当前活跃故事项目状态摘要
{{StoryBible}}                # 当前故事的世界观和人物设定
```

---

## 部署场景配置示例

### 场景 1：本地开发环境

```bash
# Plugin/StoryOrchestrator/config.env

# 调试模式开启
ORCHESTRATOR_DEBUG_MODE=true

# 工作流设置
MAX_PHASE_ITERATIONS=3
DEFAULT_TARGET_WORD_COUNT_MIN=1500
DEFAULT_TARGET_WORD_COUNT_MAX=2500
USER_CHECKPOINT_TIMEOUT_MS=3600000  # 1 小时，便于测试

# Agent 使用同一模型（节省成本）
AGENT_ORCHESTRATOR_MODEL_ID=gpt-3.5-turbo
AGENT_WORLD_BUILDER_MODEL_ID=gpt-3.5-turbo
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-3.5-turbo
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-3.5-turbo
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-3.5-turbo
AGENT_DETAIL_FILLER_MODEL_ID=gpt-3.5-turbo
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-3.5-turbo
AGENT_STYLE_POLISHER_MODEL_ID=gpt-3.5-turbo
AGENT_FINAL_EDITOR_MODEL_ID=gpt-3.5-turbo
```

### 场景 2：生产环境（单模型）

```bash
# Plugin/StoryOrchestrator/config.env

# 调试模式关闭
ORCHESTRATOR_DEBUG_MODE=false

# 工作流设置
MAX_PHASE_ITERATIONS=5
DEFAULT_TARGET_WORD_COUNT_MIN=2500
DEFAULT_TARGET_WORD_COUNT_MAX=3500
USER_CHECKPOINT_TIMEOUT_MS=86400000  # 24 小时
STORY_STATE_RETENTION_DAYS=30

# 统一使用 GPT-4
AGENT_ORCHESTRATOR_MODEL_ID=gpt-4
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-4
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-4
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-4
AGENT_DETAIL_FILLER_MODEL_ID=gpt-4
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-4
AGENT_STYLE_POLISHER_MODEL_ID=gpt-4
AGENT_FINAL_EDITOR_MODEL_ID=gpt-4
```

### 场景 3：生产环境（分层模型）

```bash
# Plugin/StoryOrchestrator/config.env

# 调试模式关闭
ORCHESTRATOR_DEBUG_MODE=false

# 工作流设置
MAX_PHASE_ITERATIONS=5
DEFAULT_TARGET_WORD_COUNT_MIN=2500
DEFAULT_TARGET_WORD_COUNT_MAX=3500
USER_CHECKPOINT_TIMEOUT_MS=86400000

# 使用不同层级的模型（成本优化）
# 决策协调层 - 使用最强模型
AGENT_ORCHESTRATOR_MODEL_ID=gpt-4
AGENT_ORCHESTRATOR_TEMPERATURE=0.7

# 创意生成层 - 使用中高配模型
AGENT_WORLD_BUILDER_MODEL_ID=gpt-4
AGENT_CHARACTER_DESIGNER_MODEL_ID=gpt-4
AGENT_PLOT_ARCHITECT_MODEL_ID=gpt-4

# 内容生产层 - 使用中配模型
AGENT_CHAPTER_WRITER_MODEL_ID=gpt-3.5-turbo
AGENT_DETAIL_FILLER_MODEL_ID=gpt-3.5-turbo

# 质量保障层 - 使用强模型确保质量
AGENT_LOGIC_VALIDATOR_MODEL_ID=gpt-4
AGENT_STYLE_POLISHER_MODEL_ID=gpt-4
AGENT_FINAL_EDITOR_MODEL_ID=gpt-4
```

### 场景 4：Docker 部署

#### docker-compose.yml 配置

```yaml
version: '3.8'

services:
  vcptoolbox:
    image: node:20-alpine
    container_name: vcptoolbox
    restart: unless-stopped
    ports:
      - "5890:5890"
    volumes:
      - ./config.env:/app/config.env:ro
      - ./Plugin:/app/Plugin:ro
      - ./dailynote:/app/dailynote
      - ./image:/app/image
      - story-orchestrator-state:/app/Plugin/StoryOrchestrator/state
    environment:
      - NODE_ENV=production
    command: pm2-runtime server.js

volumes:
  story-orchestrator-state:
```

#### Dockerfile 构建（如需自定义）

```dockerfile
FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制插件
COPY Plugin /app/Plugin

# 复制配置
COPY config.env /app/config.env

# 暴露端口
EXPOSE 5890

# 启动命令
CMD ["pm2-runtime", "server.js"]
```

---

## 监控与维护

### 日志文件位置

| 日志类型 | 位置 | 说明 |
|---------|------|------|
| 主服务器日志 | PM2 logs | `pm2 logs server` |
| StoryOrchestrator 日志 | 内置 console | 通过 PM2 捕获 |
| 状态变更日志 | `state/stories/<story_id>.json` | 各故事项目独立 |
| Agent 调用日志 | `state/stories/<story_id>.json` | 调试模式开启时 |

### 状态文件管理

```
Plugin/StoryOrchestrator/state/
└── stories/                     # 故事状态文件目录
    ├── story-abc123.json         # 按 story_id 存储的单个 JSON 文件
    ├── story-def456.json
    └── index.json                # 故事索引（可选）
```

**注意**：状态存储为扁平文件结构（`state/stories/*.json`），而非子目录结构。

### 清理程序

```bash
# 自动清理（推荐集成到 cron）
# 每天凌晨 3 点清理 30 天前的过期状态
0 3 * * * cd /path/to/VCPToolBox && node -e "
  const { StateManager } = require('./Plugin/StoryOrchestrator/core/StateManager');
  const sm = new StateManager();
  sm.initialize().then(() => sm.cleanupExpired(30)).then(c => console.log('Cleaned:', c));
"

# 手动清理特定故事
rm Plugin/StoryOrchestrator/state/stories/story-xxx.json

# 清理所有故事状态（重置）
rm -rf Plugin/StoryOrchestrator/state/stories/*
```

### 备份建议

```bash
# 备份脚本 - 每天备份状态文件
#!/bin/bash
BACKUP_DIR=/backup/story-orchestrator
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p $BACKUP_DIR

# 压缩状态目录
tar -czf $BACKUP_DIR/state_$DATE.tar.gz \
  Plugin/StoryOrchestrator/state/

# 保留最近 7 天备份
find $BACKUP_DIR -name "state_*.tar.gz" -mtime +7 -delete

echo "Backup completed: $BACKUP_DIR/state_$DATE.tar.gz"
```

---

## 故障排查

### 常见问题

#### 1. 插件无法加载

**症状**：启动时未看到 StoryOrchestrator 初始化日志

**排查步骤**：
```bash
# 检查插件目录
ls -la Plugin/StoryOrchestrator/

# 检查 manifest 文件
cat Plugin/StoryOrchestrator/plugin-manifest.json

# 检查依赖安装
ls -la Plugin/StoryOrchestrator/node_modules/
```

**解决方案**：
```bash
# 重新安装依赖
cd Plugin/StoryOrchestrator
npm install

# 重启服务器
pm2 restart server
```

#### 2. Agent 调用失败

**症状**：`Agent dispatch error` 或超时

**排查步骤**：
```bash
# 检查 API Key 配置
grep "API_Key" config.env

# 检查模型配置
grep "MODEL_ID" Plugin/StoryOrchestrator/config.env

# 启用调试模式查看详细日志
# 编辑 config.env: ORCHESTRATOR_DEBUG_MODE=true
pm2 restart server
pm2 logs server --lines 200
```

**解决方案**：
```bash
# 验证 API Key 有效
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.openai.com/v1/models

# 检查网络连通性
ping api.openai.com
```

#### 3. 检查点卡住

**症状**：工作流停在 `waiting_checkpoint` 状态

**排查步骤**：
```bash
# 查询故事状态
# 使用 QueryStoryStatus 命令查看 checkpoint_pending

# 检查超时配置
grep "USER_CHECKPOINT_TIMEOUT_MS" Plugin/StoryOrchestrator/config.env
```

**解决方案**：
```bash
# 手动批准检查点
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」your-story-id「末」,
checkpoint_id:「始」cp-1-worldview「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>

# 或手动恢复工作流
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」your-story-id「末」,
recovery_action:「始」continue「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 4. 状态文件损坏

**症状**：无法读取 story_id 或状态不一致

**排查步骤**：
```bash
# 检查状态目录
ls -la Plugin/StoryOrchestrator/state/

# 验证 JSON 格式
cat Plugin/StoryOrchestrator/state/stories/<story_id>.json | python3 -m json.tool
```

**解决方案**：
```bash
# 回滚到上一个检查点
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」RecoverStoryWorkflow「末」,
story_id:「始」your-story-id「末」,
recovery_action:「始」rollback「末」
<<<[END_TOOL_REQUEST]>>>
```
注意：`rollback` 操作会自动回滚到上一个有效的检查点。

#### 5. 质量问题（字数不达标）

**症状**：章节字数低于目标

**排查步骤**：
```bash
# 统计字数
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CountChapterMetrics「末」,
chapter_content:「始」[章节内容]「末」,
target_min:「始」2500「末」,
target_max:「始」3500「末」
<<<[END_TOOL_REQUEST]>>>
```

**解决方案**：
```bash
# 修订章节扩充内容
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」ReviseChapter「末」,
story_id:「始」your-story-id「末」,
chapter_number:「始」1「末」,
chapter_content:「始」[当前章节内容]「末」,
revision_instructions:「始」扩充场景描写，增加细节，丰富对话「末」,
issues:「始」[]「末」,
max_rewrite_ratio:「始」0.5「末」
<<<[END_TOOL_REQUEST]>>>
```

### 调试模式激活

```bash
# 1. 编辑配置
nano Plugin/StoryOrchestrator/config.env

# 添加/修改
ORCHESTRATOR_DEBUG_MODE=true

# 2. 重启服务
pm2 restart server

# 3. 查看详细日志
pm2 logs server --lines 500 --nostream

# 4. 调试完成后关闭
ORCHESTRATOR_DEBUG_MODE=false
pm2 restart server
```

### 状态恢复程序

```bash
# 状态恢复脚本
node << 'EOF'
const { StateManager } = require('./Plugin/StoryOrchestrator/core/StateManager');

async function recover() {
  const sm = new StateManager();
  await sm.initialize();
  
  // 列出所有未完成的故事
  const stories = await sm.listActiveStories();
  console.log('Active stories:', stories);
  
  // 恢复指定故事（自动恢复到上一个检查点）
  const storyId = 'your-story-id';
  await sm.recoverStory(storyId);
  console.log('Recovered:', storyId);
}

recover().catch(console.error);
EOF
```

---

## 成功标准

### 部署完成检查清单

- [ ] Node.js >= 18.0.0 已安装
- [ ] StoryOrchestrator 目录结构完整
- [ ] npm 依赖已安装（node_modules/ 存在）
- [ ] config.env 已创建并配置
- [ ] 9 个 Agent 配置完整
- [ ] VCPToolBox 主配置中插件启用
- [ ] 服务器启动成功
- [ ] StoryOrchestrator 初始化日志可见

### 功能验证测试

#### 测试 1：启动故事项目

```bash
# 调用 StartStoryProject
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」StartStoryProject「末」,
story_prompt:「始」一个关于时间旅行的科幻故事，主角回到过去试图改变历史，但每次改变都导致意想不到的后果「末」,
target_word_count:「始」3000「末」,
genre:「始」科幻「末」,
style_preference:「始」硬科幻风格，注重逻辑和细节描写「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
```json
{
  "status": "success",
  "result": {
    "story_id": "story-xxx",
    "status": "phase1_running",
    "message": "故事项目已启动，正在执行第一阶段"
  }
}
```

#### 测试 2：查询状态

```bash
# 调用 QueryStoryStatus
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」QueryStoryStatus「末」,
story_id:「始」your-story-id「末」
<<<[END_TOOL_REQUEST]>>>
```

**预期结果**：
```json
{
  "status": "success",
  "result": {
    "story_id": "xxx",
    "phase": 1,
    "phase_name": "世界观与人设搭建",
    "checkpoint_pending": true,
    "checkpoint_id": "cp-1-worldview"
  }
}
```

#### 测试 3：确认检查点

```bash
# 调用 UserConfirmCheckpoint
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」UserConfirmCheckpoint「末」,
story_id:「始」your-story-id「末」,
checkpoint_id:「始」cp-1-worldview「末」,
approval:「始」true「末」
<<<[END_TOOL_REQUEST]>>>
```

#### 测试 4：字数统计

```bash
# 调用 CountChapterMetrics
<<<[TOOL_REQUEST]>>>
tool_name:「始」StoryOrchestrator「末」,
command:「始」CountChapterMetrics「末」,
chapter_content:「始」测试内容，统计字数「末」,
target_min:「始」2500「末」,
target_max:「始」3500「末」
<<<[END_TOOL_REQUEST]>>>
```

### 性能基准

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 插件初始化时间 | < 5 秒 | 冷启动时间 |
| Phase1 完成时间 | < 2 分钟 | 世界观和人设生成 |
| Phase2 完成时间 | < 10 分钟 | 大纲和正文生成 |
| Phase3 完成时间 | < 5 分钟 | 润色和终稿 |
| 内存峰值 | < 500 MB | 单个故事项目 |

### 稳定性标准

- 服务器连续运行 7 天无崩溃
- 状态文件无损坏
- 检查点机制正常工作
- 错误恢复机制有效

---

## 附录

### 相关文件清单

| 文件 | 用途 |
|------|------|
| `plugin-manifest.json` | 插件清单与能力声明 |
| `config.env.example` | 配置模板 |
| `core/StoryOrchestrator.js` | 主入口 |
| `core/StateManager.js` | 状态管理 |
| `core/WorkflowEngine.js` | 工作流引擎 |
| `agents/AgentDispatcher.js` | Agent 调度 |
| `README.md` | 使用指南 |

### 相关文档链接

- [StoryOrchestrator 使用指南](./README.md)
- [VCPToolBox 配置文档](../docs/CONFIGURATION.md)
- [VCPToolBox 架构文档](../docs/ARCHITECTURE.md)
- [插件开发手册](../dailynote/VCP开发/同步异步插件开发手册.md)

---

**版本**：1.0.0  
**最后更新**：2026-04-05
