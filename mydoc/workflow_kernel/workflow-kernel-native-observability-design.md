# WorkflowKernel 原生可观测性设计

## 文档目标

本文面向 `workflowKernel` 内核维护者与工作流插件作者，定义一套可作为内核原生能力提供的可观测性设计。目标不是为某一个业务插件临时补日志，而是在内核层提供统一的执行轨迹、失败状态、状态摘要与查询接口，让任何基于 `WorkflowKernel` 的工作流都能在不侵入业务实现的前提下具备基础诊断能力。

读完本文后，维护者应能够：

- 理解哪些可观测性能力应下沉到内核，哪些应由业务层补充。
- 依据统一抽象为 `WorkflowKernel` 增加原生 trace 能力。
- 为 `StoryOrchestrator` 等业务插件提供兼容接入路径，而不是继续扩张插件私有日志协议。

## 背景与问题

当前 `WorkflowKernel` 已具备以下基础：

- 统一状态机与执行游标。
- 通用事件总线。
- 持久化仓储接口与事件历史追加接口。
- 检查点恢复与 crash recovery。

但当前内核暴露的观测信息仍停留在“轻量事件广播”层，主要问题是：

- 事件只覆盖 `workflow.started`、`workflow.step_started`、`workflow.step_completed`、`workflow.failed`、`workflow.completed` 等摘要型节点。
- `step_started` 与 `step_completed` 事件缺少输入摘要、输出摘要、耗时、重试上下文、错误分类等核心诊断信息。
- `getStatus()` 只能返回当前状态、执行游标、上下文与检查点状态，无法回答“最后失败在哪一步”“最近发生了什么”“上一步输出了什么类型的数据”。
- 当前持久化接口只有 `appendHistory()`，缺少 run 级状态面、step 级 trace 面、last-error 面等原生模型。
- 上层插件只能把业务状态文件误用成执行轨迹，导致“业务摘要失真”和“执行过程黑盒”同时出现。

这类问题不是 `StoryOrchestrator` 特有问题，而是所有 workflow 宿主的共性问题，因此应在 `workflowKernel` 内核层提供统一解决方案。

## 设计目标

本设计的目标如下：

1. 为每次 workflow 执行提供原生 `run` 级轨迹。
2. 为每个 step 提供可持久化的输入输出摘要与失败上下文。
3. 在不耦合业务数据结构的前提下，定义统一的 trace schema。
4. 允许业务层以 artifact 引用方式补充大体积原始输入输出。
5. 兼容现有 `EventBus`、`WorkflowStateRepository`、`StoryEventAdapter` 与 legacy consumers。
6. 让宿主无需翻日志文件即可通过 API 获取“当前状态 + 最近关键事件 + 最近失败信息”。

## 非目标

以下内容不属于本轮内核原生能力范围：

- 不在内核默认持久化完整 prompt、完整模型原始响应、完整章节正文等大体积业务数据。
- 不在内核中硬编码 `StoryOrchestrator` 专属概念，如 `worldview`、`outline`、`chapterDrafts`。
- 不引入重型 observability 基础设施，如外部 tracing backend、metrics server 或专用 UI。
- 不要求所有业务 step 都返回统一业务 payload；内核只要求可序列化的摘要与引用。

## 核心原则

### 1. 骨架下沉，语义上浮

内核负责“执行轨迹骨架”，业务层负责“业务语义补全”。

内核必须统一提供：

- run 生命周期事件
- step 生命周期事件
- step trace 持久化
- last error 持久化
- run 状态查询

业务层按需补充：

- 原始 prompt artifact
- 原始模型响应 artifact
- 业务输出预览
- 脱敏逻辑

### 2. 摘要与明细分离

可观测性必须明确分成两层：

- 摘要层：适合快速查询与状态显示
- 明细层：适合排障、复盘与审计

摘要层应足够轻量，可直接放入 repository 或状态接口返回。明细层应通过 trace sink 或 artifact 引用进行持久化。

### 3. 记录决策，不记录噪音

不记录无意义的函数进入退出日志。只记录未来排障者真正会问的问题：

- 为什么进入重试
- 为什么进入 checkpoint
- 为什么 guard 失败
- step 的输入大致是什么
- step 的输出大致是什么
- 哪一层抛出了错误

### 4. 原生接口优先，文件实现可插拔

内核不直接绑定某个业务目录结构。内核只依赖原生抽象接口，文件系统实现只是默认适配器之一。

## 设计总览

本设计引入三类新抽象：

1. `TraceSink`
2. `ExecutionTrace`
3. `RunStatusView`

三者关系如下：

- `WorkflowKernel` 在执行过程中产出标准化 trace event。
- `TraceSink` 负责将 trace event 持久化到文件、数据库或其他存储。
- `ExecutionTrace` 定义事件与 step 记录的统一 schema。
- `RunStatusView` 负责聚合“当前状态 + 最近关键轨迹”的查询结果。

## 新增抽象一：TraceSink

### 目标

让内核以统一接口写入可观测性数据，而不是把所有诊断细节塞进 `appendHistory()` 或 `console.log()`。

### 接口草案

```js
class WorkflowTraceSink {
  async onRunStarted(event) {}
  async onStepStarted(event) {}
  async onStepCompleted(event) {}
  async onStepFailed(event) {}
  async onCheckpointPending(event) {}
  async onCheckpointResolved(event) {}
  async onRunRecovered(event) {}
  async onRunCompleted(event) {}
  async onRunFailed(event) {}
  async updateRunStatus(statusView) {}
  async writeLastError(lastErrorView) {}
}
```

### 说明

- `event` 使用统一 trace schema，而不是业务私有结构。
- `updateRunStatus()` 面向快速查询场景。
- `writeLastError()` 用于稳定暴露最近失败原因，避免只能依赖 history 回放。
- 若未配置 trace sink，内核仍然能工作，只是退化为仅有 `EventBus + appendHistory()` 的模式。

## 新增抽象二：ExecutionTrace Schema

### TraceEvent

```js
{
  traceId: 'trc-...',
  workflowId: 'wf-001',
  runToken: 'rt-...',
  sequence: 12,
  type: 'workflow.step_completed',
  timestamp: '2026-05-02T12:00:00.000Z',
  phaseId: 'drafting',
  stepId: 'generateOutline',
  stepType: 'agentCall',
  status: 'completed',
  payload: {
    outputKey: 'outline',
    durationMs: 1532,
    inputPreview: { kind: 'object', keys: ['genre', 'theme'] },
    outputPreview: { kind: 'array', size: 12 },
    attempt: 1
  }
}
```

### StepTraceRecord

```js
{
  workflowId: 'wf-001',
  runToken: 'rt-...',
  sequence: 12,
  phaseId: 'drafting',
  stepId: 'generateOutline',
  stepType: 'agentCall',
  status: 'completed',
  startedAt: '2026-05-02T12:00:00.000Z',
  finishedAt: '2026-05-02T12:00:01.532Z',
  durationMs: 1532,
  attempt: 1,
  inputPreview: {
    kind: 'object',
    keys: ['genre', 'theme'],
    truncated: false
  },
  outputPreview: {
    kind: 'array',
    size: 12,
    truncated: false
  },
  artifactRefs: {
    input: null,
    output: null,
    error: null
  },
  error: null
}
```

### LastErrorView

```js
{
  workflowId: 'wf-001',
  runToken: 'rt-...',
  failedAt: '2026-05-02T12:05:00.000Z',
  phaseId: 'drafting',
  stepId: 'qualityGuard',
  stepType: 'guard',
  errorCode: 'STEP_EXECUTION_FAILED',
  errorMessage: 'Step qualityGuard failed: score below threshold',
  causeType: 'guard_failure',
  attempt: 2,
  inputArtifactRef: null,
  outputArtifactRef: null
}
```

### RunStatusView

```js
{
  workflowId: 'wf-001',
  runToken: 'rt-...',
  state: 'running',
  currentPhaseId: 'drafting',
  currentStepId: 'generateOutline',
  currentStepType: 'agentCall',
  checkpointState: null,
  lastEventAt: '2026-05-02T12:00:01.532Z',
  lastCompletedStep: {
    phaseId: 'worldbuilding',
    stepId: 'generateWorld'
  },
  lastFailedStep: null,
  recentEvents: [
    { type: 'workflow.step_started', stepId: 'generateOutline', timestamp: '...' },
    { type: 'workflow.step_completed', stepId: 'generateWorld', timestamp: '...' }
  ]
}
```

## 新增抽象三：Trace Payload Policy

为防止内核默认写入过大或敏感内容，需要新增 payload 摘要策略。

### 接口草案

```js
class TracePayloadPolicy {
  buildInputPreview(step, resolvedInput, context) {}
  buildOutputPreview(step, result, context) {}
  shouldPersistInline(value, channel) {}
  sanitizeError(error) {}
}
```

### 默认策略

默认策略不理解业务语义，只做通用摘要：

- string：保存长度、前若干字符摘要
- array：保存长度、前若干项类型
- object：保存 key 列表、对象大小
- error：保存 `name`、`message`、裁剪后的 `stack`

业务插件可以覆盖该 policy，用更懂业务的方式生成 preview，但不改变内核 trace schema。

## WorkflowKernel 改造点

### 1. 构造函数新增配置

建议在 `WorkflowKernel` 构造函数中新增以下可选项：

```js
const kernel = new WorkflowKernel({
  agentDispatcher,
  stateRepository,
  traceSink,
  tracePayloadPolicy,
  config: {
    observability: {
      enabled: true,
      recentEventLimit: 20,
      persistStepTraces: true
    }
  }
});
```

### 2. 执行时生成 run 级上下文

当前内核已生成 `runToken`。建议进一步引入内存级 `runTraceContext`：

```js
{
  runToken,
  sequence: 0,
  startedAt,
  currentPhaseId,
  currentStepId,
  recentEvents: []
}
```

该上下文用于：

- 为 trace event 分配单调递增 `sequence`
- 聚合 `recentEvents`
- 维护 `lastCompletedStep` 与 `lastFailedStep`
- 驱动 `RunStatusView`

### 3. `_executeStep()` 增加 step 级 trace 生命周期

在 step handler 调用前后记录：

- `startedAt`
- `resolvedInput`
- `attempt`
- `finishedAt`
- `durationMs`
- `result.status`
- `result.output` 摘要
- `result.error` 摘要

新增标准事件：

- `workflow.step_started`
- `workflow.step_completed`
- `workflow.step_failed`
- `workflow.step_waiting_checkpoint`

其中 `workflow.step_failed` 必须与 `workflow.failed` 并存。前者回答“哪一步为什么失败”，后者回答“整个 workflow 已失败”。

### 4. `getStatus()` 扩展为原生状态查询

建议保留现有 `getStatus()` 兼容返回，但新增扩展字段：

- `runToken`
- `currentPhaseId`
- `currentStepId`
- `currentStepType`
- `lastCompletedStep`
- `lastFailedStep`
- `lastError`
- `recentEvents`

也可以新增一个更明确的方法：

```js
async getRunStatus(workflowId, options = {})
```

这样可以避免老调用方被强制升级。

### 5. `_persistEvent()` 语义拆分

当前 `_persistEvent()` 仅调用 `appendHistory()`。建议调整为双通道：

- `appendHistory()` 继续维护轻量兼容 history
- `traceSink` 写入结构化 trace 数据

两者职责不同：

- history：兼容旧消费者
- trace：面向诊断与排障

## Repository 扩展方案

### 方案 A：扩展现有 `WorkflowStateRepository`

在现有仓储接口上新增以下方法：

```js
async updateRunStatus(workflowId, statusView) {}
async writeLastError(workflowId, lastErrorView) {}
async appendTraceEvent(workflowId, traceEvent) {}
async upsertStepTrace(workflowId, stepTraceRecord) {}
async getRunStatus(workflowId) {}
async listTraceEvents(workflowId, options = {}) {}
```

优点：

- 抽象集中，语义统一
- 数据库型实现更自然

缺点：

- 对现有适配器改动较大
- 会把“业务状态仓储”和“诊断仓储”耦得更紧

### 方案 B：引入独立 `TraceSink`

仓储继续保存 workflow 核心状态，trace 由独立接口处理。

优点：

- 边界更清晰
- 文件实现和数据库实现都容易独立演进
- 更适合先增量上线

缺点：

- 查询接口需要聚合 repository 与 trace sink 两套数据

### 推荐

推荐优先采用方案 B：

- `WorkflowStateRepository` 继续负责 workflow 核心状态
- 新增 `TraceSink` 负责详细观测数据
- `WorkflowKernel.getRunStatus()` 在内核层聚合两者

这是最稳妥的渐进路径，对现有 adapter 的冲击最小。

## 默认文件实现建议

为了尽快落地，建议内核自带一个轻量文件实现：

### `FileTraceSink`

建议存储结构如下：

```text
state/
  workflow-kernel/
    runs/
      <workflowId>/
        <runToken>/
          status.json
          last-error.json
          events.jsonl
          steps/
            0001-generateWorld.json
            0002-generateOutline.json
```

### 文件职责

- `status.json`
  - 当前 run 摘要
  - 用于快速查看当前状态
- `last-error.json`
  - 最近一次失败原因
  - 用于快速定位问题
- `events.jsonl`
  - 结构化事件流
  - 用于时序回放
- `steps/*.json`
  - step 级输入输出摘要与错误上下文
  - 用于单步排障

### 为什么默认实现仍值得放在内核中

因为它是内核自带默认实现，不是内核唯一实现。对没有数据库或没有宿主可观测基础设施的消费者来说，文件实现提供“开箱即用”的最低诊断能力。

## 业务插件接入方式

业务插件不应重写整个可观测性体系，而应通过以下方式补充：

### 1. 业务级 payload policy

插件可提供自定义 `TracePayloadPolicy`：

- 对 prompt 做脱敏与截断
- 对章节列表输出成 `{ kind: 'chapters', count: 12 }`
- 对故事世界观输出成 `{ kind: 'worldConfig', keys: [...] }`

### 2. artifact 引用注入

插件在 step 执行内部将大体积内容落到自身 artifact manager，再把路径或引用回填到 `artifactRefs`。

### 3. 自定义补充事件

插件可以额外发业务事件，如：

- `story.phase_snapshot_restored`
- `story.artifact_saved`
- `story.validation_failed`

但这些事件不应替代内核标准事件。

## 向后兼容策略

### 兼容现有 EventBus

保持现有 `EventBus` 机制不变。所有标准 trace 事件仍通过 `EventBus` 发出。

### 兼容现有 `appendHistory()`

继续写入轻量 history，避免 legacy adapter 或测试用例立即失效。

### 兼容 `StoryEventAdapter`

`StoryEventAdapter` 继续消费标准 kernel 事件并映射成 legacy story 事件。新 trace 字段对其来说是增量信息，而不是替代信息。

### 兼容现有 `getStatus()`

保留原有返回字段，新增字段只做向后兼容扩展。

## 错误分类设计

为了避免所有失败都只剩一段 message，建议引入统一失败类别：

- `STEP_EXECUTION_FAILED`
- `CHECKPOINT_PENDING`
- `CHECKPOINT_REJECTED`
- `CHECKPOINT_TIMEOUT`
- `GUARD_CONDITION_FAILED`
- `RETRY_EXHAUSTED`
- `PERSISTENCE_WRITE_FAILED`
- `HOOK_FAILED`
- `RECOVERY_FAILED`
- `UNKNOWN_KERNEL_FAILURE`

这些错误码应进入：

- `workflow.step_failed`
- `workflow.failed`
- `last-error`
- `RunStatusView.lastError`

## 分阶段实施方案

### Phase 1：内核原生 trace 骨架

交付内容：

- `TraceSink` 接口
- 默认 `FileTraceSink`
- `workflow.step_failed` 事件
- `RunStatusView`
- `LastErrorView`
- `getRunStatus()` 或扩展 `getStatus()`

收益：

- 快速脱离“黑盒执行”
- 先能看到每一步的状态与失败点

### Phase 2：step 输入输出摘要

交付内容：

- `TracePayloadPolicy`
- step 输入输出 preview
- `steps/*.json`
- `recentEvents` 聚合

收益：

- 能看到每一步拿到了什么、产出了什么

### Phase 3：业务 artifact 引用整合

交付内容：

- artifact 引用协议
- 业务插件接入范式
- 文档与示例

收益：

- 内核与业务层职责彻底分清

## 测试策略

建议新增以下测试层次：

### 单元测试

- 未配置 `traceSink` 时，内核仍正常执行。
- step 成功时写入 `workflow.step_started` 与 `workflow.step_completed`。
- step 失败时写入 `workflow.step_failed`、`workflow.failed` 与 `last-error`。
- checkpoint 挂起时写入 `workflow.checkpoint_pending` 与状态摘要。
- `getRunStatus()` 正确聚合最近事件与最后失败信息。

### 文件实现测试

- `FileTraceSink` 正确创建 `status.json`、`events.jsonl`、`steps/*.json`。
- 多 step 执行时 `sequence` 单调递增。
- 相同 workflow 多次运行时按 `runToken` 隔离。

### 兼容性测试

- 老的 `appendHistory()` 仍持续写入。
- `StoryEventAdapter` 在新增 trace 字段后仍能映射原有事件。
- 未升级业务插件时，默认 preview policy 不会因为未知输出结构而崩溃。

## 风险与权衡

### 风险一：观测数据过大

对策：

- 内核默认只存 preview
- 大体积内容通过 artifact ref 外挂
- 提供 `recentEventLimit` 与 preview 截断策略

### 风险二：repository 与 trace sink 状态不一致

对策：

- 明确 repository 保存业务执行状态，trace sink 保存诊断轨迹
- `RunStatusView` 为聚合视图，而不是单一真相源
- 优先保证状态更新，trace 写入失败时不得吞掉主执行错误

### 风险三：业务方误以为内核会自动保存所有原始 I/O

对策：

- 文档中明确区分 preview 与 artifact
- 默认策略只做摘要，不做全量落盘

## 推荐结论

推荐将“可观测性骨架”下沉为 `WorkflowKernel` 原生能力，具体包括：

- 标准 trace 事件模型
- step 级 trace 持久化
- run 级状态摘要
- 最近失败视图
- 可插拔 trace sink
- 可插拔 payload preview policy

同时保留业务层的扩展职责：

- 业务 artifact 落盘
- 业务语义化 preview
- 脱敏与隐私裁剪

这是当前最稳妥的架构边界。它既能解决 `StoryOrchestrator` 的黑盒问题，也不会把内核绑死在某个具体业务协议上。

## 建议的后续动作

1. 在内核中先落一个最小可用设计：`TraceSink + FileTraceSink + step_failed + getRunStatus()`。
2. 再把 `TracePayloadPolicy` 与 `steps/*.json` 做完，让 step 级输入输出真正可见。
3. 最后给 `StoryOrchestrator` 接上 artifact 引用，把大体积业务内容与内核 trace 正式打通。
