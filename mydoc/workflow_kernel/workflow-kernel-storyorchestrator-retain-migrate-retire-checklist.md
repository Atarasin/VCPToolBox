# StoryOrchestrator 保留 / 迁移 / 退出清单

## 文档目标

本文基于《WorkflowKernel 三波完善后 StoryOrchestrator 目标态说明》，给出一份面向落地改造的清单，用于回答下面的问题：

- `StoryOrchestrator` 现有职责中，哪些应该长期保留
- 哪些应该迁移到 `WorkflowKernel`
- 哪些应该迁移到插件 SDK
- 哪些应该降级为兼容壳，或最终退出主路径

本文的读者是负责工作流平台、插件架构和 StoryOrchestrator 演进的内部工程师。

读完后，读者应能够做一件具体的事：

- 在后续 OpenSpec change、代码重构和评审中，快速判断某个模块或职责应当被保留、上收还是退役

如果需要进一步映射到当前 `StoryOrchestrator` 的实际模块，请继续阅读《`workflow-kernel-storyorchestrator-module-mapping-checklist.md`》。

## 使用方式

这不是一份“马上删除哪些文件”的机械清单，而是一份职责决策表。

建议按下面的顺序使用：

1. 先判断某段代码属于哪个职责域
2. 再看该职责域在目标态中的归属是“保留 / 迁移 / 退出”
3. 再根据对应的阶段约束，决定它属于第一波、第二波还是第三波处理

如果某段代码同时承担多个职责，应先拆职责，再决定去向，不要整块迁移。

## 判定原则

在这份清单中，三个动作的含义如下：

- **保留**：该职责在目标态下仍然属于 `StoryOrchestrator`
- **迁移到内核**：该职责属于通用 workflow runtime，应进入 `WorkflowKernel`
- **迁移到 SDK**：该职责不属于内核底层执行，但应被抽象为未来插件可复用能力
- **退出/降级**：该职责只为旧路径或过渡期存在，目标态下不应继续作为主路径能力存在

判断时优先使用下面三条规则：

1. 如果它决定通用执行语义，就不应留在插件里
2. 如果它对多个插件都可能复用，就不应长期留在 StoryOrchestrator 私有层
3. 如果它只是故事生成领域特有语义，就应保留在插件里

## 当前执行口径更新（2026-05-04）

`workflow-kernel-storyorchestrator-structural-convergence` 当前实现批次已经把下面三类口径从“目标描述”推进到“代码中已有对应表达”：

- **退出/降级**：`WorkflowEngine`、`Phase1/2/3`、`workflow-phase1` 已明确冻结为 compatibility surface，不再接受新的主控制逻辑
- **保留并收口**：`StateManager`、`StoryStateRepository`、`ArtifactManager` 继续保留在插件侧，但必须以业务投影为主，而不是继续扮演 runtime truth
- **保留领域规则 / 识别可复用骨架**：`ContentValidator`、`ChapterOperations`、`steps/index`、`SchemaValidator` 不再使用“整块迁移”口径，而改为先区分 story-domain rules 与 reusable skeleton

因此，当前使用这份清单时应额外遵守两个判断：

1. 看到 validator / chapter / step helper 时，先问“这里是故事规则，还是通用编排骨架”，不要直接把整文件视为 SDK 候选
2. 看到状态字段或 adapter 逻辑时，先问“这是业务投影还是 runtime compatibility bookkeeping”，不要把插件私有投影误判为 kernel execution truth

## Compatibility Surface 三态补充（2026-05-04）

当某个模块已经被认定为 compatibility surface 时，当前不再只做“保留或删除”的二元判断，而改用下面三态：

- **`retain-as-shell`**：仍有兼容入口、迁移缓冲或排障价值，因此继续保留，但只能做 delegation shell，禁止继续吸收主控制语义
- **`degrade-entry`**：入口仍存在，但应收缩为更薄的兼容包装器、deprecated alias 或只读工件，不再作为首选执行来源
- **`eligible-for-retirement`**：已经存在稳定替代路径，且验证证据足够，可以继续物理删除或进一步减少壳层

使用这三态时还要额外记住一条：

- compatibility retirement 的推进不等于 thin reference plugin readiness 完成；如果 adapter、状态边界或 helper 分层仍未收口，readiness 结论仍不能提前关闭

## 总览表

| 职责域 | 目标动作 | 最终归属 | 目标态说明 |
|---|---|---|---|
| workflow definition | 保留 | StoryOrchestrator | 插件最核心资产，应成为未来插件作者主要参考对象 |
| phase class 式手写编排 | 退出/降级 | compatibility only | 不再作为主流程编排来源 |
| 通用 phase 迁移控制 | 迁移到内核 | WorkflowKernel | 属于统一控制面，不应继续留在私有 engine |
| checkpoint 状态机与 timeout 推进 | 迁移到内核 | WorkflowKernel | 属于通用 runtime 语义 |
| retry / rollback / recovery 主逻辑 | 迁移到内核 | WorkflowKernel | 属于生产级编排能力 |
| story-specific custom steps | 保留 | StoryOrchestrator | 保留少量故事领域专属能力 |
| schema validation / human review / 通用编排模板 | 迁移到 SDK | Plugin SDK | 应作为未来插件复用模式输出 |
| prompt / schema / artifact 领域配置 | 保留 | StoryOrchestrator | 仍然是故事领域知识的一部分 |
| 业务状态投影 | 保留 | StoryOrchestrator | 保留为业务摘要层，不再兼任执行轨迹 |
| 厚 adapter 兼容层 | 退出/压薄 | thin adapter only | 不能继续成为真实行为的第二来源 |
| 插件入口与装配 | 保留 | StoryOrchestrator | 作为插件形态的必要边界保留 |

## 职责域清单

### 1. Workflow 定义层

**代表内容**

- 完整 workflow definition
- phase definition
- step、guard、checkpoint、failure policy 的声明式配置

**目标动作**

- 保留

**最终归属**

- `StoryOrchestrator`

**原因**

- 这是插件最应该保留的资产
- 未来插件作者应主要学习如何组织 definition，而不是如何手写 phase class
- 三波完成后，`StoryOrchestrator` 的主价值之一就是提供一份成熟的参考 workflow definition

**改造要求**

- workflow definition 成为主流程的唯一或绝对主要表达方式
- phase class 不再是主编排来源
- phase definition 必须覆盖主路径，而不是只剩部分阶段

**完成标志**

- 读 `StoryOrchestrator` 时，首先看到的是 definition，而不是 engine

### 2. Phase Class 式手写编排

**代表内容**

- 以 `Phase1`、`Phase2`、`Phase3` 形式承载主流程控制的编排代码
- 通过 phase class 推进状态、切换分支、控制回流的逻辑

**目标动作**

- 退出主路径
- 必要时先降级为兼容壳

**最终归属**

- compatibility surface only

**原因**

- 这类代码是“手写工作流”形态的直接体现
- 如果它仍然决定主要行为，就说明替代目标尚未成立

**改造要求**

- phase class 不再承担主状态推进
- 如需保留，职责只能是兼容旧入口或迁移期包装
- 不允许再往 phase class 中继续加新控制语义

**完成标志**

- 即使关闭 phase class 主路径，workflow 仍能由 kernel 控制面完整跑通

### 3. 私有 Workflow Engine 控制逻辑

**代表内容**

- phase 迁移
- auto-approve 推进
- resume / recover / rollback 入口协调
- 关键状态推进与主事件流控制

**目标动作**

- 迁移到内核
- 原有 engine 最终降级或退出

**最终归属**

- `WorkflowKernel`

**原因**

- 这部分决定的是通用执行语义
- 只要它还留在 `StoryOrchestrator` 私有 engine 中，系统就仍然是双控制面

**改造要求**

- 控制权逐步上收至 kernel
- 原 `WorkflowEngine` 若保留，只允许充当门面或兼容层
- 新需求不得继续优先落在私有 engine

**完成标志**

- 关键状态推进不再依赖私有 engine

### 4. Checkpoint 状态机与 Timeout 推进

**代表内容**

- `approve / reject / skip / modify / timeout` 行为解析
- reject 后回流
- timeout 自动继续
- checkpoint 状态、事件和持久化推进

**目标动作**

- 迁移到内核

**最终归属**

- `WorkflowKernel`

**原因**

- 这是典型的通用 runtime 语义
- 未来任何工作流插件都可能需要，不能长期由 `StoryOrchestrator` 私有逻辑承担

**改造要求**

- 插件只声明 checkpoint 业务含义和 payload
- 不再在插件侧实现通用 reject / timeout 行为

**完成标志**

- `StoryOrchestrator` 不再通过 adapter 或旧引擎补 checkpoint 关键语义

### 5. Retry / Failure Policy / Rollback / Recovery 主逻辑

**代表内容**

- step 失败后的重试
- feedback 驱动再执行
- rollback 到安全点
- restart phase
- continue recovery

**目标动作**

- 迁移到内核

**最终归属**

- `WorkflowKernel`

**原因**

- 这些是生产级编排能力，不是故事领域特有能力
- 插件应只声明策略和边界，而不应直接控制执行语义

**改造要求**

- 策略声明与执行链分离
- 插件只声明哪些步骤可重试、哪些步骤非幂等、哪些点是业务安全边界
- 真正执行、推进和恢复由内核完成

**完成标志**

- 插件不再持有 recovery 主逻辑，只保留业务边界说明

### 6. Story-Specific Custom Steps

**代表内容**

- 大纲生成与解析
- 章节生成、扩写、修订、润色
- 终稿质量判断
- 故事领域特有的数据组织与校验

**目标动作**

- 保留

**最终归属**

- `StoryOrchestrator`

**原因**

- 这些是故事生成业务的核心差异化能力
- 若强行下沉，会把内核污染成领域内核

**改造要求**

- 只保留真正不能通用化的部分
- 能抽象成标准 step 模板的部分，应在第三波迁入 SDK

**完成标志**

- 插件仍有自定义 step，但数量和复杂度明显少于当前厚插件形态

### 7. 通用 Step 模板与编排模式

**代表内容**

- schema validation
- human review / checkpoint 模板
- prompt -> parse -> validate -> revise 模式
- 通用 step factory
- phase macro

**目标动作**

- 迁移到 SDK

**最终归属**

- Plugin SDK

**原因**

- 它们不属于内核底层执行
- 但它们明显应该被多个插件复用

**改造要求**

- 从 `StoryOrchestrator` 当前实现中抽出稳定模式
- 先定义 contract，再提供标准 helper
- `StoryOrchestrator` 自己应先成为第一批 SDK 使用者

**完成标志**

- 第二个插件接入时可直接复用这些模板，而不是复制 StoryOrchestrator 私有代码

### 8. Prompt、Schema 与 Artifact 领域配置

**代表内容**

- prompt 组织
- extraction schema
- 领域校验 schema
- 故事产物的命名、组织和展示方式

**目标动作**

- 保留

**最终归属**

- `StoryOrchestrator`

**原因**

- 这些内容直接体现故事领域知识
- 即使未来存在标准接口，具体配置本身仍应属于插件

**改造要求**

- 尽量配置化、结构化
- 避免和执行控制逻辑混写

**完成标志**

- 领域配置清晰可见，可独立于 runtime 补洞层理解

### 9. 业务状态投影与业务仓储

**代表内容**

- 故事状态摘要
- artifact 视图
- 面向产品的业务状态查询
- 业务快照投影

**目标动作**

- 保留
- 但要重新收口职责

**最终归属**

- `StoryOrchestrator`

**原因**

- 业务状态视图是插件对外的产品语义
- 但它不应再承担 workflow runtime 的真实控制职责

**改造要求**

- 明确“业务摘要”和“执行状态”分层
- 业务状态只做投影，不做控制真相来源
- 执行恢复、当前 step、rollback 决策等信息改由 kernel runtime 提供

**完成标志**

- 业务状态文件或查询接口不再被误用为执行轨迹

### 10. 厚 Adapter 与旧兼容桥接

**代表内容**

- 旧事件兼容桥接
- 旧状态字段兼容
- kernel 缺口补洞
- 跨层状态同步

**目标动作**

- 压薄
- 过渡逻辑最终退出

**最终归属**

- thin adapter only

**原因**

- adapter 可以存在，但不应继续成为核心语义承载层
- 它只能是接入边界，不应是第二执行面

**改造要求**

- adapter 仅保留合法映射职责
- 不允许继续长出 checkpoint/recovery/runtime 补丁逻辑

**完成标志**

- adapter 删除后，不会破坏 kernel 的主要执行语义

**当前阶段判断**

- 已完成第一轮职责切片，但尚未达到 thin adapter 终态
- 后续评审时，不应再把 `StoryOrchestratorKernelAdapter` 视为“可以继续承载新平台语义”的位置

### 11. 插件入口、注册与宿主接入

**代表内容**

- 插件入口
- workflow 注册
- step 注册
- 宿主侧装配逻辑

**目标动作**

- 保留

**最终归属**

- `StoryOrchestrator`

**原因**

- 这是插件存在的最基本边界
- 即便内核和 SDK 很成熟，插件仍需承担这部分职责

**改造要求**

- 尽量保持薄装配
- 入口更像装配层，而不是控制器

**完成标志**

- 入口文件主要做注册和装配，不再承载复杂流程控制

## 按阶段的处理建议

### 第一波：优先迁移通用正确性语义

优先处理：

- checkpoint 状态机
- timeout 推进
- phase 入口正确性
- retry policy 执行链

这一波的原则是：

- 优先迁移语义，不先做大规模删除
- 禁止继续在插件层补新的运行时语义

### 第二波：上收控制面并压薄旧引擎

优先处理：

- 私有 `WorkflowEngine` 控制逻辑
- recovery / rollback 主逻辑
- 旧引擎与 adapter 中残留的状态推进逻辑

这一波的原则是：

- 先让内核主导，再清理旧壳
- 不允许一边说“控制面收敛”，一边继续给旧 engine 加功能

### 第三波：抽 SDK 并收敛为参考插件

优先处理：

- 通用 step 模板
- 通用编排模式
- snapshot / artifact / checkpoint contract
- reference implementation 收口

这一波的原则是：

- 不只是“抽一些 helper”
- 而是真正让 `StoryOrchestrator` 变薄，并让第二个插件能复用其模式

## 评审时可直接使用的检查问题

后续做代码评审或 change 评审时，可以直接用下面的问题快速判断方向是否正确：

- 这段代码是在表达故事领域语义，还是在补通用 runtime 语义
- 如果把这段代码复制给第二个插件，是否合理
- 如果合理复用，它是不是应该进入 SDK
- 如果它决定 phase、checkpoint、retry、recovery 的执行行为，它为什么不在内核里
- 如果它只是兼容旧路径，它是否还在主路径里承担关键职责
- 删除这段代码后，kernel 主路径是否仍然成立

## 最终保留形态

如果这份清单被正确执行，最终的 `StoryOrchestrator` 应主要由下面几类东西组成：

- workflow definition
- 少量故事领域 custom step
- prompt / schema / artifact 配置
- 业务状态投影
- 插件入口与注册

而不应再主要由下面几类东西组成：

- 私有 workflow engine
- phase class 式主编排
- checkpoint/retry/recovery 通用补洞层
- 厚 adapter
- 依赖旧路径才能成立的关键状态推进逻辑

## 最终结论

这份清单的核心目的，不是简单做一次代码搬家，而是确保三波改造后，`StoryOrchestrator` 真正完成从“历史厚插件”到“未来参考插件”的收敛。

判断标准可以归结为一句话：

**凡是通用执行语义，上收到 `WorkflowKernel`；凡是通用插件模式，下沉到 SDK；凡是故事领域专属能力，保留在 `StoryOrchestrator`；凡是过渡兼容补丁，逐步退出主路径。**

补充当前阶段性口径：

**现在的 `StoryOrchestrator` 已经进入“保留领域能力、退出历史控制面、识别可复用骨架”的收敛阶段；剩余工作主要是收薄 adapter、继续分离状态层边界，并把已识别的 reusable skeleton 逐步沉淀成稳定模式。**
