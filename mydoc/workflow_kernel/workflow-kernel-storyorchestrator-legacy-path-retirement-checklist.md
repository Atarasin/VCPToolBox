# StoryOrchestrator legacy path 退役清单

## 文档目标

本文面向继续维护 `WorkflowKernel` 与 `StoryOrchestrator` 收口工作的内部工程师。

读完本文后，维护者应能直接完成一个动作：**判断当前 legacy path 中哪些面必须保留，哪些面可以先降级收纳，哪些面在满足条件后可以进入退役。**

## 当前结论

当前不建议直接删除整个 legacy path。

更准确的判断是：

- legacy path **不是长期主路径**
- 但它 **仍然是当前有效的兼容层与回退安全网**
- 因此现在更适合做“受控退役”，而不是“一次性删除”

如果要用一句话概括当前状态：

**legacy path 现在仍需保留，但只能以 compatibility shell 的身份保留，不应再承接新的主控制语义。**

## 退役判定标准

只有同时满足下面三类条件，某个 legacy surface 才能进入物理退役阶段：

1. **主路径替代已稳定**
   kernel-owned path 已覆盖该 surface 当前承担的启动、恢复、重试或状态查询职责。

2. **兼容职责已消失或被更窄入口接管**
   旧调用点、旧持久化字段、旧 definition 引用或旧运维路径不再依赖该 surface。

3. **验证证据已到位**
   删除后仍能通过回归测试、恢复路径验证和兼容入口验证，且不再需要为旧壳保留专门 fallback。

只满足其中一部分，最多只能做降级收纳，不能直接删除。

## 当前 legacy surface inventory

| Surface | 当前职责 | 当前判断 | 说明 |
|---|---|---|---|
| `WorkflowEngine` | 提供启动、恢复、重试、状态投影与 kernel fallback 外壳 | 必须保留 | 仍是 StoryOrchestrator 对外兼容控制面的承接层，不是死代码 |
| `Phase1_WorldBuilding` | phase1 兼容执行壳 | 必须保留 | legacy phase-class path 仍存在，且当前仍受回归测试保护 |
| `Phase2_OutlineDrafting` | phase2 兼容执行与 checkpoint 恢复壳 | 必须保留 | 当前仍参与 legacy resume / continue 路径 |
| `Phase3_Refinement` | phase3 兼容执行与最终完成壳 | 必须保留 | 当前仍承担 compatibility-driven polish / completion 入口 |
| `workflow-phase1` | 旧 phase-only definition 兼容入口 | 可先降级收纳 | 当前更像旧 `definitionRef` 的兼容别名，而不是推荐执行源 |

## 分类清单

### 1. 当前必须保留

下面这些面目前仍不应删除：

#### `WorkflowEngine`

保留原因：

- 插件初始化时仍会创建它
- 它仍承接 `start`、`resume`、`recover`、`retryPhase` 一类兼容入口
- 在 kernel adapter 不可用或需要 fallback 时，它仍是明确的回退安全网
- 它还承担把 kernel 状态投影回旧 API 形状的兼容职责

退役前必须先满足：

- `StoryOrchestrator` 不再总是依赖它作为命令分发与 fallback 中枢
- kernel path 已提供等价的启动、恢复、重试与状态查询外形
- 兼容入口改为更薄的 façade，而不是继续以 engine 形式保留

#### `Phase1_WorldBuilding`

保留原因：

- 当前仍是 legacy phase-class path 的一部分
- 还承担 phase1 壳层执行语义

退役前必须先满足：

- phase1 已不再通过 legacy class path 执行
- 恢复和回归测试不再依赖旧 phase runner 存在

#### `Phase2_OutlineDrafting`

保留原因：

- 当前仍支撑 legacy phase2 执行
- 对 checkpoint continue / resume 仍有现实兼容价值

退役前必须先满足：

- 所有 phase2 恢复、继续与拒绝分支都已完全改走 kernel-owned path
- 不再需要 phase-class `continueFromCheckpoint` 风格的兼容壳

#### `Phase3_Refinement`

保留原因：

- 当前仍支撑 legacy phase3 执行与完成收口
- compatibility path 仍会借它承接最终阶段的旧语义

退役前必须先满足：

- 最终完成、验收与 checkpoint 后续流转都已由 kernel path 稳定接管
- phase3 legacy runner 不再承担任何回退职责

### 2. 可先降级收纳

这些面当前不适合直接删除，但适合先进一步弱化存在感：

#### `workflow-phase1`

当前判断：

- 它更像旧 `definitionRef` 的兼容别名
- 它已经不是推荐执行源
- 它的存在价值主要是保证旧引用仍可被解析并降级到完整 workflow definition

建议动作：

- 继续保留别名解析能力
- 在结构上明确它只是 degraded compatibility entry
- 等旧持久化引用和恢复路径确认不再需要时，再考虑彻底退役

### 3. 满足条件后可退役

这类不是“今天就能删”的清单，而是“完成前置条件后应优先退役”的对象：

1. `workflow-phase1`
   当旧 `definitionRef` 已完成清理或全部自动归一后，应优先退役。

2. `Phase1_WorldBuilding`、`Phase2_OutlineDrafting`、`Phase3_Refinement`
   当 phase-class path 不再承担恢复、继续执行或回退责任后，应作为一组一起退役，而不是零散删除。

3. `WorkflowEngine`
   当上面两类兼容职责都已经消失后，它应从“兼容控制壳”继续收窄为更薄 façade，最终再评估是否还能整体退役。

## 推荐退役顺序

建议按下面顺序推进，而不是反过来：

1. **先退役 degraded definition entry**
   先确认旧 `definitionRef` 是否还在真实恢复路径中出现，然后优先处理 `workflow-phase1`。

2. **再退役 phase-class shells**
   等 phase2 / phase3 的 continue、resume、reject、complete 语义都已有 kernel-owned 替代后，再考虑成组移除 phase classes。

3. **最后收窄或退役 `WorkflowEngine`**
   只有在它不再承担 fallback、兼容入口和状态投影职责时，才适合讨论物理删除 engine 本身。

## 风险点

如果过早退役 legacy path，最容易破坏的是三类能力：

1. **fallback 安全网**
   kernel adapter 初始化失败时，现有行为仍可能回落到 legacy engine。

2. **恢复与继续执行语义**
   特别是 checkpoint 相关的 continue / resume / rejection 分支，目前仍有 legacy shell 参与。

3. **旧引用兼容**
   旧 `definitionRef` 与旧测试路径仍可能依赖 degraded entry 或 phase-class path。

## 验证要求

每推进一层退役，至少要重新验证下面四组证据：

1. 启动路径验证
   主路径启动不再需要 legacy engine 兜底。

2. 恢复路径验证
   resume、recover、retry、checkpoint continue 在 kernel-owned path 下全部闭环。

3. 兼容入口验证
   旧引用、旧命令、旧持久化数据要么仍被兼容读取，要么已完成迁移。

4. 回归测试验证
   现有保护 compatibility shell 的测试要么删除，要么改写为保护新 canonical path。

## 推荐动作

当前最合理的动作不是立刻删文件，而是先做一次小范围 legacy retirement audit，回答下面三个问题：

- 现在还有哪些真实命令和恢复分支会走进 legacy shell
- 哪些测试只是在保护历史壳，而不是当前主路径
- 哪些 surface 已经满足 `eligible-for-retirement`，但还没有被正式下线

如果这轮审计完成，再决定是否起一个新的小范围 change，会比现在直接删 `Phase2_OutlineDrafting` 一类文件安全得多。
