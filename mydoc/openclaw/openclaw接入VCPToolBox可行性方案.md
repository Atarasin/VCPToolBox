# OpenClaw 接入 VCPToolBox 可行性方案

## 1. 目标

目标不是“让 OpenClaw 间接调用一个外部脚本”，而是让它以尽量原生的方式获得：

- VCPToolBox 现有插件能力
- VCP 的记忆 / RAG 检索能力
- 未来可扩展的上下文注入、自动回忆、权限控制与审计能力

这里的“原生”建议拆成三层理解：

1. **工具层原生**：VCP 插件在 OpenClaw 中表现为真正的 tools，而不是让模型手写某种 VCP 专用协议文本
2. **记忆层原生**：VCP 的日记 / RAG 能进入 OpenClaw 的 memory 或 context engine 生命周期，而不是退化成普通搜索插件
3. **运维层原生**：启停、发现、鉴权、审计、错误处理符合 OpenClaw 插件体系与 Gateway 运行方式

结论先行：

- **可行**
- **最优路线不是“把 VCPToolBox 整个嵌进 OpenClaw 进程”**
- **最推荐路线是：OpenClaw 原生插件 + VCP 机器接口桥接层 + 可选的 OpenClaw memory/context engine 适配**

---

## 2. 现状基线

### 2.1 VCPToolBox 现状

从当前代码看，VCP 已经具备一个很适合被桥接的统一运行时。

- VCP 插件体系由 `plugin-manifest.json` 驱动，支持 `static`、`synchronous`、`asynchronous`、`service`、`messagePreprocessor`、`hybridservice` 六类插件  
  参考：[PLUGIN_ECOSYSTEM.md:L24-L60](file:///home/zh/projects/VCP/VCPToolBox/docs/PLUGIN_ECOSYSTEM.md#L24-L60)
- `hybridservice` 可以同时具备 `processMessages`、`processToolCall` 与占位符能力，是最适合承载“记忆 + 工具”桥接的类型  
  参考：[PLUGIN_ECOSYSTEM.md:L348-L408](file:///home/zh/projects/VCP/VCPToolBox/docs/PLUGIN_ECOSYSTEM.md#L348-L408)
- 对外工具执行最终统一收敛到 `PluginManager.processToolCall()`，内部已经透明处理本地、混合服务、分布式工具三类调用  
  参考：[Plugin.js:L778-L852](file:///home/zh/projects/VCP/VCPToolBox/Plugin.js#L778-L852)
- 服务器已有一个“人工工具调用入口” `POST /v1/human/tool`，但它现在接收的是 VCP 特有文本协议，不适合直接作为 OpenClaw 的正式机器接口  
  参考：[server.js:L888-L954](file:///home/zh/projects/VCP/VCPToolBox/server.js#L888-L954)
- 管理面板已有插件清单接口 `GET /admin_api/plugins`，可以复用来做能力发现  
  参考：[adminPanelRoutes.js:L380-L462](file:///home/zh/projects/VCP/VCPToolBox/routes/adminPanelRoutes.js#L380-L462)

### 2.2 VCP 记忆 / RAG 现状

- `RAGDiaryPlugin` 当前核心定位是 **消息预处理 + 系统提示词占位符注入**
- 它已经支持四种日记调用模式：`{{}}`、`[[]]`、`<<>>`、`《《》》`
- 真正的底层检索能力依赖 `KnowledgeBaseManager.search(...)`

关键事实：

- `RAGDiaryPlugin` 当前主要通过 `processMessages` 处理 system 消息中的占位符，而不是一个现成的“外部 JSON RAG API”  
  参考：[RAGDiaryPlugin.js:L1014-L1046](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L1014-L1046)、[RAGDiaryPlugin.js:L1267-L1283](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L1267-L1283)
- 统一 RAG 占位符处理收敛到 `_processRAGPlaceholder()`  
  参考：[RAGDiaryPlugin.js:L2177-L2214](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L2177-L2214)
- 底层知识库管理器已经有统一搜索接口 `KnowledgeBaseManager.search(...)`，这意味着“抽一个稳定的机器检索桥”在工程上是可行的  
  参考：[KnowledgeBaseManager.js:L314-L354](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L314-L354)

### 2.3 OpenClaw 现状

根据 OpenClaw 官方文档，OpenClaw 已经提供三种与本项目高度相关的原生扩展点：

- **Native Plugin**：可注册 tool / service / HTTP route / hook
- **Memory Slot**：可替换 active memory plugin
- **Context Engine Slot**：可替换上下文装配与 compaction 生命周期

相关文档：

- OpenClaw 插件体系与 `registerTool` / `registerContextEngine` / `registerService`：<https://docs.openclaw.ai/tools/plugin>
- OpenClaw Gateway 支持 `/v1/models`、`/v1/embeddings`、`/v1/chat/completions`、`/v1/responses`：<https://docs.openclaw.ai/gateway>
- OpenClaw Memory 概念与 memory plugin：<https://docs.openclaw.ai/concepts/memory>
- OpenClaw Context Engine 生命周期：<https://docs.openclaw.ai/concepts/context-engine>

这意味着从 OpenClaw 侧看，VCP 接入至少有三条路：

1. 注册为 OpenClaw tools
2. 注册为 OpenClaw memory 插件
3. 注册为 OpenClaw context engine

---

## 3. 核心难点

### 3.1 工具调用协议不匹配

VCP 内部已经有统一工具调用总线，但对外公开入口 `POST /v1/human/tool` 仍然是面向 VCP 指令文本协议，而 OpenClaw 原生 tool 更适合 JSON schema。

这意味着：

- **内部执行层已经够好**
- **外层机器接口还不够标准**

所以不应该重做插件执行，只需要在 `processToolCall()` 外面补一层稳定 JSON Bridge。

### 3.2 RAG 当前更像“上下文预处理器”，不是“独立 memory 服务”

现在的 VCP 记忆能力主要依托：

- system prompt 占位符
- `processMessages`
- `KnowledgeBaseManager.search`

因此如果想让 OpenClaw “原生拥有 VCP 记忆”，不能只包装现有占位符语法，还需要把下面两层抽出来：

1. **机器可调用的检索接口**
2. **可嵌入 OpenClaw assemble / memory_search 生命周期的适配层**

### 3.3 插件类型并不全都适合直接映射为 OpenClaw tool

VCP 六类插件里，真正天然适合映射到 OpenClaw tool 的主要是：

- `synchronous`
- `asynchronous`
- 带 `processToolCall` 的 `hybridservice`
- 分布式工具

而下面这些更适合映射成别的能力：

- `messagePreprocessor` → 更适合 context engine / hook
- `static` → 更适合 system prompt addition / context injection
- `service` → 更适合后台服务或 HTTP route

### 3.4 不推荐直接在 OpenClaw 插件里 `require()` VCP 内部模块

原因：

- VCP 当前运行时依赖 `server.js` 注入 `pluginManager`、`knowledgeBaseManager`、`webSocketServer`
- `Plugin.js` 与 `KnowledgeBaseManager.js` 都有较强启动顺序与生命周期耦合
- OpenClaw 插件是自己的宿主进程和生命周期

因此“同进程嵌入”会遇到：

- 初始化顺序复杂
- 配置来源冲突
- 热重载边界模糊
- 审计与稳定性变差

所以建议采用：

- **逻辑复用内部总线**
- **进程边界保持清晰**
- **通过本机 HTTP / localhost 或 Unix Socket 桥接**

---

## 4. 三种可行方案

## 4.1 方案 A：工具桥接方案

### 定义

做一个 OpenClaw native plugin，只负责把 VCP 的可调用插件暴露成 OpenClaw tools。

调用路径：

`OpenClaw tool` → `OpenClaw VCP plugin` → `VCP JSON Bridge API` → `PluginManager.processToolCall()`

### 优点

- 落地最快
- 几乎不动 VCP 核心执行层
- 现有同步、异步、分布式、hybridservice 工具都能复用
- 失败隔离好，OpenClaw 与 VCP 进程边界清晰

### 缺点

- 只解决“工具原生”，没有真正解决“记忆原生”
- `RAGDiaryPlugin` 仍然只能退化为一个或多个搜索工具
- 自动回忆、上下文拼装、记忆写回体验一般

### 适用场景

- 先打通插件能力
- 希望尽快让 OpenClaw 使用 VCP 现有工具库
- 记忆能力暂时接受“工具式召回”

### 可行性评估

- **高**

这是最稳妥的第一阶段。

---

## 4.2 方案 B：原生工具 + 原生记忆双桥接方案

### 定义

OpenClaw 侧提供一个完整插件包，内部包含三个子模块：

1. `tool adapter`：把 VCP 插件暴露成 OpenClaw tools
2. `memory adapter`：把 VCP 日记 / RAG 暴露成 OpenClaw memory_search / memory_get / memory write 能力
3. `context adapter`：在每轮 assemble 时调用 VCP 做主动召回，把结果注入 `systemPromptAddition`

### 调用路径

#### 工具调用

`OpenClaw tool` → `OpenClaw VCP plugin` → `VCP tool bridge` → `PluginManager.processToolCall()`

#### 记忆搜索

`OpenClaw memory_search` → `OpenClaw VCP memory plugin` → `VCP rag/search API` → `KnowledgeBaseManager.search(...)`

#### 自动回忆

`OpenClaw contextEngine.assemble()` → `VCP rag/context API` → 返回 recall blocks → 注入 `systemPromptAddition`

### 优点

- 满足“原生工具 + 原生记忆”的核心目标
- 用户体验最接近“OpenClaw 自带 VCP 大脑”
- 能复用 VCP 的时间感知、语义组、Rerank、TagMemo 等检索特性
- 工具与记忆走统一桥接，后续好维护

### 缺点

- 需要补出稳定的 VCP 机器接口
- 需要做 agent ↔ diary / knowledge-base 映射策略
- 需要额外处理记忆写回一致性

### 可行性评估

- **很高**
- **推荐作为正式方案**

---

## 4.3 方案 C：VCP 侧做 MCP / 标准协议服务器

### 定义

由 VCPToolBox 侧直接暴露一个 MCP Server 或等价标准协议层，OpenClaw 通过自己的 MCP 能力接入。

### 优点

- 标准化程度高
- 不止 OpenClaw，其他支持 MCP 的客户端也能接入
- 生态扩展性最好

### 缺点

- 只能天然解决“工具标准化”，对“自动记忆 / context engine 深度集成”帮助有限
- 仍需要额外设计 memory 与 context engine 适配
- 落地成本高于方案 A

### 可行性评估

- **中高**
- 适合作为第二阶段生态扩展，而不是第一优先级

---

## 5. 推荐方案

推荐采用：

**方案 B：OpenClaw 原生插件 + VCP JSON Bridge + VCP Memory / Context 适配**

原因：

- 方案 A 只能解决一半目标
- 方案 C 标准化很好，但不直接等于“OpenClaw 原生记忆体验”
- 方案 B 可以先用 A 的方式快速打通工具，再平滑演进到记忆与上下文层

一句话概括：

**OpenClaw 负责“宿主体验与原生生命周期”，VCPToolBox 负责“工具执行与记忆检索能力内核”。**

---

## 6. 推荐架构设计

## 6.1 VCP 侧新增机器桥接层

建议新增一组专门给 OpenClaw 使用的 JSON 接口，不直接复用 `/v1/human/tool`。

推荐接口：

### 1. 能力发现

`GET /admin_api/openclaw/capabilities`

返回内容建议包含：

- 当前服务器信息
- 所有可桥接插件列表
- 每个插件的 schema、类型、是否需要审批、是否分布式
- 可用知识库 / 日记本列表
- 支持的 RAG 特性：`time`、`group`、`rerank`、`tagmemo`、`aimemo`

### 2. 工具调用

`POST /admin_api/openclaw/tools/:toolName`

请求体建议直接使用 JSON：

```json
{
  "args": {
    "maid": "Nova",
    "query": "关于上次A项目会议的讨论内容"
  },
  "requestContext": {
    "source": "openclaw",
    "sessionId": "sess_xxx",
    "agentId": "default"
  }
}
```

内部直接调用：

- `pluginManager.processToolCall(toolName, args, requestIp)`

### 3. RAG 搜索

`POST /admin_api/openclaw/rag/search`

建议支持字段：

- `diary`
- `query`
- `k`
- `mode`
- `timeAware`
- `groupAware`
- `rerank`
- `tagMemo`
- `maid`

内部优先直接桥接：

- `KnowledgeBaseManager.search(...)`

而不是要求 OpenClaw 拼接 VCP 占位符语法再走 `processMessages`。

### 4. 上下文召回

`POST /admin_api/openclaw/rag/context`

作用：

- 输入最近 user / assistant 消息
- 由 VCP 输出一组“适合注入上下文”的 recall blocks
- 可附带来源 diary、score、time tag、group hit 等 metadata

这个接口用于给 OpenClaw context engine 的 `assemble()` 使用。

### 5. 记忆写回

`POST /admin_api/openclaw/memory/write`

作用：

- 将 OpenClaw 想持久化的记忆写入 VCP 日记体系
- 可选写入 `DailyNoteWrite` / `DailyNoteEdit`
- 保持 VCP 向量索引自动增量同步

---

## 6.2 OpenClaw 侧插件结构

建议做成一个 OpenClaw native plugin，例如：

- `@vcp/openclaw-vcptoolbox`

内部拆分为五个模块：

### 1. `VcpClient`

职责：

- 负责与 VCP JSON Bridge 通信
- 处理鉴权、重试、超时、错误码映射
- 维护 capabilities 缓存

### 2. `VcpToolRegistry`

职责：

- 从 `/admin_api/openclaw/capabilities` 读取插件列表
- 将 VCP manifest / capability 信息转换为 OpenClaw `registerTool()` 所需 schema
- 对需要审批的工具加安全标签

### 3. `VcpMemoryPlugin`

职责：

- 实现 OpenClaw memory slot
- 把 `memory_search` 映射到 VCP 的 `rag/search`
- 把 `memory_get` 映射到 VCP 日记文件读取 / 片段读取
- 把持久化写入映射到 `memory/write`

### 4. `VcpContextEngine`

职责：

- 在 `assemble()` 时调用 `/rag/context`
- 把召回结果注入 `systemPromptAddition`
- 根据 token budget 控制注入量
- 可选接管 compaction 后的回忆再检索逻辑

### 5. `VcpPolicyGuard`

职责：

- 工具白名单 / 黑名单
- 高危工具审批映射
- 日记库访问范围控制
- 审计事件上报

---

## 6.3 插件类型映射策略

| VCP 插件类型 | OpenClaw 映射方式 | 建议 |
|---|---|---|
| synchronous | tool | 直接桥接 |
| asynchronous | tool + job polling | 直接桥接 |
| hybridservice(processToolCall) | tool | 直接桥接 |
| hybridservice(processMessages) | context engine / hook | 选择性桥接 |
| messagePreprocessor | context engine / hook | 不建议直接映射为 tool |
| static | systemPromptAddition / lazy read tool | 视内容决定 |
| service | background service / http route | 不直接映射为 tool |
| distributed | tool | 由 VCP 内部透明转发 |

结论：

- **真正原生的入口应分为 tool、memory、context 三类**
- 不应该强行把所有能力都压扁成 tool

---

## 7. 为什么不建议直接复刻 VCP 占位符语法到 OpenClaw

理论上可以让 OpenClaw 生成：

- `[[角色日记本]]`
- `《《角色日记本::Time::Group》》`

然后转发到 VCP 的消息预处理链。

但这条路不推荐作为主方案，原因是：

1. **模型必须学习一套 VCP 专用 DSL**
2. **对 OpenClaw 来说，这不是“原生记忆”，而是“提示词技巧”**
3. **可观测性差，难以控制 token 消耗**
4. **后续很难与 OpenClaw memory / context engine 生命周期融合**

更好的做法是：

- 把 DSL 背后的能力拆成结构化 JSON 接口
- 让 OpenClaw 决定在什么生命周期调用
- 让 VCP 只负责能力执行

---

## 8. 推荐落地顺序

## 8.1 Phase 1：工具桥打通

目标：

- OpenClaw 可以列出并调用 VCP 插件

VCP 侧工作：

- 新增 `/admin_api/openclaw/capabilities`
- 新增 `/admin_api/openclaw/tools/:toolName`
- 从 `plugin-manifest.json` 衍生 JSON schema

OpenClaw 侧工作：

- 做 `VcpClient`
- 做 `VcpToolRegistry`
- 将 VCP 工具注册为 OpenClaw tools

验收标准：

- OpenClaw 能调用 3~5 个代表性插件
- 同步、异步、hybridservice、distributed 至少各验证 1 个

## 8.2 Phase 2：记忆检索桥

目标：

- OpenClaw 能通过原生 memory_search 使用 VCP 日记 RAG

VCP 侧工作：

- 新增 `/admin_api/openclaw/rag/search`
- 暴露 diary / knowledge-base 列表
- 提供检索 metadata

OpenClaw 侧工作：

- 实现 `VcpMemoryPlugin`
- 做 agent ↔ diary 映射配置

验收标准：

- `memory_search` 可以命中指定 diary
- 支持 `time/group/rerank/tagmemo` 基本参数
- 支持空结果、超时、无权限等错误分支

## 8.3 Phase 3：自动上下文召回

目标：

- OpenClaw 在 assemble 阶段自动获得 VCP recall blocks

VCP 侧工作：

- 新增 `/admin_api/openclaw/rag/context`
- 输出适合直接注入的 recall block

OpenClaw 侧工作：

- 实现 `VcpContextEngine`
- 控制 token budget、召回阈值、频率

验收标准：

- 对用户无感完成自动回忆
- 注入块可追踪来源
- 不明显放大上下文污染

## 8.4 Phase 4：写回与双向记忆

目标：

- OpenClaw 写入的 durable memory 同步进入 VCP 日记知识库

VCP 侧工作：

- 新增 `/admin_api/openclaw/memory/write`
- 与 `DailyNoteWrite` / `DailyNoteEdit` 对齐

OpenClaw 侧工作：

- 将 memory flush / durable memory 写回 VCP
- 可选保留本地 Markdown 镜像

验收标准：

- 写回后可被 VCP 索引
- 下一轮检索可召回
- 支持幂等与去重

---

## 9. 建议新增的 VCP 适配抽象

为了避免 OpenClaw 接口直接绑定 `RAGDiaryPlugin` 的占位符细节，建议在 VCP 内部补一个新的抽象层：

- `OpenClawBridgeService`

建议职责：

- 插件能力导出
- 参数 schema 导出
- 工具调用代理
- RAG 检索代理
- 记忆写回代理
- 审计日志与审批联动

建议实现方式：

- 插件类型：`hybridservice`
- 原因：同时支持 API route、`processToolCall`、必要时也能利用 `processMessages`

这样做的好处是：

- 不污染 `server.js` 主入口太多
- 与 VCP 现有插件生态一致
- 后续如果要对接 MCP，也可以复用这层桥

---

## 10. 安全与权限设计

OpenClaw 接入后，安全边界会比当前更敏感，必须在方案里前置。

### 10.1 工具权限

建议为能力导出增加三层控制：

1. 插件级白名单
2. 参数级约束
3. 高危工具审批继承

当前 VCP 已有工具审批机制，可以沿用  
参考：[Plugin.js:L732-L776](file:///home/zh/projects/VCP/VCPToolBox/Plugin.js#L732-L776)

### 10.2 日记权限

建议至少支持：

- 仅允许访问指定 diary 前缀
- 按 OpenClaw agent 映射 diary 范围
- 对跨角色日记访问单独加开关

### 10.3 审计

建议统一记录：

- OpenClaw agentId
- sessionId
- 调用的 VCP plugin / diary
- 输入参数摘要
- 执行耗时
- 命中分布式节点与否

---

## 11. 测试与验证方案

虽然当前阶段还是设计，但建议从第一天就按“桥接系统”来设计验证面。

## 11.1 接口级测试

对 VCP 新增桥接接口做自动化验证：

- `capabilities` 返回结构完整
- tool schema 可被 OpenClaw 正常注册
- tool 调用的成功 / 失败 / 超时 / 无权限分支正确
- RAG search 在有结果、无结果、非法 diary 下行为稳定

## 11.2 集成级测试

建议选 4 类代表性能力做端到端测试：

1. 普通同步工具
2. 异步工具
3. hybridservice 工具
4. RAG 记忆检索

## 11.3 体验级测试

重点验证三件事：

1. OpenClaw 是否真的把 VCP 工具当成原生 tool 使用
2. OpenClaw 是否能在不显式“调用搜索插件”的情况下自动获得回忆
3. 写回的记忆是否能在后续轮次稳定召回

---

## 12. MVP 建议

如果只做一个最小可用版本，建议包含以下内容：

### MVP-1

- OpenClaw native plugin
- VCP capabilities API
- VCP tool invoke API
- 先桥接 5 个代表性插件

### MVP-2

- 增加 `rag/search`
- 增加 diary 映射
- 在 OpenClaw 中接成 memory_search

### MVP-3

- 增加 `rag/context`
- 做自动回忆注入

这三步完成后，已经能达到“OpenClaw 原生使用 VCPToolBox 插件与记忆”的核心目标。

---

## 13. 最终建议

最终建议明确如下：

### 13.1 结论

- **可行**
- **推荐做**
- **推荐从工具桥开始，但正式目标应是工具 + memory + context 三层一体化**

### 13.2 具体推荐路线

优先级从高到低：

1. **VCP 新增标准 JSON Bridge**
2. **OpenClaw native plugin 映射 VCP tools**
3. **VCP RAG search 抽象为机器接口**
4. **OpenClaw memory plugin 接入 VCP 日记检索**
5. **OpenClaw context engine 接入 VCP 自动回忆**
6. **最后再考虑 MCP 标准化对外输出**

### 13.3 不推荐路线

- 不推荐让 OpenClaw 直接学习 VCP DSL 作为主接入方式
- 不推荐在 OpenClaw 内直接 require VCP 内部模块
- 不推荐把所有 VCP 能力都压成普通 tool

---

## 14. 附：本方案引用的关键代码定位

- VCP 插件类型与能力契约：  
  [PLUGIN_ECOSYSTEM.md:L24-L60](file:///home/zh/projects/VCP/VCPToolBox/docs/PLUGIN_ECOSYSTEM.md#L24-L60)  
  [PLUGIN_ECOSYSTEM.md:L348-L408](file:///home/zh/projects/VCP/VCPToolBox/docs/PLUGIN_ECOSYSTEM.md#L348-L408)
- VCP 统一工具执行入口：  
  [Plugin.js:L778-L852](file:///home/zh/projects/VCP/VCPToolBox/Plugin.js#L778-L852)
- 当前人工工具入口：  
  [server.js:L888-L954](file:///home/zh/projects/VCP/VCPToolBox/server.js#L888-L954)
- 管理面板插件发现接口：  
  [adminPanelRoutes.js:L380-L462](file:///home/zh/projects/VCP/VCPToolBox/routes/adminPanelRoutes.js#L380-L462)
- RAGDiaryPlugin 占位符处理入口：  
  [RAGDiaryPlugin.js:L1014-L1046](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L1014-L1046)  
  [RAGDiaryPlugin.js:L1267-L1283](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L1267-L1283)  
  [RAGDiaryPlugin.js:L2177-L2214](file:///home/zh/projects/VCP/VCPToolBox/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js#L2177-L2214)
- KnowledgeBaseManager 检索入口：  
  [KnowledgeBaseManager.js:L314-L354](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L314-L354)
