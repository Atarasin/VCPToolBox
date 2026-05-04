# StoryOrchestrator 薄型插件三步执行方案

## 文档目标

本文面向接下来继续推进 `StoryOrchestrator` 收敛的内部工程师。

它回答三个直接问题：

- 为了达到“基于工作流内核的理想化插件”目标，接下来到底还剩哪三步
- 这三步应该按什么顺序推进
- 每一步应拆成什么新的 OpenSpec change

读完本文后，维护者应能够直接做一件事：

- 按推荐顺序起 3 个新的 OpenSpec change，并明确每个 change 的边界、依赖和完成标准

## 当前基线

当前已经成立的前提有三条：

1. `WorkflowKernel` 对手写工作流的 runtime replacement 已成立
2. compatibility surface 的 retain / degrade 治理口径已正式化
3. `StoryOrchestrator` 的正式 readiness review 已给出 `not-ready` 结论，且 blocker 已收缩为三类：
   - adapter 仍偏厚
   - 状态边界尚未完全闭合
   - helper / SDK promotion 尚未稳定化

因此，后续推进不应再围绕“系统能不能跑”展开，而应围绕“最后三类结构债如何收口”展开。

## 目标态

最终理想态不是把 `StoryOrchestrator` 删除掉，也不是继续保留一个大型特例插件，而是把它收敛成下面这种形态：

- 主要资产是 workflow definition
- 主要保留的是少量故事领域 step
- 业务状态只承担 projection 角色
- 插件入口只负责装配和注册
- 通用执行语义、通用编排骨架和共享 contract 都由 `WorkflowKernel` 与 plugin SDK 承担

换句话说，最终目标是：

**让 `StoryOrchestrator` 成为一个足够薄、足够清晰、足够可复制的参考插件。**

## 三步总览

| 步骤 | 新 change id | 主要目标 | 推荐优先级 | 依赖 |
|---|---|---|---|---|
| 第一步 | `workflow-kernel-storyorchestrator-adapter-thinning-phase-2` | 把 adapter 从“职责可见”推进到“职责真正收薄” | P0 | 无，建议立刻开始 |
| 第二步 | `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2` | 把状态层从“显式区分”推进到“长期不易误读” | P0 | 建议晚于或紧跟 adapter phase 2 |
| 第三步 | `workflow-kernel-plugin-sdk-helper-promotion-stabilization` | 把 helper promotion 从首批 adoption 推进到稳定 shared surface | P1 | 建议晚于前两步 |

## 推荐顺序

### 第一步：先压薄 Adapter

先做 adapter，是因为它仍然是最集中的复杂度承载点。

当前 `StoryOrchestratorKernelAdapter` 虽已完成第一轮职责切片，但还同时承载：

- kernel bridge
- business projection / restore
- compatibility event adaptation
- StoryOrchestrator 私有 helper glue

如果这里不继续收薄，后续状态边界和 helper promotion 很容易继续被吸回 adapter，重新长成“第二平台层”。

### 第二步：再继续收紧状态边界

状态层已经从“口头区分”推进到“helper + 注释 + 测试的显式区分”，但还没达到长期不会误导维护者的程度。

这一阶段的重点不是再写一遍状态层，而是继续压缩：

- business projection
- artifact projection
- compatibility bookkeeping

之间的误读空间。

### 第三步：最后稳定化 SDK Surface

等 adapter 和状态层再收紧一轮后，再做 helper / SDK 稳定化，收益最高，也更安全。

原因很简单：

- 过早扩大 shared surface，容易把过渡性实现细节固化进长期平台 API
- 先把前两步收口，才能更准确判断哪些 skeleton 值得长期上收

## 每一步的完成标准

### 第一步完成标准

- adapter 不再像协调中心，而更像薄桥接层
- 新增平台语义不会再自然落进 adapter
- snapshot / compatibility / helper glue 至少有更清晰的独立 seam

### 第二步完成标准

- 插件状态更难被误读为 kernel runtime truth
- compatibility residue 的存在范围被进一步收紧
- 查询、artifact lookup、业务摘要的长期口径更稳定

### 第三步完成标准

- shared helper surface 不再只是首批 adoption，而是更稳定的长期 SDK 面
- StoryOrchestrator 私有层中剩余的更多是 story-domain logic，而不是可复用骨架
- 第二、第三个 workflow plugin 的复用成本继续下降

## 不建议的推进方式

当前不建议采用下面三种做法：

### 1. 再起一个“大而全”的继续结构收敛总 change

问题在于：

- scope 太宽
- 不利于观察哪类债真正被解决
- 容易把前面已经做过的口径重新混在一起

### 2. 重新打开 replacement certification

问题在于：

- 当前矛盾已不是 runtime correctness
- 重新打开只会模糊已经成立的 archive 结论

### 3. 先急着宣称 StoryOrchestrator 已达成薄型参考插件

问题在于：

- readiness review 已正式给出 `not-ready`
- 当前 blocker 已足够明确，不应提前跳过收口阶段

## 推荐落地方式

建议按下面节奏推进：

1. 起 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
2. adapter 进入实现后，紧跟起 `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`
3. 当前两项都进入稳定收口后，再起 `workflow-kernel-plugin-sdk-helper-promotion-stabilization`
4. 三项都完成并归档后，再起新的 readiness review 收官 change

## 三个 Change Brief

本文配套输出了 3 份可直接转 OpenSpec artifacts 的 change brief：

1. `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
2. `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`
3. `workflow-kernel-plugin-sdk-helper-promotion-stabilization`

如果后续只允许立刻起一个 change，优先建议：

**先起 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`。**

## 最终结论

从当前 `not-ready` 结论走向“理想化插件”终态，不需要再补一轮大而泛的 runtime 工程，而是只需要把最后三类结构债按顺序收口：

1. 先把 adapter 真正压薄
2. 再把状态边界推进到长期不易误读
3. 最后把 shared helper / SDK surface 稳定化

只要按这个顺序推进，`StoryOrchestrator` 就会从“参考插件候选态”进一步逼近“真正可复制的薄型参考插件完成态”。
