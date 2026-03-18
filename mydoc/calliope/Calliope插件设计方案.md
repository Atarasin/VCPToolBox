# Calliope 插件设计方案（开发前）

## 1. 目标

将《多Agent讨论式长篇小说创作工作流》转化为 VCP 可调用插件 **Calliope**，核心目标：

- 工具化“设计者-挑刺者”辩论机制；
- 覆盖前期四层设定闭环（世界观/人物/分卷/章节细纲）；
- 提供章节创作质量门禁与回流控制；
- 支持持久化状态、可追踪、可恢复。

本稿只做设计，不做代码实现。

---

## 2. VCP 生态适配决策

### 2.1 插件形态

- 首发类型：`synchronous`
- 协议：`stdio`
- 建议超时：`900000ms`（15 分钟）

理由：与现有创作类插件一致，调用方式简单，返回可标准化；多轮辩论存在长耗时，60 秒默认值偏短。

### 2.2 Manifest 草案

```json
{
  "manifestVersion": "1.0.0",
  "name": "Calliope",
  "displayName": "Calliope 长篇小说多Agent工作流",
  "version": "0.1.0",
  "description": "多Agent讨论式小说创作流程编排插件",
  "author": "VCPToolBox",
  "pluginType": "synchronous",
  "entryPoint": {
    "type": "nodejs",
    "command": "node Calliope.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 900000
  }
}
```

---

## 3. 能力映射

### 3.1 原流程关键能力

- 双Agent：Designer 生成方案，Critic 挑刺审核；
- 统一闭环：预检 → 辩论循环 → 终审 → 存档；
- 四层依赖：world → character → volume → chapter；
- 迭代控制：最大轮数 + 通过阈值（默认 85）；
- 章节阶段：质量门禁 + 回流决策。

### 3.2 Calliope 模块职责

- 流程编排层：阶段状态机、依赖控制、推进策略；
- 辩论执行层：多轮迭代、评分聚合、问题分级；
- 质量门禁层：一致性/节奏/长度等检查；
- 存档层：状态、历史、导出包管理。

---

## 4. 命令接口设计

采用少量高聚合命令，避免碎片化。

### 4.1 命令清单

1. `InitializeProject`：初始化小说项目
2. `RunSetupLayerDebate`：执行单层设定辩论
3. `RunPreparationPipeline`：四层设定一键流水线
4. `RunChapterCreationLoop`：单章创作闭环
5. `GetWorkflowState`：查询流程状态
6. `ExportProjectBundle`：导出项目设定包

### 4.2 输入输出约定（摘要）

#### InitializeProject

- 输入：`projectName`、`requirements`、`qualityPolicy?`
- 输出：`projectId`、`effectivePolicy`、`createdAt`

#### RunSetupLayerDebate

- 输入：`projectId`、`layer(world|character|volume|chapter)`、`requirements`、`maxIterations?`、`passThreshold?`
- 输出：`status`、`finalScore`、`iterations`、`issuesSummary`、`finalDesign`

#### RunPreparationPipeline

- 输入：`projectId`、`pipelineConfig?`
- 输出：`completedLayers`、`layerReports`、`blockedLayer?`、`nextAction`

#### RunChapterCreationLoop

- 输入：`projectId`、`volumeNo`、`chapterNo`、`chapterPlan`、`maxReflow?`
- 输出：`chapterStatus`、`qualityReport`、`finalChapterContent`、`reflowHistory`

#### GetWorkflowState

- 输入：`projectId`
- 输出：`currentStage`、`completionPercent`、`riskFlags`、`pendingTasks`

#### ExportProjectBundle

- 输入：`projectId`、`format(json|markdown)?`
- 输出：`bundlePath`、`manifestSummary`

---

## 5. 工程结构设计

建议目录：

```text
Plugin/Calliope/
├── Calliope.js
├── plugin-manifest.json
├── lib/
│   ├── commandRouter.js
│   ├── workflowEngine.js
│   ├── debateEngine.js
│   ├── qualityGateEngine.js
│   ├── dependencyResolver.js
│   ├── stateStore.js
│   └── schemaValidator.js
└── storage/
    └── calliope/<projectId>/
        ├── project.meta.json
        ├── state.json
        ├── setup/
        ├── debate_logs/
        ├── chapter_runs/
        └── exports/
```

---

## 6. 数据模型设计

### 6.1 ProjectMeta

- `projectId`
- `projectName`
- `requirements`
- `qualityPolicy`
- `createdAt`

### 6.2 WorkflowState

- `currentStage`
- `currentLayer`
- `completedLayers`
- `lastError`
- `updatedAt`

### 6.3 DebateRunRecord

- `layer`
- `iteration`
- `designerOutput`
- `criticReview`
- `score`
- `canPass`

### 6.4 ChapterRunRecord

- `volumeNo`
- `chapterNo`
- `draftContent`
- `qualityCheck`
- `reflowDecisions`
- `finalStatus`

---

## 7. 配置设计（configSchema 草案）

```json
{
  "configSchema": {
    "CALLIOPE_DEFAULT_MODEL": { "type": "string", "default": "" },
    "CALLIOPE_MAX_ITERATIONS": { "type": "integer", "default": 3 },
    "CALLIOPE_PASS_THRESHOLD": { "type": "integer", "default": 85 },
    "CALLIOPE_STORAGE_DIR": { "type": "string", "default": "Plugin/Calliope/storage/calliope" },
    "CALLIOPE_ENABLE_STRICT_VALIDATION": { "type": "boolean", "default": true },
    "CALLIOPE_DEBUG_MODE": { "type": "boolean", "default": false }
  }
}
```

---

## 8. 错误处理与返回规范

### 8.1 错误分级

- `USER_INPUT_ERROR`
- `DEPENDENCY_ERROR`
- `WORKFLOW_BLOCKED`
- `SYSTEM_ERROR`

### 8.2 统一响应结构

```json
{
  "status": "success|error",
  "result": {},
  "error": "错误消息",
  "messageForAI": "建议下一步"
}
```

---

## 9. 与现有插件协同

- `CreativeWritingAssistant`：字数校验、外部审查、定向修订
- `DailyNoteWrite` / `DailyNoteManager`：过程归档与运营复盘
- `AgentMessage` / `AgentAssistant`：跨Agent通信（Designer/Critic）

协同原则：Calliope 负责“编排与决策”，专用能力交给已有插件。

---

## 10. 开发计划（建议）

### Phase 1（MVP，约 1~1.5 周）

- 搭建入口、路由、状态存储
- 完成 3 个命令：`InitializeProject`、`RunSetupLayerDebate`、`GetWorkflowState`
- 跑通 world 层辩论闭环

### Phase 2（约 1 周）

- 四层设定全链路
- 新增 `RunPreparationPipeline`
- 增加中断恢复

### Phase 3（约 1~1.5 周）

- 章节闭环与回流逻辑
- 新增 `RunChapterCreationLoop`
- 增加人工介入标记

### Phase 4（约 0.5~1 周）

- 导出能力 `ExportProjectBundle`
- 完善错误码与观测指标
- 端到端验收

---

## 11. 结论

Calliope 采用 `synchronous + stdio` 首发最稳妥，先落地“多Agent辩论 + 质量闭环 + 状态可恢复”的核心能力，再逐步扩展为 `hybridservice`。  
该方案与 VCP 现有 manifest、生命周期、执行模式完全兼容，开发路径清晰、风险可控。
