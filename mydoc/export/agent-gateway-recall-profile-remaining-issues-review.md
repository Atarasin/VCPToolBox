# Agent Gateway Recall Profile 遗留问题评审

> 评审基准：`agent-gateway-recall-profile-final-design.md`
>
> 评审对象：当前 `agentGateway` 中与 recall profile / recall runtime 相关的实现
>
> 目标读者：继续推进 Agent Gateway recall profile 落地的内部工程师
>
> 阅读后应能执行的动作：识别当前实现距离设计稿闭环还差哪些关键项，并按优先级安排后续修复

---

## 1. 结论先行

当前实现已经从“Recall Profile 原型”继续推进到了“结构化 rule 主链基本可运行”的阶段，但仍不能认定为已经按最终设计稿完成收口。

更准确地说，当前状态应描述为：

- `recall/run` 主路径已经具备较完整的执行骨架。
- `baseMode`、`targets`、rule-level `projection` 已进入 resolver、runtime、projection 与生成侧主链。
- 结构化 rule 已经不再只是编译产物，而是开始成为运行时优先消费的模型。
- 但兼容入口、profile 级 merge、部分 modifier 语义、对外契约和配置样例仍未完全收口。

一句话总结：

**当前实现已经证明最终设计稿的核心模型可以在 Gateway 中跑通，但仍停留在“主链可运行、边缘与契约未闭环”的阶段。**

---

## 2. 本次评审范围

本次评审聚焦“相对于最终设计稿，当前还遗留哪些问题”，重点核对以下几类内容：

- 配置模型是否已经按 `agents + profiles + rules + merge` 收口
- runtime 是否真正以结构化 rule 为主执行
- `memory/search` 与 `context/assemble` 是否已经转向 projection 模式
- profile 级 merge 与 rule 级 modifier 是否具备设计稿要求的语义
- Native / MCP / OpenAPI 对外契约是否与实现一致
- DSL compiler、迁移脚本与默认配置是否继续推动结构化模型落地

本次评审不再重复展开已经基本成立的能力，例如：

- 顶层 `profiles` 配置模型基础迁移
- `full_text` / `gated_full_text` 独立路径基础接入
- `roleValve.expression` 基础支持
- rule-level `projection` 回退
- 结构化 DSL rule 生成与对应回归测试

---

## 3. 已经基本成立的部分

### 3.1 结构化 rule 已进入主链

当前 resolver、runtime、projection、DSL compiler、migration script、inline rule 生成侧都已经识别或产出以下核心结构：

- `baseMode`
- `targets.diaries`
- `targets.aggregate`
- `targets.kMultiplier`
- `projection.emit`

这意味着设计稿强调的“内部模型以结构化 rule 为主”已经不再只是目标，而是已经进入真实实现。

### 3.2 runtime 已开始优先消费结构化语义

当前 runtime 已经能够：

- 从 `baseMode` 解析基础执行模式
- 从 `targets.diaries` 解析目标 diary
- 从 `targets.kMultiplier` 驱动 RAG K 值
- 从 `targets.aggregate` 推断目标模式并在不支持的场景下早期失败
- 从 rule-level `projection` 影响 diagnostics 与后续投影

这说明 runtime 已经开始摆脱对旧 `type / diaries / kMultiplier` 字段的主路径依赖。

### 3.3 生成侧正在向结构化模型收紧

当前 DSL compiler、迁移脚本、inline rule 生成逻辑都已经开始停止默认产出旧字段，并配套补上了结构化断言与回归。

这一步非常关键，因为它决定了后续新增配置和测试是继续加深兼容层，还是推动最终模型收口。

---

## 4. 仍然遗留的关键问题

### 4.1 `memory/search` 与 `context/assemble` 仍未真正接入 profile

这是当前最重要的遗留问题之一。

设计稿要求：

- `recall/run` 作为 canonical recall 入口
- `memory/search` 和 `context/assemble` 保持兼容
- 两个兼容入口应能够逐步共享 Recall Runtime 与 projection 语义
- MCP 的 `gateway_memory_search` 与 `gateway_context_assemble` 应支持可选 `profile`

当前现实是：

- `memory/search` 和 `context/assemble` 仍主要通过 inline rule 走兼容路径
- 它们没有真正消费 `profile`
- 相关 MCP 描述与 published OpenAPI 也没有完整暴露 `profile`

实际影响是：

- 同一 agent 的默认 profile 无法自然作用到兼容入口
- `recall/run` 与旧入口可能长期产生语义漂移
- projection 虽已存在，但“统一 RecallResult 再投影”的架构尚未完全兑现

这项问题的优先级应高于多数内部语义细节问题，因为它直接影响多入口的一致性。

### 4.2 profile 级 `merge` 模型尚未按设计稿真正落地

设计稿中的 profile 级 merge 不只是“合并后做一下去重”，而是应支持：

- `dedupe`
- `sort`
- `maxBlocks`
- `tokenBudget`
- `maxTokenRatio`
- `minScore`

当前实现虽然已经有合并、排序、部分截断逻辑，但整体仍偏固定策略，尚未形成设计稿定义的结构化 merge 能力。

这带来两个问题：

- `recall/run` 还不能完整承载设计稿中的预算控制与筛选策略
- `context/assemble` 仍需要自己维护一套预算与截断逻辑，无法完全下沉到 canonical recall 层

如果不先补这层，Recall Runtime 仍更像“多条 rule 的执行器”，而不是“带统一 merge 策略的可发布 recall 编排引擎”。

### 4.3 `truncate` 仍不是严格的 rule-level modifier

设计稿要求 `truncate` 作为 rule 执行顺序的一部分，在单条 rule 的后处理阶段生效。

当前实现中，`truncate` 虽然能被解析，但实际更接近“合并后按第一条 rule 的设定做全局截断”。

这意味着：

- 多 rule profile 中，后续 rule 上声明的 `truncate` 可能被静默忽略
- 截断位置偏后，会和设计稿定义的执行顺序产生语义偏差
- 一旦不同 rule 需要不同截断阈值，当前模型无法保真表达

这不是简单的代码风格问题，而是运行时语义仍未完全收口的表现。

### 4.4 `aiMemo` 仍不是严格的多 rule 语义

当前 `aiMemo` 已经进入 runtime，但它更像“在最终合并结果上根据第一条 rule 的配置做一次后置处理”。

如果 profile 的第 2 条或之后的 rule 才声明 `aiMemo`，或者不同 rule 需要不同智能摘要策略，当前行为就会偏离设计稿对 rule 编排的预期。

这说明：

- `aiMemo` 虽然已存在
- 但仍没有完全融入多 rule 的结构化执行语义

这一点和 `truncate` 类似，都属于“功能存在，但还不是最终模型要求的执行位置和作用域”。

### 4.5 resolver 的编译期校验还没有真正闭环

设计稿要求在编译阶段尽量早失败，包括：

- profile 是否可用
- diary 是否在 agent 可访问范围内
- modifier 是否合法
- 组合是否被当前运行时支持

当前 resolver 已经具备若干校验函数和基础能力，但主链上的实际校验闭环仍不够完整。

结果是：

- 某些非法引用或不支持组合仍更像运行时才暴露
- “配置错误尽早失败”的原则还没有完全变成稳定行为

这会增加配置排障成本，也会削弱 profile 作为可治理能力的价值。

### 4.6 published contract 与真实实现仍有细节不一致

当前 `recall/run` 路由已经存在，运行时也会返回若干明确错误类型，但 published OpenAPI 对失败面和兼容参数的覆盖仍不完整。

这类问题的风险在于：

- 本地功能已经能跑
- 但正式对外契约没有同步到同一精度
- SDK、调用方、自动化集成和第三方适配层会因此得到不完整甚至误导性的接口认知

这一类问题通常不会在本地自测第一时间暴露，却会在对外接入阶段形成真实障碍。

### 4.7 默认配置与示例配置仍明显偏向兼容层

当前部分默认配置和示例文件仍保留较强的旧模型痕迹，例如：

- 更偏向旧 `type / diaries` 兼容字段
- 样例结构没有完全体现 `targets / baseMode / projection / merge`

这带来的问题不是“功能不能运行”，而是：

- 新增开发更容易继续沿旧形状写代码
- 测试与迁移示例无法持续推动结构化模型成为唯一主流表达
- 项目会长期停留在“兼容可用，但最终模型未成为默认认知”的中间态

### 4.8 DSL compiler 与迁移脚本的默认投影仍与设计稿存在漂移

设计稿给出的默认原则是：

- `rag` / `gated_rag` 默认投影为 `items`
- `full_text` / `gated_full_text` 默认投影为 `full_text_sections`

当前生成侧对 `rag` 类规则的默认投影仍更偏向 `recall_blocks`。

如果这是有意调整后的新约定，那么文档需要同步更新。
如果目标仍是最终设计稿，则生成侧默认值尚未完全对齐。

这项问题优先级低于前几项，但它会持续制造“文档、生成器、运行时默认值”之间的轻微语义漂移。

---

## 5. 风险判断

如果以上遗留问题不继续收口，后续最可能出现的风险有三类。

### 5.1 多入口语义继续分叉

`recall/run`、`memory/search`、`context/assemble` 会继续保持“表面相关、内部不同”的状态。

短期看还能兼容，长期会导致：

- 默认 profile 行为不一致
- 调试成本越来越高
- 新功能需要同时补多条路径

### 5.2 结构化模型停在“半落地”状态

虽然主链已经开始消费 `baseMode` 和 `targets`，但如果示例、契约、兼容入口和 merge 层不跟上，结构化模型仍难成为真正的唯一主模型。

### 5.3 多 rule 语义继续失真

像 `truncate`、`aiMemo` 这类 modifier 如果始终以“第一条 rule 的全局后处理”存在，就会让 profile 的多 rule 编排能力停留在部分成立的状态。

这会削弱设计稿最核心的价值，即：

- 同一个 profile 中能可靠表达多条异构 rule
- 各 rule 之间既能独立生效，又能由统一 merge 策略收口

---

## 6. 建议优先级

建议按以下顺序继续推进。

### 6.1 第一优先级

- 给 `memory/search` 和 `context/assemble` 增加 `profile` 支持
- 让兼容入口真正复用 profile 与 projection 主链
- 同步 MCP descriptor 与 published OpenAPI 的兼容参数

原因很简单：

- 这一步能最快收敛多入口语义
- 也是把 `recall/run` 从“新功能”变成“canonical 能力中心”的关键一步

### 6.2 第二优先级

- 落地 profile 级 `merge`
- 将 `maxBlocks`、`tokenBudget`、`maxTokenRatio`、`minScore` 等预算字段真正下沉到 Recall Runtime

这样做之后，`context/assemble` 的预算能力才有机会逐步转成“RecallResult -> projection”的纯视图层逻辑。

### 6.3 第三优先级

- 修正 `truncate` 的生效位置与作用域
- 修正 `aiMemo` 的多 rule 语义
- 继续减少 runtime 内部对兼容字段的残余依赖

这一步完成后，结构化 rule 才能称得上是“执行语义主模型”，而不是“结构上已对齐，行为上仍有历史包袱”。

### 6.4 第四优先级

- 补齐 resolver 的编译期校验闭环
- 更新默认配置与样例配置
- 对齐 DSL compiler、迁移脚本与设计稿中的默认投影约定

这些工作优先级略低，但它们决定了后续开发是否会继续被旧模型牵引。

---

## 7. 当前阶段判断

如果问题是“当前实现是否已经具备继续迭代的坚实基础？”答案是：**是。**

如果问题是“当前实现是否已经按最终设计稿闭环？”答案是：**还没有。**

如果只看当前最主要的差距，可以浓缩为三句话：

- canonical recall 已经有了，但兼容入口还没有真正统一进来
- 结构化 rule 已经进入主链，但 merge 和部分 modifier 语义还没完全保真
- 实现已经领先于部分样例和契约，但对外闭环仍需要继续收口

因此，当前最合适的工程判断不是“重新设计”，而是：

**沿现有主链继续收口，把兼容入口、merge、modifier 语义和对外契约补齐。**

---

## 8. 推荐后续验证

在继续修复上述问题时，建议同步补以下验证：

- `memory/search(profile=...)` 与 `recall/run + items projection` 结果一致
- `context/assemble(profile=...)` 与 `recall/run + recallBlocks projection` 结果一致
- profile 级 `merge.maxBlocks`、`tokenBudget`、`minScore` 生效
- 多 rule 下不同 `truncate` 配置不会互相覆盖
- 多 rule 下 `aiMemo` 的触发范围与设计预期一致
- 非法 profile / 非法 diary / 非法 modifier 在 resolver 阶段稳定早失败
- published OpenAPI、MCP descriptor 与真实错误面保持一致

如果这些验证全部补齐，当前实现就会从“主链基本可运行”更接近提升到“设计稿语义基本闭环”。
