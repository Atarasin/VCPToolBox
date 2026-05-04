# StoryOrchestrator 薄型参考插件 Readiness 最终评审

## 文档目标

本文用于把 `StoryOrchestrator` 在 `WorkflowKernel` 替代成立之后的结构收敛证据，正式汇总为一次可归档、可复用、可继续引用的 readiness review。

它回答的不是“运行时替代是否成立”，而是更具体的问题：

- `StoryOrchestrator` 是否已经达到可作为薄型参考插件继续复用的状态
- 当前剩余问题是否还是 blocker，还是已经下降为可接受 note
- 未来维护者现在应把哪些结构边界视为长期约束，而不是继续开放问题

## 评审边界

本评审遵循下面三条边界：

1. **不重新打开 `workflow-kernel-replacement-certification`**
   replacement certification 已回答运行时替代是否成立；本评审只判断结构收敛是否已足以支持“薄型参考插件”口径。

2. **不把最终评审变成新的结构重构**
   本文只汇总证据、更新结论、标记 residual notes，不再在评审文档里发起新的大范围收敛工程。

3. **仍按四个既有维度出结论**
   - compatibility surface governance
   - adapter thinness
   - state projection boundaries
   - helper / SDK promotion maturity

## 最终结论

### Outcome

**`ready-with-notes`**

### 一句话结论

`StoryOrchestrator` 现在已经可以按“薄型参考插件”口径继续被引用和复用；之前阻塞 readiness 的 adapter、状态边界与 helper promotion 三类结构债，已经在本轮 follow-up 中收敛到足够窄、足够显式、且有测试保护的长期边界，但仓库里仍保留少量受控的 compatibility shell、transition glue 与 plugin-local domain semantics，应继续作为 note 管理，而不再作为 blocker 管理。

### 结论更新说明

这次结论相对上一版正式评审发生了一个关键变化：

- 上一版 outcome 是 `not-ready`
- 当前 outcome 更新为 `ready-with-notes`

变化原因不是“运行时替代突然更强”，而是此前三类 blocker 已全部经过独立 change 的实现、验证、主 spec 同步与 archive：

- `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
- `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`
- `workflow-kernel-plugin-sdk-helper-promotion-stabilization`

## 证据矩阵

| 维度 | 当前判断 | 分类 | 结论摘要 |
|---|---|---|---|
| compatibility surface governance | 已稳定 | note | 兼容壳 retain / degrade 规则已正式化，且不再被当成 readiness blocker |
| adapter thinness | 已收敛到可接受范围 | note | adapter 现已按 bridge seam inventory 和初始化计划表达，仍有少量 transitional seams，但已不再是厚协调中心 |
| state projection boundaries | 已收敛到可接受范围 | note | business projection、compatibility view 与 boundary summary 已显式分离，查询口径更难再误读为 kernel truth |
| helper / SDK promotion maturity | 已收敛到可接受范围 | note | shared helper surface 已有 inventory、boundary report 与聚焦 contract tests，StoryOrchestrator 私有层更多保留 story-domain semantics |

## 维度 1：Compatibility Surface Governance

### 当前事实

- compatibility shell 的 retain / degrade / eligible-for-retirement 治理口径已经正式化
- `WorkflowEngine` 和保留 phase 模块的存在理由已经被清楚限定为 compatibility surface
- compatibility retirement 现在回答的是“是否可以继续收窄”，而不是“是否还影响 readiness”

### 评审结论

这一维度继续维持 **non-blocking note**。

原因不是 compatibility shell 已经被彻底移除，而是：

- 它们的存在理由已被文档化
- 它们的未来处理方式已被分类治理
- 它们已经不再是默认承接新主控制语义的位置

## 维度 2：Adapter Thinness

### 当前事实

- `StoryOrchestratorKernelAdapter` 现已把 bridge seams 与 transitional residue 明确区分
- adapter 初始化改为按 plan 安装 seam，而不是继续堆叠自由生长的 setup blob
- seam inventory 与初始化顺序已有聚焦测试保护
- adapter 仍保留少量 compatibility bridge 和 business projection bridge，但这些残留已经被显式归类为窄接缝，而不是混杂协调中心

### 评审结论

这一维度现在从 blocker 降级为 **note**。

原因不是 adapter 物理上已经只剩一个极小文件，而是：

- 它已经从“职责虽可见但仍混在一起”推进到“哪些是长期 bridge、哪些只是 transitional residue”都可直接读出
- 新的平台语义不再自然追加回 adapter 中心层
- 维护者现在看到的首先是 bridge seam，而不是一团混合协调流

当前 residual note 主要是：

- compatibility event bridge 与 business projection bridge 仍在 adapter 周边保留
- 这些接缝应继续保持窄化，不应再次成长为 general coordination layer

## 维度 3：State Projection Boundaries

### 当前事实

- `StateManager` 现已显式暴露 business projection、workflow compatibility view 与 boundary summary 三种读取口径
- `StoryStateRepository` 已提供更窄的 compatibility record 查询，而不是让调用方总是从宽表意对象反推状态语义
- `WorkflowEngine` 已优先读取 narrowed compatibility view，而不是默认从混合 story object 上取 runtime-like 字段
- 聚焦测试已覆盖 boundary summary、compatibility view 与 artifact lookup 仍然可用的路径

### 评审结论

这一维度现在从 blocker 降级为 **note**。

原因不是插件侧状态层被完全移除，而是：

- 维护者现在更难把 plugin-facing projection 当成 kernel runtime truth
- compatibility residue 的残留理由、读取入口和边界摘要都已显式化
- artifact lookup 继续保留为 plugin-facing projection，而不是被伪装成 canonical runtime surface

当前 residual note 主要是：

- business projection 与 compatibility residue 仍然共处在插件状态子系统中
- 但这种共处已被边界 API 和测试约束为受控状态，而不再构成 readiness blocker

## 维度 4：Helper / SDK Promotion Maturity

### 当前事实

- `pluginSdk` 已不只是一些零散 helper export，而是已有 shared helper family inventory
- shared surface 的稳定范围已经被结构化写实为 schema validation、structured extraction、structured validation orchestration 与 workflow contract builders
- `StoryOrchestrator` steps 层已增加本地 helper boundary report，明确 shared SDK consumer、transition glue 与 plugin-local domain 的分界
- 聚焦 contract tests 已证明 shared helper contract 不依赖 StoryOrchestrator 私有语义才能成立

### 评审结论

这一维度现在从 blocker 降级为 **note**。

原因不是所有候选 helper 都已迁入 SDK，而是：

- 当前 shared surface 已达到“稳定、可解释、可测试”的门槛
- StoryOrchestrator 私有层中保留的更多是 story-domain prompt、schema interpretation 与 chapter policy
- 未来维护者现在可以更清楚地区分“哪些是可复用 skeleton”“哪些仍应插件私有”

当前 residual note 主要是：

- 仍存在少量 transition glue，例如 outline normalization 一类 StoryOrchestrator 语义包裹层
- 这些逻辑可以继续观察，但在当前证据下已不再阻塞 readiness

## 当前 Residual Notes

当前仍建议持续观察，但已不再构成 blocker 的事项有四类：

1. **compatibility shell 仍然存在**
   它们继续承担 retain-as-shell 或 degrade-entry 的兼容职责，但当前治理已足够正式。

2. **adapter 仍有少量 transitional seams**
   例如 compatibility bridge 与 projection bridge 仍保留在 adapter 周边，但这些 seam 已显式且受控。

3. **插件状态层仍保留 compatibility residue**
   但 residue 已通过更窄 API、边界摘要与调用侧约束显式化。

4. **helper promotion 仍不是“所有 helper 全部上收”**
   当前 shared surface 的目标是稳定，而不是无限扩大；保留 story-domain logic 在插件侧是设计要求，不是失败信号。

## 当前不再成立的 Blockers

上一版 readiness review 中的三类 blocker 现在都可以关闭：

1. **adapter 仍偏厚**
   已通过 seam inventory、initialization plan 与回归测试收敛到可接受边界。

2. **状态边界尚未完全闭合**
   已通过 narrowed compatibility query、boundary API 与调用侧调整降到可接受误读概率。

3. **helper promotion 尚未完成稳定化**
   已通过 shared helper inventory、plugin-local boundary report 与 contract tests 进入长期可管理状态。

## 推荐统一表述

如果未来维护者现在要一句话描述 `StoryOrchestrator` 的真实状态，建议使用下面这句：

**`StoryOrchestrator` 已完成运行时替代认证，并且已达到可作为薄型参考插件继续复用的 `ready-with-notes` 状态；当前仍保留少量受控的 compatibility shell、transitional seam 和 story-domain local logic，但这些已属于长期边界管理问题，而不再构成 readiness blocker。**

## 维护建议

基于当前 outcome，后续更合适的动作不是再立刻新起一轮大而泛的结构收口 change，而是：

- 按 note 管理 compatibility shell、adapter transitional seam 和 plugin-local glue
- 当第二、第三个 workflow plugin 真实接入时，用它们验证当前 shared helper surface 是否还需要扩张
- 只有在新的 consumer 证据表明某个边界再次失真时，才针对具体问题起小范围 follow-up change
