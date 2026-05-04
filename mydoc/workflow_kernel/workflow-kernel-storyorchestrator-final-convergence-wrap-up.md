# StoryOrchestrator 最终收口总结

## 文档目标

本文面向接手 `WorkflowKernel` 与 `StoryOrchestrator` 后续维护的内部工程师。

读完本文后，维护者应能直接完成两件事：

- 用统一口径描述这轮三步 follow-up 完成后 `StoryOrchestrator` 的真实状态
- 判断接下来应该做的是继续开新一轮结构收口，还是进入按 note 管理的维护阶段

## 最终判断

当前推荐的正式口径是：

- replacement certification：**已成立**
- thin reference plugin readiness：**`ready-with-notes`**
- 当前阶段：**完成本轮结构收口，进入 note-driven maintenance**

这意味着现在最准确的判断不再是“它还是 `not-ready`”，也不是“所有历史结构债都被物理消失了”，而是：

**`StoryOrchestrator` 已经完成本轮从 reference-plugin candidate 到可复用薄型参考插件的关键收口，但仓库仍保留少量受控的 compatibility、projection 与 transition glue 边界，这些边界应继续被管理，而不应再被描述为 readiness blocker。**

## 这轮收口做完了什么

### 1. Compatibility Governance 不再是开放问题

本轮收口前，compatibility shell 已经从“历史遗留”变成“受控兼容面”；本轮收口后，这个结论继续稳定成立。

当前可以清楚说出：

- 哪些 compatibility shell 继续 retain
- 哪些 entry 已进入 degrade 状态
- compatibility retirement 现在是治理问题，而不是 readiness 问题

### 2. Adapter 从厚协调层收窄成受控 bridge seams

adapter phase 2 完成后，当前已能明确区分：

- 长期 bridge seams
- transitional residue seams
- 初始化安装计划
- 哪些行为不得继续长回 adapter 中心层

这让 `StoryOrchestratorKernelAdapter` 从“还有很多职责的可见模块”进一步收口为“可被维护者按 seam 理解和约束的桥接层”。

### 3. State Boundary 从“能解释”推进到“更难误读”

state boundary phase 2 完成后，当前已经不再主要依赖注释告诉维护者哪些状态是真、哪些状态是假。

新的实现口径已经显式区分：

- business projection
- workflow compatibility view
- boundary summary
- artifact-facing projection lookup

同时，`WorkflowEngine` 也改走更窄的 compatibility view 读取路径。

### 4. Helper Promotion 从“首批 adoption”推进到“稳定 shared surface”

helper promotion stabilization 完成后，`pluginSdk` 已经不是“抽出了一些有用 helper”的松散集合，而是有了更明确的长期 shared surface 表达：

- shared helper family inventory
- plugin-local boundary report
- 聚焦 contract tests
- story-domain semantics 继续留在插件侧的明确规则

这一步真正解决的问题不是“SDK 变大了”，而是“shared surface 终于变稳了”。

## 三步执行结果总览

| 维度 | 完成的 change | 当前状态 | 对最终口径的影响 |
|---|---|---|---|
| adapter thinness | `workflow-kernel-storyorchestrator-adapter-thinning-phase-2` | 已完成并归档 | adapter 从 blocker 降为 note |
| state projection boundaries | `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2` | 已完成并归档 | 状态误读风险从 blocker 降为 note |
| helper / SDK promotion | `workflow-kernel-plugin-sdk-helper-promotion-stabilization` | 已完成并归档 | shared surface 稳定性从 blocker 降为 note |

## 现在为什么可以给出 `ready-with-notes`

当前之所以不再维持 `not-ready`，关键不在于“代码看起来更整齐”，而在于之前那三类 blocker 都已经发生了性质变化：

- 它们不再是“会阻止 `StoryOrchestrator` 被继续当作薄型参考插件使用”的结构风险
- 它们已经变成“有边界、有文档、有测试保护的长期注意项”

换句话说，当前仓库里确实还保留：

- compatibility shell
- adapter transitional seams
- plugin-side compatibility residue
- plugin-local domain helpers

但这些保留现在都符合新的边界口径，本身不再代表结构收口失败。

## 还剩什么 Note

### Note 1：Compatibility Shell 仍需持续治理

compatibility shell 不是“已经可以完全忽略”的历史残留。它们仍需继续维持 retain / degrade 口径，避免未来贡献者把新主控制语义重新塞回去。

### Note 2：Adapter 仍有窄化但未消失的 Transitional Seams

当前 adapter 已经被成功压薄，但 compatibility bridge 和 projection bridge 仍然存在。后续应继续保持它们显式且狭窄，而不是期待它们自然消失。

### Note 3：插件状态层仍然不是 Kernel Runtime Truth

当前状态层边界已经显式，但未来维护者仍需记住：插件侧状态是 projection 与 compatibility residue 的组合，不是 kernel runtime truth 的替身。

### Note 4：Helper Promotion 的目标是稳定，不是无限扩张

shared surface 现在已经够稳，可以作为参考样板继续使用；但这不代表每个可疑似通用 helper 都应该马上进入 SDK。未来仍应以第二 consumer 证据驱动扩张。

## 当前最合适的后续策略

当前不建议立刻再开一轮大而泛的“继续结构收口” change。更合适的做法是：

1. 先接受本轮结果，把统一口径切换到 `ready-with-notes`
2. 把剩余问题转入 note-driven maintenance，而不是 blocker-driven execution
3. 等下一个真实 workflow plugin 接入时，再利用第二 consumer 证据决定 shared surface 是否继续扩张
4. 只有当某个 note 再次演化成真实结构风险时，才起新的小范围 follow-up change

## 推荐统一表述

如果后续有人问“现在 `StoryOrchestrator` 到底算不算理想化参考插件”，建议统一回答：

**`StoryOrchestrator` 已完成本轮结构收口，并达到可继续作为薄型参考插件引用的 `ready-with-notes` 状态；剩余事项主要是受控 note，而不再是阻止其被视为参考样板的 blocker。**
