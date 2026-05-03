# StoryOrchestrator 结构收敛 Change 归档后阶段总结

## 文档目标

本文面向在第三波之后继续维护 `WorkflowKernel` 与 `StoryOrchestrator` 的内部工程师，用于总结 `workflow-kernel-storyorchestrator-structural-convergence` 归档后已经稳定成立的结论、被修正的长期口径，以及仍需继续推进的剩余结构债。

读完本文后，维护者应能够直接回答三件事：

- 这次结构收敛 change 到底解决了什么，而不必再回放实现过程
- `StoryOrchestrator` 现在应被如何准确描述
- 如果后续继续推进薄型参考插件目标，下一步应该盯住哪些剩余问题

## 这次 change 为什么重要

在这次 change 之前，仓库已经完成了两件大事：

- `WorkflowKernel` 对 `StoryOrchestrator` 手写工作流的运行时替代证据已经成立
- plugin authoring SDK、business contracts 与 replacement certification 已经沉淀为主 spec

因此，当时的主要矛盾已经不再是“主流程能不能跑”，而是：

- `WorkflowEngine` 是否还会继续长成第二控制面
- `StoryOrchestratorKernelAdapter` 是否仍然承担过多混合职责
- 业务状态、artifact 投影与 runtime compatibility state 是否仍然混在一起
- validator、chapter helper、step helper 是否还在用“整块迁移”这种不准确口径描述

这次 change 的价值，不是重做第三波认证，而是把这些“已经不再阻断运行时替代、但会长期影响可维护性”的结构问题，收敛成稳定边界。

## 已完成的稳定收口

### 1. Compatibility Shell 边界已经写实

这次 change 之后，`WorkflowEngine`、`Phase1/2/3` 和 `workflow-phase1` 的长期定位已经变得明确：

- 它们仍然存在，但只应被视为 compatibility surface 或 compatibility artifact
- 它们不再是未来新增主控制逻辑的承接点
- kernel 模式下的控制面 ownership 已被清楚表达为委托到 `StoryOrchestratorKernelAdapter`

这一步最重要的结果不是“删掉了多少 legacy 文件”，而是：

**后续维护者已经很难再合理地把这些模块误当成主执行引擎继续扩展。**

### 2. Adapter 的混合职责已经被显式分区

`StoryOrchestratorKernelAdapter` 仍然没有被彻底拆成多个独立文件，但它最关键的结构变化已经完成：

- kernel bridge 与 execution delegation 被明确识别
- business snapshot / restore projection 被单独识别
- legacy event compatibility 被单独识别
- extraction、validation、step helper glue 被识别为另一类职责

这意味着当前 adapter 虽然仍然偏厚，但它已经不再是“只能靠通读整文件才能理解”的黑箱桥接层。

这次 change 把后续继续压薄 adapter 的工作，从“重新摸索边界”推进到了“沿既定边界继续拆分”。

### 3. 状态层的双重语义已经被明确区分

`StateManager`、`StoryStateRepository`、`ArtifactManager` 这组模块在这次 change 后形成了更清晰的长期口径：

- 插件侧继续保留业务状态投影、业务查询和 artifact 消费能力
- runtime compatibility bookkeeping 仍然存在，但已经被显式标注为兼容性遗产，而不是 kernel execution truth
- artifact 层被明确描述为 plugin-facing projection，而不是 workflow runtime 真相来源

这一步并没有“一次性迁空”插件状态层，但它把一个更危险的问题压住了：

**未来读者不应再自然地把插件私有状态对象当成唯一执行真相。**

### 4. Helper 分层口径已经从“整块迁移”校准为“骨架与领域规则分开”

这是这次 change 最重要的长期口径修正之一。

此前容易出现的误判是：

- 看到 `ContentValidator`、`ChapterOperations`、`steps/index`、`SchemaValidator` 这类模块，就直接把它们整体视为 SDK 候选

这次 change 之后，项目内已经形成更准确的判断：

- 可复用的是 orchestration skeleton，例如 delegate -> parse -> aggregate、delegate -> retry -> expand
- 不可直接上收的是故事领域规则，例如世界观校验、人物规则、章节修订约束、outline 语义规整

因此，这次 change 真正稳定下来的不是“又迁了几个 helper”，而是：

**未来在讨论 SDK 抽取时，团队已经有了更不容易误伤领域规则的判断框架。**

### 5. 薄型参考插件的判断标准已经进入主 spec

归档前，这次 change 已经把新的结构收敛 capability 同步进主 spec，并补齐 replacement certification 的主 spec 口径。

这带来两个稳定结果：

- `StoryOrchestrator` 是否达到 thin reference plugin 状态，已经可以基于正式 requirement 判断
- “runtime replacement 已完成，但 structural convergence 尚未完成” 也已经进入长期 contract，而不是只存在于会话上下文中

这使得后续任何人再问“现在是不是已经彻底完成”时，都可以直接回到主 spec 和总结文档，而不是重新发明判断标准。

## 这次 change 修正了哪些长期口径

### 1. 对 `WorkflowEngine` 的口径被修正了

更准确的说法已经不再是“仍然负责部分工作流控制”，而是：

- 它已经完成主控制权让渡
- 当前主要价值是 compatibility shell
- 它仍然带着 legacy 结构债，但不应再被视为第二控制面

### 2. 对 `StoryOrchestratorKernelAdapter` 的口径被修正了

更准确的说法不再是“普通桥接层”，而是：

- 它是当前 kernel 接入的核心桥接层
- 但它仍是一个混合了 bridge、projector、compatibility 和 helper glue 的过渡性厚 adapter
- 后续工作的重点不是简单删除它，而是继续沿已识别边界压薄它

### 3. 对 `SchemaValidator` 与相关 helper 的口径被修正了

更准确的说法已经变成：

- 通用 validation mechanism 可以进入 shared surface
- 具体的故事领域字段规则不应被粗暴提升为平台 API
- helper 抽取必须先分离 reusable skeleton 与 story-domain rules

### 4. 对 `StoryOrchestrator` 当前状态的口径被修正了

现在最准确的统一表述应是：

**`StoryOrchestrator` 已经完成运行时替代层面的关键收口，并完成了一轮显式结构收敛；它应被视为具有明确 thin-plugin 判断标准的参考插件候选态，而不是仍停留在“运行时是否成立”的不确定阶段，也不是已经百分之百完成最终收敛的薄型参考插件。**

## 归档后已经成立的阶段结论

这次 change 归档后，可以稳定成立下面这些结论：

### 1. 运行时替代结论没有被重新打开，且得到更清晰的长期边界保护

这次 change 没有回头重做 replacement certification，也没有改变第三波已经成立的运行时结论。

它做的是另一件更长期的事：

- 防止 compatibility shell、adapter 和状态层继续回长，从而反向稀释已经成立的 runtime replacement 结论

### 2. `StoryOrchestrator` 已经具备更可信的参考插件候选态描述

在这次 change 之后，`StoryOrchestrator` 不再只是“通过测试的首个 consumer”，而是：

- 已有 shared workflow definition 与 contracts
- 已有明确的 compatibility shell 边界
- 已有一轮完成的 adapter / state / helper 分层写实
- 已有面向主 spec 的 thin-plugin 判断标准

这使它比第三波刚结束时更接近“可被未来维护者直接借鉴”的参考实现。

### 3. 剩余问题已经被压缩成少量明确结构债

归档后最重要的变化之一是，后续问题已经不再发散。

当前剩余结构债主要集中在三类：

- `StoryOrchestratorKernelAdapter` 还没有收缩到真正的 thin adapter 形态
- 业务投影与 runtime compatibility bookkeeping 仍然在状态层局部共存
- helper skeleton 虽已被识别，但尚未继续沉淀为稳定 shared surface

相比归档前那种“哪里都还有点混”的状态，现在的剩余问题已经足够集中，适合未来继续单独判断和推进。

## 仍未完成的部分

这次 change 已经归档，但它并不等于 `StoryOrchestrator` 的结构工作全部结束。

当前仍未彻底完成的部分包括：

### 1. Adapter 还没有真正变薄

虽然职责边界已经识别清楚，但 `StoryOrchestratorKernelAdapter` 仍然同时承担：

- kernel bridge
- snapshot / restore projection
- legacy event compatibility
- extraction 与 helper glue

也就是说，最关键的“识别边界”已经完成，但“最终压到多薄才算达标”还没有完全闭合。

### 2. 状态层仍然保留 compatibility bookkeeping

`StateManager` 和 `StoryStateRepository` 现在已经更容易被正确理解，但仍然没有彻底摆脱：

- 业务摘要层
- runtime compatibility 适配层

在同一聚合对象或同一仓储边界中的并存关系。

这意味着后续若继续做结构治理，状态层仍是高价值切入点。

### 3. Reusable skeleton 还没有进一步沉淀成稳定 shared surface

这次 change 的主要成果是“看清楚哪些东西可以复用、哪些东西不能误上收”。

但它还没有试图在本轮里继续扩大 shared SDK surface。

这符合当时的 change 边界，也意味着一个现实结论：

- 当前已经有了更安全的抽取判断框架
- 但真正的后续沉淀动作，仍需要未来按需推进

## 推荐的归档后统一口径

如果后续需要对这次 change 做一句话总结，建议统一使用下面的表述：

**这次 structural convergence change 没有重新定义 runtime replacement，而是把 `StoryOrchestrator` 的 compatibility shell、adapter、状态层和 helper 边界写实为长期可维护的结构口径；归档后，`StoryOrchestrator` 已经从“运行时替代成立的 reference consumer”进一步推进到“具备显式 thin-plugin 判断标准的参考插件候选态”，剩余问题主要集中在 adapter 最终收薄、状态层继续分层，以及 helper skeleton 的后续沉淀。**

## 后续建议

归档后，最合理的后续动作不是回头打开已完成的替代认证，而是按下面顺序继续观察或推进：

1. 持续监控 `StoryOrchestratorKernelAdapter` 是否再次吸收新平台语义
2. 在涉及状态查询、artifact 投影或恢复调试时，继续压制把插件私有状态误用为 kernel execution truth 的倾向
3. 若未来继续抽取 shared helper，必须坚持“先识别 skeleton，再判断领域规则是否可上收”的原则
4. 对外引用阶段结论时，优先基于第三波整体总结、结构收敛审查、这份归档后总结，以及主 spec 的统一口径

如果需要进一步把这些剩余结构债转成下一批可执行的 OpenSpec 方案，建议继续阅读《`workflow-kernel-follow-up-change-candidates.md`》。

## 最终结论

这次 structural convergence change 的真正价值，不是“又完成了一轮整理”，而是：

- 它把第三波之后仍然松散的结构判断收敛成了长期文档和主 spec
- 它让 `StoryOrchestrator` 的当前状态更容易被准确描述，而不是在“已经成功”与“还没完成”之间摇摆
- 它把后续工作的重点稳定地压缩到少量明确结构债，而不是重新回到大范围 runtime 怀疑

因此，这次归档后的最准确结论是：

**运行时替代已经是既定事实；结构收敛也已经完成第一轮真正落地；接下来要做的，不是重新证明系统能不能跑，而是继续把剩余少量结构债收薄到目标态。**
