# 编排抽象裁决文档

**裁决日期：** 2026-04-30
**裁决范围：** StoryOrchestrator, NovelWorkflowOrchestrator, WorkflowKernel (M002)

---

## 一、核心裁决

### 裁决 1：WorkflowKernel 是全局唯一通用编排核心

**陈述：** `modules/workflowKernel/` 是 VCP 内唯一的通用多 Agent 工作流编排内核。后续所有新工作流（长篇小说、其他多 Agent 场景）原则上都应挂载到该内核之上，而不是复制新的编排实现。

**理由：**
- StoryOrchestrator 的硬编码阶段模式已证明维护成本过高
- NovelWorkflowOrchestrator 的 ACK 驱动状态机 + TickRunner 模式已证明过于复杂且未跑通
- 三套编排模型并存会让每个新工作流都要先回答"挂在哪一套内核上"

**边界：**
- WorkflowKernel 只负责**执行态编排**（步骤调度、检查点、重试、事件推送）
- 不负责**业务逻辑**（prompt 组织、解析修复、章节特殊处理）

---

### 裁决 2：NovelWorkflowOrchestrator 仅作问题样本，不作为实现基线

**陈述：** NovelWorkflowOrchestrator 被界定为一次未跑通的探索。其代码仅用于提取"已识别的坑"，不作为 WorkflowKernel 的设计基线。

**已识别的坑（详见 `novel-workflow-orchestrator-pitfalls.md`）：**
1. ACK 驱动状态机与外部输入紧耦合
2. designer/critic 角色轮转硬编码在执行态中
3. TickRunner 单体反模式（400+ 行）
4. 质量门禁与状态机紧耦合
5. 人工介入逻辑分散
6. 存储抽象层级混乱（文件系统 JSON）
7. 唤醒预算机制引入调度复杂度
8. 缺乏执行态/业务态分层

**结论：** WorkflowKernel 的设计应主动避开上述坑。

---

### 裁决 3：执行态由内核统一，业务态由插件维护

**陈述：** WorkflowKernel 统一管理**执行态**（execution-state），插件（StoryOrchestrator）维护**业务态**（business-state）。

**执行态（内核统一）：**
```
idle → running → waiting_checkpoint → retrying → failed → completed
                     ↑_____________________________________|
                     └ recovering（崩溃恢复时）
```

**业务态（StoryOrchestrator 维护）：**
- `phase1` / `phase2` / `phase3` —— 阶段语义
- `worldview` / `characters` / `outline` / `chapters` —— 产物类型
- 检查点的业务类型（`phase1_checkpoint`, `final_acceptance`）—— 业务标签

**内核视角：** 检查点只有一个类型 —— `checkpoint`。业务标签（如 `phase1_checkpoint`）作为 metadata 附加，不参与内核调度逻辑。

---

### 裁决 4：首轮迁移复用现有 StoryStateRepository，内核接口预留替换点

**陈述：** M002 首轮迁移不新建独立 `WorkflowStateRepository`，而是在现有 `StoryStateRepository` 之上做适配。内核的 `WorkflowStateRepository` 接口从第一天就采用**适配器模式**，现有 repository 作为第一个适配器实现。

**理由：**
- 现有 repository 已支持乐观锁、检查点、快照、事件追踪
- 迁移验证前重建存储层风险过高
- 适配器模式允许后续无痛替换为独立 repository

**接口预留：**
```javascript
interface WorkflowStateRepository {
  async create(workflowId, definitionRef, initialContext)
  async get(workflowId)
  async update(workflowId, patch)  // 深合并
  async appendHistory(workflowId, event)
  async listActive()
}
```

---

## 二、StoryOrchestrator 行为分类表

| 行为 | 归属 | 必须在内核中保留 | 理由 |
|------|------|----------------|------|
| 步骤顺序执行 | 内核 | ✅ | 工作流编排的基本能力 |
| Agent 调用（串行/并行） | 内核 | ✅ | 多 Agent 协作的核心机制 |
| 检查点创建/等待/恢复 | 内核 | ✅ | 人工介入的核心机制 |
| 检查点超时自动批准 | 内核 | ✅ | 生产可用性必需 |
| 步骤级重试（maxAttempts + backoff） | 内核 | ✅ | 容错核心机制 |
| 循环/迭代（质量门控） | 内核 | ✅ | Phase3 润色迭代的核心模式 |
| 状态持久化（step 级） | 内核 | ✅ | 崩溃恢复的基础 |
| 启动崩溃恢复 | 内核 | ✅ | 长周期工作流的生产安全 |
| 事件推送（WebSocket） | 内核 | ✅ | 前端观察面必需 |
| `phase1`/`phase2`/`phase3` 命名 | 业务态 | ❌ | StoryOrchestrator 专属 |
| prompt 组织与构建 | 业务态 | ❌ | 各工作流差异极大 |
| 解析修复（parse repair） | 业务态 | ❌ | Agent 输出处理，非编排 concern |
| 校验策略（schema/business valid） | 业务态 | ❌ | 各工作流校验规则不同 |
| 章节特殊逻辑（chapter operations） | 业务态 | ❌ | StoryOrchestrator 专属 |
| 世界观/人设/大纲的产物结构 | 业务态 | ❌ | 各工作流产物格式不同 |
| 检查点的业务类型标签 | 业务态 | ❌ | 内核只认 checkpoint，标签是 metadata |
| 事件的具体业务语义 | 业务态 | ❌ | 内核推送 generic 事件，适配层映射 |

---

## 三、内核与 StoryOrchestrator 的分层边界

```
┌─────────────────────────────────────────────┐
│         StoryOrchestrator 插件层             │
│  ┌──────────────┐  ┌──────────────────────┐ │
│  │ 业务配置      │  │ 适配层                │ │
│  │ - phase 定义  │  │ - shouldContinue()   │ │
│  │ - agent 映射  │  │ - 事件映射            │ │
│  │ - prompt 模板 │  │ - 产物结构转换        │ │
│  └──────────────┘  └──────────────────────┘ │
├─────────────────────────────────────────────┤
│              WorkflowKernel                  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ StateMachine│ │ StepRegistry│ │ Checkpoint │  │
│  │ (执行态)  │ │ (步骤调度) │ │ Manager    │  │
│  └──────────┘ └──────────┘ └────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ RetryPolicy│ │ Expression │ │ Event Pusher│  │
│  │          │ │ (最小)     │ │ (generic)  │  │
│  └──────────┘ └──────────┘ └────────────┘  │
├─────────────────────────────────────────────┤
│  WorkflowStateRepository (适配器模式)        │
│  - 首轮：StoryStateRepository 适配器         │
│  - 未来：独立 workflows 表适配器             │
├─────────────────────────────────────────────┤
│         AgentDispatcher (共享模块)           │
└─────────────────────────────────────────────┘
```
