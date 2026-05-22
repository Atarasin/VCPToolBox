# Agent Gateway Recall Profile 实现评审与完成度报告

> 评审基准：`agent-gateway-recall-profile-final-design.md`
>
> 评审对象：`modules/agentGateway` 当前基于设计稿完成的一轮实现
>
> 目标读者：继续推进 Agent Gateway recall profile / recall runtime 落地的工程师
>
> 阅读后应能执行的动作：判断当前实现距离“最终设计可发布状态”还有多少差距，并据此安排后续修复优先级

---

## 1. 结论先行

当前实现已经完成了 Recall Profile 的第一轮骨架搭建，但还不能认定为“已按最终设计完成”。

如果按“是否已经做出一套可运行的 recall profile 原型”来评估，当前完成度约为 **70%**。

如果按“是否已经达到设计稿定义的统一 Recall Runtime、兼容投影、MCP 与 OpenAPI 对外契约、可发布状态”来评估，当前完成度约为 **45%**。

更准确地说，当前状态应定义为：

- Recall Runtime 骨架：已建立。
- Native `recall/run` 路由：已接入。
- Projection service：基本可用。
- S01-S04 局部能力：已有较多实现与测试覆盖。
- 最终配置模型：未完成。
- 兼容旧接口统一投影：未完成。
- MCP `gateway_recall_run`：只声明，未真正接通。
- Published OpenAPI / governance / backend client：未完成。
- 结构化 modifier 语义与运行时消费一致性：未完成。

一句话总结：

**当前实现已经证明 Recall Profile 方案可以在 `agentGateway` 中跑通一条主路径，但距离设计稿要求的最终收口形态还有明显差距，尤其欠缺统一契约发布、兼容路径收口和配置模型收敛。**

---

## 2. 本次评审依据

本次结论来自三类证据：

- 设计稿审阅：`mydoc/export/agent-gateway-recall-profile-final-design.md`
- 源码审阅：resolver、runtime、projection、context runtime、route、MCP descriptor、MCP adapter、published contract、backend client、配置与脚本
- 测试验证：执行 `tests/s01/*.js`、`tests/s02/*.js`、`tests/s03/*.js`、`tests/s04/*.js`

测试结果如下：

- 294 个测试中 291 个通过，3 个失败。
- 3 个失败都不是核心功能回归，而是旧测试预期仍停留在未纳入 `aiMemo` 的阶段。
- 失败集中在 modifier 集合与 modifier pipeline 断言，反映的是测试滞后，不足以推翻当前 runtime 已进入 S03 阶段这一事实。

---

## 3. 已完成部分

### 3.1 Recall Runtime 主骨架已经存在

当前实现已经具备统一 Recall Runtime 的基本执行形态，包括：

- 按 `agentId + profile` 解析 profile
- 基本输入校验
- query 向量预计算
- 多条 rule 顺序执行
- gated rule 判定
- rule 结果合并、去重、排序、截断
- diagnostics、pipeline stages、profile meta 输出
- AIMemo 后置阶段骨架

这说明设计稿要求的“共享 Recall Runtime”已经不是空白，而是已经进入可运行状态。

### 3.2 Native `recall/run` 已经打通

当前 Native Gateway 已注册 `POST /agent_gateway/recall/run` 对应路由，并能够：

- 接收 `agentId`、`query`、`profile`
- 调用 `recallRuntimeService.executeRecall(...)`
- 通过 `recallProjectionService.projectFullResult(...)` 返回结构化响应

这部分是当前实现最接近最终设计的一层。

### 3.3 Projection service 完成度较好

当前 projection 层已经具备：

- `projectItems`
- `projectRecallBlocks`
- `projectFullResult`
- `projectFullTextSections`
- `projectSearchItems`
- `projectContextBlocks`

这说明“统一结果再投影”的思路已经落入代码，并且相关 S02/S03 投影测试通过情况较好。

### 3.4 Recall 相关服务已进入共享 bundle

`recallProfileResolver`、`recallRuntimeService`、`recallProjectionService` 已纳入共享 service bundle，这意味着整体骨架不再是零散试验代码，而是已经进入正式服务装配层。

### 3.5 DSL compiler 与 migration script 已有实现

设计稿后期要求中的两项能力已经有明显进展：

- DSL compiler 已支持较完整的 bracket 语法、modifiers、meta 与 profile 生成
- migration script 已能从旧 memory policy 推导 recall profile 配置建议

从实现成熟度来看，这两层甚至比当前 runtime 的结构化语义消费更接近设计目标。

---

## 4. 部分完成但仍有明显差距的部分

### 4.1 Resolver 只实现了早期配置模型

当前 resolver 具备基础能力，包括：

- config 文件加载与缓存
- `resolveForAgent(agentId, profileName)`
- wildcard / alias / default profile 基础解析
- rule type 与 modifier 白名单校验
- diary access 基础校验

但它仍然停留在“agent 内嵌 profiles”的早期模型，尚未达到设计稿最终结构。当前缺失的关键字段包括：

- `agents.allowedProfiles`
- 顶层 `profiles`
- `targets`
- `aggregate`
- `kMultiplier`
- `projection`
- `merge`
- profile 的 `description`、`version`、`tags`、`metadata`

这意味着 resolver 虽然可用，但消费的不是最终设计稿配置模型。

### 4.2 Runtime 具备流程骨架，但语义保真度不足

当前 runtime 已经支持：

- `rag`
- `gated_rag`
- S02 modifiers：`timeDecay`、`roleValve`、`base64Memo`
- `aiMemo`
- diagnostics / pipeline stages / profileMeta

但与设计稿相比，仍有几类关键语义没有真正落地：

- `full_text` / `gated_full_text` 没有独立全文执行路径，仍然复用了 RAG 收集路径
- `truncate` 更像“取前 N 条”，不是设计里更结构化的截断语义
- `roleValve.expression` 没有按表达式求值，而是被简化为角色过滤
- `rerank.weight`、`tagMemo.weight`、`tagMemo.geodesic`、`aiMemo.preset` 等结构化参数没有真正被消费
- profile 级 `merge` 策略没有落地，当前仍是固定的去重加排序

因此，当前 runtime 更像是“能跑通主路径的执行器”，而不是“完整保真消费最终设计结构化规则的运行时”。

### 4.3 Projection 思路已实现，但兼容旧接口尚未真正统一

设计稿要求：

- `recall/run` 作为 canonical recall 入口
- `memory/search` 与 `context/assemble` 通过 projection 兼容旧输出

当前现实是：

- projection service 已存在
- `memory/search` 与 `context/assemble` 仍主要由 `contextRuntimeService` 独立实现
- 两者仍然直接调用 `collectRagItems(...)`
- 旧接口还没有切换为“RecallResult -> projection”模式

这意味着“统一 Recall Runtime 收口语义，再由旧接口投影兼容”的设计目标，目前只完成了一半。

---

## 5. 未完成或明显偏离设计的部分

### 5.1 MCP `gateway_recall_run` 只发布了描述，没有真正实现

这是当前最高优先级问题之一。

当前状态是：

- `mcpDescriptorRegistry` 已声明 `gateway_recall_run`
- MCP descriptor 对外已经暴露该 tool 名称与输入 schema
- `mcpAdapter` 中却没有对应执行分支

实际后果是：

- 调用方会认为 Gateway 已经支持 `gateway_recall_run`
- 真正执行时却会落入 “Unsupported gateway-managed tool”

这属于对外契约不一致，优先级应高于多数内部语义问题。

### 5.2 Published contract 尚未补齐 `recall/run`

当前 Native route 已存在，但正式 published contract 还没有同步到位：

- `protocolGovernance` 的 published native paths 不包含 `/agent_gateway/recall/run`
- published OpenAPI document 不包含 `/agent_gateway/recall/run`
- `GatewayBackendClient` 没有 `runRecall(...)` 之类的 client 方法

这意味着：

- 功能在本地代码路径中存在
- 但尚未成为正式、完整、对外可消费的 Gateway 能力

### 5.3 最终配置模型尚未落地

设计稿明确要求 Recall Profile 是：

- 一组可命名、可授权、可默认化的 profile
- 每个 profile 由多条 rule 组成
- rule 支持多 diary、聚合、基础模式、modifiers、projection
- profile 级支持 merge

当前 `recall_profiles.json` 仍是简化样例模型，无法完整承载这些目标。

这意味着设计稿最核心的“结构化配置优先”原则实际上还没有完成。

### 5.4 `full_text` 目前属于伪实现

代码中已经引入 `full_text` 与 `gated_full_text` 类型集，但执行时并没有独立全文检索路径，而只是通过调大基础 K 值后继续复用 `collectRagItems(...)`。

如果按设计稿评估，这不能算真正完成了 `full_text` / `gated_full_text` 支持，只能算“为后续实现预留了规则类型”。

### 5.5 结构化 modifier 语义与 DSL/compiler 产物不一致

当前割裂非常明显：

- DSL compiler 已能输出更结构化的 modifiers
- migration script 也开始面向 recall profile 迁移
- runtime 却仍主要按布尔值或简化参数逻辑执行

这会带来两个问题：

- 配置越接近最终设计，运行时越可能退化为“只消费 enabled，不消费具体语义”
- DSL/compiler 层先先进化，但 runtime fidelity 跟不上，导致设计闭环中断

---

## 6. 完成度评估

### 6.1 按能力分层评估

- 配置解析层：**部分完成**
- Recall Runtime 骨架：**部分完成且已可运行**
- Projection 层：**大体完成**
- Canonical route：**已完成**
- 兼容旧接口统一投影：**未完成**
- MCP surface：**部分完成，但存在契约断裂**
- OpenAPI / governance / client surface：**未完成**
- DSL compiler：**完成度较高**
- Migration script：**部分完成**
- 测试资产：**总体较好，但阶段预期未完全同步**

### 6.2 两种口径下的完成度

- 按“Recall Profile 原型是否成立”评估：**约 70%**
- 按“最终设计是否已可对外发布”评估：**约 45%**

差异之所以这么大，主要不是因为代码量不够，而是因为设计稿强调的是“统一语义收口 + 对外契约完整 + 配置模型最终化”，而这三件事恰恰是当前最不完整的部分。

---

## 7. 主要风险

### 7.1 对外声明与实际能力不一致

`gateway_recall_run` 已在 descriptor 中出现，但未在 adapter 中可执行。这会直接造成调用侧误判能力状态。

### 7.2 存在多套 recall 入口并行演进的风险

如果 `memory/search`、`context/assemble` 和 `recall/run` 继续分别维护自己的检索逻辑，后续会越来越难收敛成统一 recall semantics。

### 7.3 配置与运行时语义继续分叉

如果 DSL/compiler 和 runtime 长期不对齐，后续会出现“配置能表达，运行时不真正支持”的伪能力累积。

### 7.4 测试口径可能继续滞后于实现阶段

当前已有 3 个失败用例反映测试仍按旧阶段断言。如果不及时收敛，会让后续评审越来越难区分“真实缺陷”和“测试口径滞后”。

---

## 8. 建议优先级

### 第一优先级：补齐对外契约断裂

建议首先完成以下事项：

1. 在 `mcpAdapter` 中真正接通 `gateway_recall_run`
2. 将 `/agent_gateway/recall/run` 纳入 published paths
3. 将 `/agent_gateway/recall/run` 纳入 published OpenAPI
4. 在 `GatewayBackendClient` 中补充 `runRecall(...)`
5. 为以上路径补充 contract tests / adapter tests

原因很简单：这些问题已经影响“功能是否能被正式、安全地对外使用”，优先级最高。

### 第二优先级：完成统一 Recall Runtime 收口

建议：

1. 让 `memory/search` 与 `context/assemble` 消费统一 `RecallResult`
2. 通过 projection service 生成各自兼容输出
3. 避免继续让旧接口直接维护独立 recall 主逻辑

这一步完成后，设计稿中的“投影分离”原则才算真正成立。

### 第三优先级：重构配置模型到最终稿

建议：

1. 将配置提升为 `agents + profiles` 的最终结构
2. 引入 `allowedProfiles`
3. 引入 `targets`、`aggregate`、`kMultiplier`
4. 引入 `projection` 与 `merge`
5. 增加 profile metadata 字段

这一步完成后，Recall Profile 才真正从“样例配置”变成“稳定契约”。

### 第四优先级：修复 runtime 语义保真度

建议：

1. 为 `full_text` / `gated_full_text` 提供真实全文路径
2. 让结构化 modifiers 被真正消费
3. 引入 profile 级 merge policy
4. 对齐 DSL/compiler 输出与 runtime 语义

### 第五优先级：清理测试阶段错位

建议：

1. 更新 S01/S02 中关于 modifier 数量与 pipeline 的旧断言
2. 增加 MCP `gateway_recall_run` 的 adapter tests
3. 增加 published contract parity tests
4. 增加 `memory/search` / `context/assemble` 与 `recall/run` 的语义一致性测试

---

## 9. 最终判断

最终判断如下：

- 如果问题是“Recall Profile 方案是否已经在 `agentGateway` 中形成可运行原型？”：**是。**
- 如果问题是“当前实现是否已经符合最终设计稿？”：**否。**
- 如果问题是“当前最接近完成的是哪一层？”：**Native route、projection service、runtime 基础骨架。**
- 如果问题是“当前最大缺口是什么？”：**MCP/Published contract 未闭环、旧接口尚未统一投影、配置模型不是最终稿、runtime 语义保真度不足。**

一句话总结：

**这轮实现已经把 Recall Profile 从设计稿推进到了“可运行骨架”阶段，但还没有进入“统一语义、统一契约、统一配置模型”的最终完成态。**
