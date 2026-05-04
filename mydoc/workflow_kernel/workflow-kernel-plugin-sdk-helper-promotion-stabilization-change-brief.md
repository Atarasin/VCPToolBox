# Change Brief: workflow-kernel-plugin-sdk-helper-promotion-stabilization

## 文档目标

本文用于定义下一轮 helper / SDK promotion 稳定化 change 的建议边界，供维护者直接据此创建新的 OpenSpec artifacts。

## 建议 Change ID

`workflow-kernel-plugin-sdk-helper-promotion-stabilization`

## 为什么现在做

当前 shared `pluginSdk` 已经跨过“只会写文档”的阶段，开始真实承接 extraction helper、structured validation helper 和部分 step wiring skeleton。

但 readiness review 仍把 helper promotion maturity 列为 blocker，原因不是它没开始，而是它还停留在：

- 第一批 family adoption
- StoryOrchestrator 仍保留较多候选 reusable skeleton
- shared surface 还没有稳定到足以成为长期参考样板

因此，下一步不应继续做“整块迁移试错”，而应做更谨慎的稳定化收口。

## 这个 Change 要解决什么

- 把已识别的 reusable skeleton 从首批 adoption 推进到更稳定 shared surface
- 继续区分 shared orchestration pattern 与 story-domain logic
- 降低未来第二、第三个 workflow plugin 的重复造轮子成本
- 避免把过渡性实现细节或故事领域规则错误提升成长期平台 API

## In Scope

- 梳理当前仍留在 StoryOrchestrator 内、但已表现出复用潜力的 helper family
- 继续上收稳定的 extraction / validation / step-orchestration skeleton
- 强化 shared helper 的 contract、最小示例和聚焦测试
- 保持 story-domain prompts、schema rules、chapter policy 留在插件侧

## Out Of Scope

- 不把 StoryOrchestrator 的 helper 模块整块迁空
- 不把故事领域规则提升成平台 API
- 不在本 change 中顺手重做 adapter 或状态层主结构
- 不为了追求“SDK 更大”而牺牲 shared surface 的长期稳定性

## 建议设计问题

创建 OpenSpec artifacts 时，建议优先回答下面四个问题：

1. 哪些 helper family 已经满足“跨插件可复用”的稳定门槛
2. 哪些 helper 仍然只是 StoryOrchestrator 私有领域逻辑
3. 怎样让 shared helper 的 contract 更稳定，而不是继续暴露过渡细节
4. 第二个 consumer 已经证明了什么，还缺什么才足以支撑长期 SDK surface

## 建议任务组

### 1. Helper Family 审计

- 列出当前仍在 StoryOrchestrator 私有层中的候选 reusable skeleton
- 区分 shared skeleton 与 story-domain logic

### 2. Shared Surface 稳定化

- 继续把合适的 family 上收为 shared helper
- 补 contract、builder、最小示例或宏级骨架

### 3. 复用验证

- 补聚焦测试
- 验证 shared surface 不只对 StoryOrchestrator 单一场景成立

## 完成标准

- StoryOrchestrator 私有层中剩下的更多是领域逻辑，而不是可复用骨架
- shared helper surface 具备更稳定的长期 contract
- 新 workflow plugin 的接入成本进一步下降

## 主要风险

- 过早平台化，把过渡细节固化为长期 API
- 把 story-domain semantics 错误抽进 shared layer
- 为了追求“更多 SDK 能力”反而增加理解成本

## 风险控制

- 只上收已经表现出稳定复用价值的 skeleton
- 继续坚持“shared pattern 与 story-domain rule 分开评估”
- 用第二 consumer 视角审视每个 helper family，而不是只看 StoryOrchestrator 本身

## 推荐优先级

**P1**

## 推荐依赖关系

- 建议晚于 `workflow-kernel-storyorchestrator-adapter-thinning-phase-2`
- 建议晚于 `workflow-kernel-storyorchestrator-state-projection-boundaries-phase-2`

## 一句话建议

这一步不是把 SDK 做大，而是把已经证明有价值的 shared surface 做稳。
