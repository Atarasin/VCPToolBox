# VCP Agent Gateway Recall Profile 修正后的最终设计稿

> 文档目标：在现有 `agentGateway` 基线之上，为“外部 agent 只传 `query` 即可使用预置召回策略”提供一份最终设计稿，并明确与 VCP 既有 `RAGDiaryPlugin` 召回能力的复用边界。
>
> 目标读者：继续实现 `agentGateway` 记忆/召回能力的工程师。
>
> 阅读完成后应能执行的动作：按本文给出的配置模型、运行时分层、接口契约和测试计划，开始实现 `Recall Profile` 与统一 `Recall Runtime`。

---

## 1. 结论先行

本设计的最终结论如下：

1. `agentGateway` 不重新发明第二套召回算法，而是以 `RAGDiaryPlugin` 为召回语义来源。
2. `Recall Profile` 不再只是“一组默认参数”，而是“一组可编排的 recall rules”。
3. 单个 `profile` 允许同时包含：
   - 单日记本 rule
   - 多日记本聚合 rule
   - 多条使用不同基础模式和不同修饰符的异构 rule
4. 外部 agent 的主路径调用应简化为“只传 `query`”，而复杂召回方式通过配置文件预置。
5. 现有 `memory/search` 和 `context/assemble` 保持兼容，新增统一的 `recall/run` 作为更上层的 canonical recall 入口。

一句话概括：

**这一版设计不是在 Gateway 再造一个 RAG 系统，而是在 Gateway 之上增加一层可配置、可授权、可投影的 Recall Runtime，把 VCP 已有召回语义收口成稳定对外能力。**

---

## 2. 修正点

本设计相对于初版方案有两个关键修正。

### 2.1 多日记本聚合不重做

VCP 本身已经支持多日记本聚合召回。聚合检索不是本次 Gateway 改造需要重新设计的新能力，而是既有能力的配置化暴露。

因此：

- 多日记本聚合应被视为单条 rule 的一种目标形态
- Gateway 只负责声明、授权、编排和结果投影
- 聚合的具体语义应与现有 VCP 行为保持一致

### 2.2 Profile 是“编排计划”，不是“参数模板”

如果同一 profile 需要让不同日记本使用不同召回方式，那么 profile 就不能只表达一组全局参数，而必须表达一组有顺序的 rule。

因此：

- profile 需要支持多条 rule
- 每条 rule 可以作用于一个 diary 或多个 diary
- 每条 rule 可以拥有不同的基础模式和不同的 modifiers
- 最终结果由 profile 级别的 merge 策略统一收口

---

## 3. 设计目标

本方案要同时满足以下目标：

- 支持外部 agent 默认只传 `query`
- 支持单 profile 下的多 diary 异构召回
- 支持多日记本聚合召回
- 支持 `RAGDiaryPlugin` 中除“元思考链”和“DeepMemo”外的全部召回方式
- 保持现有 `memory/search` 与 `context/assemble` 的向后兼容
- 不把 DSL 继续扩散为长期公共接口
- 让 Native Gateway、MCP、未来其他 adapter 共用同一套 recall 语义

---

## 4. 非目标

本方案明确不做以下事情：

- 不重新实现一套独立于 `RAGDiaryPlugin` 的聚合算法
- 不在第一阶段支持元思考链
- 不在第一阶段支持 DeepMemo 历史对话检索
- 不强制废弃现有显式参数调用方式
- 不要求所有外部调用都改成新接口

---

## 5. 设计原则

### 5.1 语义复用优先

Gateway 应复用 VCP 既有召回语义，而不是长出第二套行为略有不同的召回实现。

### 5.2 核心编排优先

复杂性应收口在共享 Recall Runtime，而不是散落在各个 adapter、OpenAPI schema 或单个 route handler 中。

### 5.3 结构化配置优先

运行时内部只消费结构化 rule。历史 DSL 只作为兼容输入或配置编译来源，不作为长期核心模型。

### 5.4 兼容性优先

显式参数调用路径继续保留。profile 是更简单的默认路径，不是对旧路径的破坏性替代。

### 5.5 投影分离

统一 Recall Runtime 负责执行，`memory/search`、`context/assemble`、未来的其他召回接口只负责从统一结果中取视图。

---

## 6. 术语定义

### 6.1 Recall Profile

一个可命名、可授权、可默认化的召回配置单元。其本质是一组 recall rules 与一组 merge 规则。

### 6.2 Recall Rule

一次召回动作的声明，描述：

- 对哪些 diary 生效
- 是否聚合
- 使用哪种基础模式
- 应用哪些 modifiers
- 结果如何投影

### 6.3 Base Mode

召回的基础执行路径。支持四类：

- `full_text`
- `rag`
- `gated_full_text`
- `gated_rag`

### 6.4 Modifiers

叠加在基础模式之上的高级修饰符。包括：

- `time`
- `group`
- `rerank`
- `timeDecay`
- `tagMemo`
- `truncate`
- `aiMemo`
- `roleValve`
- `base64Memo`

### 6.5 Projection

单条 rule 的结果输出目标，如：

- `items`
- `recall_blocks`
- `full_text_sections`
- `attachments`

### 6.6 Merge Policy

profile 级别的统一合并策略，用于对多条 rule 的结果进行去重、排序、截断和预算控制。

---

## 7. 总体架构

建议把召回能力分成四层。

### 7.1 Policy Layer

负责加载并校验 recall profile 配置，解决以下问题：

- 当前 agent 允许使用哪些 profile
- 默认 profile 是哪个
- profile 中引用的 diary 是否在 agent 可访问范围内
- profile 中的 rule 是否合法

### 7.2 Compiler Layer

负责把配置输入编译成统一的内部执行计划。

输入可以是：

- 结构化 profile 配置
- 兼容 DSL 表达式

输出必须是统一的结构化 `Execution Plan`。

### 7.3 Recall Runtime

负责执行 rule：

- 做 `RoleValve` 判定
- 选择 base mode
- 调用 RAG / gated / full text 分支
- 执行 modifiers
- 收集结果与诊断信息

### 7.4 Projection Layer

负责把统一 recall result 投影为不同出口需要的视图：

- `recall/run` 返回完整结果
- `memory/search` 返回 `items`
- `context/assemble` 返回 `recallBlocks`

---

## 8. 配置模型

### 8.1 顶层结构

建议新增独立配置文件，而不是继续把召回策略塞进现有 memory policy 文件。

推荐顶层结构如下：

```json
{
  "agents": {
    "Aemeath": {
      "allowedProfiles": ["aemeath-default"],
      "defaultProfile": "aemeath-default"
    }
  },
  "profiles": {
    "aemeath-default": {
      "description": "爱弥斯默认召回编排",
      "rules": [],
      "merge": {}
    }
  }
}
```

### 8.2 Agent 绑定层

`agents` 仅负责授权与默认值，不负责描述具体召回方式。

建议支持：

- `allowedProfiles`
- `defaultProfile`

后续如有需要，可补充：

- `profileAliases`
- `profileOverrides`

### 8.3 Profile 层

`profile` 至少包括：

- `description`
- `rules`
- `merge`

可选补充：

- `version`
- `tags`
- `metadata`

### 8.4 Rule 层

每条 rule 建议包含以下结构：

```json
{
  "id": "daily-aggregate",
  "targets": {
    "diaries": ["爱弥斯", "爱弥斯的日常日记本"],
    "aggregate": true,
    "kMultiplier": 1.0
  },
  "baseMode": "rag",
  "modifiers": {
    "time": true,
    "group": true,
    "tagMemo": {
      "enabled": true
    }
  },
  "projection": {
    "emit": "recall_blocks"
  }
}
```

### 8.5 Targets 模型

`targets` 的职责是表达 diary 目标与聚合形态。

建议字段：

- `diaries`: diary 名称数组
- `aggregate`: 是否按多日记本聚合语义执行
- `kMultiplier`: 动态 K 乘数

规则如下：

- `aggregate=false` 且 diary 数量为 1：单 diary rule
- `aggregate=true` 且 diary 数量大于 1：原生聚合 rule
- `aggregate=false` 且 diary 数量大于 1：保留给将来的“并行多 diary 非聚合”语义，第一阶段不推荐开放

### 8.6 Base Mode 模型

建议固定为四类：

- `full_text`
- `rag`
- `gated_full_text`
- `gated_rag`

它们分别映射 VCP 的四种基础调用模式：

- `{{日记本}}`
- `[[日记本]]`
- `<<日记本>>`
- `《《日记本》》`

### 8.7 Modifiers 模型

建议按结构化字段表达。

```json
{
  "time": true,
  "group": true,
  "rerank": {
    "enabled": true,
    "rrfAlpha": 0.7
  },
  "timeDecay": {
    "halfLifeDays": 30,
    "minScore": 0.5,
    "whitelistTags": ["box归档"]
  },
  "tagMemo": {
    "enabled": true,
    "weight": 0.3,
    "geodesicRerank": true
  },
  "truncate": {
    "threshold": 0.4
  },
  "aiMemo": {
    "enabled": true,
    "preset": "Default"
  },
  "roleValve": {
    "expression": "@User>=2&@Assistant<5"
  },
  "base64Memo": true
}
```

### 8.8 Projection 模型

建议第一阶段只允许以下输出目标：

- `items`
- `recall_blocks`
- `full_text_sections`
- `attachments`

如果未显式指定：

- `rag` / `gated_rag` 默认投影为 `items`
- `full_text` / `gated_full_text` 默认投影为 `full_text_sections`

### 8.9 Merge 模型

profile 级别的 `merge` 建议支持：

- `dedupe`
- `sort`
- `maxBlocks`
- `tokenBudget`
- `maxTokenRatio`
- `minScore`

示例：

```json
{
  "dedupe": "semantic",
  "sort": "score_desc",
  "maxBlocks": 6,
  "tokenBudget": 1800,
  "maxTokenRatio": 0.5,
  "minScore": 0.3
}
```

---

## 9. 单 Profile 多 Rule 的表达能力

这是本设计的核心。

### 9.1 同构聚合

当多个 diary 共享同一种基础模式和同一组 modifiers 时，应使用一条聚合 rule 表达。

例如：

- `爱弥斯`
- `爱弥斯的日常日记本`

二者都使用：

- `rag`
- `Time`
- `Group`
- `TagMemo`

则表达成一条 `aggregate=true` 的 rule 即可。

### 9.2 异构召回

当不同 diary 需要不同召回方式时，应拆成多条 rule。

例如：

- 一条聚合 rule 负责日常和主日记
- 一条单 diary rule 负责知识日记

最终由 profile 的 merge 策略统一收口。

### 9.3 为什么必须支持多条 Rule

因为只有多条 rule 才能同时表达：

- 聚合与非聚合共存
- `rag` 与 `gated_rag` 共存
- `full_text` 与 `items` 投影共存
- 不同日记本使用不同 modifiers

---

## 10. 召回方式支持矩阵

本方案要求 Gateway 支持 `RAGDiaryPlugin` 中除“元思考链”和“DeepMemo”外的全部召回方式。

### 10.1 基础模式

- `full_text`
- `rag`
- `gated_full_text`
- `gated_rag`

### 10.2 高级修饰符

- `Time`
- `Group`
- `Rerank`
- `Rerank+`
- `TimeDecay`
- `TagMemo`
- `TagMemo+`
- `Truncate`
- `AIMemo`
- `RoleValve`
- `Base64Memo`

### 10.3 多日记本聚合

多日记本聚合由 `targets.aggregate=true` 表达，不另发明新模型。

### 10.4 暂不支持

- 元思考链
- DeepMemo

---

## 11. DSL 与结构化配置的关系

### 11.1 内部模型只认结构化 Rule

Gateway 内部执行计划必须是结构化的，不应让 DSL 继续扩散到运行时核心。

### 11.2 DSL 作为兼容输入层

如果已有历史配置、提示词或迁移脚本依赖 DSL，可在配置加载时编译成 rule。

例如：

```text
[[爱弥斯|爱弥斯的日常日记本::Time::Group::TagMemo]]
```

可编译成：

- `targets.diaries = ["爱弥斯", "爱弥斯的日常日记本"]`
- `targets.aggregate = true`
- `baseMode = "rag"`
- `modifiers.time = true`
- `modifiers.group = true`
- `modifiers.tagMemo.enabled = true`

### 11.3 为什么不把 DSL 暴露成长期外部接口

原因如下：

- 不利于 schema 校验
- 不利于 OpenAPI 与 MCP descriptor 表达
- 不利于未来扩展和精细授权
- 容易把内部召回细节永久暴露给调用方

---

## 12. 运行时分层设计

### 12.1 Recall Policy Resolver

职责：

- 加载 recall 配置
- 处理缓存与热更新
- 校验当前 agent 可访问的 profile
- 解析默认 profile

输出：

- `ResolvedRecallPolicy`

### 12.2 Recall Plan Compiler

职责：

- 把 profile 编译成统一执行计划
- 对非法 base mode、非法 modifier、非法组合进行早期失败
- 把 DSL 编译成结构化 rule

输出：

- `ExecutionPlan`

### 12.3 Recall Runtime Service

职责：

- 执行 plan 中的 rules
- 调用既有 RAG / full text / gated 分支
- 应用 modifiers
- 聚合结果与诊断信息

输出：

- `RecallResult`

### 12.4 Recall Projection Service

职责：

- 把 `RecallResult` 投影为：
  - `memory/search`
  - `context/assemble`
  - `recall/run`

---

## 13. Rule 执行顺序

为避免语义漂移，建议固定如下执行顺序：

1. `RoleValve` 前置判定
2. 解析 targets 与聚合形态
3. 执行 base mode
4. `Time` 与 `Group`
5. `TagMemo`
6. `TimeDecay`
7. `Rerank` / `Rerank+`
8. `Truncate`
9. `AIMemo`
10. `Base64Memo`
11. 投影与 merge

这一顺序的含义如下：

- `RoleValve` 不通过时直接空结果
- `baseMode` 决定主召回路径
- `Time/Group/TagMemo` 属于检索增强阶段
- `TimeDecay/Rerank/Truncate` 属于后处理阶段
- `AIMemo` 属于后置智能汇总阶段
- `Base64Memo` 属于结果抽取阶段

---

## 14. 统一返回结果模型

建议 `RecallResult` 至少包含以下字段：

```json
{
  "items": [],
  "recallBlocks": [],
  "fullTextSections": [],
  "attachments": [],
  "diagnostics": {
    "profile": "aemeath-default",
    "rules": [],
    "durationMs": 0
  }
}
```

### 14.1 Items

用于表达普通 RAG 片段结果。

### 14.2 Recall Blocks

用于表达可直接注入上下文的块结果。

### 14.3 Full Text Sections

用于表达全文注入或 gated 全文注入结果。

### 14.4 Attachments

用于承载 `Base64Memo` 抽取出的附件信息。

### 14.5 Diagnostics

用于记录：

- profile 命中情况
- rule 命中情况
- gated 是否通过
- AIMemo 是否生效
- 被哪些 modifiers 影响
- token 与耗时信息

---

## 15. 对外接口设计

### 15.1 新增统一接口

建议新增 canonical recall 接口：

`POST /agent_gateway/recall/run`

其定位是：

- 作为统一的 profile 驱动召回入口
- 允许调用方默认只传 `query`
- 返回完整 `RecallResult`

### 15.2 最简请求示例

```json
{
  "agentId": "Aemeath",
  "query": "最近讨论过的知识整理和日常事项"
}
```

行为：

- 如果未传 `profile`，使用该 agent 的默认 profile
- 如果也没有默认 profile，则按现有兼容逻辑回退

### 15.3 显式切换 Profile

```json
{
  "agentId": "Aemeath",
  "query": "最近讨论过的知识整理和日常事项",
  "profile": "aemeath-default"
}
```

### 15.4 与现有接口的关系

现有接口继续保留：

- `memory/search`
- `context/assemble`

但建议内部改为基于 `RecallResult` 投影：

- `memory/search` 只取 `items`
- `context/assemble` 只取 `recallBlocks`

### 15.5 MCP 侧能力

MCP 工具建议新增：

- `gateway_recall_run`

同时对现有工具做最小兼容增强：

- `gateway_memory_search` 新增可选 `profile`
- `gateway_context_assemble` 新增可选 `profile`

---

## 16. 参数优先级

为保持兼容，建议采用以下优先级：

1. 显式请求参数
2. 显式传入的 `profile`
3. agent 默认 profile
4. profile 中的 rule 默认值
5. 系统默认值

解释如下：

- 老调用方直接传显式参数时，行为不应被 profile 覆盖
- 新调用方只传 `query` 时，应优先走默认 profile

---

## 17. 鉴权与授权

Recall Profile 不应绕过现有 diary 访问控制。

因此：

- profile 中引用的 diary 必须属于该 agent 的允许 diary 集合
- profile 中引用的 profile 必须属于该 agent 的允许 profile 集合
- 不合法配置应优先在编译阶段失败
- 不要等到实际检索时才部分失败

建议校验顺序：

1. agent 是否存在默认/可用 profile
2. profile 是否存在
3. rule 中 diary 是否都在该 agent 允许范围内
4. modifier 是否合法
5. 组合是否被当前运行时支持

---

## 18. 与现有 Gateway 能力的边界

### 18.1 保留的既有能力

继续保留：

- 原有 `memory/search` 显式参数调用
- 原有 `context/assemble` 显式参数调用
- 现有 agent memory policy
- 现有 diary scope 与 tool scope 约束

### 18.2 新增的核心能力

新增：

- recall profile 配置
- recall rule 编排
- canonical `recall/run`
- result projection

### 18.3 不应出现的重复建设

不要在 Gateway 中重做：

- 聚合召回算法
- 一套新的 TagMemo 解释器
- 一套新的 gated 判定语义
- 一套新的 AIMemo 许可证模型

---

## 19. 推荐实现分期

### 19.1 第一阶段

目标：

- 引入 recall profile 配置
- 引入统一 `recall/run`
- 支持 `rag` 与 `gated_rag`
- 支持聚合 targets
- 支持 `Time`、`Group`、`Rerank`、`TagMemo`、`Truncate`

### 19.2 第二阶段

目标：

- 补 `full_text` 与 `gated_full_text`
- 补 `TimeDecay`
- 补 `RoleValve`
- 补 `Base64Memo`

### 19.3 第三阶段

目标：

- 补 `AIMemo`
- 许可证检查
- 更完整的 diagnostics
- 将 `memory/search` 与 `context/assemble` 全面改造成 projection 模式

### 19.4 第四阶段

目标：

- DSL 配置编译器
- 配置迁移工具
- 更完善的 profile 管理文档与示例

---

## 20. 推荐测试计划

### 20.1 配置与编译测试

- profile 配置加载成功
- 默认 profile 解析成功
- 非法 profile 拒绝
- 非法 diary 引用拒绝
- 非法 modifier 拒绝
- DSL 编译结果正确

### 20.2 Rule 执行测试

- 单 diary `rag`
- 多 diary 聚合 `rag`
- 单 diary `gated_rag`
- `full_text`
- `gated_full_text`

### 20.3 Modifiers 测试

- `Time`
- `Group`
- `Rerank`
- `Rerank+`
- `TimeDecay`
- `TagMemo`
- `TagMemo+`
- `Truncate`
- `RoleValve`
- `AIMemo`
- `Base64Memo`

### 20.4 Projection 测试

- `RecallResult -> items`
- `RecallResult -> recallBlocks`
- `RecallResult -> fullTextSections`
- `RecallResult -> attachments`

### 20.5 兼容性测试

- 老的 `memory/search` 显式参数路径不变
- 老的 `context/assemble` 显式参数路径不变
- 新的 `recall/run` 与 projection 结果一致

### 20.6 集成测试

- 单 profile 多 rule
- 同构聚合 rule
- 异构 diary rule 合并
- token budget 与 maxBlocks 生效
- profile 与 diary scope 联动生效

---

## 21. 推荐文件与模块拆分

建议新增或扩展以下模块职责。

### 21.1 Policy

- recall policy loader
- profile authorization resolver

### 21.2 Compiler

- profile compiler
- DSL compiler
- rule validator

### 21.3 Runtime

- recall runtime service
- gated evaluator
- merge coordinator

### 21.4 Projection

- search projection
- context projection
- full result serializer

### 21.5 Contract

- OpenAPI schema
- MCP descriptor
- response envelope schema

---

## 22. 最终推荐

最终推荐的实现路径如下：

1. 以 `RAGDiaryPlugin` 为召回语义来源
2. 在 Gateway 新增共享 `Recall Runtime`
3. 用 `Recall Profile -> Rules -> Targets/BaseMode/Modifiers/Projection` 作为核心配置模型
4. 用 `recall/run` 作为统一 canonical recall 接口
5. 用 projection 兼容 `memory/search` 与 `context/assemble`

一句话收束：

**修正后的最终方案不是“把复杂参数藏到配置里”，而是“把 VCP 既有召回语义提升成可授权、可默认、可编排、可投影的 Gateway Recall Runtime”。**

---

## 23. 实施前检查清单

开始编码前，建议先确认以下事项：

- 是否确认新增独立 recall policy 配置文件
- 是否确认新增 `recall/run` 作为 canonical 入口
- 是否确认 profile 内部允许多条 rule
- 是否确认聚合 rule 复用既有语义而不是重做
- 是否确认 DSL 只作为兼容输入层
- 是否确认 `memory/search` 与 `context/assemble` 将逐步转为 projection
- 是否确认第一阶段先排除元思考链和 DeepMemo

确认以上事项后，即可进入实现拆分与测试编写阶段。
