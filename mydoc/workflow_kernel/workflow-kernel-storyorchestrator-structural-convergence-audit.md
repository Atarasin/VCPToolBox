# StoryOrchestrator 结构收敛与长期口径审查

## 文档目标

本文基于《StoryOrchestrator 保留 / 迁移 / 退出清单》与《StoryOrchestrator 模块映射版保留 / 迁移 / 退出清单》，对当前 `StoryOrchestrator` 剩余核心模块做一次现实状态审查。

它回答的不是“第三波有没有完成”，而是更具体的问题：

- 第三波之后，哪些模块已经接近目标态
- 哪些模块虽然不再阻塞运行时替代，但仍然属于结构收敛债务
- 哪些旧模块已经明确只能作为 compatibility surface 存在
- 后续若继续推进收敛，应该优先从哪里下手

本文面向内部维护者，读完后应能够直接做一件事：

- 在不重新打开第三波已归档 changes 的前提下，确定下一批“结构收敛与长期口径”工作的最小切入面

若决定把本审查转成新的 OpenSpec 工作项，建议继续阅读《`workflow-kernel-storyorchestrator-structural-convergence-change-plan.md`》。

## 审查范围与方法

本轮审查聚焦当前最影响目标态判断的模块：

- 插件入口与状态查询层
- `WorkflowEngine` compatibility shell
- `StoryOrchestratorKernelAdapter`
- workflow definition 与 contract
- 领域 step、领域校验与可复用 helper
- 业务状态、业务仓储与 artifact 管理
- 已降级的 phase compatibility 文件

判定口径沿用前两份清单，统一分为三档：

- **已接近目标态**：当前职责与目标态基本一致，后续只需小幅清理
- **部分达成**：方向正确，但仍混有不该长期保留的跨层职责
- **应继续退出/降级**：当前只应保留为兼容壳或历史过渡层，不应继续演化为主路径能力

## 总体结论

当前 `StoryOrchestrator` 的结构状态可以概括为：

- 主流程 definition、shared contracts 和 kernel-led 运行时证据已经收口
- 插件入口、业务投影与领域能力已经大体区分出边界
- 但 `WorkflowEngine`、`StoryOrchestratorKernelAdapter`、`StateManager` 这一组模块仍然保留了较多过渡性结构债
- 因此，`StoryOrchestrator` 已经是“运行时替代成立的 reference consumer”，但还不是“结构完全收敛的薄型参考插件”

如果只用一句话总结本轮审查结果，最准确的口径是：

**控制面 ownership 已经完成上收，但 compatibility shell、adapter 和业务状态聚合层仍需继续压薄，才能把 `StoryOrchestrator` 从 reference consumer 推进到真正的薄型参考插件。**

## 模块审查矩阵

| 模块 | 清单目标动作 | 当前判断 | 主要依据 | 结论 |
|---|---|---|---|---|
| `core/StoryOrchestrator.js` | 保留并压薄 | 部分达成 | 已主要承担插件入口、工具分发与装配，但仍直接做双路径路由、启动前 workflow 写入、legacy fallback 和双源状态拼装 | 可长期保留，但需继续压薄为装配层 |
| `core/WorkflowEngine.js` | 退出主路径，降级为 compatibility shell | 部分达成 | `start/resume/recover/retryPhase` 已在 kernel 模式下委托到 kernel；但仍实例化 `Phase1/2/3`、保留 auto-approve、phase 运行、recovery 分支和状态推进逻辑 | 已不再是主控制面，但结构上仍然过厚 |
| `adapters/StoryOrchestratorKernelAdapter.js` | 拆分后压薄 | 部分达成 | 已成为 kernel 接入主桥，但仍同时承担 step 注册、提取与解析、legacy 事件兼容、业务快照恢复、contract 投影等多种职责 | 当前是最大结构收敛债之一 |
| `config/workflow-definition.js` | 保留 | 已接近目标态 | 主流程已通过 plugin SDK helper、contracts、macros 组织，且已被真实 kernel-led 路径验证 | 已是长期保留资产 |
| `config/workflow-contracts.js` | 保留并对齐 shared contract | 已接近目标态 | phase output、checkpoint、snapshot、artifact contract 均已声明化，并被 adapter 与认证路径消费 | 已达到第三波预期 |
| `steps/index.js` | 保留领域 step，抽出通用模板 | 部分达成 | 既包含故事领域步骤，也包含 extraction、outline 解析、validation 结果解析等明显可复用模式 | 需要继续拆分为“领域 step”与“可复用 helper” |
| `core/StateManager.js` | 保留并收口职责 | 部分达成 | 仍同时维护业务状态、`workflow` 字段、checkpoint、history 与 SQLite/JSON dual-write 聚合 | 应保留，但需减少 runtime 真相职责 |
| `core/StoryStateRepository.js` | 保留业务仓储，避免继续私有化 runtime contract | 部分达成 | 除故事数据外，还承载 checkpoints、snapshots、events、phase_attempts 等 runtime 相关模型 | 需要明确哪些是业务资产，哪些只应作为 kernel 适配遗产 |
| `core/ArtifactManager.js` | 保留并对齐 contract | 部分达成 | 已是轻量 artifact 存储层，但接口仍偏插件本地落盘与 SQLite 索引视角 | 可保留，后续主要是 contract-facing 收口 |
| `core/ChapterOperations.js` | 领域能力保留，局部抽象 | 部分达成 | 核心是故事章节生成、修订、润色，但内部包含“生成 -> 扩写 -> 校验 -> 修订”的可复用套路 | 应主体保留，同时识别可复用子模式 |
| `core/ContentValidator.js` | 拆分后部分保留、部分抽 SDK | 部分达成 | 故事校验规则应保留，但结构化结果解析、综合聚合骨架具备复用潜力 | 需要拆分“校验骨架”与“故事规则” |
| `utils/SchemaValidator.js` | 原清单写为迁移到 SDK，现需校准 | 部分达成 | 通用 schema validation handler 已进入 shared plugin SDK，但本文件里的 worldview/characters/outline 校验仍明显偏故事领域 | 更准确的动作是“拆分并校准口径”，不是整块迁移 |
| `utils/PromptBuilder.js` | 保留并模板化 | 已接近目标态 | 当前主要承载故事领域 prompt 模板，不再承担通用 runtime 控制 | 可以作为长期保留资产继续维护 |
| `utils/ValidationSchemas.js` | 保留 | 已接近目标态 | 当前是插件工具入口的输入边界校验，不构成通用 runtime 语义泄漏 | 长期保留合理 |
| `config/extraction-schemas.js` | 保留 | 已接近目标态 | 承载领域 extraction schema，本身属于领域数据定义 | 长期保留合理 |
| `config/workflow-phase1.js` | compatibility only | 应继续退出/降级 | 文件头已声明 compatibility artifact，但仍未被显式退役或打上机器可判定的 deprecated 信号 | 应继续退役，不再作为参考实现的一部分 |
| `core/Phase1_WorldBuilding.js` / `core/Phase2_OutlineDrafting.js` / `core/Phase3_Refinement.js` | compatibility only | 应继续退出/降级 | 仍由 `WorkflowEngine` 在 legacy 路径中实例化并持有，说明手写 phase class 还没从结构上彻底退出 | 仅应保留为过渡壳，不应再承接新逻辑 |

## 已接近目标态的部分

下面这些模块和边界，已经可以视为第三波后的稳定资产：

### 1. Workflow Definition 已成为主流程真相来源

`config/workflow-definition.js` 已经满足目标态中最关键的一条：

- 主流程通过 definition 表达
- phase 结构、checkpoint、guard、failure policy 都以声明式形式出现
- shared `pluginSdk` helper 和 `workflow-contracts` 已接入主流程

这说明“未来插件主要写 definition，而不是重造 engine”这件事，在 `StoryOrchestrator` 上已经有真实样板。

### 2. Contract 层已经基本稳定

`config/workflow-contracts.js` 已经把下面这些内容转成 shared contract 消费面：

- phase outputs
- checkpoint payloads
- business snapshots
- artifact projection

这是 `StoryOrchestrator` 从“靠私有字段约定”走向“靠稳定 contract 协作”的核心标志。

### 3. 部分领域模块已具备长期保留资格

下面几类模块目前看没有明显方向错误：

- `utils/PromptBuilder.js`
- `utils/ValidationSchemas.js`
- `config/extraction-schemas.js`

它们主要承载领域 prompt、插件入口校验和领域 schema，本质上属于故事领域配置面，而不是通用 runtime。

## 部分达成、仍需继续收口的部分

### 1. `core/StoryOrchestrator.js` 仍然比理想入口层更重

当前入口层已经不再手写 phase 主流程，但仍保留了几个不够理想的结构特征：

- `startStoryProject()` 在 kernel path 下仍会预写 workflow 状态与 `runToken`
- `queryStoryStatus()` 同时拼装 `workflowEngine.getWorkflowStatus()` 和 `kernelAdapter.getStatus()`
- `userConfirmCheckpoint()` 仍保留 `legacy-fallback` 分支

这说明入口层已经不再是主控制器，但也还没有收敛成“纯装配 + 统一 facade”。

### 2. `core/WorkflowEngine.js` 已经变成 compatibility shell，但壳还太厚

这是当前最清晰的结构判断：

- 好消息是，`start()`、`resume()`、`recover()`、`retryPhase()` 在 kernel 模式下已经委托给 kernel-owned 路径
- 但坏消息是，它仍然持有：
  - `Phase1/2/3` legacy class 实例
  - legacy `_runPhase1/_runPhase2/_runPhase3`
  - auto-approve timer 与 `_autoApproveExpiredCheckpoint()`
  - 大量恢复、回滚、phase 切换和 phase result 处理逻辑

因此它现在更像“已经不再拥有主控制权，但还带着完整 legacy 躯壳的 compatibility shell”。

### 3. `StoryOrchestratorKernelAdapter.js` 仍然是厚 adapter

当前 adapter 之所以重要，是因为它同时做对了两件事，也同时暴露了两类结构债：

已经做对的部分：

- 把 `StoryOrchestrator` 接入 `WorkflowKernel`
- 通过 lifecycle hooks 与 `workflow-contracts` 支撑 business snapshot / restore
- 提供 legacy event compatibility

仍然过厚的部分：

- 注册自定义 step 的同时，还直接承载 prompt 构造、提取、解析和多段输出规整
- 维护业务快照恢复和 legacy event adapter
- 混合了 kernel bridge、SDK-like helper、兼容桥接三层职责

这意味着它仍然是当前最需要继续拆分的过渡模块。

### 4. 状态与仓储边界还没有完全收口

`StateManager.js` 和 `StoryStateRepository.js` 当前已经不再阻塞运行时替代，但仍然混有明显的“双层语义”：

- 一层是业务摘要与产品查询需要的故事状态
- 一层是 workflow runtime 相关的 checkpoints、snapshots、events、retryContext

只要这两层继续在同一聚合对象里并存，后续维护者就仍有机会把业务状态误用成执行真相。

### 5. 领域 step 与通用 helper 仍然混放

`steps/index.js`、`ContentValidator.js`、`ChapterOperations.js` 和 `SchemaValidator.js` 当前都存在同一种问题：

- 模块里既有故事领域专属能力
- 也有明显属于“别的插件未来也会需要”的 helper 或骨架

其中最典型的口径修正点是：

- `SchemaValidator.js` 不应再简单表述为“整体迁移到 SDK”
- 更准确的口径应是：**通用 schema validation 机制已迁入 SDK，但故事领域的具体 validator 仍应保留或拆出为插件私有领域校验模块**

这也是本轮审查对早期模块映射清单做出的最重要现实校准。

## 应继续退出或降级的部分

### 1. Phase Class 主路径遗产

`Phase1_WorldBuilding.js`、`Phase2_OutlineDrafting.js`、`Phase3_Refinement.js` 仍被 `WorkflowEngine` 持有并实例化。

这本身并不再说明系统仍是 legacy 主导，但说明：

- 手写 phase class 尚未从结构上完全退出
- 只要它们仍被宿主持有，就仍有被新需求误加逻辑的风险

当前最合理的长期策略是：

- 保留 compatibility 壳身份
- 禁止继续承接新控制语义
- 为未来明确退役创造更清晰边界

### 2. `config/workflow-phase1.js` 兼容定义文件

这个文件已经在注释层声明自己只是 compatibility artifact，但还存在两个问题：

- 它仍保留在主配置目录中
- 它没有以更明确的长期口径被判定为“仅兼容、不可继续扩展”

因此它虽然不再是运行时 blocker，但仍应列为明确的退役对象。

## 建议更新的长期口径

基于本轮代码现实，建议把后续对 `StoryOrchestrator` 的长期口径统一为下面这组表述：

### 1. 对 `WorkflowEngine` 的口径

不要再把它描述成“仍然负责部分工作流控制”的模块。

更准确的说法是：

- 它已经完成主控制权让渡
- 当前主要价值是 compatibility shell
- 但它仍携带大量 legacy 结构债，需要继续压薄

### 2. 对 `StoryOrchestratorKernelAdapter` 的口径

不要再把它简单描述为“桥接层”。

更准确的说法是：

- 它是现阶段 kernel 接入的核心桥接层
- 但当前仍是一个混合了 kernel bridge、SDK helper 和兼容逻辑的厚 adapter
- 未来的重点不是删除它，而是拆职责、缩边界

### 3. 对 `SchemaValidator.js` 的口径

需要修正早期“整体迁移到 SDK”的过度表述。

更准确的说法是：

- 通用 schema validation handler 已迁入 SDK
- 具体的故事领域 schema validator 应保留在插件侧，或拆分为更清晰的领域校验模块

### 4. 对 `StoryOrchestrator` 当前状态的口径

建议统一使用：

**`StoryOrchestrator` 已完成运行时替代层面的关键收口，但 compatibility shell、adapter 和业务状态层仍需继续压薄；当前应视为“参考插件候选态”，而不是“最终完全收敛的薄型参考插件”。**

## 后续最小收敛动作

如果接下来继续推进“结构收敛与长期口径”收尾，建议按下面顺序做，而不是重新回到大规模 runtime 改造：

### 1. 明确冻结 compatibility shell 边界

优先对象：

- `core/WorkflowEngine.js`
- `core/Phase1_WorldBuilding.js`
- `core/Phase2_OutlineDrafting.js`
- `core/Phase3_Refinement.js`
- `config/workflow-phase1.js`

目标是把“这些模块仅用于兼容，不再承接新主逻辑”的边界写实并固化。

### 2. 拆分 `StoryOrchestratorKernelAdapter.js`

优先把下列职责分离：

- kernel bridge
- business snapshot / restore projector
- legacy event compatibility
- reusable step helper / extraction helper

这是当前最能直接降低结构复杂度的一步。

### 3. 收紧业务状态与 runtime 状态边界

优先对象：

- `StateManager.js`
- `StoryStateRepository.js`
- `ArtifactManager.js`

目标不是推翻现有存储，而是明确：

- 哪些字段是业务投影
- 哪些字段只是 kernel 适配历史遗留
- 哪些 contract 不应继续在插件私有仓储里扩张

### 4. 继续提炼可复用 helper

优先对象：

- `steps/index.js`
- `ContentValidator.js`
- `ChapterOperations.js`
- `SchemaValidator.js`

目标是把“通用骨架”和“故事领域规则”分开，而不是整块迁移。

## 最终结论

本轮审查确认了一件很重要的事：

第三波之后，`StoryOrchestrator` 的主要矛盾已经从“运行时替代是否成立”，转移到了“结构是否已经收敛到长期可维护形态”。

当前最值得继续推进的不是重新证明 kernel 能不能跑，而是继续压缩这三类剩余复杂度：

- compatibility shell 的历史壳复杂度
- adapter 的混合职责复杂度
- 业务状态层与 runtime 适配层的边界复杂度

只要这三类复杂度继续被收口，`StoryOrchestrator` 才能从当前的“reference consumer 候选态”，真正走到目标态里定义的“薄型参考插件”。
