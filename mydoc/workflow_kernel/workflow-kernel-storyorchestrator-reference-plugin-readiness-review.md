# StoryOrchestrator 薄型参考插件 Readiness 最终评审

## 文档目标

本文用于把 `StoryOrchestrator` 在 `WorkflowKernel` 替代成立之后的结构收敛证据，正式汇总为一次可归档、可复用、可继续引用的 readiness review。

它回答的不是“运行时替代是否成立”，而是更具体的问题：

- `StoryOrchestrator` 是否已经达到薄型参考插件终态
- 当前还剩哪些明确 blocker
- 哪些问题已经从 blocker 降级为可接受 note
- 如果现在仍未达标，下一批 follow-up 应继续收什么债

## 评审边界

本评审遵循下面三条边界：

1. **不重新打开 `workflow-kernel-replacement-certification`**
   replacement certification 已经回答运行时替代是否成立；本评审只判断结构收敛是否足以宣称“薄型参考插件”。

2. **不把 readiness review 变成新的结构重构**
   本文只汇总证据、做判断、命名 blocker，不在这里顺手扩 scope 做新的平台设计。

3. **只按四个既有维度出结论**
   - compatibility surface governance
   - adapter thinness
   - state projection boundaries
   - helper / SDK promotion maturity

## 最终结论

### Outcome

**`not-ready`**

### 一句话结论

`StoryOrchestrator` 已经具备 reference plugin readiness review 所需的大部分前提条件，但截至当前实现批次，它仍未达到可以正式宣称为“薄型参考插件”的终态；阻塞点已经收缩为少量明确的 adapter、状态边界与 helper promotion 收口问题，而不再是 runtime correctness 问题。

## 证据矩阵

| 维度 | 当前判断 | 分类 | 结论摘要 |
|---|---|---|---|
| compatibility surface governance | 已建立正式治理口径 | note | 兼容壳边界与 retain/degrade 规则已具备稳定文档和测试，不再是 readiness 的主 blocker |
| adapter thinness | 仍未完全达标 | blocker | adapter 虽已切出职责，但仍未收缩到真正的 thin bridge 形态 |
| state projection boundaries | 仍未完全达标 | blocker | business projection 与 compatibility residue 的边界已显式化，但仍在同一插件状态层并存 |
| helper / SDK promotion maturity | 仍未完全达标 | blocker | shared helper 已开始承接通用骨架，但 StoryOrchestrator 仍保留较多候选 family 的混层实现 |

## 维度 1：Compatibility Surface Governance

### 证据

- `Plugin/StoryOrchestrator/docs/COMPATIBILITY_SURFACE_STATUS.md`
- `Plugin/StoryOrchestrator/core/CompatibilitySurfaceRegistry.js`
- `Plugin/StoryOrchestrator/core/WorkflowEngine.js`
- `Plugin/StoryOrchestrator/tests/WorkflowEngine.test.js`
- `Plugin/StoryOrchestrator/tests/KernelAdapterBackupRestore.test.js`

### 当前事实

- `WorkflowEngine`、`Phase1_WorldBuilding`、`Phase2_OutlineDrafting`、`Phase3_Refinement` 已被显式分类为 `retain-as-shell`
- `config/workflow-phase1.js` 已被显式分类为 `degrade-entry`
- 旧 `story-orchestrator-phase1` recovery ref 已被降级归一到 canonical `workflow-definition.js`
- 聚焦测试已经覆盖 compatibility surface report 与 degraded definition ref 的行为

### 评审结论

这一维度当前**不是 blocker**。

原因不是“兼容壳已经全部删除”，而是：

- 它们的存在理由已经被写实
- 继续保留与继续收窄的规则已经正式化
- 这些模块已不再被默认当成未来新增主控制逻辑的承接点

因此，compatibility governance 当前更适合作为 **non-blocking note**：

- 壳层仍存在
- 但它们的治理方式已经从“历史遗留不确定项”变成“受控兼容面”

## 维度 2：Adapter Thinness

### 证据

- `Plugin/StoryOrchestrator/adapters/StoryOrchestratorKernelAdapter.js`
- `Plugin/StoryOrchestrator/docs/SDK_BOUNDARIES.md`
- `mydoc/workflow_kernel/workflow-kernel-storyorchestrator-target-state.md`

### 当前事实

`StoryOrchestratorKernelAdapter` 顶部职责说明仍明确列出四类职责：

- kernel bridge and execution delegation
- business snapshot / restore projection
- legacy event compatibility
- StoryOrchestrator-specific helper and extraction glue

这说明 adapter 已经完成第一轮“可见职责切片”，但它还不是一个只做薄桥接的模块。尤其是：

- snapshot 投影与恢复桥接仍在 adapter 内
- legacy event compatibility 仍在 adapter 内
- extraction/helper glue 仍在 adapter 内

### 评审结论

这一维度当前是**明确 blocker**。

阻塞理由不是“adapter 还很乱”，而是：

- 它虽然已经不再是完全黑箱
- 但仍未收缩到只保留宿主接入边界、kernel lifecycle hookup 与少量合法业务投影的 thin adapter 形态

只要 adapter 还同时持有 bridge、projection、compatibility、helper glue 四类职责，`StoryOrchestrator` 就仍然更接近“收敛中的 reference consumer”，而不是已经闭合的薄型参考插件。

## 维度 3：State Projection Boundaries

### 证据

- `Plugin/StoryOrchestrator/core/StateManager.js`
- `Plugin/StoryOrchestrator/core/StoryStateRepository.js`
- `Plugin/StoryOrchestrator/core/ArtifactManager.js`
- `Plugin/StoryOrchestrator/tests/StateProjectionBoundaries.test.js`
- `mydoc/workflow_kernel/workflow-kernel-storyorchestrator-target-state.md`

### 当前事实

- `StateManager` 已显式区分 phase projection 默认值、snapshot rehydrate、workflow compatibility patch
- `StoryStateRepository` 已把 artifact rows 标注为 plugin-facing lookup，而不是 workflow runtime truth
- `ArtifactManager` 已把 artifact indexing 标注为 plugin-facing projection record，而不是 runtime state persistence
- `StateProjectionBoundaries.test.js` 已覆盖 malformed snapshot fallback、workflow compatibility patch、artifact index failure、artifact list lookup 等边界

但当前仍有一个关键现实没有被完全消除：

- 业务投影
- compatibility-oriented workflow bookkeeping

仍然在同一插件状态层中并存。

### 评审结论

这一维度当前仍是**明确 blocker**。

原因不是状态边界完全没做，而是：

- 它已经从“口头区分”推进到“helper + 注释 + 测试的显式区分”
- 但还没有达到“维护者几乎不会再把插件状态误读成 kernel runtime truth”的最终状态

因此，当前状态层更适合被描述为：

- 已开始显式收口
- 但尚未完全完成 reference-plugin readiness 所要求的长期边界闭合

## 维度 4：Helper / SDK Promotion Maturity

### 证据

- `modules/workflowKernel/pluginSdk/extraction.js`
- `modules/workflowKernel/pluginSdk/structuredValidation.js`
- `tests/workflowKernel/pluginSdk/PluginSdk.test.js`
- `Plugin/StoryOrchestrator/steps/index.js`
- `Plugin/StoryOrchestrator/docs/SDK_BOUNDARIES.md`
- `mydoc/workflow_kernel/workflow-kernel-storyorchestrator-target-state.md`

### 当前事实

- `modules/workflowKernel/pluginSdk` 已正式承接 extraction helper 与 structured validation helper
- `tests/workflowKernel/pluginSdk/PluginSdk.test.js` 已证明 shared helper、contract builder、macro builder 的最小通用性
- `Plugin/StoryOrchestrator/steps/index.js` 已开始直接消费 shared plugin SDK surface

但 `steps/index.js` 的文件头也明确承认当前仍处于“可复用骨架 + story-domain rules 共存”的阶段：

- 一部分逻辑已是 shared orchestration skeleton
- 另一部分仍然是故事领域规则，如 outline normalization、chapter production 等

### 评审结论

这一维度当前仍是**明确 blocker**。

阻塞理由不是 helper promotion 没有开始，而是：

- 当前只完成了第一批 family 的上收
- StoryOrchestrator 仍保留较多“未来也可能被其他插件复用”的候选骨架
- shared helper surface 已经可用，但尚未稳定到足以把 `StoryOrchestrator` 宣称为“参考插件终态样板”

换句话说，当前更准确的判断是：

- helper promotion 已跨过“只会写文档不会落代码”的阶段
- 但还没有跨过“多数可复用骨架都已沉淀为稳定 shared surface”的 readiness 门槛

## Blockers

当前最终阻塞项只剩三类：

1. **Adapter 仍未压薄到真正的 thin bridge**
   `StoryOrchestratorKernelAdapter` 仍同时承担 bridge、projection、compatibility、helper glue 四类职责。

2. **插件状态层仍保留 business projection 与 compatibility residue 的同层并存**
   边界已显式，但尚未完全达到长期不会被误解为 runtime truth 的状态。

3. **Helper promotion 仍停留在第一批 family 收敛阶段**
   shared helper 已成立，但 StoryOrchestrator 还没有收敛成“主要保留 definition、领域 step、业务投影和装配”的最终薄插件形态。

## Non-Blocking Notes

下面这些事项已不再构成 readiness 的主 blocker：

- `WorkflowKernel` 对手写工作流的 **replacement certification 已成立**
- compatibility shell 的 retain/degrade 治理口径已经正式化
- shared plugin SDK 已有最小第二 consumer / shared helper 证明，不再只是 StoryOrchestrator 私有抽象

这些 note 很重要，但它们回答的是“基础前提是否具备”，不是“终态是否已经闭合”。

## 后续动作建议

由于当前 outcome 是 `not-ready`，最合理的下一批 follow-up 不应重新打开 replacement certification，而应继续围绕剩余三类结构债收口：

### 方向 1：继续 adapter thinning

建议沿既有 `workflow-kernel-storyorchestrator-adapter-thinning` 口径继续推进第二轮收口，目标从“职责可见”进一步推进到“职责真正收薄”。

### 方向 2：继续 state projection boundary tightening

建议沿既有 `workflow-kernel-storyorchestrator-state-projection-boundaries` 口径继续推进，把 plugin-facing projection 与 compatibility bookkeeping 再继续拆薄，减少对 kernel truth 的误读空间。

### 方向 3：继续 helper promotion stabilization

建议沿既有 `workflow-kernel-plugin-sdk-helper-promotion` 口径继续推进，把已识别的 shared skeleton 从“第一批 adoption”推进到“更稳定、更多 family 的长期 shared surface”。

## 推荐统一表述

如果未来维护者现在要一句话描述 `StoryOrchestrator` 的真实状态，建议使用下面这句：

**`StoryOrchestrator` 已完成运行时替代认证，并且 compatibility surface 治理已经正式化；它当前已处于薄型参考插件候选态，但仍因 adapter 仍偏厚、状态边界尚未完全闭合、helper promotion 尚未完成稳定化而不宜宣称为最终完成的 thin reference plugin。**
