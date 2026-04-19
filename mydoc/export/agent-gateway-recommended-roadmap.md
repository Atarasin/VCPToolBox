# VCP Agent Gateway 建议路线图

> 文档目标：基于当前 `agent_gateway` 已完成的 M1-M6 基线，整理后续可行的完善方向，形成一份便于继续排期、起 OpenSpec change、分阶段验收的建议路线图。
>
> 当前判断：`agent_gateway` 已具备 `capabilities / agents / memory / context / tools` 的 Native beta 面，也具备共享 `authContext`、`policy`、`job runtime skeleton` 和 `MCP readiness` 预留，但仍处于“可用、未完全定型”的阶段。

---

## 1. 结论先行

如果后续继续完善 `agent_gateway`，推荐采用下面的总体顺序：

1. **先收口协议与治理，再继续扩展生态接入**
2. **先把 beta 面变成稳定的 canonical contract**
3. **再开放 job、auth、event、MCP 这类扩展能力**
4. **最后补 SDK、配额、观测和对外运营能力**

一句话概括：

**下一阶段最值得做的，不是“再多加几个 endpoint”，而是把现有能力沉淀成真正稳定、可治理、可接入、可演进的 Agent Gateway 平台边界。**

---

## 2. 当前基线

从当前代码状态看，`agent_gateway` 已经具备以下基础：

- 原生路由层已存在：`/agent_gateway/*`
- 共享 service bundle 已存在：能力、agent registry、memory、context、tool runtime 已统一复用
- `authContextResolver`、`agentPolicyResolver`、`toolScopeGuard`、`diaryScopeGuard` 已落地
- `JobRuntimeService` 已有最小骨架，可表达 `accepted`、`waiting_approval`、`poll`、`cancel`
- Native Gateway 与 OpenClaw adapter 已共用同一套核心服务
- 关键链路已有自动化测试覆盖

这意味着后续工作不再是“从零设计”，而是围绕以下四类缺口继续推进：

- **协议缺口**：beta 能用，但契约还没有完全冻结
- **治理缺口**：鉴权仍是过渡态，配额、幂等、审计还不完整
- **运行时缺口**：job/event 语义已有骨架，但没有完整对外接口
- **生态缺口**：MCP、SDK、OpenAPI 总表整合等能力还未正式推出

---

## 3. 设计原则

后续路线建议继续坚持下面几个原则。

### 3.1 先稳定 core，再发展 adapter

Native Gateway 应继续作为 canonical contract。MCP、OpenClaw、未来 SDK 都应该围绕同一套 core service 和统一契约展开，而不是各自长出自己的业务逻辑。

### 3.2 先补治理，再补广度

如果 auth、policy、job、error、幂等、可观测性没有稳定下来，后续无论接 MCP 还是接更多宿主，都会把技术债放大。

### 3.3 资源语义优先

不要把后续能力继续退化成“全是 tool”。`agent`、`memory`、`context`、`job`、`event` 都应该是独立资源对象。

### 3.4 渐进迁移

保持现有 `OpenClaw + Native` 双 adapter 共存，避免通过一次性切换打断现有兼容面。

### 3.5 测试先行

每推进一个阶段，都应优先补对应的 service 或 route 测试，再继续扩展接口和契约。

---

## 4. 推荐总路线

推荐把后续工作拆成 5 个阶段：

1. `M7` 协议收口与独立鉴权
2. `M8` Job / Event Runtime 正式化
3. `M9` Native Gateway GA 与文档/SDK 输出
4. `M10` MCP Adapter 落地
5. `M11` 运营级硬化与生态扩展

推荐关系如下：

```text
M7 Protocol/Auth Stabilization
        |
        v
M8 Job/Event Runtime
        |
        v
M9 Native Gateway GA
        |
        +-------> SDK / OpenAPI / Contract Tests
        |
        v
M10 MCP Adapter
        |
        v
M11 Quota / Observability / Ecosystem
```

---

## 5. M7：协议收口与独立鉴权

这是最推荐优先推进的阶段。

### 5.1 目标

- 把当前 Native beta 面升级为稳定的对外协议骨架
- 让 `/agent_gateway/*` 从过渡态 admin auth 逐步演进为独立 gateway auth
- 冻结 response envelope、error code、request context、capability model 的基础语义

### 5.2 核心工作

- 正式定义 gateway 身份模型：`gateway identity + agent identity + session identity`
- 为 `/agent_gateway/*` 设计独立凭证形态，例如 `gateway key` 或 `service token`
- 统一 query/body/header 中 `agentId`、`sessionId`、`requestId` 的获取与校验
- 冻结 `AGW_*` 错误码集合，减少后续漂移
- 完善 capability 输出结构，不只返回当前工具，还要明确 memory/context/jobs/events 能力边界
- 为写操作设计幂等键语义，优先覆盖 `memory/write` 和 `tools/:toolName/invoke`

### 5.3 建议新增或完善的能力

- `idempotencyKey` 支持
- 统一 `gatewayVersion`
- 更清晰的 `meta` 返回字段
- 更完整的 `policy` 可见结果，例如 tool scopes、diary scopes、auth mode

### 5.4 验收标准

- Native Gateway 不再只依赖 admin 身份表达权限
- 关键接口错误码和响应包络可冻结
- 双 adapter 对 core service 的调用路径保持一致
- 至少补齐一轮 auth/policy/response 的集成回归

### 5.5 推荐 capability 命名

- `agent-gateway-protocol-governance`
- `agent-gateway-auth-runtime`

---

## 6. M8：Job / Event Runtime 正式化

这是把当前 skeleton 变成完整外部能力的一步。

### 6.1 目标

- 将内部 `JobRuntimeService` 正式开放到 HTTP 面
- 把审批等待、长任务、可轮询状态从“内部机制”升级为“正式协议对象”
- 为未来 SSE / WebSocket / Webhook 推送预留统一状态模型

### 6.2 核心工作

- 新增 `GET /agent_gateway/jobs/:jobId`
- 新增 `POST /agent_gateway/jobs/:jobId/cancel`
- 评估是否需要 `POST /agent_gateway/jobs/:jobId/approve` 与 `reject`
- 统一 job state machine，例如：
  - `accepted`
  - `running`
  - `waiting_approval`
  - `completed`
  - `failed`
  - `cancelled`
- 明确 tool invoke 与 job runtime 的关系：同步结果直接返回，异步结果返回 job handle
- 明确审批等待与 job 的绑定关系

### 6.3 可选扩展

- `GET /agent_gateway/events/stream` SSE
- webhook 回调
- 与 `WebSocketServer.js` 的事件桥接

### 6.4 验收标准

- 至少一个长耗时或审批类能力走通 job 模型
- polling 协议稳定可用
- 工具调用可稳定区分 `completed / accepted / waiting_approval`
- job cancel 对外行为清晰、错误码稳定

### 6.5 推荐 capability 命名

- `agent-gateway-job-runtime`
- `agent-gateway-event-runtime`

---

## 7. M9：Native Gateway GA 与交付物补齐

这个阶段的目标是把“能用的 beta”升级成“适合正式接入的机读协议”。

### 7.1 目标

- 将 Native Gateway 从 beta 提升到更稳定的 GA 或准 GA 状态
- 对外补齐可消费的文档、示例、契约测试和 SDK 基础材料
- 让外部系统可以不读源码也能稳定接入

### 7.2 核心工作

- 生成并维护正式 OpenAPI 文档
- 将独立 gateway 文档整合到总 `openapi.yaml` 或并行维护独立入口
- 输出 JSON 版本，方便 Swagger / Postman / SDK 生成
- 补最小 SDK 或示例客户端，优先 Node.js
- 增加协议示例：capabilities、agents、memory、context、tool invoke、job poll
- 增加面向调用方的错误码说明和迁移说明

### 7.3 测试建议

- 增加契约测试，重点验证 schema 不漂移
- 增加 response snapshot 测试
- 增加跨 adapter 一致性测试

### 7.4 验收标准

- 外部团队可仅依据 OpenAPI 和示例完成接入
- OpenAPI 与真实路由行为一致
- 关键接口具备回归保护
- 对外契约已有版本说明和兼容策略

### 7.5 推荐 capability 命名

- `agent-gateway-native-gateway-ga`
- `agent-gateway-contract-publishing`

---

## 8. M10：MCP Adapter 落地

这是从“内部正式协议”走向“更广泛生态兼容”的阶段。

### 8.1 目标

- 基于现有 core service 落地 MCP adapter
- 把现有 VCP 能力映射到 MCP 可理解的对象模型
- 在不复制业务逻辑的前提下扩展更广泛 agent 生态

### 8.2 推荐范围

第一阶段先做最小子集：

- tools discover
- tool invoke
- 少量资源读取

第二阶段再考虑：

- prompts
- agent registry 映射
- memory/context 的 MCP 表达
- 会话与事件的进一步兼容

### 8.3 关键难点

- 现有 `authContext` 如何映射到 MCP 侧身份
- 现有错误码与状态如何映射到 MCP 客户端语义
- `memory / context` 这类不纯粹是 tool 的能力如何表达

### 8.4 验收标准

- 至少一个 MCP client 成功接入并调用代表性工具
- MCP adapter 不直接依赖底层业务模块，只走 Gateway Core
- 同一条 tool invoke 链路在 Native 和 MCP 下具有可比对的语义

### 8.5 推荐 capability 命名

- `agent-gateway-mcp-adapter`

---

## 9. M11：运营级硬化与生态扩展

这是面向正式运营和大规模接入的增强阶段。

### 9.1 目标

- 提升网关的稳定性、可观测性、配额治理和生态接入体验
- 让 `agent_gateway` 从“开发可用”升级为“运营可用”

### 9.2 核心工作

- 增加 rate limit / quota / concurrency limit
- 增加 payload size、timeout、retry policy
- 完善审计日志与 trace 传播
- 增加性能指标与错误指标
- 评估缓存策略，例如 capability cache、registry cache
- 视需要追加多语言 SDK

### 9.3 建议关注点

- 不同 agent 的资源隔离
- 大量 memory search 的性能上限
- 大模型宿主重试导致的副作用
- 审批类任务的超时与清理策略

### 9.4 验收标准

- 网关关键路径具备监控与审计
- 高频调用和异常输入有明确限流/保护策略
- 对外接入具备最基本的运营能力

### 9.5 推荐 capability 命名

- `agent-gateway-operability`
- `agent-gateway-quota-observability`

---

## 10. 各方向优先级对比

为了便于继续排期，下面给出一个优先级排序。

| 方向 | 优先级 | 价值 | 原因 |
|---|---|---|---|
| 协议收口与独立鉴权 | P0 | 很高 | 决定后续所有接入是否稳定 |
| Job / Event Runtime | P1 | 很高 | 承接审批、长任务、异步能力 |
| Native Gateway GA / OpenAPI / SDK | P1 | 高 | 直接影响外部接入效率 |
| MCP Adapter | P2 | 高 | 扩展生态，但依赖前面契约稳定 |
| 运营级硬化 | P2 | 高 | 适合在开始真实对外接入前补齐 |
| Memory / Context 效果增强 | P3 | 中高 | 很重要，但应建立在协议稳定后 |
| Registry 深化与诊断输出 | P3 | 中 | 能增强可解释性，但不是最急缺口 |

---

## 11. 推荐推进顺序

如果从现在继续推进，我建议采用下面顺序：

1. 先做 `M7`：协议收口 + 独立 auth
2. 再做 `M8`：job / event runtime 正式化
3. 接着做 `M9`：OpenAPI、JSON、示例、SDK、GA 契约
4. 然后做 `M10`：MCP adapter
5. 最后做 `M11`：观测、限流、配额、运营能力

这样安排的原因是：

- 先把 canonical contract 稳住
- 再让异步状态模型稳定
- 再把文档和 SDK 做成正式交付物
- 最后才扩生态和运营层，避免重复返工

---

## 12. 每阶段建议测试

结合当前项目风格，建议每个阶段都附带最少但关键的验证。

### 12.1 M7 测试

- authContext 解析测试
- policy scope 测试
- response envelope 契约测试
- error code 映射测试
- 幂等键行为测试

### 12.2 M8 测试

- job create / poll / cancel 测试
- waiting approval 场景测试
- tool invoke 返回同步/异步两种形态测试
- 轮询与错误状态测试

### 12.3 M9 测试

- OpenAPI 与真实路由一致性检查
- JSON 导出检查
- snapshot/contract 测试
- 示例客户端联调测试

### 12.4 M10 测试

- MCP tool discover 测试
- MCP tool invoke 测试
- Native 与 MCP 语义对齐测试

### 12.5 M11 测试

- 限流与配额测试
- 审计日志字段完整性检查
- 异常负载保护测试

---

## 13. 起 Change 的建议

如果后续继续用 OpenSpec 推进，建议优先按下面顺序起 change：

1. `agent-gateway-m7-protocol-auth-stabilization`
2. `agent-gateway-m8-job-event-runtime`
3. `agent-gateway-m9-native-gateway-ga-contract-publishing`
4. `agent-gateway-m10-mcp-adapter`
5. `agent-gateway-m11-operability-observability`

对应 capability 可优先考虑：

- `agent-gateway-protocol-governance`
- `agent-gateway-auth-runtime`
- `agent-gateway-job-runtime`
- `agent-gateway-event-runtime`
- `agent-gateway-native-gateway`
- `agent-gateway-mcp-readiness`
- `agent-gateway-mcp-adapter`
- `agent-gateway-operability`

---

## 14. 最终建议

如果只保留一个最明确的结论，那就是：

**建议下一步优先推进 `M7`，把当前 `agent_gateway` 从“功能上已经打通”推进到“协议上真正稳定”。**

原因很简单：

- 当前最明显的短板不在功能数量，而在协议稳定性
- 鉴权、job、OpenAPI、MCP 都依赖这一层先收口
- 一旦 `M7` 做稳，后续 `M8-M11` 的推进成本会明显降低

换句话说：

**现阶段最值得做的，是把 `agent_gateway` 从 beta 能力集合，推进成真正的 VCP Agent Runtime 平台边界。**
