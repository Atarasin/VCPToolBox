# 方案B实施路径（OpenClaw 原生工具 + 原生记忆双桥接）

## 1. 实施目标与完成定义

基于既有方案B，本实施路径聚焦一个明确终态：

- OpenClaw 可把 VCPToolBox 能力当作**原生 tools**使用
- OpenClaw 可把 VCP 日记/RAG 当作**原生 memory 能力**使用
- OpenClaw 可在上下文装配阶段自动调用 VCP 回忆能力，实现**自动记忆注入**

完成定义（Definition of Done）：

1. OpenClaw 侧可动态发现并注册 VCP 工具
2. 至少覆盖同步工具、异步工具、hybridservice 工具、分布式工具四类调用
3. OpenClaw `memory_search` 能调用 VCP RAG 检索并返回结构化结果
4. OpenClaw context engine 在 assemble 阶段可按策略注入 VCP recall blocks
5. 全链路具备鉴权、审计、限权、错误分级与回退策略

---

## 2. 实施边界与约束

### 2.1 范围内

- VCP 侧新增 OpenClaw 专用 JSON Bridge 接口
- OpenClaw 侧开发 native plugin（工具层 + 记忆层 + 上下文层）
- 双侧联调、契约测试、集成测试、体验验证

### 2.2 范围外

- 不在本阶段重构 VCP 全部插件架构
- 不在本阶段全面改造 RAGDiaryPlugin DSL 语法
- 不在本阶段推进 MCP 通用化对接（可作为后续扩展）

### 2.3 必守原则

- 不绕开 `PluginManager.processToolCall()` 另建工具执行主通道
- 不在 OpenClaw 插件内直接 require VCP 内部运行时模块
- 所有跨系统交互必须通过稳定 JSON 接口与明确契约版本

---

## 3. 目标架构（实施态）

调用分三条主链路：

1. **工具链路**  
   OpenClaw Tool -> OpenClaw VCP Plugin -> VCP Bridge `/tools/:toolName` -> `PluginManager.processToolCall()`

2. **记忆检索链路**  
   OpenClaw `memory_search` -> OpenClaw VCP Memory Adapter -> VCP Bridge `/rag/search` -> `KnowledgeBaseManager.search(...)`

3. **自动回忆链路**  
   OpenClaw ContextEngine `assemble()` -> VCP Bridge `/rag/context` -> Recall Blocks -> `systemPromptAddition`

---

## 4. 分阶段实施路径

## Phase 0：契约冻结与样板工程

### 目标

- 明确 API 契约、错误码体系、鉴权方式、版本管理方式

### VCP 侧动作

1. 定义 OpenClaw Bridge 命名空间：`/admin_api/openclaw/*`
2. 确定统一响应结构：
   - 成功：`{ success: true, data, meta }`
   - 失败：`{ success: false, error, code, details, requestId }`
3. 增加 `x-openclaw-bridge-version`（如 `v1`）响应头
4. 增加请求追踪字段：`requestId`、`source`、`sessionId`、`agentId`

### OpenClaw 侧动作

1. 建立插件仓库骨架（建议模块）：
   - `client/`：VcpClient
   - `tools/`：VcpToolRegistry
   - `memory/`：VcpMemoryAdapter
   - `context/`：VcpContextEngine
   - `policy/`：VcpPolicyGuard
2. 建立配置 schema：
   - `vcp.baseUrl`
   - `vcp.auth`
   - `vcp.toolAllowList/toolDenyList`
   - `vcp.diaryMap`
   - `vcp.recallPolicy`

### 验收标准

- 契约文档冻结
- OpenClaw 插件可启动并完成健康检查请求

---

## Phase 1：工具桥接最小闭环

### 目标

- 打通 OpenClaw -> VCP 插件工具调用闭环

### VCP 侧动作

1. 新增 `GET /admin_api/openclaw/capabilities`
   - 输出可桥接工具列表
   - 输出参数 schema（从 manifest + 运行时规则映射）
   - 输出工具元信息：插件类型、是否分布式、是否审批、超时策略
2. 新增 `POST /admin_api/openclaw/tools/:toolName`
   - 入参：`args`, `requestContext`
   - 内部调用：`pluginManager.processToolCall(toolName, args, requestIp)`
3. 增加错误码分层：
   - `OCW_TOOL_NOT_FOUND`
   - `OCW_TOOL_APPROVAL_REQUIRED`
   - `OCW_TOOL_TIMEOUT`
   - `OCW_TOOL_EXECUTION_ERROR`
4. 增加审计事件日志（调用前后）

### OpenClaw 侧动作

1. 实现 `VcpClient`（鉴权、重试、超时、错误映射）
2. 实现 `VcpToolRegistry`
   - 启动时加载 capabilities
   - 转换为 `registerTool()` 所需 schema
   - 动态注册工具
3. 实现工具调用代理：
   - tool handler -> `/tools/:toolName`
   - 将错误转换成 OpenClaw 可读错误对象

### 测试验证

1. 契约测试
   - capabilities 字段完整性
   - tool invoke 请求体/响应体结构校验
2. 集成测试（至少 4 类）
   - 同步工具
   - 异步工具
   - hybridservice 工具
   - 分布式工具
3. 异常测试
   - 不存在工具
   - 审批拒绝
   - 执行超时
   - 插件内部错误

### 验收标准

- OpenClaw 可稳定调用多类 VCP 工具
- 工具错误可被 OpenClaw 明确识别与反馈

---

## Phase 2：记忆检索桥接（memory_search）

### 目标

- 将 VCP RAG 检索接入 OpenClaw memory 生命周期

### VCP 侧动作

1. 新增 `POST /admin_api/openclaw/rag/search`
   - 入参：
     - `query`
     - `diary`（可选）
     - `k`
     - `mode`
     - `timeAware/groupAware/rerank/tagMemo`
     - `maid`
   - 出参：
     - `items[]`（text, score, sourceDiary, sourceFile, timestamp, tags）
     - `diagnostics`（耗时、命中数、策略）
2. 新增 `GET /admin_api/openclaw/rag/targets`
   - 返回可访问 diary/knowledge-base 列表
3. 权限控制
   - 按 agentId 限制 diary 范围
   - 可配置跨角色访问开关

### OpenClaw 侧动作

1. 实现 `VcpMemoryAdapter`
   - `memory_search` -> `/rag/search`
   - `memory_get` -> diary 片段读取接口（可后续追加）
2. 实现 diary 映射策略
   - `agentId -> diary[]`
   - 默认 diary fallback
3. 实现结果规范化
   - 映射为 OpenClaw memory tool 期望格式

### 测试验证

1. 检索正确性测试
   - 命中相关片段
   - 空结果行为稳定
2. 策略测试
   - `timeAware/groupAware/rerank/tagMemo` 开关组合
3. 权限测试
   - 越权 diary 请求被拒绝

### 验收标准

- OpenClaw 能把 VCP RAG 当作 memory_search 使用
- 权限边界有效

---

## Phase 3：上下文自动召回（ContextEngine）

### 目标

- 让 OpenClaw 在 assemble 阶段自动获得 VCP recall blocks

### VCP 侧动作

1. 新增 `POST /admin_api/openclaw/rag/context`
   - 入参：最近对话片段、tokenBudget、agentId、sessionId、策略参数
   - 出参：
     - `recallBlocks[]`（text + metadata）
     - `estimatedTokens`
     - `appliedPolicy`
2. 增加去重与长度控制
   - 相同片段去重
   - 按 score/token 比排序

### OpenClaw 侧动作

1. 实现 `VcpContextEngine.assemble()`
   - 拉取 recall blocks
   - 注入 `systemPromptAddition`
2. 注入策略
   - 召回阈值
   - 最大注入条数
   - 最大 token 占比
3. 降级策略
   - VCP 不可用时继续使用原上下文流程

### 测试验证

1. 稳定性测试
   - 高并发 assemble 请求
   - 接口慢响应
2. 注入质量测试
   - 相关性
   - 污染率（无关召回比例）
3. 降级测试
   - VCP 断连时不中断 OpenClaw 对话

### 验收标准

- 自动回忆对用户无感生效
- 注入可控且可观测

---

## Phase 4：双向记忆写回与闭环优化

### 目标

- OpenClaw 记忆沉淀可写回 VCP，并被后续检索召回

### VCP 侧动作

1. 新增 `POST /admin_api/openclaw/memory/write`
   - 入参：memory text、tags、target diary、source metadata
2. 与 `DailyNote` 对齐
   - 插件路径：`Plugin/DailyNote`
3. 写回幂等控制
   - 指纹哈希去重
   - 幂等键支持

### OpenClaw 侧动作

1. 在 memory flush 或 durable memory 事件触发写回
2. 增加本地写回队列
   - 重试
   - 死信记录
3. 增加写回结果反馈与追踪

### 测试验证

1. 写回成功路径
2. 重复写回去重
3. 写回后可检索召回
4. 网络抖动下重试行为

### 验收标准

- 形成“检索 -> 推理 -> 写回 -> 再检索”闭环

---

## 5. 接口契约清单（落地用）

最小必需接口：

1. `GET /admin_api/openclaw/capabilities`
2. `POST /admin_api/openclaw/tools/:toolName`
3. `POST /admin_api/openclaw/rag/search`
4. `GET /admin_api/openclaw/rag/targets`
5. `POST /admin_api/openclaw/rag/context`
6. `POST /admin_api/openclaw/memory/write`

建议附加接口：

7. `GET /admin_api/openclaw/health`
8. `GET /admin_api/openclaw/audit/:requestId`

---

## 6. 工作分解结构（WBS）

## 6.1 VCP 侧

1. 路由实现（`routes/adminPanelRoutes.js` 新增 openclaw 命名空间）
2. Bridge 服务实现（建议 `hybridservice`：`OpenClawBridgeService`）
3. 参数 schema 映射器
4. 审批、审计、鉴权联动
5. 单元测试与路由测试

## 6.2 OpenClaw 侧

1. Plugin 入口与配置解析
2. VcpClient（HTTP 客户端 + 错误映射）
3. Tool Registry + 动态注册
4. Memory Adapter
5. Context Engine
6. Policy Guard + 可观测性
7. 集成测试与回归测试

## 6.3 联调侧

1. 契约一致性检查
2. 跨版本兼容验证
3. 压测与故障注入测试
4. 灰度发布与回滚演练

---

## 7. 风险清单与应对

1. **风险：schema 映射不准确导致 tool 参数错配**  
   应对：引入 schema 校验器 + 契约快照测试

2. **风险：RAG 召回量过大导致上下文污染**  
   应对：注入预算、阈值门控、去重、策略开关

3. **风险：跨系统故障放大**  
   应对：超时、重试、熔断、降级（context 不中断）

4. **风险：权限泄漏（越权访问 diary 或高危工具）**  
   应对：agent 范围映射、白名单、审批继承、审计告警

5. **风险：分布式工具链路不稳定**  
   应对：结果追踪 requestId、异步任务状态查询、重放保护

---

## 8. 验收与发布路径

## 8.1 验收分层

1. API 层验收：接口可用、错误可解释、鉴权可控
2. 能力层验收：工具调用、记忆检索、自动召回、记忆写回
3. 体验层验收：对话质量提升、人工干预降低、稳定性达标

## 8.2 发布策略

1. 内部联调环境启用
2. 小范围 agent 灰度
3. 扩大覆盖并观察审计指标
4. 全量启用 + 保留回滚开关

## 8.3 回滚策略

1. OpenClaw 侧可一键禁用 VCP 插件
2. ContextEngine 可切回 legacy
3. Memory Adapter 可切回默认 memory-core
4. VCP Bridge 路由可通过配置开关关闭

---

## 9. 立即执行清单（Next Actions）

按优先级直接执行：

1. 冻结 OpenClaw Bridge v1 契约（字段与错误码）
2. 在 VCP 新增 `/admin_api/openclaw/capabilities` 与 `/tools/:toolName`
3. 在 OpenClaw 实现 VcpClient + ToolRegistry，先打通工具桥
4. 追加 `/rag/search` 并接入 memory_search
5. 追加 `/rag/context` 并接入 ContextEngine assemble
6. 最后落地 `/memory/write`，完成双向记忆闭环

该顺序可确保每一步都具备可验证结果，并且能持续向“原生工具 + 原生记忆”目标收敛。
