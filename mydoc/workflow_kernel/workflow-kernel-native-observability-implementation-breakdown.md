# WorkflowKernel 原生可观测性实现任务拆解

## 文档目标

本文将《WorkflowKernel 原生可观测性设计》细化成可执行的实现任务拆解，面向内核开发者给出：

- 具体要改哪些模块
- 推荐的实施顺序
- 每个阶段的交付物
- 每个阶段的验收标准
- 对应的测试落点

读完本文后，开发者应能够直接开始编码，而不需要再自己补齐“先做什么、后做什么、在哪里测”的实现计划。

## 适用范围

本任务拆解覆盖：

- `modules/workflowKernel` 内核原生可观测性骨架
- `tests/workflowKernel` 内核测试补充
- 与 `StoryOrchestrator` 的兼容接入点设计约束

本任务拆解不覆盖：

- `StoryOrchestrator` 业务层 artifact 全量接入实现
- UI 展示层
- 外部可视化平台或 metrics 系统

## 总体实施策略

建议采用三阶段渐进交付，而不是一次性大改：

1. 先补最小可用的 run 和 step 可见性
2. 再补 step 输入输出摘要与 trace 持久化
3. 最后补业务插件接入规范与兼容收口

这样做的原因是：

- 第一阶段就能快速解决“黑盒执行”和“只知道失败但不知道为什么失败”的问题
- 第二阶段再引入更细粒度的输入输出摘要，避免第一轮改动过大
- 第三阶段才处理业务层 artifact 引用，减少内核与业务层耦合风险

## 模块边界

实现时建议按以下职责划分：

- `core`
  - 新增 trace 事件、run 状态聚合、step trace 生命周期
- `persistence`
  - 保持 workflow 状态仓储职责不变，避免把详细 trace 强塞进 repository
- `tracing`
  - 新增 trace sink、默认文件实现、preview policy
- `adapters`
  - 保持现有 legacy 事件适配逻辑兼容
- `tests/workflowKernel`
  - 分层补齐单元、集成与兼容测试

## 阶段一：最小可用可观测性骨架

### 目标

先让内核具备“能看见 run 和 step 执行状态”的最小能力，不要求完整业务输入输出。

### 交付物

- `TraceSink` 原生接口
- `NoopTraceSink` 默认空实现
- `workflow.step_failed` 标准事件
- `LastErrorView` 原生模型
- `RunStatusView` 原生模型
- `WorkflowKernel.getRunStatus()` 或扩展后的 `getStatus()`

### 任务 1.1：新增 tracing 抽象目录

建议新增目录：

```text
modules/workflowKernel/tracing/
  WorkflowTraceSink.js
  NoopTraceSink.js
  traceModels.js
```

### 任务 1.2：定义 trace 基础模型

建议在 `traceModels.js` 中定义并导出：

- `createTraceEvent()`
- `createRunStatusView()`
- `createLastErrorView()`
- `createStepTraceRecord()`

最小字段要求：

- `workflowId`
- `runToken`
- `sequence`
- `timestamp`
- `type`
- `phaseId`
- `stepId`
- `stepType`
- `status`

### 任务 1.3：给 `WorkflowKernel` 注入 `traceSink`

在 `WorkflowKernel` 构造函数中新增：

- `traceSink`
- `config.observability`

处理规则：

- 未提供时默认使用 `NoopTraceSink`
- 不影响现有 `agentDispatcher`、`stateRepository`、`webSocketPusher`

### 任务 1.4：引入 run trace 上下文

在 active workflow record 或其并行结构中新增运行态 trace 元数据：

- `runToken`
- `sequence`
- `lastEventAt`
- `currentPhaseId`
- `currentStepId`
- `currentStepType`
- `lastCompletedStep`
- `lastFailedStep`
- `recentEvents`

建议不要把这一整套观测字段直接塞回业务 `context`，应作为内核运行元信息管理。

### 任务 1.5：补 `workflow.step_failed`

当前内核只在 step 失败后发 `workflow.failed`。需要补发：

- `workflow.step_failed`

触发时机：

- 任意 step handler 抛错
- step 返回 `{ status: 'failed' }`
- guard/checkpoint/retry 等分支被归类为失败时

最小 payload：

- `stepId`
- `stepType`
- `phaseId`
- `errorCode`
- `errorMessage`
- `attempt`

### 任务 1.6：新增 run 状态查询接口

推荐新增：

```js
async getRunStatus(workflowId, options = {})
```

返回字段至少包括：

- `workflowId`
- `runToken`
- `state`
- `currentPhaseId`
- `currentStepId`
- `currentStepType`
- `checkpointState`
- `lastEventAt`
- `lastCompletedStep`
- `lastFailedStep`
- `lastError`
- `recentEvents`

兼容策略：

- `getStatus()` 保留现有行为
- `getRunStatus()` 提供增强视图

### 阶段一验收标准

- 不配置 trace sink 时，现有 workflow 仍能正常执行
- step 成功时至少可从 `getRunStatus()` 看到当前 step 与最近事件
- step 失败时至少可看到 `lastFailedStep` 与 `lastError`
- 现有 `appendHistory()` 行为保持不变
- 现有 `StoryEventAdapter` 不因新事件而失效

### 阶段一测试落点

建议新增或修改以下测试：

- `tests/workflowKernel/core/WorkflowKernel.test.js`
  - 断言 `workflow.step_failed` 会发出
  - 断言 `getRunStatus()` 返回增强状态
  - 断言未配置 trace sink 时不报错
- `tests/workflowKernel/adapters/StoryEventAdapter.test.js`
  - 断言新增事件不会破坏原有适配逻辑
- `tests/workflowKernel/integration/minimal-workflow.test.js`
  - 断言成功路径与失败路径都能查询 run 状态

## 阶段二：step trace 与输入输出摘要

### 目标

把“看得见状态”升级为“看得见每一步大致拿到了什么、产出了什么、耗时多久”。

### 交付物

- `TracePayloadPolicy`
- `DefaultTracePayloadPolicy`
- `StepTraceRecord`
- `workflow.step_waiting_checkpoint` 或等价细化事件
- step 级输入输出摘要持久化

### 任务 2.1：新增 preview policy

建议新增文件：

```text
modules/workflowKernel/tracing/TracePayloadPolicy.js
modules/workflowKernel/tracing/DefaultTracePayloadPolicy.js
```

默认 policy 负责：

- string 摘要
- object key 摘要
- array 长度摘要
- error 脱敏与裁剪

### 任务 2.2：在 `_executeStep()` 中提取 step 级 trace 数据

围绕 step handler 执行前后补齐：

- `startedAt`
- `finishedAt`
- `durationMs`
- `inputPreview`
- `outputPreview`
- `attempt`
- `status`

注意点：

- preview 应基于 resolved input，而不是原始定义里的 `$ref`
- preview 构造失败不能影响主执行流程

### 任务 2.3：补 checkpoint 细粒度事件

当前已有 `workflow.checkpoint_pending`，建议额外引入：

- `workflow.step_waiting_checkpoint`

这样可以明确表示：

- 是哪个 step 进入了 checkpoint
- 当时 step 的状态是什么
- 与 run 级 checkpoint 事件的区别是什么

### 任务 2.4：新增 step trace 写入接口

在 `TraceSink` 中新增：

- `upsertStepTrace(record)` 或保留命名风格一致的方法

写入时机：

- `step_started` 时创建草稿
- `step_completed` 时补齐输出与耗时
- `step_failed` 时补齐错误与结束时间

### 阶段二验收标准

- step 成功时可看到输入摘要、输出摘要、耗时
- step 失败时可看到错误摘要与失败前输入摘要
- checkpoint 挂起时可定位到具体 step
- 大型 output 不会被默认全量内联到 trace 中

### 阶段二测试落点

建议新增测试文件：

- `tests/workflowKernel/core/WorkflowKernelObservability.test.js`
  - 覆盖 step trace 生命周期
- `tests/workflowKernel/core/WorkflowKernelStatus.test.js`
  - 覆盖 `getRunStatus()` 聚合行为

也可以先继续并入现有：

- `tests/workflowKernel/core/WorkflowKernel.test.js`

补充断言：

- `durationMs` 存在
- `inputPreview` 存在
- `outputPreview` 存在
- checkpoint step 被单独标识

## 阶段三：默认文件 sink 落地

### 目标

提供开箱即用的可持久化诊断能力，让没有数据库扩展实现的宿主也能直接使用。

### 交付物

- `FileTraceSink`
- 文件布局约定
- run 状态文件
- last-error 文件
- events jsonl
- step trace 文件

### 任务 3.1：新增 `FileTraceSink`

建议新增文件：

```text
modules/workflowKernel/tracing/FileTraceSink.js
```

职责：

- 确保 run 目录存在
- 追加写 `events.jsonl`
- 更新 `status.json`
- 更新 `last-error.json`
- 维护 `steps/*.json`

### 任务 3.2：定义默认目录结构

建议由宿主传入根目录，内核只拼装其下结构：

```text
<traceRoot>/
  runs/
    <workflowId>/
      <runToken>/
        status.json
        last-error.json
        events.jsonl
        steps/
          0001-stepA.json
```

建议不要在内核里硬编码 `StoryOrchestrator/state/stories` 之类业务路径。

### 任务 3.3：处理写入失败策略

文件 sink 失败时必须满足：

- 主 workflow 执行不能被普通 trace 写入失败阻断
- 但要产生 `trace write failed` 级别的诊断日志
- 若 `status.json` 写入失败，至少不应覆盖主业务错误

建议区分：

- `hard failure`：主业务状态持久化失败
- `soft failure`：trace 写入失败

### 阶段三验收标准

- 成功执行后 run 目录结构完整
- 失败执行后 `last-error.json` 正确落盘
- 多次运行同一 workflow 时按 `runToken` 隔离
- trace 文件写入失败不会把成功 workflow 误判为 failed

### 阶段三测试落点

建议新增：

- `tests/workflowKernel/tracing/FileTraceSink.test.js`

覆盖：

- 正常创建目录与文件
- step 事件按 sequence 顺序写入
- last-error 正确更新
- 多 run 隔离
- 写入异常容错

## 阶段四：内核与 repository 聚合查询收口

### 目标

让查询接口不再只依赖内存态，而是能在 crash 后从持久化状态和 trace 数据聚合出“足够可读”的 run 状态。

### 交付物

- `getRunStatus()` 聚合持久化状态
- 从 repository + trace sink 组合恢复最近状态
- 非活跃 workflow 也可查询最近 run 摘要

### 任务 4.1：抽象 `RunStatusAssembler`

建议新增：

```text
modules/workflowKernel/tracing/RunStatusAssembler.js
```

职责：

- 从 active memory record 构建状态
- 若内存中不存在，则从 repository 获取 workflow 主状态
- 再从 trace sink 获取最近事件与 last-error

### 任务 4.2：定义 trace sink 读接口

如果希望 `getRunStatus()` 在非活跃 workflow 上也能工作，`TraceSink` 需要增加只读接口，例如：

- `getRunStatus(workflowId, runToken?)`
- `listRecentEvents(workflowId, runToken?, limit)`
- `getLastError(workflowId, runToken?)`

### 阶段四验收标准

- crash recovery 前后 `getRunStatus()` 结果可连续理解
- workflow 不活跃时仍能看到最近失败信息
- recent events 查询顺序稳定

### 阶段四测试落点

- `tests/workflowKernel/integration/crash-recovery.test.js`
  - 补 run 状态聚合断言
- `tests/workflowKernel/integration/persistence-integration.test.js`
  - 补 trace + repository 联合查询断言

## 阶段五：StoryOrchestrator 兼容接入

### 目标

验证内核原生观测面可以被 `StoryOrchestrator` 消费，而不要求插件先重写全部业务层。

### 交付物

- `StoryOrchestrator` 侧使用 `FileTraceSink` 或其包装实现
- kernel event 与 story event 并存
- `queryStoryStatus()` 能引用 run status

### 任务 5.1：插件注入 trace sink

由 `StoryOrchestratorKernelAdapter` 或构造内核的位置注入：

- `traceSink`
- 可选自定义 `TracePayloadPolicy`

### 任务 5.2：业务 artifact 引用桥接

插件逐步补充：

- prompt artifact ref
- raw response artifact ref
- 业务输出 artifact ref

这些都只作为 step trace 的附加引用，不改变内核标准 schema。

### 任务 5.3：状态查询桥接

在 `queryStoryStatus()` 中读取：

- `runToken`
- `currentStep`
- `recentEvents`
- `lastError`

但业务 `story-*.json` 仍保持其“故事业务状态摘要”的职责。

### 阶段五验收标准

- `StoryOrchestrator` 不再把业务状态文件误用成完整执行轨迹
- 插件能通过 kernel status 面看到真实当前 step
- 内核 trace 与 story 业务状态并存且职责清晰

### 阶段五测试落点

除了 `tests/workflowKernel` 外，建议补少量业务集成验证：

- `Plugin/StoryOrchestrator/tests/KernelAdapterExtraction.test.js`
- `Plugin/StoryOrchestrator/tests/KernelAdapterBackupRestore.test.js`
- `Plugin/StoryOrchestrator/tests/integration.test.js`

重点只测：

- adapter 接入 trace sink 后不破坏原有执行
- 状态查询能看到 kernel 当前运行状态

## 推荐文件变更清单

### 必改文件

- `modules/workflowKernel/core/WorkflowKernel.js`
- `modules/workflowKernel/persistence/WorkflowStateRepository.js`

### 建议新增文件

- `modules/workflowKernel/tracing/WorkflowTraceSink.js`
- `modules/workflowKernel/tracing/NoopTraceSink.js`
- `modules/workflowKernel/tracing/FileTraceSink.js`
- `modules/workflowKernel/tracing/TracePayloadPolicy.js`
- `modules/workflowKernel/tracing/DefaultTracePayloadPolicy.js`
- `modules/workflowKernel/tracing/traceModels.js`
- `modules/workflowKernel/tracing/RunStatusAssembler.js`

### 可能需要更新的导出文件

- `modules/workflowKernel/index.js`
- `modules/workflowKernel/README.md`
- `docs/workflow-kernel-api.md`

## 推荐提交切分

建议按以下原子提交切分，便于审查与回滚：

1. `feat(workflow-kernel): add trace sink interfaces and status models`
2. `feat(workflow-kernel): emit step_failed and add getRunStatus`
3. `feat(workflow-kernel): add step previews and step trace lifecycle`
4. `feat(workflow-kernel): add file trace sink`
5. `test(workflow-kernel): cover native observability flows`
6. `docs(workflow-kernel): document native observability APIs`
7. `feat(story-orchestrator): consume kernel native observability`

## 测试执行建议

优先从最靠近改动的测试开始跑，不要一开始就跑全量：

### 第一轮

- `tests/workflowKernel/core/WorkflowKernel.test.js`
- `tests/workflowKernel/adapters/StoryEventAdapter.test.js`

### 第二轮

- `tests/workflowKernel/integration/minimal-workflow.test.js`
- `tests/workflowKernel/integration/persistence-integration.test.js`
- `tests/workflowKernel/integration/crash-recovery.test.js`

### 第三轮

- `tests/workflowKernel/tracing/FileTraceSink.test.js`
- 必要时补跑 `Plugin/StoryOrchestrator/tests` 中 kernel 相关用例

## 风险检查清单

实现过程中，需重点防止以下回归：

- 新增 trace 写入导致 workflow 主执行被意外阻断
- `recentEvents` 无限增长导致内存膨胀
- preview 生成逻辑抛错反向污染主流程
- `getRunStatus()` 过度依赖内存态，导致 crash 后无法排障
- 把业务大对象直接塞进事件 payload 导致 trace 文件爆炸
- 破坏现有 `StoryEventAdapter` 的 legacy 事件消费逻辑

## 最小上线范围建议

如果只允许先上线一个最小版本，建议只做以下内容：

- `TraceSink`
- `NoopTraceSink`
- `workflow.step_failed`
- `LastErrorView`
- `RunStatusView`
- `getRunStatus()`
- `FileTraceSink`
- 针对 `WorkflowKernel` 的核心测试

这一版就已经能解决最核心的问题：

- workflow 当前跑到哪一步
- 最后失败在哪一步
- 为什么失败
- 最近发生了哪些关键事件

而且不会过早把业务 artifact 方案一起绑进内核。

## 建议结论

推荐按以下节奏实施：

1. 先完成阶段一和阶段三的最小闭环
2. 再补阶段二的 step 输入输出摘要
3. 最后推进阶段四和阶段五做持久化聚合与业务接入

这是当前风险最低、收益最高、最适合快速脱离黑盒状态的实现路径。
