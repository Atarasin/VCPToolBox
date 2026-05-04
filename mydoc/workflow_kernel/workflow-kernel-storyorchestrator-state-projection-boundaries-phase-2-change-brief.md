# Change Brief: workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2

## 文档目标

本文用于定义下一轮状态边界收口 change 的建议边界，供维护者直接据此创建新的 OpenSpec artifacts。

## 建议 Change ID

`workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`

## 为什么现在做

状态层当前已经从“口头区分 business projection 与 runtime truth”推进到“helper、注释和测试都开始显式区分”的阶段，但 readiness review 仍明确把这项问题列为 blocker。

真正的问题不是“状态代码乱不乱”，而是下面三类东西仍然局部共存：

- story-facing business projection
- artifact lookup / projection
- compatibility-oriented workflow bookkeeping

只要这些口径仍然容易被维护者混读，`StoryOrchestrator` 就还不能宣称已经完成薄型参考插件所要求的长期边界闭合。

## 这个 Change 要解决什么

- 把状态层从“显式区分”推进到“长期不易误读”
- 继续收紧 compatibility residue 允许存在的范围
- 继续明确哪些字段是业务投影，哪些字段只是 compatibility bookkeeping
- 让查询、调试、artifact lookup 的长期口径更稳定

## In Scope

- `StateManager` 中 workflow compatibility state 的进一步收口
- `StoryStateRepository` 中 projection / lookup 与 runtime truth 的长期口径进一步写实
- `ArtifactManager` 中 artifact projection record 的继续边界化
- 新一轮聚焦测试，覆盖容易误读的状态组装与查询场景

## Out Of Scope

- 不把整个状态层改写成另一套架构
- 不重新定义 kernel runtime source of truth
- 不在本 change 中顺手做 adapter 大改或 helper promotion 大改
- 不把业务投影彻底从插件侧移除

## 建议设计问题

创建 OpenSpec artifacts 时，建议优先回答下面四个问题：

1. 哪些状态字段在当前阶段仍然必须作为 compatibility residue 保留
2. 哪些状态字段已经可以进一步下沉、降级或改为只读投影
3. 维护者最容易把哪些查询结果误读为 kernel truth
4. 如何用更少字段、更清楚命名和更聚焦测试来降低误读概率

## 建议任务组

### 1. 状态字段与查询口径审计

- 重新审视当前 workflow compatibility state
- 标记最容易误读成 runtime truth 的字段与查询入口

### 2. 边界继续收口

- 收紧 compatibility bookkeeping 的存在范围
- 强化 business projection / artifact projection / compatibility residue 的分层表达

### 3. 聚焦验证

- 增加代表性测试
- 验证查询、回读、artifact lookup 和 fallback 场景的长期口径

## 完成标准

- 维护者更难把插件状态误当成 kernel runtime truth
- compatibility residue 的残留理由与残留范围都更明确
- artifact projection 与业务状态摘要的长期口径更稳定

## 主要风险

- 过度清理状态字段，伤到当前兼容路径
- 命名和注释变清楚了，但实际查询边界仍不稳
- 把状态层问题错误扩大成“大规模数据模型重构”

## 风险控制

- 先清口径，再收字段，再补测试
- 以“降低误读概率”为主目标，而不是追求状态结构表面整洁
- 所有调整都通过聚焦测试验证，而不是只靠注释断言

## 推荐优先级

**P0**

## 推荐依赖关系

- 建议晚于或紧跟 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`

## 一句话建议

这一步的目标不是“把状态层做漂亮”，而是“让它长期不再冒充 kernel truth”。
