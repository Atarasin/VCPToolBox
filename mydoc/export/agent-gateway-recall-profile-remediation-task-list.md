# Agent Gateway Recall Profile 整改任务清单

> 来源文档：`agent-gateway-recall-profile-remaining-issues-review.md`
>
> 评审基准：`agent-gateway-recall-profile-final-design.md`
>
> 目标读者：继续推进 Agent Gateway recall profile / recall runtime 收口的内部工程师
>
> 使用方式：按优先级从上到下执行；同一优先级内默认也按顺序推进，除非依赖关系明确允许并行

---

## 1. 使用说明

这份清单不是“问题罗列”，而是可直接进入排期和执行的整改任务列表。

排序原则如下：

- `P0`：不解决就会持续导致多入口分叉、对外契约不一致或 canonical 能力无法真正成立
- `P1`：会限制最终设计稿中的核心运行时语义，属于主链能力缺口
- `P2`：会造成语义失真或治理能力不足，但不会立即阻断主路径
- `P3`：偏收口、对齐和长期维护质量，适合在主链问题解决后统一处理

每项任务都包含：

- 目标
- 整改范围
- 完成标准
- 依赖关系
- 建议验证

---

## 2. P0 任务

### P0-1 让 `memory/search` 真正支持 `profile`

**目标**

让 `memory/search` 能显式或默认消费 recall profile，而不是始终走 inline rule 兼容路径。

**整改范围**

- `contextRuntimeService` 中 `memory/search` 的执行主链
- `gateway_memory_search` 的参数透传与兼容逻辑
- profile 与显式参数的优先级处理

**完成标准**

- 调用 `memory/search(profile=...)` 时，能够进入 profile 解析主链
- 未显式传 `profile` 时，可使用 agent 默认 profile
- 仍保留老的显式参数覆盖优先级，不破坏兼容行为
- 输出结果与 `recall/run + items projection` 一致

**依赖关系**

- 无，可立即开始

**建议验证**

- `memory/search(profile=...)` 与 `recall/run + items projection` 结果一致
- `memory/search` 显式参数优先级高于默认 profile
- 未配置 profile 时仍维持旧行为

### P0-2 让 `context/assemble` 真正支持 `profile`

**目标**

让 `context/assemble` 也进入 profile 驱动主链，逐步从“独立召回实现”收口到“RecallResult 投影”。

**整改范围**

- `contextRuntimeService` 中 `context/assemble` 主链
- `gateway_context_assemble` 的参数透传与兼容处理
- 默认 profile 与显式参数的优先级逻辑

**完成标准**

- 调用 `context/assemble(profile=...)` 时，能够通过 recall profile 执行
- 未显式传 `profile` 时，可按 agent 默认 profile 回退
- 输出结果与 `recall/run + recallBlocks projection` 保持一致
- 现有 `maxBlocks`、`tokenBudget` 等兼容参数在过渡期内仍可用

**依赖关系**

- 建议在 `P0-1` 之后执行，以复用同一套参数优先级约定

**建议验证**

- `context/assemble(profile=...)` 与 `recall/run + recallBlocks projection` 结果一致
- 兼容参数与 profile merge 字段的优先级可预测且稳定

### P0-3 同步 MCP descriptor 与 published OpenAPI 的 `profile` 契约

**目标**

把 `memory/search`、`context/assemble`、`recall/run` 的真实可用参数和错误面同步到正式对外契约。

**整改范围**

- MCP descriptor registry
- published OpenAPI document
- Native route 对外 schema
- 如有需要，同步 backend client 能力描述

**完成标准**

- `gateway_memory_search` 与 `gateway_context_assemble` 对外声明可选 `profile`
- `recall/run` 的错误响应面覆盖真实实现中的关键状态码和错误类型
- 文档、descriptor、真实实现三者一致

**依赖关系**

- 依赖 `P0-1`、`P0-2` 的参数形态稳定后再落

**建议验证**

- descriptor 与 OpenAPI 自动/半自动检查
- 对外工具调用示例与真实返回一致

---

## 3. P1 任务

### P1-1 落地 profile 级 `merge` 结构化模型

**目标**

让 Recall Runtime 真正支持设计稿中的 profile 级 merge，而不是仅靠固定的去重、排序与截断逻辑。

**整改范围**

- resolver 对 `merge` 字段的解析与校验
- runtime 中合并阶段的统一执行逻辑
- merge 配置与兼容参数之间的优先级约定

**完成标准**

- 至少支持 `dedupe`、`sort`、`maxBlocks`、`tokenBudget`、`maxTokenRatio`、`minScore`
- 这些字段在 `recall/run` 中真实生效，而不是只停留在配置模型中
- `context/assemble` 可逐步下沉为“RecallResult -> projection”视图层

**依赖关系**

- 建议在 `P0-1`、`P0-2` 完成后执行

**建议验证**

- 多 rule profile 下 merge 策略真实生效
- `maxBlocks`、`tokenBudget`、`minScore` 有定向回归
- `context/assemble` 预算行为与 canonical recall 一致

### P1-2 统一兼容入口与 canonical recall 的预算语义

**目标**

把目前散落在兼容入口中的预算与截断能力，逐步收口到 Recall Runtime 的 merge 层。

**整改范围**

- `context/assemble` 当前独立维护的预算、截断、过滤逻辑
- runtime 合并阶段与 projection 阶段的职责边界

**完成标准**

- 预算与截断的核心语义由 Recall Runtime 负责
- 兼容入口只保留参数适配和视图投影职责
- 不再出现“`recall/run` 一套预算规则，`context/assemble` 另一套预算规则”的状态

**依赖关系**

- 依赖 `P1-1`

**建议验证**

- 相同输入下，`context/assemble` 与 `recall/run` 在预算语义上无分叉
- projection 层不再重复实现核心预算逻辑

---

## 4. P2 任务

### P2-1 修正 `truncate` 的生效位置与作用域

**目标**

让 `truncate` 真正作为 rule-level modifier，在单条 rule 的后处理阶段生效。

**整改范围**

- runtime 的 rule 执行顺序
- modifier pipeline 中 `truncate` 的落点
- 合并后全局截断与 rule 内截断的职责区分

**完成标准**

- 每条 rule 上的 `truncate` 独立生效
- 多 rule profile 下，后续 rule 的 `truncate` 不会被第一条 rule 覆盖
- 执行顺序与设计稿定义一致

**依赖关系**

- 可与 `P1` 并行，但建议在 `merge` 结构稳定后收口

**建议验证**

- 多 rule 不同 `truncate` 配置的定向测试
- 兼容旧字段路径与结构化路径都通过

### P2-2 修正 `aiMemo` 的多 rule 语义

**目标**

让 `aiMemo` 不再只依赖第一条 rule，而是具备清晰的多 rule 作用域和触发规则。

**整改范围**

- runtime 中 `aiMemo` 的触发点与配置解析
- 多 rule 下 `aiMemo` 的合并策略或优先级约定

**完成标准**

- profile 中后续 rule 声明的 `aiMemo` 不会被静默忽略
- 多 rule 下 `aiMemo` 的生效方式有明确约定，并体现在 diagnostics 或文档中
- 行为与最终设计目标保持一致，或明确形成新的项目约定

**依赖关系**

- 建议在 `P2-1` 之后执行，以统一 modifier 语义收口方式

**建议验证**

- 第 2 条 rule 才声明 `aiMemo` 的场景有回归
- diagnostics 能体现 `aiMemo` 的实际命中情况

### P2-3 继续压缩 runtime 对兼容字段的残余依赖

**目标**

让 `type / diaries / kMultiplier` 从“兼容 fallback”继续退到真正的边缘层，而不是在内部语义上继续占主导。

**整改范围**

- runtime 内部 helper 和 diagnostics 的字段来源
- 测试夹具默认输入形态
- projection / merge 中可能仍默认读旧字段的分支

**完成标准**

- 结构化 `baseMode + targets + projection` 成为默认输入和默认断言模型
- 旧字段仅保留为兼容 fallback，不再影响主路径设计判断
- 新增测试优先使用结构化 rule

**依赖关系**

- 可与 `P2-1`、`P2-2` 交叉推进

**建议验证**

- 结构化输入为主的回归全部通过
- legacy fallback 场景仍有覆盖，且不会干扰主路径测试

---

## 5. P3 任务

### P3-1 补齐 resolver 的编译期校验闭环

**目标**

把“尽早失败”从局部能力变成稳定行为，提升 profile 的治理能力。

**整改范围**

- profile 是否可用
- diary 访问范围校验
- modifier 合法性与组合合法性校验
- 不支持组合的早期失败策略

**完成标准**

- 非法 profile、非法 diary、非法 modifier 在 resolver 阶段稳定失败
- 错误码与错误信息可预测、可测试
- 不再主要依赖运行时执行阶段暴露配置错误

**依赖关系**

- 可独立推进

**建议验证**

- 非法配置场景的定向 resolver 测试
- 兼容路径与 canonical path 错误行为一致

### P3-2 更新默认配置与示例配置

**目标**

让默认配置、样例配置和测试样例主动推动结构化模型成为唯一主流表达。

**整改范围**

- `recall_profiles.json`
- `recall_profiles.json.example`
- 相关导出文档或示例片段

**完成标准**

- 样例优先使用 `baseMode`、`targets`、`projection`、`merge`
- 旧 `type / diaries` 仅作为兼容说明出现，不再作为默认示例
- 新工程师按样例写配置时，天然走结构化主模型

**依赖关系**

- 建议在 `P0`、`P1` 主链稳定后执行

**建议验证**

- 样例配置可直接通过 resolver 加载
- 示例与测试断言保持一致

### P3-3 对齐 DSL compiler、迁移脚本与设计稿中的默认投影约定

**目标**

消除“文档默认值、生成器默认值、运行时默认值”之间的轻微漂移。

**整改范围**

- DSL compiler 默认 `projection.emit`
- migration script 默认生成值
- 如有必要，同步设计文档中的默认约定说明

**完成标准**

- 明确 `rag / gated_rag` 默认投影到底是 `items` 还是 `recall_blocks`
- 生成器、运行时、文档三者保持一致
- 相关回归测试同步更新

**依赖关系**

- 建议在 `P3-2` 同期处理

**建议验证**

- DSL compiler 和 migration script 的定向测试通过
- 默认投影约定有单一权威来源

---

## 6. 建议执行顺序

建议的实际执行顺序如下：

1. `P0-1` 让 `memory/search` 支持 `profile`
2. `P0-2` 让 `context/assemble` 支持 `profile`
3. `P0-3` 同步 MCP 与 OpenAPI 契约
4. `P1-1` 落地 profile 级 `merge`
5. `P1-2` 统一预算语义到 Recall Runtime
6. `P2-1` 修正 `truncate` rule-level 语义
7. `P2-2` 修正 `aiMemo` 多 rule 语义
8. `P2-3` 压缩兼容字段残余依赖
9. `P3-1` 补齐 resolver 编译期校验
10. `P3-2` 更新默认配置与样例
11. `P3-3` 对齐 DSL / migration 默认投影

---

## 7. 里程碑判断标准

如果以下条件同时成立，可以认为这轮整改已经基本完成：

- `recall/run`、`memory/search`、`context/assemble` 三条主路径在 profile 语义上基本一致
- profile 级 `merge` 真正进入 Recall Runtime
- `truncate` 与 `aiMemo` 不再依赖“第一条 rule 的全局后处理”语义
- resolver 具备稳定的编译期早失败能力
- 默认配置、样例、生成器、published contract 与真实实现基本对齐

到那时，当前实现就会从“结构化主链基本可运行”更接近提升到“最终设计稿语义基本闭环”。
