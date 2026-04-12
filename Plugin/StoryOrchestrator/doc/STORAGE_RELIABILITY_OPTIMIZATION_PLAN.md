# StoryOrchestrator 存储可靠性完整优化方案

## 1. 背景与目标

StoryOrchestrator 当前将单个故事项目的全部运行状态保存在 `Plugin/StoryOrchestrator/state/stories/<storyId>.json` 中。该方案在原型期实现简单、便于手工排查，但随着工作流复杂度增加，已经暴露出以下结构性风险：

1. **单文件承载过多职责**
   - 当前单个 JSON 同时承担“权威状态”“阶段快照”“检查点历史”“工作流事件”“最终产物缓存”五类职责。
   - 任一阶段写入异常、结构漂移或历史冗余，都会污染整个故事状态。

2. **缺少权威 Schema 边界**
   - JSON 文件只保证“可以被序列化和反序列化”，不保证“结构符合业务契约”。
   - 一旦解析修复器把残缺 JSON 修补为“可解析但结构错误”的对象，该对象会直接进入正式状态。

3. **整文件重写导致写放大**
   - Phase1、Phase2、Workflow 任意局部更新都会触发整份 story 对象重写。
   - 随着 `workflow.history`、章节内容、终稿文本增长，写入成本与冲突概率持续增加。

4. **缺少版本控制与并发保护**
   - 当前 `StateManager.updateStory()` 属于 read-modify-write 逻辑，缺少版本号或 Compare-And-Swap 保护。
   - 多路径同时更新时，可能出现 later write 覆盖 earlier write 的问题。

5. **原始输出、候选结果、正式状态未分层**
   - 模型原始输出、repair 后候选 JSON、用户确认前快照、正式通过状态全部混在一个对象里。
   - 缺少“候选态 → 校验通过 → 晋升正式态”的明确提交协议。

本方案目标是：

- 从根本上提升 StoryOrchestrator 的状态可靠性、可追溯性与可恢复性
- 防止不完整或结构漂移的 AI 输出污染正式状态
- 降低整文件重写风险，提高阶段数据隔离能力
- 为后续 Phase1/Phase2/Phase3 的校验、回滚、审计提供稳定基础

---

## 2. 现状问题拆解

## 2.1 当前状态模型

当前 `StateManager` 在创建故事时，会将完整故事状态一次性初始化到单个对象中，包括：

- story 基础信息
- phase1 / phase2 / phase3
- workflow.activeCheckpoint
- workflow.history
- finalOutput

并在每次局部更新时执行：

1. 读取 story
2. 修改局部字段
3. 序列化整个对象
4. 通过 `.tmp + rename` 覆盖原文件

这种方式具备基本原子性，但仍存在以下局限：

- 原子替换只能保证“文件不写半截”
- 无法保证“内容结构正确”
- 无法表达“某次生成失败但保留原始证据”
- 无法表达“同一阶段多次尝试及其质量差异”

## 2.2 本次故障暴露出的核心链路缺陷

从 `story-761b4a5d1db1.json` 的追溯可以归纳出以下事实：

1. 第二次 Phase1 生成的原始 world builder 输出已经发生：
   - 顶层字段漂移（`factions/history/sceneNorms` 被放入 `rules`）
   - 尾部字符串截断（`sceneNorms` 最后一条未结束）

2. `_repairTruncatedJson()` 成功把残缺文本修补成了“可解析 JSON”

3. `_parseWorldview()` 将该对象视为成功结果

4. `updatePhase1()` 将其写入正式 `phase1.worldview`

5. 验证器虽然识别出问题，但 `有条件通过` 仍被视为 `passed = true`

6. 工作流继续创建 checkpoint，最终用户批准了坏结构结果

该故障说明系统当前缺少两道关键防线：

- **结构防线**：候选对象是否符合严格 schema
- **提交防线**：不完整/修复后的候选对象能否直接晋升为正式状态

---

## 3. 总体设计原则

新的可靠性方案建议遵循以下原则：

### 3.1 状态分层

必须将以下内容彻底拆分：

1. **Raw Output**
   - 模型原始文本响应
   - 只追加，不覆盖
   - 作为审计与回放依据

2. **Parsed Candidate**
   - 经提取、repair、解析后的候选结构
   - 可失败、可无效、可多次尝试

3. **Validated Snapshot**
   - 通过结构校验 + 业务校验后的可用快照
   - 可供 checkpoint 展示与前端读取

4. **Approved State**
   - 用户确认后的正式阶段状态
   - 作为下一阶段输入来源

### 3.2 事件与状态分离

- 状态表只保存“当前权威状态”
- 事件表保存“发生过什么”
- 快照表保存“某一时刻完整可恢复的阶段产物”

### 3.3 只让合法结构进入正式态

不论使用文件还是数据库，必须增加：

- JSON 解析成功 ≠ 结构合法
- repair 成功 ≠ 可晋升正式状态
- 有条件通过 ≠ 允许直接进入后续阶段

### 3.4 最小侵入迁移

考虑项目现状，建议采用：

- **SQLite 作为权威存储**
- **保留原 JSON 文件作为兼容读取与备份导出**
- **逐阶段灰度迁移**

原因：

- 项目已具备 `better-sqlite3` 依赖
- 单机部署场景多，SQLite 足够稳定
- 落地成本显著低于直接切 PostgreSQL

---

## 4. 推荐方案：SQLite + Snapshot + Event Log

## 4.1 存储职责划分

### 4.1.1 SQLite 负责权威状态

建议将以下信息迁移至 SQLite：

- 故事基础元信息
- 当前阶段状态
- 阶段尝试记录
- 检查点记录
- 工作流事件
- 当前生效 snapshot 引用
- 校验状态与审计标记

### 4.1.2 文件系统负责大文本与归档

建议保留文件系统存储：

- 模型原始响应全文
- Prompt 快照
- 超长章节正文
- 最终导出稿件
- 调试日志

SQLite 只保存其索引字段：

- `raw_output_path`
- `prompt_path`
- `artifact_path`
- `content_hash`
- `size_bytes`

---

## 5. 数据模型设计

## 5.1 stories

保存故事主记录与当前权威状态引用。

```sql
CREATE TABLE stories (
  story_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  current_phase TEXT NOT NULL,
  current_step TEXT,
  config_json TEXT NOT NULL,
  active_checkpoint_id TEXT,
  current_phase1_snapshot_id TEXT,
  current_phase2_snapshot_id TEXT,
  current_phase3_snapshot_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

作用：

- 只保存“当前状态”
- 使用 `version` 做乐观锁
- 当前阶段输入永远来自 snapshot 引用，而不是散落字段

## 5.2 phase_attempts

记录每次生成、重试、修订尝试。

```sql
CREATE TABLE phase_attempts (
  attempt_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  attempt_kind TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  source_checkpoint_id TEXT,
  raw_prompt_path TEXT,
  raw_response_path TEXT,
  parse_status TEXT NOT NULL,
  repair_used INTEGER NOT NULL DEFAULT 0,
  schema_valid INTEGER NOT NULL DEFAULT 0,
  business_valid INTEGER NOT NULL DEFAULT 0,
  candidate_snapshot_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

推荐枚举：

- `attempt_kind`:
  - `initial_generation`
  - `revision`
  - `rerun_after_rejection`
  - `manual_restart`
- `parse_status`:
  - `raw_only`
  - `parsed`
  - `repaired_parsed`
  - `parse_failed`

## 5.3 snapshots

保存阶段完整结构化快照。

```sql
CREATE TABLE snapshots (
  snapshot_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  schema_valid INTEGER NOT NULL,
  completeness_score REAL,
  created_from_attempt_id TEXT,
  created_at TEXT NOT NULL
);
```

推荐 `snapshot_type`：

- `candidate`
- `validated`
- `checkpoint_payload`
- `approved`
- `rollback_target`

## 5.4 checkpoints

```sql
CREATE TABLE checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  phase_name TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL,
  status TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  feedback TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  resolved_at TEXT
);
```

说明：

- checkpoint 不再直接把整份 payload 塞进 `workflow.history`
- 只引用 `snapshot_id`

## 5.5 workflow_events

```sql
CREATE TABLE workflow_events (
  event_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  phase_name TEXT,
  event_type TEXT NOT NULL,
  event_detail_json TEXT,
  related_attempt_id TEXT,
  related_snapshot_id TEXT,
  related_checkpoint_id TEXT,
  created_at TEXT NOT NULL
);
```

作用：

- 取代当前 `workflow.history` 中的冗余大对象
- 用于前端时间线展示
- 用于追溯“何时发生了什么”

## 5.6 artifacts

```sql
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  story_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
```

可用于索引：

- raw model response
- prompt snapshot
- exported markdown
- final output

---

## 6. 核心状态流转设计

## 6.1 Phase1 生成新协议

当前协议：

1. 调模型
2. 解析 JSON
3. 直接写入 `phase1.worldview`
4. 验证
5. 创建 checkpoint

建议改为：

1. 记录 prompt 为 artifact
2. 保存 raw response 为 artifact
3. 创建 `phase_attempts` 记录
4. 尝试解析
5. 若使用了 repair，标记 `repair_used = 1`
6. 执行严格 schema 校验
7. 若 schema 不通过，则 attempt 结束为失败，不更新正式状态
8. 若 schema 通过，再执行业务验证
9. 生成 `candidate snapshot`
10. 满足晋升条件后才生成 `validated snapshot`
11. checkpoint 绑定 `validated snapshot`
12. 用户批准后，再将其登记为 `approved snapshot`
13. `stories.current_phase1_snapshot_id` 指向 approved snapshot

## 6.2 “repair 后结果”处理策略

必须区分两类 repair：

### 允许的 repair

- 去除包裹前缀
- 截取首尾 JSON 边界
- 补齐最外层单个缺失括号

### 不允许自动晋升的 repair

- 在字符串中途被截断后补引号
- 自动补齐多个数组/对象嵌套
- 导致字段层级变化的修补
- 导致内容完整性下降的修补

规则建议：

- `repair_used = 1` 时默认不得直接晋升 approved
- 必须通过更严格的 completeness 校验
- 若发现关键字段缺失，直接标为 invalid candidate

## 6.3 Checkpoint 只消费快照

checkpoint 创建时不再携带大 payload，而只做：

- 绑定 `snapshot_id`
- 前端读取 checkpoint 时再查询 snapshot 详情

好处：

- 历史不重复存储
- snapshot 可多处复用
- 回滚时可以直接指向已有快照

## 6.4 Approval 只提升引用

用户批准 checkpoint 时：

- 不复制整份 payload
- 不回写整棵 phase 对象
- 只做：
  - checkpoint 状态改为 approved
  - 生成 approved snapshot（可复用原 validated snapshot）
  - 更新 `stories.current_phase1_snapshot_id`
  - 写一条 workflow event

---

## 7. Schema 与校验体系

## 7.1 结构校验层

建议为三大阶段建立 JSON Schema：

- `phase1.worldview.schema.json`
- `phase1.characters.schema.json`
- `phase2.outline.schema.json`
- `phase3.final.schema.json`

以 `worldview` 为例，必须校验：

- 顶层允许字段：
  - `setting`
  - `rules`
  - `factions`
  - `history`
  - `sceneNorms`
  - `secrets`
- `rules` 内只允许：
  - `physical`
  - `special`
  - `limitations`
- 若出现：
  - `rules.factions`
  - `rules.history`
  - `rules.sceneNorms`
  - `rules.secrets`
  则直接标记为 `schema_invalid`

## 7.2 完整性校验层

在 schema 通过后，再做 completeness 检查：

- `setting` 最小长度
- `factions` 至少 N 个
- `history.keyEvents` 至少 N 条
- `sceneNorms` 至少 N 条
- `secrets` 可以为空，但需显式为 `[]`
- 任意字符串不得疑似截断

可加入截断启发式规则：

- 字符串尾部为明显中断语义
- 连续出现不闭合引号修复
- 最后一项长度异常短于均值

## 7.3 业务验证层

逻辑验证器输出不能再只靠文本关键词判定。

建议要求逻辑验证器输出严格结构：

```json
{
  "verdict": "PASS | PASS_WITH_WARNINGS | FAIL",
  "schema_risk": false,
  "completeness_risk": false,
  "blocking_issues": [],
  "non_blocking_issues": [],
  "suggestions": []
}
```

晋升条件建议：

- `verdict !== FAIL`
- `schema_risk === false`
- `completeness_risk === false`
- `blocking_issues.length === 0`

也就是说：

- `有条件通过` 不能再自动等价于“可直接进入 checkpoint”

---

## 8. Repository 层改造建议

## 8.1 引入 StateRepository 抽象

建议新增统一访问层，而不是让 `WorkflowEngine` 和 `PhaseX` 直接拼装 story 对象。

```javascript
class StoryStateRepository {
  createStory(config) {}
  getStoryHead(storyId) {}
  createPhaseAttempt(input) {}
  saveRawArtifact(input) {}
  saveCandidateSnapshot(input) {}
  validateAndPromoteSnapshot(input) {}
  createCheckpoint(input) {}
  approveCheckpoint(input) {}
  rejectCheckpoint(input) {}
  appendEvent(input) {}
  rollbackToSnapshot(input) {}
}
```

## 8.2 StateManager 的新职责

当前 `StateManager` 建议逐步收缩为 facade：

- 向旧调用方暴露兼容 API
- 内部改调 `StoryStateRepository`
- 在迁移期支持“双写 JSON + SQLite”

## 8.3 双写策略

迁移期建议：

1. SQLite 成为主写目标
2. JSON 作为兼容导出视图
3. 读路径优先读 SQLite
4. 当 SQLite 不存在对应记录时，再回退 JSON

---

## 9. 迁移方案

## 9.1 Phase 0：只做观测，不改读路径

目标：

- 增加 schema 校验与 completeness 日志
- 对现有 JSON 生成风险报告

产出：

- 识别已有多少历史 story 存在字段漂移
- 评估旧数据修复成本

## 9.2 Phase 1：引入 SQLite 与双写

目标：

- 新建 SQLite 数据库与表结构
- `StateManager` 写 JSON 时同步写 SQLite
- 读路径仍保持 JSON

收益：

- 不影响现有前端和流程
- 可开始积累结构化状态

## 9.3 Phase 2：checkpoint 与 history 切到 SQLite

目标：

- 将 `workflow.history` 改为从 `workflow_events` 读取
- checkpoint payload 改为引用 snapshot

收益：

- 大幅降低 story JSON 膨胀
- 为回滚与审计打基础

## 9.4 Phase 3：Phase1/Phase2/Phase3 正式态切换到 snapshot

目标：

- 不再直接写 `phase1.worldview`
- 而是写 `current_phase1_snapshot_id`

收益：

- 正式状态和候选状态彻底解耦

## 9.5 Phase 4：JSON 退化为导出/备份

目标：

- 仅在需要兼容旧面板、导出人工排查时生成 JSON 视图
- 不再把 JSON 当作权威状态源

---

## 10. 回滚与恢复设计

## 10.1 回滚不再依赖“当前对象字段”

回滚应改为：

- 指定 checkpoint
- 查出对应 snapshot
- 更新 `stories.current_phaseX_snapshot_id`
- 写 rollback event

而不是：

- 直接把 phase 字段清空再重跑

## 10.2 保留失败尝试证据

当前失败常常只留下部分状态和日志。

建议每次失败保留：

- prompt artifact
- raw response artifact
- parse result
- schema report
- completeness report
- validator report

这样后续排障可以复盘：

- 是模型没遵守 schema
- 还是上限截断
- 还是 repair 过度宽松

---

## 11. 前端与 API 适配建议

本次后端重构必须额外满足一个现实约束：

- **StoryOrchestratorPanel 是既有生产前端**
- **新版后端输出需要与当前前端契约对齐**
- **优先保证“不改前端即可工作”，至少做到“只做极少量前端修改”**

因此，本方案不建议直接把 SQLite / snapshot 模型暴露给前端，而应在后端增加一层：

- **Panel Compatibility Adapter（面板兼容适配层）**

该适配层负责：

- 从 SQLite / snapshots / workflow_events 读取权威状态
- 转换为当前 `StoryOrchestratorPanel` 已依赖的返回结构
- 保持字段命名、嵌套方式、响应包裹格式不变
- 屏蔽底层存储从 JSON 文件迁移到 SQLite 的实现差异

## 11.1 兼容性原则

后端 API 必须遵循以下兼容性原则：

1. **保持 URL 不变**
   - 继续保留现有面板使用的接口路径
   - 例如 `/stories/:id/worldview`、`/stories/:id/history`

2. **保持响应外壳不变**
   - 继续返回当前前端已经消费的结构，例如：
   - `{ success: true, worldview, phase1Status, userConfirmed }`

3. **保持核心字段命名不变**
   - 例如 `worldview.factions`
   - `worldview.history.keyEvents`
   - `characters.relationshipNetwork.direct`
   - `history[].detail.data`

4. **允许后端内部重构，不允许前端感知底层存储变化**
   - 前端不应该知道数据来自 JSON、SQLite、快照表还是事件表

5. **新增字段只能追加，不能替换旧字段**
   - 可以新增 `meta`、`schemaVersion`、`snapshotId`
   - 但不能移除前端已使用字段

## 11.2 StoryOrchestratorPanel 当前契约基线

根据 `Plugin/StoryOrchestratorPanel/frontend/js` 的现有实现，当前前端已经稳定依赖以下接口契约。

### 11.2.1 世界观接口契约

当前前端依赖：

- `GET /stories/:id/worldview`

建议保持响应：

```json
{
  "success": true,
  "worldview": {
    "setting": "",
    "rules": {
      "physical": "",
      "special": "",
      "limitations": ""
    },
    "factions": [],
    "history": {
      "keyEvents": [],
      "coreConflicts": []
    },
    "sceneNorms": [],
    "secrets": []
  },
  "phase1Status": "pending",
  "userConfirmed": false
}
```

这与前端页面的读取方式直接对应：

- `worldview.setting`
- `worldview.rules.physical`
- `worldview.factions`
- `worldview.history.keyEvents`
- `worldview.sceneNorms`
- `worldview.secrets`

因此，即使内部改为从 snapshot 读取，**对外也必须继续组装成这个结构**。

### 11.2.2 角色接口契约

当前前端依赖：

- `GET /stories/:id/characters`

建议保持响应：

```json
{
  "success": true,
  "characters": [],
  "total": 0,
  "categories": {
    "protagonists": 0,
    "supporting": 0,
    "antagonists": 0
  }
}
```

同时，在 checkpoint / StoryBible 等页面中，后端仍需能够还原出前端期望的人物结构：

```json
{
  "protagonists": [],
  "supportingCharacters": [],
  "antagonists": [],
  "relationshipNetwork": {
    "direct": [],
    "hidden": []
  },
  "oocRules": {}
}
```

### 11.2.3 历史与检查点接口契约

当前前端依赖：

- `GET /stories/:id/history`

建议保持响应：

```json
{
  "success": true,
  "history": [],
  "currentState": "idle",
  "currentPhase": null,
  "activeCheckpoint": null
}
```

其中 `history` 中至少应继续兼容以下结构：

```json
{
  "type": "checkpoint_created",
  "phase": "phase1",
  "step": "checkpoint",
  "detail": {
    "checkpointId": "cp-xxx",
    "data": {
      "worldview": {},
      "characters": {},
      "validation": {}
    }
  }
}
```

原因是当前前端会直接从：

- `historyResponse.history`
- `checkpointEntry.detail.data.worldview`
- `checkpointEntry.detail.data.characters`

恢复 Phase1 的展示内容。

这意味着：

- 即使底层切换为 `workflow_events + snapshots`
- API 层仍要把 event 与 snapshot 拼装回旧结构
- 否则会迫使前端大改

### 11.2.4 大纲与章节接口契约

当前前端依赖：

- `GET /stories/:id/outline`
- `GET /stories/:id/chapters`
- `GET /stories/:id/chapters/:chapterNumber`

这些接口在新版后端中也应保持现有字段形状稳定，不应直接暴露内部 snapshot / artifact 索引。

## 11.3 推荐实现：BFF 兼容层

建议把 `StoryOrchestratorPanel/index.js` 所在的面板后端视为一个 BFF（Backend For Frontend）兼容层。

职责划分如下：

### StoryOrchestrator Core

- 只关心权威状态存储
- 只产出规范化 snapshot / event / checkpoint 数据
- 不对前端页面结构负责

### StoryOrchestratorPanel BFF

- 负责把 Core 的内部结构投影成前端现有格式
- 负责字段归一化与兼容修补
- 负责把 snapshot 引用重建为旧的 `detail.data` 形状

这样可以带来两个好处：

1. Core 能彻底重构，不被旧前端结构绑死
2. 前端可以零修改继续工作

## 11.4 不建议的做法

以下做法虽然看似“更干净”，但与当前目标冲突：

1. **直接让前端读取 SQLite 模型**
   - 前端将感知底层实现细节
   - 后续 schema 变化会波及 UI

2. **把 API 改成全新 DTO，再要求前端整体跟改**
   - 改动面大
   - 回归成本高
   - 不符合“尽量不改前端”的目标

3. **迁移时同时大改后端和前端**
   - 排障难度会显著升高
   - 难以分辨问题来自存储重构还是 UI 改动

## 11.5 推荐迁移策略：后端先兼容，前端后演进

推荐采用以下顺序：

### 第一步：只改后端内部存储

- Core 切换到 SQLite + snapshots + events
- Panel API 继续返回旧结构
- 前端零改动

### 第二步：在后端响应中附加非破坏性元数据

例如：

```json
{
  "success": true,
  "worldview": { ...旧结构... },
  "phase1Status": "pending_confirmation",
  "userConfirmed": false,
  "meta": {
    "snapshotId": "snap-xxx",
    "schemaVersion": "phase1.worldview.v2"
  }
}
```

旧前端会自动忽略 `meta`，新前端可逐步使用。

### 第三步：如有需要，再逐步优化前端

只有在以下场景才建议前端改动：

- 需要展示更多审计信息
- 需要查看多次 attempt 详情
- 需要分页显示长历史流
- 需要显式展示 schema/repair 风险标记

在这之前，前端保持不动是最稳妥的。

## 11.6 历史分页的兼容方式

虽然长期建议历史接口分页，但为避免大改前端，建议分两层推进：

### 兼容阶段

- 保持 `GET /stories/:id/history` 原语义不变
- 默认返回前端当前需要的完整 history

### 增强阶段

- 新增可选参数：
  - `cursor`
  - `limit`
- 老前端不传参数时仍保持旧行为
- 新前端如需大历史分页，再逐步启用

即：

- **分页是向后兼容增强，不是立即替换旧契约**

---

## 12. 运维与可观测性设计

## 12.1 关键指标

建议记录以下指标：

- schema 校验失败率
- repair 使用率
- repair 后被拒绝晋升的比例
- checkpoint 审批拒绝率
- 每个 phase 的平均尝试次数
- 截断响应发生率

## 12.2 关键告警

以下情况建议告警：

- `repair_used = 1`
- `schema_valid = 0`
- candidate 缺失关键字段
- 同一 story phase1 连续失败超过阈值
- checkpoint 创建时 snapshot 不完整

## 12.3 审计能力

必须能回答以下问题：

- 某次 approved 状态来自哪次 attempt？
- 该 attempt 的原始模型响应是什么？
- 是否使用过 repair？
- 校验器当时给出的 verdict 是什么？
- 用户批准的是哪个 snapshot？

---

## 13. 方案对比

## 13.1 保持单 JSON 文件

优点：

- 实现最简单
- 人工查看方便

缺点：

- 无法从根本解决结构污染
- 无法优雅支持多次尝试与快照
- 历史越多越重

结论：

- 仅适合原型阶段，不适合继续作为权威状态源

## 13.2 拆分多个 JSON 文件

优点：

- 比单文件更细粒度
- 可降低整文件重写压力

缺点：

- 仍缺少事务、版本控制、结构约束
- 多文件一致性管理复杂

结论：

- 可作为过渡方案，但不是最终解法

## 13.3 SQLite + 文件归档

优点：

- 本地事务能力强
- 单机部署友好
- 支持事件、快照、版本化
- 与现有项目依赖兼容

缺点：

- 需要引入 repository 与迁移逻辑
- 需要重构 StateManager 读写路径

结论：

- **最适合 StoryOrchestrator 当前阶段的方案**

## 13.4 PostgreSQL

优点：

- 更适合分布式多实例
- 更强的并发和运维能力

缺点：

- 部署成本高
- 对当前插件式单机场景偏重

结论：

- 可作为未来多节点版本升级目标，不建议作为当前第一步

---

## 14. 最终推荐

### 14.1 推荐结论

建议采用：

- **SQLite 作为权威状态存储**
- **文件系统作为 raw output 与调试归档层**
- **Snapshot + Event Log 作为核心状态模型**
- **Schema Gate + Completeness Gate 作为晋升正式态的强制前置条件**

### 14.2 优先级最高的四项改造

1. **建立严格 schema 校验**
   - 阻止 `rules.factions` 这类结构漂移直接进入正式态

2. **引入 phase_attempts 与 snapshots**
   - 区分“原始输出”“候选结果”“正式状态”

3. **将 checkpoint 改为引用 snapshot**
   - 不再在 history 中复制整份 payload

4. **将正式状态切换为 snapshot 引用**
   - 从根本上避免坏对象直接污染整个 story

### 14.3 预期收益

完成后系统将具备：

- 更高的状态可靠性
- 更好的异常隔离能力
- 更清晰的回滚与审计链路
- 更低的整文件重写风险
- 更稳健的 AI 结果准入控制

---

## 15. 建议实施顺序

### 短期（1-2 次迭代）

- 增加 worldview/characters/outline 的 schema 校验
- repair 结果禁止直接晋升 approved
- Phase1 逻辑验证的 `PASS_WITH_WARNINGS` 不再直接放行
- 保留 raw response artifact

### 中期（2-4 次迭代）

- 引入 SQLite
- 建立 `stories / phase_attempts / snapshots / checkpoints / workflow_events`
- `StateManager` 改为 repository facade

### 长期（4 次迭代以上）

- JSON 仅作为导出视图
- 支持更细粒度回滚
- 为多节点/多进程扩展保留升级空间

---

## 16. 附录：判定“可晋升正式态”的建议规则

以 `phase1.worldview` 为例，必须同时满足：

1. JSON 解析成功
2. 未使用高风险 repair，或 repair 后通过人工/附加校验
3. 顶层字段齐全
4. `rules` 内无非法嵌套字段
5. `sceneNorms` / `history.keyEvents` / `factions` 完整性达标
6. 逻辑验证结果无 blocking issue
7. 若 verdict 为 `PASS_WITH_WARNINGS`，仅允许创建“待人工复核候选快照”，不允许自动进入 approved 路径

只有满足以上条件，candidate snapshot 才能晋升为 validated snapshot，随后进入 checkpoint。

---

**文档结论**

从系统可靠性角度看，StoryOrchestrator 不应继续以“单个 story JSON 文件”作为长期权威状态源。最优路径是以 SQLite 承担权威状态，以 snapshot/event 模型替代大对象直写，并在 raw output 与 approved state 之间建立严格的结构与完整性准入门禁。
