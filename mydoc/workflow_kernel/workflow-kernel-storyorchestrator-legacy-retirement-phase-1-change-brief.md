# Change Brief: workflow-kernel-storyorchestrator-legacy-retirement-phase-1

## 文档目标

本文用于定义一轮真正进入删除阶段的 legacy retirement implementation change。

读完本文后，维护者应能直接完成一个动作：**创建一个以减少兼容代码为目标、以删除和关闭降级路径为成功标准的 OpenSpec change。**

## 建议 Change ID

`workflow-kernel-storyorchestrator-legacy-retirement-phase-1`

## 为什么现在做

`StoryOrchestrator` 围绕 `WorkflowKernel` 已连续完成至少三轮收口工作：

- compatibility retirement criteria
- adapter thinning phase 2
- state projection boundaries phase 2
- plugin SDK helper promotion stabilization

这些工作已经足够证明主方向成立，也已经把系统推进到 `ready-with-notes`。

但当前仓库仍然保留了较多 legacy compatibility code。问题已经不再是“边界是否够清楚”，而是“为什么在工作流内核稳定后，这些降级路径仍然存在”。

如果继续沿用“先保留兼容壳，再慢慢评估退役”的节奏，迁移会持续停留在双轨状态：

- kernel path 已成立
- legacy path 仍可运行
- 测试继续保护旧壳
- 代码复杂度长期不下降

因此，下一步不应再是新的审计型收口，而应进入**受控删除阶段**。

## 这次 Change 要解决什么

- 明确宣告：当工作流内核已稳定，`StoryOrchestrator` 不再继续接受永久降级路径
- 选择当前最弱、最适合先删除的一组兼容面，完成第一刀 retirement implementation
- 把成功标准从“边界更清楚”改成“兼容代码更少、降级分支更少、旧合同测试更少”
- 为后续 phase-class shell 和 `WorkflowEngine` 的退役建立更强的执行节奏

## Phase 1 的建议目标

本轮只做第一刀，不追求一次删空全部 legacy path。

建议优先处理：

1. `workflow-phase1` degraded compatibility entry
2. 明确禁止新增新的 legacy fallback 或新的 degraded entry
3. 开始把一部分测试从“保护旧壳”改写为“证明 kernel-only path 成立”

## 为什么先选这一刀

相比 `WorkflowEngine` 和 phase-class shells，`workflow-phase1` 已经最接近 retirement：

- 它不再是推荐执行源
- 它更多只是旧 `definitionRef` 的兼容别名
- 它的退役半径最小
- 它最适合作为“从收口模式切到删除模式”的第一步

这一步的价值不只是减少一份代码，更重要的是改变迁移策略：

- 从“解释为什么旧壳还在”
- 变成“证明为什么它今天可以删”

## In Scope

- 审计并确认 `workflow-phase1` 的剩余运行时与持久化依赖面
- 在可控前提下退役、内联或停止支持 `workflow-phase1` 这一 degraded entry
- 删除或收紧与该 degraded entry 绑定的 compatibility alias 路径
- 更新恢复、归一化与测试逻辑，使 canonical full workflow definition 成为唯一受支持形态
- 增加或改写聚焦测试，证明 kernel-only / canonical definition path 成立
- 加入明确约束，禁止在本轮之后继续新增 legacy fallback

## Out Of Scope

- 不在本轮直接删除 `WorkflowEngine`
- 不在本轮直接删除 `Phase1_WorldBuilding`、`Phase2_OutlineDrafting`、`Phase3_Refinement`
- 不顺手重写整套命令分发结构
- 不重新打开已归档的 adapter / state / helper change
- 不做一次性“大扫除式”兼容删除

## 建议设计问题

创建 OpenSpec artifacts 时，建议优先回答下面六个问题：

1. 当前还有哪些真实数据、恢复输入或测试依赖 `workflow-phase1`
2. 这些依赖是必须迁移、可以自动归一，还是可以直接停止支持
3. 删除 `workflow-phase1` 后，canonical full workflow definition 是否能完整覆盖现有行为
4. 哪些测试应删除，哪些测试应改写为 kernel-only/canonical-path 断言
5. 如何把“禁止新增新的 legacy fallback”表达成明确约束
6. 本轮做完后，下一轮 phase-class shell retirement 的进入条件是什么

## 建议任务组

### 1. `workflow-phase1` 依赖面收口

- 盘点旧 `definitionRef`、恢复归一化、备份恢复与测试对 `workflow-phase1` 的剩余依赖
- 判断这些依赖是迁移、内联、自动归一还是直接停止支持

### 2. degraded entry 退役实现

- 删除、内联或停用 `workflow-phase1`
- 收紧相关 compatibility alias
- 保证 canonical full workflow definition 成为唯一受支持入口

### 3. 测试与治理切换

- 删除或改写专门保护 `workflow-phase1` 的旧合同测试
- 新增聚焦测试，证明 kernel-only / canonical definition path 正常工作
- 更新治理文档，明确“稳定后不再保留降级路径”的原则

## 完成标准

- `workflow-phase1` 不再作为受支持的 degraded entry 存在
- 与它绑定的 compatibility alias 或旧引用语义完成迁移、归一或显式停止支持
- 测试不再把 `workflow-phase1` 当作应长期保护的合同面
- 文档明确写出：工作流内核稳定后，不再继续接受新的降级路径
- 代码与测试数量出现真实下降，而不是仅仅增加解释性文档

## 主要风险

- 低估旧数据或恢复输入对 phase-only definition alias 的依赖
- 过快删除导致 backup/restore 或 recovery 路径断裂
- 只删文件不改测试，导致测试体系继续保护已不存在的兼容合同
- scope 意外膨胀，从删 degraded entry 演变成重写整个 legacy path

## 风险控制

- 只做第一刀，优先处理最弱兼容面
- 删除前先确认旧引用的迁移或归一策略
- 删除动作与测试改写必须成对出现
- 把“禁止新增 fallback”写成明确 requirement，而不是口头共识

## 推荐依赖关系

- 建议晚于 `workflow-kernel-storyorchestrator-legacy-path-retirement-audit`
- 建议晚于 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
- 建议晚于 `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`
- 建议晚于 `workflow-kernel-plugin-sdk-helper-promotion-stabilization`

## 后续节奏

如果 Phase 1 成功，后续建议按下面顺序继续：

1. `workflow-phase1` retirement 完成
2. phase-class shells 成组 retirement
3. `WorkflowEngine` 从兼容控制壳收窄直至退役

## 一句话建议

不要再把下一轮工作定义成“让 legacy path 更清楚”，而要定义成“让 legacy path 真实减少”，并从 `workflow-phase1` 这类最弱兼容面开始执行第一刀。
