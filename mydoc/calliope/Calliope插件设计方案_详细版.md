# Calliope 插件设计方案（详细版）

## 1. 文档定位

### 1.1 文档目标

本方案是 Calliope 的开发前详细蓝图，用于直接指导 `Plugin/Calliope` 的工程实现、联调、测试与验收。

### 1.2 设计边界

- 当前阶段只做设计，不提交插件代码。
- 设计覆盖：架构、命令契约、状态机、数据模型、异常策略、测试方案。
- 设计假设：Calliope 首发形态为 `synchronous + stdio`。

### 1.3 设计原则

1. 流程可控：每一阶段都可追踪、可回放、可中断恢复。  
2. 质量前置：在设定阶段尽可能提前发现逻辑问题。  
3. 最小改造：优先复用 VCP 现有机制与插件能力。  
4. 可演进：从同步单体插件平滑演进到 hybridservice。

---

## 2. 业务目标与成功指标

### 2.1 业务目标

将“多Agent讨论式长篇小说创作工作流”产品化为工具能力，支持：

- 前期设定四层闭环自动化；
- 章节创作质量门禁与回流；
- 项目级状态管理与产物归档；
- 面向 AI 调用的结构化返回与下一步建议。

### 2.2 成功指标（MVP）

- 设定四层流水线一次通过率 ≥ 70%；
- 单层辩论平均迭代次数 ≤ 2.2；
- 章节回流后通过率 ≥ 80%；
- 任意时刻可查询项目状态；
- 中断后恢复成功率 100%（本地持久化场景）。

---

## 3. VCP 生态适配方案

### 3.1 插件类型与协议

- `pluginType`: `synchronous`
- `communication.protocol`: `stdio`
- `communication.timeout`: `900000`

设计理由：

1. 与 VCP 同步插件执行模型天然兼容；
2. 返回结果一次性聚合，便于 AI 直接消费；
3. 对“命令式工作流推进”最直接。

### 3.2 Manifest（建议正式稿）

```json
{
  "manifestVersion": "1.0.0",
  "name": "Calliope",
  "displayName": "Calliope 长篇小说多Agent工作流",
  "version": "0.1.0",
  "description": "将多Agent讨论式长篇小说创作流程工具化，支持辩论迭代、质量门禁、状态持久化与导出。",
  "author": "VCPToolBox",
  "pluginType": "synchronous",
  "entryPoint": {
    "type": "nodejs",
    "command": "node Calliope.js"
  },
  "communication": {
    "protocol": "stdio",
    "timeout": 900000
  },
  "configSchema": {
    "CALLIOPE_DEFAULT_MODEL": { "type": "string", "default": "" },
    "CALLIOPE_MAX_ITERATIONS": { "type": "integer", "default": 3 },
    "CALLIOPE_PASS_THRESHOLD": { "type": "integer", "default": 85 },
    "CALLIOPE_CHAPTER_MAX_REFLOW": { "type": "integer", "default": 3 },
    "CALLIOPE_STORAGE_DIR": { "type": "string", "default": "Plugin/Calliope/storage/calliope" },
    "CALLIOPE_ENABLE_STRICT_VALIDATION": { "type": "boolean", "default": true },
    "CALLIOPE_DEBUG_MODE": { "type": "boolean", "default": false }
  },
  "capabilities": {
    "invocationCommands": [
      { "commandIdentifier": "InitializeProject", "description": "初始化小说项目与策略基线" },
      { "commandIdentifier": "RunSetupLayerDebate", "description": "执行单层设定辩论闭环" },
      { "commandIdentifier": "RunPreparationPipeline", "description": "执行四层设定流水线" },
      { "commandIdentifier": "RunChapterCreationLoop", "description": "执行单章创作与回流闭环" },
      { "commandIdentifier": "GetWorkflowState", "description": "查询项目状态与风险" },
      { "commandIdentifier": "ExportProjectBundle", "description": "导出项目产物包" }
    ]
  }
}
```

---

## 4. 逻辑架构设计

### 4.1 分层架构

```text
输入(stdin JSON)
   ↓
Calliope.js
   ↓
CommandRouter
   ├─ InitializeProject
   ├─ RunSetupLayerDebate
   ├─ RunPreparationPipeline
   ├─ RunChapterCreationLoop
   ├─ GetWorkflowState
   └─ ExportProjectBundle
   ↓
WorkflowEngine
   ├─ DependencyResolver
   ├─ DebateEngine
   ├─ QualityGateEngine
   ├─ StateStore
   └─ ExportService
   ↓
标准响应(JSON)
```

### 4.2 模块职责

1. `Calliope.js`
   - 读取 stdin
   - JSON 解析
   - 调用路由
   - 包装统一输出

2. `commandRouter.js`
   - 按 `command` 分发
   - 执行输入 schema 校验
   - 将领域错误映射为统一错误码

3. `workflowEngine.js`
   - 阶段推进与状态机控制
   - 处理阶段中断、重试、恢复

4. `debateEngine.js`
   - 设计者/挑刺者循环
   - 评分阈值与迭代上限判定
   - 反馈历史聚合

5. `qualityGateEngine.js`
   - 章节维度质量检查
   - 回流策略决策

6. `stateStore.js`
   - 本地持久化读写
   - 快照与审计日志

7. `schemaValidator.js`
   - 命令级参数校验
   - 输入裁剪与默认值补齐

---

## 5. 状态机与流程编排

### 5.1 顶层状态机

状态集合：

- `INIT`
- `SETUP_WORLD`
- `SETUP_CHARACTER`
- `SETUP_VOLUME`
- `SETUP_CHAPTER_OUTLINE`
- `CHAPTER_WRITING`
- `PAUSED_MANUAL_REVIEW`
- `COMPLETED`
- `FAILED`

### 5.2 状态转移规则

1. `INIT -> SETUP_WORLD`：项目初始化成功。  
2. `SETUP_WORLD -> SETUP_CHARACTER`：world 通过审核并归档。  
3. `SETUP_CHARACTER -> SETUP_VOLUME`：character 通过审核并归档。  
4. `SETUP_VOLUME -> SETUP_CHAPTER_OUTLINE`：volume 通过审核并归档。  
5. `SETUP_CHAPTER_OUTLINE -> CHAPTER_WRITING`：章节细纲通过审核。  
6. 任意状态 -> `PAUSED_MANUAL_REVIEW`：连续回流未通过或出现高风险冲突。  
7. `CHAPTER_WRITING -> COMPLETED`：达到预设完成条件（卷或全书）。  
8. 任意状态 -> `FAILED`：系统错误且不可恢复。

### 5.3 单层辩论子状态机

- `PRECHECK`
- `DESIGN_ROUND_N`
- `CRITIC_REVIEW_N`
- `DECIDE_PASS_OR_RETRY`
- `FINALIZE`

终止条件：

1. `can_pass == true` 且 `score >= passThreshold`；  
2. 达到 `maxIterations`，输出 `max_iterations_reached`。

---

## 6. 命令契约（详细）

### 6.1 通用输入包装

```json
{
  "command": "RunSetupLayerDebate",
  "projectId": "novel_demo_001",
  "args": {}
}
```

### 6.2 InitializeProject

请求参数：

```json
{
  "command": "InitializeProject",
  "args": {
    "projectName": "玄幻长篇A",
    "requirements": {
      "genre": "玄幻",
      "style": "热血",
      "coreConcept": "废柴逆袭",
      "totalVolumes": 3,
      "chaptersPerVolume": 30
    },
    "qualityPolicy": {
      "passThreshold": 85,
      "maxIterations": 3,
      "chapterMaxReflow": 3
    }
  }
}
```

响应示例：

```json
{
  "status": "success",
  "result": {
    "projectId": "calliope_20260318_001",
    "currentStage": "INIT",
    "effectivePolicy": {
      "passThreshold": 85,
      "maxIterations": 3,
      "chapterMaxReflow": 3
    }
  }
}
```

### 6.3 RunSetupLayerDebate

请求参数：

```json
{
  "command": "RunSetupLayerDebate",
  "projectId": "calliope_20260318_001",
  "args": {
    "layer": "world",
    "requirements": {
      "genre": "玄幻",
      "coreConcept": "废柴逆袭"
    },
    "maxIterations": 3,
    "passThreshold": 85
  }
}
```

响应示例：

```json
{
  "status": "success",
  "result": {
    "layer": "world",
    "iterations": 2,
    "finalScore": 88,
    "canPass": true,
    "issuesSummary": {
      "critical": 0,
      "major": 1,
      "minor": 2
    },
    "finalDesign": {}
  }
}
```

### 6.4 RunPreparationPipeline

请求参数：

```json
{
  "command": "RunPreparationPipeline",
  "projectId": "calliope_20260318_001",
  "args": {
    "startLayer": "world",
    "endLayer": "chapter",
    "forceRebuild": false
  }
}
```

响应示例：

```json
{
  "status": "success",
  "result": {
    "completedLayers": ["world", "character", "volume", "chapter"],
    "layerReports": [],
    "nextStage": "CHAPTER_WRITING"
  }
}
```

### 6.5 RunChapterCreationLoop

请求参数：

```json
{
  "command": "RunChapterCreationLoop",
  "projectId": "calliope_20260318_001",
  "args": {
    "volumeNo": 1,
    "chapterNo": 1,
    "chapterPlan": {
      "goal": "主角获得关键线索",
      "mustKeep": ["主线不变", "角色A不OOC"]
    },
    "maxReflow": 3
  }
}
```

响应示例：

```json
{
  "status": "success",
  "result": {
    "chapterStatus": "success",
    "iterations": 2,
    "qualityReport": {
      "outlineCoverage": "pass",
      "consistency": "pass",
      "pacing": "warning",
      "length": "pass"
    },
    "finalChapterContent": "......",
    "reflowHistory": []
  }
}
```

### 6.6 GetWorkflowState

响应字段：

- `currentStage`
- `completionPercent`
- `completedLayers`
- `currentVolumeChapter`
- `riskFlags`
- `lastAction`
- `nextActions`

### 6.7 ExportProjectBundle

输出内容：

- `bundlePath`
- `files`
- `manifestSummary`
- `exportedAt`

---

## 7. 数据模型（详细字段）

### 7.1 project.meta.json

```json
{
  "projectId": "calliope_20260318_001",
  "projectName": "玄幻长篇A",
  "createdAt": "2026-03-18T10:30:00.000Z",
  "requirements": {},
  "qualityPolicy": {},
  "version": "0.1.0"
}
```

### 7.2 state.json

```json
{
  "currentStage": "SETUP_CHARACTER",
  "completedLayers": ["world"],
  "currentLayer": "character",
  "currentVolume": 0,
  "currentChapter": 0,
  "lastAction": "RunSetupLayerDebate(character)",
  "lastError": null,
  "updatedAt": "2026-03-18T10:48:00.000Z"
}
```

### 7.3 debate_logs/<layer>/<runId>.json

```json
{
  "runId": "debate_world_001",
  "layer": "world",
  "startedAt": "2026-03-18T10:35:00.000Z",
  "iterations": [
    {
      "iteration": 1,
      "designerOutput": {},
      "criticReview": {
        "score": 79,
        "canPass": false,
        "issues": []
      }
    }
  ],
  "finalScore": 88,
  "status": "success",
  "endedAt": "2026-03-18T10:40:00.000Z"
}
```

### 7.4 chapter_runs/v{volume}_c{chapter}.json

```json
{
  "volumeNo": 1,
  "chapterNo": 1,
  "attempts": [
    {
      "attempt": 1,
      "draft": "...",
      "quality": {},
      "decision": "reflow"
    },
    {
      "attempt": 2,
      "draft": "...",
      "quality": {},
      "decision": "pass"
    }
  ],
  "finalStatus": "success"
}
```

---

## 8. 质量门禁设计

### 8.1 设定阶段门禁

检查项：

1. 依赖一致性（与上层设定不冲突）  
2. 内部逻辑一致性（无自相矛盾）  
3. 扩展性（可支撑后续卷级推进）  
4. 冲突潜力（剧情驱动力充足）

判定策略：

- 若 `critical > 0`：必回流  
- 若 `score < passThreshold`：回流  
- 否则通过

### 8.2 章节阶段门禁

检查项：

1. 大纲覆盖度  
2. 人设一致性  
3. 世界观规则一致性  
4. 节奏与钩子  
5. 长度策略（可与 CreativeWritingAssistant 联动）

决策规则：

- 全部 pass：通过  
- 存在 high 风险：回流  
- 连续回流超上限：人工介入

---

## 9. Prompt 编排策略

### 9.1 Designer Prompt 结构

1. 角色定义  
2. 当前任务  
3. 必守依赖  
4. 上轮问题列表  
5. 输出结构模板

### 9.2 Critic Prompt 结构

1. 审核目标  
2. 审核维度  
3. 严重级别定义  
4. JSON 输出模板（score/canPass/issues）

### 9.3 Prompt 版本化

- 每次调用记录 `promptVersion`
- 在 `debate_logs` 中存档输入摘要
- 后续可做 A/B 优化

---

## 10. 异常与恢复设计

### 10.1 错误码

- `CALLIOPE_4001`：命令不存在  
- `CALLIOPE_4002`：参数校验失败  
- `CALLIOPE_4003`：项目不存在  
- `CALLIOPE_4091`：依赖层缺失  
- `CALLIOPE_4092`：流程状态不允许  
- `CALLIOPE_4221`：最大迭代已达仍未通过  
- `CALLIOPE_5001`：存储读写失败  
- `CALLIOPE_5002`：内部执行异常

### 10.2 恢复策略

1. 每个命令执行前生成 `pre_action_snapshot`  
2. 执行成功后提交 `post_action_state`  
3. 异常时回滚到最近稳定快照  
4. 在 `state.json` 写入 `lastError` 与 `recoverHint`

---

## 11. 可观测性设计

### 11.1 日志结构

```json
{
  "ts": "2026-03-18T10:40:00.000Z",
  "level": "INFO",
  "projectId": "calliope_20260318_001",
  "command": "RunSetupLayerDebate",
  "event": "debate_round_completed",
  "meta": { "layer": "world", "iteration": 2, "score": 88 }
}
```

### 11.2 指标采集

- `debate_avg_iterations`
- `debate_pass_rate_first_try`
- `chapter_reflow_rate`
- `manual_review_rate`
- `command_latency_ms_p50/p95`

---

## 12. 与现有插件协同方案

### 12.1 推荐协同链路

1. Calliope 进行章节草稿生成  
2. 调用 `CreativeWritingAssistant.CountChapterLength` 统计字数  
3. 调用 `CreativeWritingAssistant.RequestExternalReview` 进行外审  
4. 若有问题，调用 `CreativeWritingAssistant.EditChapterContent` 定向修订  
5. 写回 Calliope `chapter_runs`

### 12.2 协同边界

- Calliope 不重复实现字数统计和外部审查。
- Calliope 保留最终流程决策权（是否回流、是否人工介入）。

---

## 13. 工程目录与文件规划

```text
Plugin/Calliope/
├── Calliope.js
├── plugin-manifest.json
├── package.json
├── lib/
│   ├── commandRouter.js
│   ├── workflowEngine.js
│   ├── debateEngine.js
│   ├── qualityGateEngine.js
│   ├── dependencyResolver.js
│   ├── stateStore.js
│   ├── exportService.js
│   ├── errorCodes.js
│   ├── schemaValidator.js
│   └── promptBuilders/
│       ├── designerPrompt.js
│       └── criticPrompt.js
├── tests/
│   ├── unit/
│   └── integration/
└── storage/calliope/
```

---

## 14. 测试设计

### 14.1 单元测试

覆盖：

- 参数 schema 校验
- 状态机转移
- 评分阈值判定
- 回流上限判定
- 错误码映射

### 14.2 集成测试

场景：

1. 初始化 -> world 辩论通过  
2. world 通过后 character 自动依赖加载  
3. volume 未完成时执行 chapter 辩论应失败并返回依赖错误  
4. chapter 回流超过上限进入人工介入状态  
5. 导出包内容完整性校验

### 14.3 验收测试

给定两套题材（玄幻/都市），执行：

- 四层设定全流程；
- 至少 3 章创作闭环；
- 导出结果包；
- 状态查询与中断恢复验证。

---

## 15. 版本演进路线

### 15.1 v0.1.0（MVP）

- 同步插件
- 四层设定 + 单章闭环
- 本地 JSON 存储

### 15.2 v0.2.0

- 增加批量章节运行
- 增加更细粒度质量规则
- 增加 prompt 策略配置化

### 15.3 v0.3.0

- 演进 `hybridservice`
- 提供动态占位符（项目进度摘要）
- 可选 Web 面板接口（查看状态与报告）

---

## 16. 风险与应对

1. 风险：辩论迭代超时频发  
   - 应对：分层超时配置 + 长任务拆分 + 输出裁剪

2. 风险：章节阶段 token 开销过大  
   - 应对：上下文压缩、仅传必要依赖快照

3. 风险：并发调用导致状态冲突  
   - 应对：project 级文件锁 + 乐观版本号检查

4. 风险：回流循环过多影响效率  
   - 应对：上限阈值 + 人工介入兜底

---

## 17. 开发执行计划（细化）

### 第 1 周

- 搭建插件骨架与 manifest
- 完成路由、校验、错误码、状态存储
- 完成 `InitializeProject` / `GetWorkflowState`

### 第 2 周

- 完成 `RunSetupLayerDebate`
- 完成 world/character 依赖流程
- 编写对应单元测试

### 第 3 周

- 完成 `RunPreparationPipeline`
- 打通四层设定全流程
- 完成导出服务基础实现

### 第 4 周

- 完成 `RunChapterCreationLoop`
- 接入 CreativeWritingAssistant 协同链路
- 增加回流策略与人工介入状态

### 第 5 周

- 集成测试与验收测试
- 性能与稳定性调优
- 输出开发文档与调用样例

---

## 18. 最终结论

Calliope 采用 `synchronous + stdio` 的首发方案，可在不改变 VCP 现有执行模型的前提下，将“多Agent讨论式长篇小说创作工作流”完整落地为可调用、可追踪、可恢复的工程化插件。  
本详细方案已经具备直接进入开发阶段的颗粒度，可作为后续代码实现基线。
