# WorkflowKernel 第三波整体状态总结

## 文档目标

本文面向项目内继续推进工作流平台化收口的工程师，用于总结第三波工作的最终交付、当前已经成立的结论，以及第三波结束后 `StoryOrchestrator` 的真实状态。

读完本文后，维护者应能够直接回答三件事：

- 第三波到底交付了哪些稳定能力
- 现在是否已经可以宣称 `WorkflowKernel` 完成了对 `StoryOrchestrator` 手写工作流的运行时替代
- `StoryOrchestrator` 当前距离“薄型参考插件”还剩什么工作

## 第三波范围

第三波对应两个 OpenSpec changes：

1. `workflow-kernel-plugin-authoring-sdk`
2. `workflow-kernel-replacement-certification`

这一波不是继续补底层运行时语义，而是回答两个最终问题：

- 未来工作流插件是否真的比以前更容易编写
- 在前两波完成后，`WorkflowKernel` 是否已经具备对外宣称替代 `StoryOrchestrator` 手写工作流的证据基础

因此，第三波的重点不在于再发明新 runtime，而在于：

- 把 `StoryOrchestrator` 中已经稳定的可复用模式上收为 shared plugin SDK
- 把 phase outputs、checkpoint payload、business snapshot、artifact projection 固化为稳定业务 contract
- 用真实测试、第二个 consumer 和长期文档，建立最终替代声明的验收口径

## 已完成交付

### 1. Plugin Authoring SDK 已沉淀为主能力

第三波首先完成了 plugin authoring SDK 的提炼与归档，当前已经形成两份主 spec：

- `workflow-kernel-plugin-sdk`
- `workflow-kernel-business-contracts`

这意味着仓库已经正式拥有以下稳定能力：

- 面向插件作者的 shared helper 与标准 authoring pattern
- 标准 schema validation 与 human review / checkpoint helper
- phase outputs、checkpoint payload、business snapshot、artifact projection 的统一 contract
- 可被第二个 consumer 复用的 workflow composition pattern

这一步把“StoryOrchestrator 私有 adapter 中的可复用部分”从历史实现经验，提升成了平台长期 contract。

### 2. Replacement Certification 已完成并归档

第三波随后完成了 `workflow-kernel-replacement-certification` 的实现、主 spec 沉淀与归档。

当前已经存在主 spec：

- `workflow-kernel-replacement-certification`

同时，第三波最终归档集合已经完整闭合：

- `workflow-kernel-plugin-authoring-sdk`
- `workflow-kernel-replacement-certification`

这意味着第三波不再停留在“能力大致够用”的口头判断，而是已经拥有面向未来维护者可重复引用的 archive、主 spec 和文档结论。

## 当前已经成立的结论

### 1. 运行时替代证据已经成立

基于第三波的认证测试与归档证据，下面这些结论已经成立：

- `WorkflowEngine` 在 kernel 模式下已被约束为 compatibility shell，而不是第二控制面
- `start()`、`resume()`、`retryPhase()`、`recover()` 的主控制权已由 `WorkflowKernel` 持有
- 真实 `StoryOrchestratorKernelAdapter` 已被验证可驱动共享 workflow definition 跑通 `phase1 -> phase2 -> phase3 -> completed`
- `phase2` 和 `phase3` 的下游输出消费已在 kernel-led 路径下被连续验证
- checkpoint `modify / timeout / restart_phase / rollback` 与跨阶段恢复都已有 fresh passing evidence

因此，若问题是“`WorkflowKernel` 是否已经具备对 `StoryOrchestrator` 手写工作流的核心运行时替代证据”，当前答案是：

**是，运行时替代证据已经成立。**

### 2. SDK 通用性已经得到最小证明

第三波不仅验证了 `StoryOrchestrator` 这个首个 consumer，还补了一条最小第二 consumer 证明路径。

当前已经成立的结论是：

- shared `pluginSdk` 并非只对 `StoryOrchestrator` 这一个插件成立
- 第二个 consumer 可以直接复用 shared helper、checkpoint contract 与 macro pattern
- 新 consumer 不需要复制一套 `StoryOrchestrator` 级厚 adapter，说明 SDK 抽象已经跨过“只服务单一插件”的门槛

因此，若问题是“第三波是否证明了未来插件可以主要写 definition、helper 和少量领域 step”，当前答案也是：

**是，已经有最小但真实的通用性证明。**

### 3. 替代声明已从讨论进入正式 contract

第三波结束后，替代声明不再只是评审报告里的目标，而是已经被主 spec 正式约束为一组 requirement：

- 替代声明必须 evidence-backed
- legacy-off 或 compatibility shell 边界必须可验证
- replacement regression matrix 必须覆盖 checkpoint、recovery、rollback、跨阶段恢复与全流程完成
- SDK 通用性必须在 `StoryOrchestrator` 之外得到证明
- “薄型参考插件”状态必须显式判断，不能靠默认乐观推断

这使得后续任何人再讨论“是否已经替代完成”时，都可以直接回到稳定 spec，而不是重新口头定义标准。

## StoryOrchestrator 当前状态

第三波结束后，`StoryOrchestrator` 的当前状态可以总结为：

- 它已经不再是必须掌握独立主控制面的历史工作流系统
- 它已经拥有 shared plugin SDK、shared business contract 和 replacement certification 作为平台支撑
- 它已经是一个经过运行时替代认证的 reference consumer
- 但它还不能被无保留地宣称为“最终完成收敛的薄型参考插件”

更准确的表述应是：

**`StoryOrchestrator` 已经完成了运行时替代层面的关键收口，并进入“参考插件候选态”；但结构收敛是否完全达标，仍需继续结合保留/迁移/退出清单和模块映射清单做审查。**

这一定义同时避免了两种错误：

- 低估第三波成果，继续把系统当作“还没有替代成功”
- 高估第三波成果，在结构债仍未收口时直接宣称“薄插件目标已经完全达成”

## 第三波后的剩余问题

第三波结束后，主要剩余问题已经不再是运行时正确性，而是结构收敛与长期维护口径：

### 1. 薄型参考插件结论仍需继续审查

当前虽然已经证明控制面 ownership 在 kernel，且 shared authoring pattern 已经开始上收，但仍需继续回答：

- adapter 中是否还保留跨插件可复用的平台逻辑
- compatibility shell 是否仍然承担了不该长期保留的行为复杂度
- `StoryOrchestrator` 的保留代码是否已经真正以 definition、领域 step、业务投影和装配为主

这部分不再是第三波的 runtime blocker，但仍是目标态是否真正闭合的关键判断。

### 2. 旧集成测试入口仍有 legacy fixture 历史包袱

现有某些旧集成测试夹具仍然显式保留 legacy fixture，因此不适合作为 replacement certification 的长期证据入口。

这不影响第三波已成立的认证结论，但说明后续若继续清理测试资产，应把：

- 旧 legacy fixture
- 新 kernel-led certification fixture

进一步明确分层，避免未来读者混淆“兼容验证”和“替代证据”。

## 建议的统一口径

如果未来需要对第三波完成状态做一句话总结，建议统一使用下面的表述：

**第三波已经完成 plugin SDK 平台化与 replacement certification 收口，`WorkflowKernel` 已具备对 `StoryOrchestrator` 手写工作流的核心运行时替代证据，`StoryOrchestrator` 已进入参考插件候选态；但其是否完全收敛为薄型参考插件，仍需继续以模块清单为依据做结构审查。**

## 下一步建议

第三波结束后，最合理的后续动作不是回头重做 runtime，而是继续做“结构收敛与长期口径”收尾：

1. 以保留/迁移/退出清单和模块映射清单为依据，审查 `StoryOrchestrator` 当前剩余模块
2. 明确哪些 adapter / compatibility 代码仍属过渡层，哪些已经可以视为长期保留资产
3. 在需要时发起新的收敛型 change，而不是重新打开已经归档的第三波 change
4. 对外引用时统一基于主 spec、archive 和本总结文档，避免回退到旧评审报告的历史口径

按当前 follow-up 进度，更具体的顺序已经变成：

1. `adapter-thinning` 已完成并归档，adapter seam 已从黑箱混合层推进到可继续收薄的显式边界
2. `state-projection-boundaries` 已完成首批实现与聚焦回归，正在把 `StateManager`、`StoryStateRepository`、`ArtifactManager` 的 business projection / artifact projection / compatibility residue 口径同步进长期文档与主 spec
3. 在这两类核心结构债收紧之后，再决定是否进入 helper promotion、compatibility retirement criteria 与最终 readiness review

若继续执行这一步，建议配合阅读《`workflow-kernel-storyorchestrator-structural-convergence-audit.md`》，它记录了第三波后剩余模块的现实状态审查与最小收敛动作。

若需要查看该 follow-up change 在归档后实际稳定了什么、修正了哪些长期口径，以及当前还剩哪些明确结构债，建议继续阅读《`workflow-kernel-storyorchestrator-structural-convergence-post-archive-summary.md`》。

若需要直接决定下一批 follow-up change 应该怎么排优先级、每个候选 change 解决什么问题，以及推荐先起哪一个，建议继续阅读《`workflow-kernel-follow-up-change-candidates.md`》。

## 最终结论

第三波已经完成了它最重要的使命：

- 把未来插件作者可复用的编排模式沉淀成稳定 SDK 与 business contract
- 把“是否已经替代成功”从主观讨论变成可重复验证的正式 contract
- 把 `StoryOrchestrator` 从历史迁移对象推进到“已完成关键运行时替代、等待最终结构收敛判断”的新阶段

因此，第三波的正确结论不是“所有问题都已经结束”，而是：

**平台化与替代验收这两件最关键的事，已经完成；剩下的重点是结构收敛，而不再是运行时替代是否成立。**
