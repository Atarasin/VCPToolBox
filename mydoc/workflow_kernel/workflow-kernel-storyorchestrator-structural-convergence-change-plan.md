# StoryOrchestrator 结构收敛 OpenSpec Change 方案

## 文档目标

本文将《StoryOrchestrator 结构收敛与长期口径审查》转换为一个新的 OpenSpec 收敛型 change 方案，用于指导下一步正式创建 change artifacts。

这份方案回答四个问题：

- 新 change 应该叫什么
- 它为什么应该作为一个单独的收敛型 change 存在
- 它的边界、非目标、验收标准和测试重点是什么
- 后续起 `proposal.md / design.md / tasks.md / delta spec` 时应该如何落笔

读完本文后，维护者应能够直接开始创建：

- `openspec/changes/workflow-kernel-storyorchestrator-structural-convergence/`

## 推荐 Change

### 推荐 change id

- `workflow-kernel-storyorchestrator-structural-convergence`

### 推荐定位

这是一个**后第三波的结构收敛型 change**，不是新的 runtime 正确性 change，也不是 replacement certification 的补丁 change。

它的目标不是重新证明 `WorkflowKernel` 能否替代 `StoryOrchestrator`，而是把第三波后已经确认存在的结构债，转化为一组明确、可验收、可归档的收敛动作。

### 推荐 capability

- `workflow-kernel-reference-plugin-convergence`

这个 capability 的长期作用是定义：

- `StoryOrchestrator` 何时可以被正式视为“薄型参考插件”
- compatibility shell、adapter、状态边界和可复用 helper 应如何收敛

## 为什么应该单独成一个 change

第三波已经完成了三件关键的事：

- plugin authoring SDK 已沉淀成主 spec
- replacement certification 已完成并归档
- `WorkflowKernel` 对 `StoryOrchestrator` 手写工作流的运行时替代证据已经成立

因此，当前问题已经发生变化。

现在的主要矛盾不是：

- checkpoint 还能不能跑
- rollback 能不能恢复
- kernel-led path 能不能完成主流程

而是：

- `WorkflowEngine` 是否已经足够薄，只保留 compatibility shell 职责
- `StoryOrchestratorKernelAdapter` 是否仍然混合了过多 bridge / helper / compatibility 责任
- 状态层是否还在把业务投影与 runtime 适配状态混在一起
- `StoryOrchestrator` 是否真的已经逼近“未来插件样板”

这类问题不适合回填到已归档的第三波 change 中，原因有三点：

1. 第三波的验收重点已经完成，重新打开会让 archive 口径失真
2. 当前工作属于结构压薄与长期边界治理，不再是运行时替代性验证
3. 这些问题彼此高度关联，如果拆成多个很细的 change，反而会让 compatibility shell、adapter 和状态层边界再次断裂

因此，最合理的方式是：

- 新起一个明确面向“结构收敛与长期口径”的 change
- 以前三波 archive 与主 spec 为稳定前置
- 以“把 `StoryOrchestrator` 从 reference consumer 候选态推进到薄型参考插件候选完成态”为目标

## 目标

这个 change 的目标应明确限制在结构收敛，而不是回头扩 runtime 语义：

1. 冻结并压薄 `WorkflowEngine` 及 phase compatibility 遗产
2. 拆分并收缩 `StoryOrchestratorKernelAdapter` 的混合职责
3. 收紧业务状态、artifact 投影与 runtime 适配状态的边界
4. 继续把可复用 helper 从插件私有实现中识别并分层
5. 输出可长期复用的“薄型参考插件”判断标准与收敛结论

## 非目标

为了避免 scope 漂移，建议在 proposal 里明确写出下面这些非目标：

- 不重新设计 `WorkflowKernel` 的 checkpoint、recovery、rollback 或 certification 语义
- 不重新打开已归档的 `workflow-kernel-plugin-authoring-sdk` 或 `workflow-kernel-replacement-certification`
- 不在本 change 内引入新的大规模 plugin SDK API 面，除非审查证明现有 shared helper 仍缺少最小支撑
- 不把 `StoryOrchestrator` 一次性重写成全新的插件实现
- 不以“物理删除全部 legacy 文件”为唯一完成标准

## 建议范围

### 1. Compatibility Shell 冻结

聚焦对象：

- `WorkflowEngine`
- `Phase1_WorldBuilding`
- `Phase2_OutlineDrafting`
- `Phase3_Refinement`
- `workflow-phase1`

建议动作：

- 把这些模块明确标注为 compatibility surface
- 禁止继续承接新的主控制语义
- 明确哪些方法仍需保留给兼容入口，哪些逻辑应只允许委托到 kernel
- 让未来读者能一眼区分“兼容壳”与“真实主路径”

### 2. Adapter 拆分与压薄

聚焦对象：

- `StoryOrchestratorKernelAdapter`

建议动作：

- 把 kernel bridge、business snapshot / restore projector、legacy event compatibility、reusable extraction / helper 识别为独立职责
- 至少完成职责边界重组，即使第一轮不完全拆到多个文件，也要把内部结构改成可继续拆分的形态
- 避免 adapter 继续自然长成新的平台层

### 3. 状态边界收紧

聚焦对象：

- `StateManager`
- `StoryStateRepository`
- `ArtifactManager`

建议动作：

- 明确哪些字段属于业务投影
- 明确哪些字段属于 runtime 兼容遗产
- 减少把 workflow 执行真相继续沉积到插件私有状态层的机会
- 为后续查询、审计和 artifact 消费建立更稳定的边界口径

### 4. Helper 分层校准

聚焦对象：

- `steps/index`
- `ContentValidator`
- `ChapterOperations`
- `SchemaValidator`

建议动作：

- 把故事领域专属逻辑与通用骨架逻辑拆开
- 修正“`SchemaValidator` 整体迁移到 SDK”的过度表述
- 识别哪些 helper 真的需要继续上收，哪些应明确保留在插件侧

### 5. 薄型参考插件结论收口

建议动作：

- 把“薄型参考插件”判断从口头目标转成正式 requirement
- 输出一份明确的完成条件与剩余阻塞口径
- 让后续任何人都能基于 spec 和文档判断 `StoryOrchestrator` 是否已达成目标态

## 建议能力拆分

建议本 change 只引入一个 capability：

- `workflow-kernel-reference-plugin-convergence`

建议 requirement 主题控制在以下几类：

1. compatibility shell boundary contract
2. adapter responsibility boundary contract
3. business-state vs runtime-state separation contract
4. reusable helper extraction boundary contract
5. thin reference plugin assessment contract

这样可以保证 spec 关注长期结构边界，而不是重新叙述第三波已经沉淀过的 runtime contract。

## 建议 Proposal 结构

`proposal.md` 建议回答以下问题：

### Why

- 第三波已完成运行时替代与认证，但 `StoryOrchestrator` 仍未完成结构压薄
- 当前最大的风险不是“不能跑”，而是“继续在兼容壳、adapter 和状态层累积长期复杂度”
- 如果不把这部分单独收敛，`StoryOrchestrator` 会长期停留在“参考插件候选态”而非真正样板

### What Changes

- 冻结 compatibility shell 边界
- 拆分 adapter 职责并压薄核心桥接层
- 收紧业务状态与 runtime 适配状态边界
- 校准 helper 抽取口径
- 输出薄型参考插件的正式判断标准

### Impact

- 降低 `StoryOrchestrator` 的长期维护复杂度
- 让未来插件样板更清晰
- 为后续是否继续退役 legacy 壳提供可靠依据

## 建议 Design 结构

`design.md` 建议围绕以下决策展开：

### 决策 1：Compatibility Shell 采用“冻结边界”而不是“立即删除”

原因：

- 现有兼容入口仍有价值
- 当前目标是结构压薄，不是用一次 refactor 追求物理删除
- 冻结边界比仓促删除更稳

### 决策 2：Adapter 先按职责切片，再决定文件拆分

原因：

- 当前最大的风险是职责混合，不是文件长度本身
- 先在设计上清楚区分 bridge / projector / compatibility / helper，后续实现才能稳定推进

### 决策 3：状态层按“业务投影优先”收口

原因：

- `StoryOrchestrator` 长期需要的是业务查询与 artifact 消费能力
- workflow runtime 真相已经在 kernel 侧更稳定
- 插件状态层不应继续膨胀成第二执行真相来源

### 决策 4：Helper 提炼采用“拆分并校准”，而不是“整块迁移”

原因：

- 领域逻辑与通用骨架已经交错
- 如果继续沿用“整块迁移”口径，会把故事规则误推成平台 API

## 建议 Tasks 结构

`tasks.md` 建议按下面五组组织：

### 1. Baseline

- 盘点 compatibility shell、adapter、状态层、helper 层的当前职责边界
- 将审查文档中的结论映射到 change 范围

### 2. Compatibility Shell 收口

- 明确 `WorkflowEngine` 和 phase class 的兼容壳边界
- 为 legacy compatibility 文件补足长期口径与必要注释
- 删除或冻结容易误承接新逻辑的入口

### 3. Adapter 与状态边界收口

- 重组 `StoryOrchestratorKernelAdapter` 的职责边界
- 明确状态层与 artifact 层的数据责任
- 收紧业务状态与 runtime 适配状态的写入和读取边界

### 4. Helper 分层与文档同步

- 校准 `SchemaValidator`、`ContentValidator`、`ChapterOperations`、`steps/index` 的分类口径
- 同步目标态文档、清单文档或开发指南中的表述

### 5. Verification

- 运行兼容壳与 kernel-led 路径的针对性回归
- 验证 adapter 拆分后主流程行为无回退
- 复核“薄型参考插件”判断标准与 runtime reality 一致

## 建议验收标准

这个 change 完成时，建议至少满足以下条件：

1. `WorkflowEngine` 被明确约束为 compatibility shell，不再继续承接新增主控制逻辑
2. `StoryOrchestratorKernelAdapter` 的主要职责边界已经拆清，不再是继续自然膨胀的单体 adapter
3. `StateManager` / `StoryStateRepository` / `ArtifactManager` 的责任分层更明确，业务投影与 runtime 适配状态不再随意混用
4. `steps`、validator、chapter 操作中的通用骨架与领域规则已形成更准确边界
5. 文档和 spec 已能明确说明 `StoryOrchestrator` 是否达到薄型参考插件标准，以及若未完全达到还缺什么

## 建议测试重点

这个 change 的验证应偏“结构不回退”，而不是重新构建完整第三波认证矩阵。

建议重点保留以下测试方向：

- `WorkflowEngine` kernel 模式下仍只承担委托职责
- compatibility shell 调整后，主流程与 checkpoint / recovery 入口不回退
- `StoryOrchestratorKernelAdapter` 拆分后，kernel-led 主流程与快照恢复行为不回退
- 业务状态查询、artifact 投影与 runtime 状态读取保持可诊断一致
- helper 分层后，现有 reference consumer 与相关测试不回退

## 依赖关系

建议在 proposal 中明确：

- `depends on`:
  - `workflow-kernel-plugin-authoring-sdk`
  - `workflow-kernel-replacement-certification`

因为这个 change 的前提不是“还要继续修 runtime”，而是“在已经完成认证和 SDK 平台化后继续压薄结构”。

## 与现有拆分文档的关系

这不是原七个 changes 的补丁，也不是第四波 runtime 计划。

更准确的理解方式是：

- 原七个 changes 解决的是“替代成立”
- 这个新 change 解决的是“替代成立之后，参考插件是否已经结构收敛”

因此，建议把它视为：

- **第三波后的 follow-up convergence change**

而不是回头修改第三波 change 定义。

## 一句话建议

如果需要一句话描述这个新 change，建议使用：

**`workflow-kernel-storyorchestrator-structural-convergence` 用于在第三波归档后继续压薄 `StoryOrchestrator` 的 compatibility shell、adapter 与状态边界，把它从“运行时替代已成立的 reference consumer”推进到“长期可维护的薄型参考插件候选完成态”。**
