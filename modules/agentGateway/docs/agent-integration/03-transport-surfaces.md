# MCP、REST 与 transport 接线（§5）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 依赖 [§3 身份模型](01-identity-authorization.md) 与 [§4 配置模型](02-config-data-model.md)
> 本文保留原方案的 §5.x 编号。

## 5. MCP、REST 与 transport 接线

### 5.1 一项服务，两个 adapter

当前对外 HTTP、WebSocket 和 stdio 使用 backend-proxy adapter；in-process adapter 主要服务嵌入场景和测试。guidance 不能只添加到 `resourceHandlers.js`（该文件仅被 in-process executor 引用，proxy 路径有自己的 resource 实现），必须由 canonical backend service 提供，再由两个 adapter 同时映射。

```text
in-process MCP adapter ---\
                         +-- Gateway Agent Integration Service
backend-proxy adapter ---/       |- buildGatewayRequestContext()
                                 |- authorizeTarget()
                                 |- getAgentGuidance()
                                 `- renderIntegrationArtifact()
```

backend-proxy 的可信链路固定如下，不能以普通 body 字段替代 credential 透传：

```text
HTTP / WS transport
  -> 校验 presented credential，保存于 transport-private state
  -> 每个 MCP item 决议 target，并以 request-scoped auth header 调 backend
  -> canonical backend 再次解析同一 credential、重建 effectiveAgentId
  -> Native binding / service / audit 只消费 backend 构建的 context
```

两次解析得到的 `credentialId`、`credentialSubject` 与 `effectiveAgentId` 必须一致；revision 不同时复用 §3.6 的 `isSessionCredentialCompatible()`：只有 `active -> rotating` 的兼容过渡可接受，并以 backend 的新 revision 刷新 edge snapshot，其他变化返回 401/403 并销毁旧 session/connection context。backend 结果始终优先。in-process adapter 没有网络 credential 通道，只允许组装根注入由同一 resolver 产生的 `trustedCredentialContext`；直接从 MCP params 传入的 `authContext` 不得标记为 trusted。

新增 Native REST binding，例如：

```text
GET /agent_gateway/agents/:agentId/guidance
```

该 endpoint 仍通过 `buildGatewayRequestContext()` 校验 path agent；backend-proxy resource handler 调用它。MCP resource 和 REST 结果必须具有相同 guidance revision。

既有的双 adapter surface 差异随本方案一并收敛，以 `mcpOperations.json` catalog 为准：

- in-process 当前允许经 `tools/call` 调用 `gateway_agent_render`（不在 tools/list 中列出但可调）而 proxy 显式拒绝；catalog 标记 `publishedAsTool: false`，两个 adapter 都不得将其作为 tool 暴露，in-process 对齐收敛。
- bootstrap 的 `summary` 字段两条路径均已返回（in-process 与 proxy 各有一份 `buildBootstrapResult` 实现）；真实缝隙是 in-process 的 deferred 分支（`accepted`/`waiting_approval`）直接返回、缺少 `summary`。对齐工作为：补齐该分支，并将两份重复实现收敛到 canonical service（本方案的 5.1 结构自然消除重复），见 §5.3。

### 5.2 `initialize.instructions`

现状 `createMcpHarness({ adapter, instructions, serverInfo })` 已支持静态 `instructions` 字符串，但两个 executor 均未传入，initialize 恒返回内置默认文案，且不存在任何 per-session 定制机制。本方案将其升级为 per-request 解析：

```js
createMcpHarness({
  adapter,
  resolveInstructions: async ({ requestContext, authContext }) => string,
  serverInfo
});
```

处理 `initialize` 时使用 transport 注入的受信任 context。harness factory、in-process executor、backend-proxy executor 和三种 transport 都必须透传此选项；不能让 function 被当作 JSON 属性序列化掉。

渲染规则：

- credential 绑定 agent 且具有 `gateway:read`：返回不超过 800 token 的摘要、recall/write 要点和 guidance resource URI。近似 token 计数的算法在 canonical service 单点实现并写入契约（`ceil(chars/4)`，按 UTF-8 code point 计），两个 adapter 复用同一实现，保证同一 guidance revision 在两条路径裁剪结果一致；超限截断并记录。
- execute-only、legacy credential 或其他未绑定 credential：只返回通用说明，不泄露任一 agent 的 diaries、tags 或 metadata。initialize 只要求 authenticated，不得借 instructions 绕过 read scope。
- 完整内容下沉到 resource/bootstrap。instructions 是增强，不作为唯一正确性机制。

### 5.3 Guidance resource 与 bootstrap

新增 resource URI：

```text
vcp://agent-gateway/agents/{agentId}/guidance
```

读取步骤：解析 URI 的 `targetAgentId`，构建统一 context，执行绑定校验，返回 JSON guidance bundle。

`gateway_agent_bootstrap` 保留现有 tool-only host 的 rendered prompt 兼容语义，并以向后兼容的附加字段承载 guidance：

- 继续返回现有 `renderedPrompt`、`renderMeta` 和 `summary`，不删除或改名已有字段。`summary` 两条路径均已返回；本方案要求 in-process 补齐 deferred（`accepted`/`waiting_approval`）分支的 `summary`（见 §5.1），使“现有字段”承诺在所有分支对两个 adapter 一致成立。
- 新增 `integrationGuidance` 字段，其内容与 guidance resource 等价并包含同一 revision。
- 已绑定 credential 时 `agentId` 可省略；显式不一致返回 `AGW_FORBIDDEN`。
- 未绑定 credential 时必须显式提供 agent 并通过 scope 校验。
- description 明确它仅供无法消费 prompt/resource surface 的 tool-only host，支持常规 host 时优先使用标准 prompt/resource surface。

兼容性矩阵：

| 客户端能力 | guidance 来源 | 自动性 |
|---|---|---|
| tools + resources + instructions | initialize 摘要 + resource | 取决于 host 是否自动读取 resource |
| tools，无 resources | bootstrap 的 `integrationGuidance` | host/skill 需要主动调用一次 |
| 仅 tools | tool description | 仅触发建议，不保证完整路由 |
| 无 MCP | 可选 L3 skill | 本地安装后生效 |

因此“零安装”仅表示不再需要手写 skill 才能连接并发现基础工具；不表示每个 host 都能自动消费所有 guidance 层。

### 5.4 `agentId` 迁移

迁移顺序不可颠倒：

1. 建立 credential -> `effectiveAgentId` 的端到端上下文和所有 target guard。
2. 让 MCP in-process/proxy 都在 `ensureAgentId` 前写入 effective agent。
3. 再将 MCP tool/prompt schema 中的 `agentId` 改 optional。直接 agent-scoped schema 的改动面为当前必填的两处——`gateway_agent_bootstrap` 与 `gateway_recall_run`（另加 render prompt 的 argument）；memory/context 类 tool 的 `agentId` 本就可选。`gateway_job_get` / `gateway_job_cancel` 继续保持 jobId-only，由 §3.4 的服务端 owner lookup 决议 target，不向调用方新增可伪造 owner 字段。
4. 未绑定 credential 对直接 agent-scoped 操作保持 `agentId` 必填语义；job/event 等间接对象操作以服务端 owner 为 target，不要求也不信任客户端补 agentId。
5. 记录显式 `agentId` 调用比例，完成迁移后再评估废弃时间表。

`mcpOperations.json` 的改动只影响 MCP descriptors。若 Native REST 也要放宽 agent 参数，必须同步修改 `restOperations.json`、route binding 和 OpenAPI schema；不能声称修改 MCP catalog 会自动更新 OpenAPI。此外 `contracts/generated/mcpDescriptors.json` 是构建产物，修改 catalog 后必须重跑 export 脚本，契约快照测试覆盖该一致性。

### 5.5 stdio 身份语义

stdio 没有 HTTP header 或 WebSocket handshake。其 `VCP_MCP_BACKEND_KEY`（或 `VCP_MCP_BACKEND_BEARER_TOKEN`，二者冲突规则同 §3.3）是 backend credential，必须由 canonical backend 绑定 agent；`VCP_MCP_DEFAULT_AGENT_ID` 只能作为无绑定开发环境的兼容 default，不能成为生产授权依据。

stdio 是**单进程单身份**：一个 stdio 实例注入一个 backend credential。同机多 agent 的场景需启动多个 stdio 实例，各自携带绑定不同 agent 的 credential。

proxy executor 不应在本地提前以“缺少显式 agentId”为由失败：绑定 credential 场景应允许请求到达 backend，由统一 context 注入 effective agent；未绑定 credential 才由 backend 返回“agentId required”。

