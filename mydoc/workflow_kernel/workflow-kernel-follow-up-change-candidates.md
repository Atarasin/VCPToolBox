# WorkflowKernel / StoryOrchestrator 下一批 Follow-up Change 候选列表

## 文档目标

本文面向在 `workflow-kernel-storyorchestrator-structural-convergence` 归档之后继续推进工作流平台演进的内部工程师。

它不回答“这次归档做了什么”，而回答更直接的问题：

- 归档之后，下一批最值得继续起的 OpenSpec change 有哪些
- 每个候选 change 解决的主要矛盾是什么
- 它们之间的推荐依赖和排序是什么
- 如果现在只做一个 change，应该先做哪一个

读完本文后，维护者应能够直接做一件事：

- 从候选列表中选出一个或一组 change，开始创建下一批 OpenSpec artifacts

## 当前基线

在这份候选列表成立之前，仓库已经具备下面这些稳定前提：

- `WorkflowKernel` 对 `StoryOrchestrator` 手写工作流的运行时替代已经成立
- plugin authoring SDK、business contracts、replacement certification 已沉淀成主 spec
- `StoryOrchestrator` 的 structural convergence 已完成第一轮落地并完成归档
- 当前剩余问题已经集中在少量结构债，而不是重新回到“主流程能否成立”的不确定状态

因此，下一批 follow-up change 的设计原则应是：

1. 不重新打开已完成的 replacement certification
2. 不把 scope 又拉回大而泛的 runtime 重构
3. 只围绕当前已经明确的剩余复杂度逐个收口

## 选择原则

如果接下来只打算起一到两个 change，建议按下面三个标准判断优先级：

### 1. 是否继续降低结构债密度

优先做那些能直接减少“厚 adapter、状态混层、兼容壳回长”风险的 change。

### 2. 是否能让未来插件样板更清晰

优先做那些能把 `StoryOrchestrator` 从“参考插件候选态”进一步推向“更稳定的薄型参考插件候选完成态”的 change。

### 3. 是否会重新引入大范围联动风险

如果一个 change 需要重新打开大量 runtime 路径、重新定义 kernel contract，优先级应下降，除非它真的是新的平台能力缺口。

## 候选列表总览

| 候选 change | 主要目标 | 推荐优先级 | 依赖关系 | 建议规模 |
|---|---|---|---|---|
| `workflow-kernel-storyorchestrator-adapter-thinning` | 继续压薄 `StoryOrchestratorKernelAdapter`，把已识别职责进一步分离 | P0 | 依赖已归档 structural convergence | 中 |
| `workflow-kernel-storyorchestrator-state-projection-boundaries` | 继续分离业务投影与 runtime compatibility bookkeeping | P0 | 依赖 structural convergence；最好在 adapter thinning 之后或同步推进 | 中 |
| `workflow-kernel-plugin-sdk-helper-promotion` | 把已识别的 reusable skeleton 进一步沉淀为稳定 shared helper / SDK surface | P1 | 依赖 structural convergence；建议晚于 adapter 和状态层收口 | 中到大 |
| `workflow-kernel-storyorchestrator-compatibility-retirement-criteria` | 把 compatibility shell 的长期保留、退出、退役条件变成正式标准 | P1 | 依赖 structural convergence；可在前两项之后推进 | 小到中 |
| `workflow-kernel-reference-plugin-readiness-review` | 针对 thin reference plugin 最终达标与否做正式评审型 change | P2 | 依赖前述关键结构债已明显收口 | 小 |

## 候选 1：Adapter 压薄与职责拆分

### 推荐 change id

- `workflow-kernel-storyorchestrator-adapter-thinning`

### 为什么值得先做

在当前剩余结构债里，`StoryOrchestratorKernelAdapter` 是最集中的复杂度承载点。

虽然上一轮 structural convergence 已经把它的职责写实为：

- kernel bridge
- business snapshot / restore projection
- legacy event compatibility
- helper glue

但它仍然是一个过渡性厚 adapter。只要这部分继续偏厚，未来就很容易再次吸收新的平台语义，重新长成“第二平台层”。

### 这个 change 应解决什么

- 继续把 adapter 的四类职责收缩成更可独立演进的边界
- 明确哪些职责仍必须留在插件适配层
- 明确哪些职责应下沉到更通用的位置，或至少从当前大 adapter 中切出
- 降低未来修改 snapshot / restore、事件兼容或 step glue 时的联动成本

### 为什么现在做

这是当前最直接降低结构复杂度的一步，也是后续继续做状态层边界或 helper 提升时最容易受益的一步。

### 风险

- 如果 scope 失控，容易演变成“彻底重写 adapter”
- 如果没有坚持只做职责收口，可能又会顺手改动 runtime 语义

### 推荐结论

如果现在只起一个新的 follow-up change，优先推荐先做这个。

## 候选 2：状态投影与 Runtime Truth 边界收口

### 推荐 change id

- `workflow-kernel-storyorchestrator-state-projection-boundaries`

### 为什么值得做

当前 `StateManager`、`StoryStateRepository`、`ArtifactManager` 的边界已经比之前清楚，但还没有完全达到目标态。

最关键的问题不是“状态代码很乱”，而是：

- 业务投影
- artifact 消费与查询
- runtime compatibility bookkeeping

仍然局部共存。

这会持续带来两个长期风险：

- 维护者把插件状态误当成 kernel execution truth
- 为了兼容调试或查询方便，runtime 适配字段继续在插件层膨胀

### 这个 change 应解决什么

- 进一步区分 story-facing business projection 与 runtime adaptation residue
- 收紧哪些字段允许继续存在于插件状态模型中
- 把“插件侧可见状态”和“kernel 真正执行真相”之间的边界写成更稳定的 contract
- 为后续查询、调试、artifact 消费建立更清晰的长期口径

### 为什么它排在 P0

因为它和 adapter 问题是当前仅剩的两块核心结构债之一，而且二者高度耦合。

### 推荐做法

- 可以作为 adapter thinning 之后的独立 change
- 也可以在实际判断后，与 adapter thinning 组成一个更大的“bridge + state boundary”组合批次

## 候选 3：Shared Helper / SDK Surface 继续沉淀

### 推荐 change id

- `workflow-kernel-plugin-sdk-helper-promotion`

### 为什么值得做

当前项目已经比以前更清楚地知道：

- 哪些 helper 是可复用骨架
- 哪些规则仍然是 `StoryOrchestrator` 私有领域逻辑

这意味着，后续若继续推进 plugin authoring SDK，不再需要靠“整块迁移”试错，而可以更谨慎地抽取 shared helper。

### 这个 change 应解决什么

- 识别真正值得上收的 reusable skeleton
- 把 shared validation / extraction / step-orchestration pattern 变成更稳定的 SDK surface
- 避免把故事领域规则误提升成平台 API
- 为未来第二、第三个 workflow plugin 降低重复造轮子的成本

### 为什么它不是 P0

因为它建立在前两类结构债已经进一步稳定的基础上。

如果 adapter 和状态层边界还没有继续收紧，就过早扩 shared SDK surface，容易把“过渡实现细节”错误固化成长期平台能力。

### 推荐结论

这是非常值得做的 P1，但更适合作为 adapter / state 收口之后的下一批平台化 change。

### 当前进度（2026-05-04）

- 该 change 已经起为 active change：`workflow-kernel-plugin-sdk-helper-promotion`
- 首批实现已开始把 extraction helper、structured validation helper 和 step wiring skeleton 上收到 `modules/workflowKernel/pluginSdk`
- 当前采取的是 incremental adoption，而不是一次性把 `StoryOrchestrator` helper 模块整块迁出

## 候选 4：Compatibility Surface 退役标准化

### 推荐 change id

- `workflow-kernel-storyorchestrator-compatibility-retirement-criteria`

### 为什么值得做

当前 compatibility shell 的边界已经写实，但还没有把“什么时候可以继续退役、退役到什么程度算安全”变成正式 change。

这会带来一个典型问题：

- 团队知道这些模块是 compatibility shell
- 但不知道什么时候该继续保留，什么时候可以进一步退役

### 这个 change 应解决什么

- 定义 compatibility surface 的继续保留条件
- 定义哪些入口已经可以降级或退役
- 定义“物理删除不是唯一标准，但何时允许继续减少壳层”的判断规则
- 防止后续在“保留得过多”和“过早删掉”之间摇摆

### 为什么它是 P1

因为这类 change 的价值主要在长期维护与治理，不如 adapter / state 边界那样直接降低当前复杂度。

### 适合什么时候做

- 当 adapter / state 两类关键债已经再收紧一轮之后
- 或者当团队准备进一步减少 legacy compatibility surface 时

## 候选 5：Reference Plugin Readiness 最终评审

### 推荐 change id

- `workflow-kernel-reference-plugin-readiness-review`

### 为什么这是候选而不是当前优先项

现在已经有 thin reference plugin 的正式判断标准，但还不适合立刻起一个“最终 readiness 评审” change。

原因很简单：

- 当前还存在明确、且尚未压完的结构债
- 如果现在做 readiness review，大概率只会再次确认“尚未完全达标”

### 这个 change 更适合解决什么

- 在前述关键结构债基本收口后，做正式的 target-state assessment
- 输出“已经达标”或“还差最后哪些 blocker”的最终项目结论
- 为后续是否把 `StoryOrchestrator` 作为对外样板、对内模板或 SDK 文档案例提供正式依据

### 推荐结论

这不是当前最值得立刻启动的 change，而是当前列表里的“收官型候选”。

## 推荐排序

如果接下来要按批次推进，建议按下面顺序考虑：

### 方案 A：稳健分批

1. `workflow-kernel-storyorchestrator-adapter-thinning`
2. `workflow-kernel-storyorchestrator-state-projection-boundaries`
3. `workflow-kernel-plugin-sdk-helper-promotion`
4. `workflow-kernel-storyorchestrator-compatibility-retirement-criteria`
5. `workflow-kernel-reference-plugin-readiness-review`

这个方案的好处是：

- 每个 change 的主矛盾清楚
- 风险更容易隔离
- 更适合继续沿 OpenSpec 节奏逐个归档

### 方案 B：两批收口

如果希望减少 change 数量，也可以考虑下面这种组合：

#### 第一批

- adapter thinning
- state projection boundaries

#### 第二批

- helper promotion
- compatibility retirement criteria
- readiness review

这个方案的好处是：

- 先把最硬的结构债压掉
- 再把平台化和最终评审类工作放在后半批次

## 不建议的做法

当前不建议采用下面几种思路：

### 1. 再起一个大而全的“继续结构收敛”总 change

原因：

- scope 太宽
- 容易重新回到上一轮 change 已经做过的口径
- 也不利于清楚观察哪类债真正被解决了

### 2. 现在就重新打开 replacement certification

原因：

- 当前矛盾已经不是 runtime correctness
- 重新打开只会模糊已成立的 archive 结论

### 3. 先急着扩大 SDK API 面

原因：

- adapter 和状态边界还没有完全继续收口
- 过早平台化容易把过渡形态固化成 shared surface

## 一句话建议

如果现在只允许做一个 follow-up change，建议优先起：

**`workflow-kernel-storyorchestrator-adapter-thinning`**

如果允许按两步推进，建议优先组合：

**先做 adapter + state 两类核心结构债，再做 helper promotion、compatibility retirement 与最终 readiness review。**

## 最终结论

下一批 follow-up change 不应再围绕“系统能不能跑”展开，而应围绕“剩余结构债如何逐个收口”展开。

当前最合理的候选列表是：

- 先压薄 adapter
- 再继续收紧状态投影边界
- 之后再推进 shared helper / SDK surface 的安全沉淀
- 最后再做 compatibility 退役标准化与 thin reference plugin readiness 收官评审

只要按这个顺序推进，后续 change 的目标、边界和归档结论都会比继续做泛化“结构优化”更清楚、更稳定。
