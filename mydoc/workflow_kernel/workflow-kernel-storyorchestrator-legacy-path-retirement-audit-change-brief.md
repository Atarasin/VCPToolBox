# Change Brief: workflow-kernel-storyorchestrator-legacy-path-retirement-audit

## 文档目标

本文用于定义一轮 legacy path 退役审计 change 的建议边界，供维护者直接据此创建新的 OpenSpec artifacts。

## 建议 Change ID

`workflow-kernel-storyorchestrator-legacy-path-retirement-audit`

## 为什么现在做

当前 `StoryOrchestrator` 已完成本轮结构收口，并达到 `ready-with-notes`。这意味着它已经可以继续作为薄型参考插件被复用，但仓库中仍保留一组受控的 legacy compatibility shell：

- `WorkflowEngine`
- `Phase1_WorldBuilding`
- `Phase2_OutlineDrafting`
- `Phase3_Refinement`
- `workflow-phase1`

这些 surface 当前不能被简单视为死代码，因为它们仍承担 fallback、安全兜底、checkpoint 恢复或旧引用兼容职责。

但如果长期维持两套控制和恢复语义并存，复杂度、测试面和维护认知负担会持续偏高。因此，下一步最合适的动作不是直接删除，而是先做一次受控的退役审计。

## 这个 Change 要解决什么

- 盘点 legacy path 当前仍然承接的真实入口、恢复分支和兼容职责
- 区分哪些 surface 现在必须保留，哪些只应降级收纳，哪些已接近可退役
- 为后续物理退役提供可验证的前置条件，而不是靠主观判断删文件
- 把 legacy compatibility shell 从“历史存在”推进到“明确的退役计划”

## In Scope

- 审计 `WorkflowEngine` 仍承担的 start / resume / recover / retry / status 投影职责
- 审计 phase-class shells 是否仍参与 checkpoint continue、reject、complete 与 fallback 路径
- 审计旧 `definitionRef` 与 `workflow-phase1` 的真实依赖面
- 审计当前测试中哪些是在保护 legacy shell，哪些是在保护 canonical kernel path
- 输出一份可直接驱动后续 retirement change 的 inventory、结论与验证要求

## Out Of Scope

- 不直接删除 `WorkflowEngine` 或 phase classes
- 不在本 change 中顺手重写 `StoryOrchestrator` 命令分发结构
- 不重新打开 adapter thinning、state boundary 或 helper promotion 的已归档 change
- 不在没有审计证据的前提下提前宣告 legacy path 可整体退役

## 建议设计问题

创建 OpenSpec artifacts 时，建议优先回答下面五个问题：

1. 现在还有哪些真实命令和恢复入口会走进 legacy shell
2. 哪些 legacy surface 仍承担 kernel path 暂时未完全接管的职责
3. 哪些 compatibility surface 已只剩别名解析或退化入口价值
4. 哪些测试只是保护历史壳，而非当前 canonical path
5. 每个 surface 满足什么条件后，才能安全进入 retirement

## 建议任务组

### 1. 调用点与职责审计

- 列出 `WorkflowEngine`、phase classes、旧 definition entry 的实际入口
- 标记每个入口是 canonical path、fallback path 还是 compatibility-only path

### 2. 测试与恢复路径审计

- 盘点 resume、recover、retry、checkpoint continue 仍依赖 legacy shell 的场景
- 区分保护旧壳的测试与保护主路径的测试

### 3. 退役前置条件写实

- 为每个 surface 写出“必须保留 / 可先降级 / 满足条件后可退役”的判定
- 为后续真正的 retirement implementation 准备验证清单

## 完成标准

- 维护者可以明确说出每个 legacy surface 当前为何存在
- 每个 legacy surface 都有清楚的去留分类与退役前置条件
- 后续若要真正删除 legacy 代码，可以基于审计结果起小范围 implementation change

## 主要风险

- 把审计误做成直接实现，导致 scope 失控
- 只看代码表面调用，遗漏恢复和 fallback 语义
- 低估旧测试、旧持久化引用和旧入口兼容的影响

## 风险控制

- 先审计，不直接删
- 以命令入口、恢复路径和测试依赖为主证据，而不是只看文件是否“看起来旧”
- 输出明确 retirement preconditions，再决定是否进入实现

## 推荐优先级

**P1**

## 推荐依赖关系

- 建议晚于 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
- 建议晚于 `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`
- 建议晚于 `workflow-kernel-plugin-sdk-helper-promotion-stabilization`

## 一句话建议

下一步不要急着删 legacy path，先把“为什么还在、什么时候能退、删前要验证什么”审清楚。
