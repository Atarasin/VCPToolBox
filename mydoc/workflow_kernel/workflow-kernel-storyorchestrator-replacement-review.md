# WorkflowKernel 替代 StoryOrchestrator 手写工作流评审报告

## 状态更新（2026-05-03）

本文是三波 OpenSpec changes 启动前的基线评审，主要用于说明当时为什么不能直接宣称替代成立。其历史结论仍然保留参考价值，但已经不再代表仓库当前状态。

截至 `workflow-kernel-replacement-certification` 第一轮实现完成后，下面这些结论已被新的测试和文档证据更新：

- “全生命周期替代：尚未成立” 已更新为：核心运行时替代证据已成立，具体见 `openspec/changes/workflow-kernel-replacement-certification/CERTIFICATION_EVIDENCE.md`
- “通用插件开发体验：尚未成立” 已更新为：shared `pluginSdk` 已由第二个 minimal reference consumer 完成最小通用性证明
- “StoryOrchestrator 参考插件化：尚未成立” 已更新为：控制面 ownership 与运行时证据已满足，但结构收敛仍待结合模块映射清单继续审查，当前应表述为“部分达成”

因此，阅读本文时应将其视为“为什么需要 7 个 changes”的问题定义文档，而不是最新验收结论。最新口径以 replacement certification change、主 spec 和相关目标态文档为准。

## 1. 文档目的

- 读者：VCP ToolBox 内部负责工作流平台、插件架构和 StoryOrchestrator 演进的工程师。
- 阅读后应能做的事：判断 `workflowKernel` 当前是否已经具备“全面替代 StoryOrchestrator 手写工作流”的条件，并据此安排下一步改造优先级。
- 评审范围：`workflowKernel` 内核能力、`StoryOrchestrator` 现有真实工作流需求、两者之间的能力差距，以及“未来工作流插件实现更简单”这一目标是否成立。

## 2. 结论摘要

结论：`workflowKernel` 目前还不能被认定为“足够满足要求”。

更准确地说，它已经具备了一个可用微内核的骨架，并且可以支撑 StoryOrchestrator 的一条主路径跑起来，但距离“全面替代现有手写工作流”仍有明显差距，距离“让未来工作流插件显著更简单”则还有一层关键抽象尚未完成。

当前状态更适合定义为：

- 内核基础能力：基本成形。
- StoryOrchestrator happy path 迁移：部分成立。
- 全生命周期替代：尚未成立。
- 通用插件开发体验：尚未成立。
- StoryOrchestrator 参考插件化：尚未成立。

如果现在就把它视为最终替代方案，风险主要集中在四类问题：

1. 控制面仍然分裂在 `WorkflowKernel` 与 `WorkflowEngine` 之间。
2. 检查点、拒绝、超时、恢复等关键语义还没有在内核里闭环。
3. 重试、回滚、阶段化恢复等“生产级编排能力”只有接口和配置，缺少真正执行。
4. StoryOrchestrator 的领域复杂度主要被搬进了自定义步骤和适配层，还没有被沉淀成未来插件可复用的抽象。

## 3. 本次评审的主要依据

本次结论来自三类证据：

- 源码审阅：内核主执行器、表达式、检查点、恢复、持久化适配器、StoryOrchestrator 适配器、声明式 workflow 定义、自定义步骤实现。
- 现有文档与测试资产：迁移指南、零回归报告、工作流说明、内核测试。
- 现场验证：
  - `node --test tests/workflowKernel/core/WorkflowKernel.test.js tests/workflowKernel/steps/GuardStep.test.js tests/workflowKernel/core/CheckpointManager.test.js` 通过，说明内核若干基础单元能力已实现且测试覆盖较好。
  - 直接运行 `WorkflowEngine._loadPhaseDefinition('phase1' | 'phase2' | 'phase3')`，实际输出为 `path is not defined`，三个 phase definition 全部返回 `null`。
  - 直接运行最小示例验证 `WorkflowKernel.resume(... action: 'reject')`，结果工作流仍被标记为批准并继续执行到完成。
  - 直接运行最小示例验证 checkpoint 超时自动批准后，工作流仍停留在 `waiting_checkpoint`，不会自动继续后续步骤。

## 4. 已经具备的能力

从“微内核骨架”角度看，`workflowKernel` 已经具备一批有价值的基础设施，这些能力不是空壳，而是已经进入可用状态。

### 4.1 执行模型已经成形

内核已经具备如下基础执行能力：

- 基于 `phases -> steps` 的声明式 workflow 定义。
- 运行时 `StepRegistry`，支持内置 step 与自定义 step 注册。
- 明确的执行状态机：`idle / running / waiting_checkpoint / completed / failed`。
- 统一事件总线，能将执行过程作为通用事件流暴露。
- 基础上下文模型：`inputs / outputs / steps`。

这说明它已经不是“概念验证脚本”，而是有了稳定执行框架。

### 4.2 核心 step 原语足够支撑大部分编排结构

当前已经有：

- `agentCall`
- `checkpoint`
- `guard`
- `loop`
- `parallelGroup`

再加上 StoryOrchestrator 侧注册的领域自定义步骤，已经足以表达：

- 并行世界观/人物生成
- 大纲生成与校验
- 逐章生产
- 多轮润色
- 最终验收

也就是说，内核的“描述能力”总体不是主要瓶颈。

### 4.3 表达式与 Guard 能力基本达标

表达式引擎已经支持：

- 比较运算
- 布尔组合 `&&` / `||`
- 括号分组
- `ctx.*` 路径访问

对应 guard 测试全部通过，说明“声明式条件判断”这块已经比最初设计更完整，可以承载较复杂的网关逻辑。

### 4.4 StoryOrchestrator 的迁移并非从零开始

现有适配层已经把 StoryOrchestrator 的核心业务动作映射成了声明式步骤，例如：

- 解析 Agent 输出
- Schema 校验
- 业务校验
- 生成大纲
- 逐章生产
- 多轮润色
- 终校

这意味着 StoryOrchestrator 的迁移已经跨过了“能不能表达”这一关，进入“能不能正确替代”的阶段。

### 4.5 基础测试面是存在的

至少以下部分已经被明确测试：

- WorkflowKernel 基本执行、checkpoint 恢复、失败路径、状态查询。
- GuardStep 各类表达式与布尔组合。
- CheckpointManager 的创建、解析、超时自动批准。
- StoryOrchestrator 的路由开关与部分 kernel adapter 行为。

这对后续继续演进是正资产。

## 5. 为什么说“还不能全面替代”

真正的问题不在于“有没有 workflow definition”，而在于生产级编排必须保证的关键语义是否闭环。当前缺口主要有以下几类。

### 5.1 控制面仍然是分裂的

这是当前最大的结构性问题。

StoryOrchestrator 在 kernel 路径下并没有完全把工作流控制权交给内核，而是形成了三层并行控制：

- `WorkflowKernel` 管 step 级执行。
- `StoryOrchestratorKernelAdapter` 负责业务状态映射与快照同步。
- `WorkflowEngine` 仍在负责 phase 迁移、超时检查点推进、恢复入口、回滚入口、部分状态推进。

这会带来两个直接后果：

1. 真实行为不再只由 workflow definition 决定，而是由“内核 + 适配层 + 旧引擎”共同决定。
2. 一旦 checkpoint、恢复、自动推进等路径跨层流转，语义极易不一致。

从“替代手写工作流”的标准看，这意味着手写工作流并没有真正消失，只是从 phase class 内部逻辑转移到了 adapter 与旧引擎边界。

### 5.2 分阶段 kernel 执行路径实际上不可用

本次现场验证直接证明：`WorkflowEngine._loadPhaseDefinition()` 由于缺少 `path` / `fs` 依赖，调用时会抛出 `path is not defined`，最后返回 `null`。

这不是边角问题，而是会直接影响以下路径：

- `WorkflowEngine._runPhaseWithKernel('phase1')`
- `WorkflowEngine._runPhaseWithKernel('phase2')`
- `WorkflowEngine._runPhaseWithKernel('phase3')`
- 自动批准后继续下一阶段
- 基于 phase 的恢复、重启、回滚后再执行

更进一步，配置目录下目前只有：

- 完整工作流定义
- `workflow-phase1.js`

并没有 phase2、phase3 对应 definition 文件。

这说明当前 kernel 替代更像是“从 `StartStoryProject` 直接跑完整 workflow 的一条路径”，而不是“所有阶段入口都已被 kernel 完整接管”。一旦进入恢复、自动推进、按 phase 重试等路径，系统很容易重新落回旧控制逻辑甚至直接失效。

### 5.3 检查点拒绝语义是错误的

这是第二个严重阻塞点。

现场验证表明，当调用：

```js
kernel.resume(workflowId, { checkpointId: 'cp-1', action: 'reject' })
```

实际行为是：

- 事件发出 `workflow.checkpoint_approved`
- payload 的 action 却是 `reject`
- 工作流继续执行后续步骤
- 最终进入 `completed`

这意味着当前内核并不区分：

- approve
- reject
- skip
- modify

在 StoryOrchestrator 的真实业务里，checkpoint rejection 不是附属能力，而是核心闭环之一：

- Phase 1 拒绝后要回流重生成
- Phase 2 大纲拒绝后要继续留在 Phase 2
- Phase 3 拒绝后要进入再润色
- 某些情况下还要触发章节级重试

如果内核层没有正确建模 reject 语义，那么就不能说它已经能够“全面替代”现有手写工作流。

### 5.4 checkpoint 超时自动批准不会真正恢复 workflow

`CheckpointManager` 会在超时后把 checkpoint 内部状态改成已批准，但这只是 manager 自己的内存状态变化。

现场验证结果显示：

- checkpoint 被自动批准后
- workflow 仍停留在 `waiting_checkpoint`
- `context.outputs` 没有后续 step 的产出
- 内核不会自动调用 resume 或继续执行

这说明当前“auto approve”只是 checkpoint 管理器层面的局部行为，不是工作流层面的真正推进。

而 StoryOrchestrator 的要求非常明确：用户超时未确认后，系统应自动继续，不应永久卡住。该需求目前仍是依赖 `WorkflowEngine` 的旧式定时推进逻辑，而不是 kernel 自身闭环完成。

### 5.5 RetryPolicy 还没有真正进入执行链

内核对外暴露了：

- `globalRetryPolicy`
- step 级 `retryPolicy`
- `RetryPolicy.resolve()`
- `shouldRetry()`
- `getDelay()`

但在主执行链里，没有看到这些策略真正驱动 step 失败后的重试。

当前实际行为仍然接近：

- step 成功：继续
- step 失败：记录失败并结束 workflow

这和 StoryOrchestrator 现有能力之间存在明显落差。旧实现对 Phase、checkpoint rejection、章节级修订、恢复动作都有比较具体的重试/回流语义，而 kernel 目前还停留在“有配置接口，没有统一执行语义”的阶段。

因此，不能把现有 RetryPolicy 视为“能力已完成”，最多只能算“接口已铺好”。

### 5.6 RecoveryManager 还不足以承担复杂恢复

RecoveryManager 目前的设计方向是对的，但离真实生产恢复还差不少：

- 通过 `current_step` 反推最后 step type，依赖 `context.steps` 的对象顺序，鲁棒性不足。
- 回滚安全边界时直接返回 `{ phase: 0, step: i }`，并没有真正保持多 phase 精度。
- 对 `parallelGroup`、`loop`、自定义步骤的恢复语义基本没有系统建模。
- 非幂等步骤识别目前主要停留在 `agentCall` 的粗粒度分类。

StoryOrchestrator 的工作流并不是线性且无副作用的简单流程，它有：

- 多阶段输出依赖
- checkpoint 切分
- 章节集合状态
- 快照回滚
- 用户反馈驱动的再执行

所以如果恢复模型没有把这些真实语义编码进去，内核就还不能独立承担生产恢复职责。

### 5.7 业务状态仍然高度依赖 StoryOrchestrator 专属适配

从“未来插件更简单”这个目标来看，当前最大的短板在这里。

StoryOrchestrator 之所以能接入 kernel，不是因为 kernel 已经提供了通用插件抽象，而是因为 adapter 额外补了大量领域桥接逻辑：

- 业务快照提取与恢复
- Story 状态字段映射
- 旧事件格式兼容
- 自定义 prompt 构建
- Outline 解析策略
- 章节生成、扩写、修订、润色编排
- 质量评估与终稿流程

这意味着：

- kernel 抽象掉的是“通用 step 调度”
- 没有抽象掉的是“插件真实最复杂的那一层业务编排”

对未来插件作者而言，当前仍然需要亲自实现一个很重的 adapter / custom step 层，开发体验还没有达到“明显变简单”的程度。

## 6. 与替代目标相比，还缺什么

如果目标是“全面替代 StoryOrchestrator 手写工作流”，至少还缺以下能力。

### 6.1 内核必须拥有完整的 checkpoint 语义

需要补齐：

- `approve / reject / skip / modify` 的明确状态机语义。
- checkpoint rejection 后的标准分支处理模型。
- checkpoint timeout 后自动继续执行，而不是只改变 manager 内部状态。
- checkpoint 解析结果落库、事件、状态推进三者的一致性。

建议把 checkpoint 语义上升为内核原生能力，而不是继续由旧引擎补逻辑。

### 6.2 内核必须真正执行 retry / rollback / retry-after-feedback

至少要支持：

- step 失败后的策略化重试。
- checkpoint rejection 驱动的重试或回退。
- 可声明的失败策略，例如 `fail / retry / checkpoint / rollbackToSnapshot / restartPhase`。
- 对 loop、parallel、自定义 step 的统一重试边界定义。

只有这样，workflow definition 才能真正替代旧 phase class 中的控制逻辑。

### 6.3 需要消灭“内核 + 旧引擎双控制面”

建议的方向不是继续增强旧引擎协调，而是收敛责任：

- 要么 kernel 成为唯一的执行控制面。
- 要么明确 kernel 只负责底层 step runtime，不宣称可替代完整工作流。

如果产品目标是“全面替代”，那就必须让以下行为全部由 kernel 主导：

- phase 迁移
- checkpoint 继续与拒绝
- 自动批准
- 崩溃恢复
- 回滚与重启
- 统一事件流

### 6.4 需要补一层“插件工作流 SDK”

这是实现“未来插件更简单”的关键，而不是继续把复杂度推给每个 adapter。

建议把当前 StoryOrchestrator adapter 中可复用的模式上移为通用能力，例如：

- 结构化 Agent 输出提取模板
- 标准 schema validation step
- 标准 human review / checkpoint step 模板
- 快照与业务状态投影接口
- phase artifact 管理接口
- 统一 prompt / validation / revision 模式
- 面向插件作者的 step factory 和 phase macro

否则未来每个工作流插件都会复制一套“大 adapter + 一堆 custom step + 状态映射”，并不会真的更轻。

### 6.5 需要明确“业务状态模型”而不是只维护技术状态模型

当前内核有执行状态，但插件真正关心的是业务状态，例如：

- phase 产物是什么
- 哪些产物已经批准
- 哪些产物可以跨阶段引用
- rollback 到哪里才算业务安全点

建议增加一层正式契约：

- phase outputs contract
- checkpoint payload contract
- business snapshot contract
- artifact store contract

这样未来插件才能把“业务数据投影”作为一等概念处理，而不是在 adapter 里手工拼接。

### 6.6 需要补齐面向替代目标的测试

当前测试主要证明了：

- 基础内核组件单点可用
- 一条集成路径零回归

但还缺最关键的替代性测试：

- kernel 路径下 checkpoint reject 是否会正确回流
- kernel 路径下 timeout auto-approve 是否会自动推进
- phase2 / phase3 在 kernel 路径下的恢复、回滚、restart_phase 是否可用
- executeWorkflow 与 executePhase 的状态模型是否一致
- 旧引擎关闭后系统是否仍能完成全流程

在这些测试缺失前，不建议宣布“内核已完成替代”。

## 7. 对“未来工作流插件更简单”的判断

现在还不能说这个目标已经实现，但可以说方向是对的。

### 7.1 为什么方向是对的

因为以下事情已经在发生：

- 流程结构从硬编码转向声明式定义。
- 公共控制原语已经被抽出。
- 事件、状态、持久化、恢复这些横切关注点开始统一。

这说明平台化方向正确。

### 7.2 为什么现在还不够简单

因为未来插件作者目前仍需要自己解决：

- 领域数据结构映射
- 业务快照策略
- 自定义步骤编排
- prompt 组织与解析
- checkpoint 反馈回流
- 老事件兼容
- 恢复语义补洞

这其实还是“高级插件开发”，不是“轻量 workflow authoring”。

### 7.3 什么时候才算真正变简单

我建议把目标定义成以下标准：

- 新插件主要写 workflow definition，而不是写整套 phase class。
- 新插件只需要实现少量业务 step，而不是整套 adapter。
- checkpoint / retry / rollback / recovery 是开箱即用语义，而不是插件自行拼装。
- phase 产物、快照、审批、事件都有统一 contract。
- 插件可以复用 StoryOrchestrator 已验证过的编排模板，而不是重新发明。

达到这些标准之后，才可以说“未来工作流插件实现更简单”。

## 8. 推荐改造顺序

### 第一阶段：先把“正确性”补齐

优先级最高：

1. 修复分阶段 kernel definition 装载问题。
2. 补齐 phase2 / phase3 definition，或者明确废弃 phase 级执行入口。
3. 修复 checkpoint reject 语义。
4. 让 checkpoint timeout 真正驱动 workflow 自动继续。
5. 将 RetryPolicy 接入主执行链。

这一步完成前，不建议把 kernel 视为可全面替代方案。

### 第二阶段：收敛控制面

优先级次高：

1. 明确由 kernel 接管 phase 迁移与恢复。
2. 将 `WorkflowEngine` 降级为兼容壳，或逐步退出主路径。
3. 统一 auto-approve、resume、recover、rollback 的入口与状态推进逻辑。

这一步完成后，才能真正消除“声明式表面下仍有大量手写工作流逻辑”的问题。

### 第三阶段：抽出插件 SDK

优先级高：

1. 把当前 StoryOrchestrator adapter 中可复用模式提炼成 SDK。
2. 形成标准 custom step 模板与 phase macro。
3. 固化业务快照与 artifact contract。
4. 提供面向未来插件作者的 authoring guide 和 reference implementation。

这一步完成后，“未来工作流插件更简单”才会真正落地。

## 9. 建议采用的验收标准

只有同时满足下面条件，我才建议对外宣称 `workflowKernel` 已足以全面替代 StoryOrchestrator 手写工作流：

- StoryOrchestrator 全流程只走 kernel 控制面即可完成，不再依赖旧引擎推进关键状态。
- checkpoint approve / reject / timeout / modify 语义全部正确且经过测试验证。
- restart_phase、rollback、continue recovery 在 kernel 路径下都能工作。
- RetryPolicy 在真实 step 执行链中生效。
- phase2 / phase3 与跨阶段输出恢复可以独立通过测试。
- 关闭 legacy path 后仍能通过完整端到端验证。
- 至少再有一个非 StoryOrchestrator 插件以较低成本接入，证明抽象具有通用性。

## 10. 三波完善后的目标态补充

为了避免后续改造只停留在“持续修补当前集成方案”，还需要明确三波改造完成后的目标状态。

目标不是让 `StoryOrchestrator` 消失，而是让它完成一次职责收敛：

- 不再承担独立工作流控制面。
- 不再保留通用 checkpoint、retry、rollback、recovery 补洞逻辑。
- 主要保留 workflow definition、少量故事领域 custom step、业务状态投影、prompt/schema/artifact 配置和插件入口。
- 成为未来工作流插件的参考实现，而不是继续作为一个历史兼容特例存在。

换句话说，三波改造完成后，理想状态下的 `StoryOrchestrator` 应是：

- 一个运行在 `WorkflowKernel` 之上的薄型领域插件。
- 一个能被第二个插件直接借鉴其 definition、contract 和少量 step 组织方式的样板。
- 一个不再需要厚 adapter 和旧引擎共同决定真实行为的参考实现。

如果未来完成三波后，`StoryOrchestrator` 仍然需要：

- 私有 `WorkflowEngine` 推进关键状态
- adapter 补齐 reject / timeout / recovery 等核心语义
- 大量私有桥接逻辑来维持主流程成立

那么就说明：

- `WorkflowKernel` 还没有真正完成替代
- “未来插件更简单”也还没有真正落地

因此，后续所有 change 除了补能力闭环，还应同时满足一个额外判断标准：

- 是否让 `StoryOrchestrator` 更接近“薄插件”
- 是否让未来插件更接近“主要写 definition，而不是重写 engine 和 adapter”

建议将这一目标态作为后续设计和验收的统一口径，并配套维护以下文档：

- 《`workflow-kernel-storyorchestrator-target-state.md`》：定义三波完成后的目标状态
- 《`workflow-kernel-storyorchestrator-retain-migrate-retire-checklist.md`》：定义职责级保留/迁移/退出口径
- 《`workflow-kernel-storyorchestrator-module-mapping-checklist.md`》：把上述口径映射到当前代码模块

## 11. 最终判断

最终判断如下：

- 如果问题是“`workflowKernel` 有没有价值？”：有，而且已经是正确方向。
- 如果问题是“它现在能不能全面替代 StoryOrchestrator 手写工作流？”：还不能。
- 如果问题是“它现在是否已经让未来工作流插件实现明显变简单？”：还没有，但具备演进成这一目标的基础。
- 如果问题是“它未来成功时，StoryOrchestrator 应该是什么状态？”：应当是一个薄型领域插件和参考样板，而不是继续保留半套私有工作流引擎。

一句话总结：

`workflowKernel` 现在更像是“一个已经证明方向可行、但尚未完成生产级闭环的平台雏形”，而不是“已经足够取代现有 StoryOrchestrator 手写工作流的最终内核”。
