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
- `agentId` 在绑定 credential 时可省略——省略即以绑定身份为 target（2026-08-03 恢复，见 §5.4 状态框）；显式值与绑定不一致返回 `AGW_FORBIDDEN`。未绑定 credential 时必填，缺失即 invalid request。
- 未绑定 credential 时同样必须显式提供 agent 并通过 scope 校验。
- description 明确它仅供无法消费 prompt/resource surface 的 tool-only host，支持常规 host 时优先使用标准 prompt/resource surface。

兼容性矩阵：

| 客户端能力 | guidance 来源 | 自动性 |
|---|---|---|
| tools + resources + instructions | initialize 摘要 + resource | 取决于 host 是否自动读取 resource |
| tools，无 resources | bootstrap 的 `integrationGuidance` | host/skill 需要主动调用一次 |
| 仅 tools | tool description | 仅触发建议，不保证完整路由 |
| 无 MCP | 可选 L3 skill | 本地安装后生效 |

因此“零安装”仅表示不再需要手写 skill 才能连接并发现基础工具；不表示每个 host 都能自动消费所有 guidance 层。M2.S4 对 Claude Code / Codex / Kimi 的实测矩阵见 [smoke-records.md](smoke-records.md)：Claude Code 三层全消费；Codex 消费 instructions + resource；Kimi 为典型 tool-only host，仅消费 bootstrap 的 text 内容层。

### 5.4 `agentId` 语义（2026-08-03 恢复：绑定 credential 可省略）

> **状态（2026-08-03）**：绑定 credential 的 MCP 调用**可以省略 `agentId`**，服务端以绑定身份为 target。4a65ab35 的"一律强制显式"规则被再次反转；本次恢复**不**带回任何 default/env agent 兜底（那才是 4a65ab35 真正要消除的误导面），只恢复"绑定身份补全"——target 与授权身份同源同值。绑定 credential 在密码学上只能代表一个 agent（§3.2：`admin` scope 不允许出现在绑定 credential 上），显式重复不构成额外授权保证；审计每请求仍记录 `credentialId` + `effectiveAgentId`，遥测区分 `explicit`/`boundOmitted`。

现行规则矩阵：

| credential | `agentId` | 行为 |
|---|---|---|
| 绑定 agent | 省略 | target = 绑定 agent，记 `boundOmitted` |
| 绑定 agent | 显式 == 绑定 | 放行，记 `explicit` |
| 绑定 agent | 显式 ≠ 绑定 | `AGW_FORBIDDEN`（不变） |
| 未绑定 | 省略 | 受控 `MCP_INVALID_REQUEST`（"agentId is required: provide an explicit agentId, or use an agent-bound credential"） |
| 未绑定 | 显式 | 现行 scope/allowedAgents 校验（不变） |

实现面：

- proxy executor `resolveDirectAgentTarget()` 恢复绑定补全分支（**无** defaultAgentId 参数）；直接 agent-scoped 操作（render prompt、bootstrap、recall_run、memory/context 类）与 job 类操作统一经它决议。diary 策略门必须在填充后的 agentId 上执行——透传空 `agentId` 会绕过 per-agent 日记授权；job 类操作不计入显式/省略遥测（间接对象，§3.4 服务端 owner lookup 授权）。
- in-process executor `buildManagedToolContextInput()` 恢复同一补全逻辑；显式不一致在边缘即 `MCP_FORBIDDEN`（in-process 即 canonical backend）。未绑定省略仍由下游 `ensureAgentId` 受控报错。
- `mcpOperations.json` 8 个操作的 `agentId` 全部改 optional（prompt `gateway_agent_render` 的 argument 同步），字段描述写明绑定可省略规则；`gateway_job_get`/`gateway_job_cancel` 保持 `jobId` 必填。
- REST 面无代码改动：canonical 决议树（§3.2）本就支持"绑定 + 无 target → `effectiveAgentId` = 绑定 agent"。`RecallRunRequest` 的 OpenAPI `required` 放宽为 `['query']`——运行时本就经决议树填充，此前的 `['agentId','query']` 是 schema 文档漂移。
- stdio：经凭据自省端点 `GET /agent_gateway/credential/context` 在启动时解析静态 credential 的绑定身份，作为受信任身份注入后续每条请求（§5.5），与 HTTP/WS 同一省略语义；自省失败或未绑定时保持"调用方需显式 `agentId`"的现状。

`mcpOperations.json` 的改动只影响 MCP descriptors。若 Native REST 也要放宽 agent 参数，必须同步修改 `restOperations.json`、route binding 和 OpenAPI schema；不能声称修改 MCP catalog 会自动更新 OpenAPI。此外 `contracts/generated/mcpDescriptors.json` 是构建产物，修改 catalog 后必须重跑 export 脚本，契约快照测试覆盖该一致性。

> **历史（2026-07-26，commit `4a65ab35`，已被上述规则再次反转）**：首次 optional 化（绑定 credential 可省略 `agentId`）实现后被 4a65ab35 推翻，理由是"避免将请求误导到默认或隐式 agent、保持身份校验的明确性"。本次处置：default/env 兜底保持移除（不恢复）；绑定补全与授权身份同源，不构成"隐式 agent"，故恢复。首次 optional 化的迁移步骤（credential → `effectiveAgentId` 上下文 → schema optional → 未绑定保持必填 → 记录显式比例）与本次一致，不再重复列出。

### 5.5 stdio 身份语义

stdio 没有 HTTP header 或 WebSocket handshake。其 `VCP_MCP_BACKEND_KEY`（或 `VCP_MCP_BACKEND_BEARER_TOKEN`，二者冲突规则同 §3.3）是 backend credential，必须由 canonical backend 绑定 agent；`VCP_MCP_DEFAULT_AGENT_ID` 只能作为无绑定开发环境的兼容 default，不能成为生产授权依据。

stdio 是**单进程单身份**：一个 stdio 实例注入一个 backend credential。同机多 agent 的场景需启动多个 stdio 实例，各自携带绑定不同 agent 的 credential。

stdio 的静态 credential 绑定信息原本对 proxy 边缘不可见（没有 HTTP/WS 那样的逐请求受信任注入通道）。为此新增凭据自省端点 `GET /agent_gateway/credential/context`（credentialAction: `authenticated`，任何有效凭据可 introspect 自身，返回 `credentialId`、`boundAgentId`、scopes、`status`、`expiresAt`、`credentialRevision`）：stdio 在启动时解析一次，将 `boundAgentId`/`credentialScopes` 作为受信任身份覆盖注入后续每条请求（客户端 params 中的同名字段仍按伪造值剥离），从而获得与 HTTP/WS 一致的 §5.4 绑定省略语义。自省失败、未绑定或端点不可用时不阻断启动，保持"调用方需显式 `agentId`"的现状；HTTP/WS runtime（`requireRequestAuthOverride`）不做静态自省。`VCP_MCP_DEFAULT_AGENT_ID` 不参与 tools/call 兜底。


### 5.6 人格获取入口：bootstrap 是主路径，render prompt 不是

`gateway_agent_render` 与 `gateway_agent_bootstrap` 走同一条 `agents.render` 执行路径、返回同一份 `renderedPrompt`。但两者的**可达性**完全不同：

- `gateway_agent_render` 是 MCP **prompt**（`publishedAsTool: false`，不在 `tools/list`）。Claude Code 等宿主把 MCP prompt 暴露成用户手打的斜杠命令——**模型没有 `prompts/get` 这个动作**，无法自主调用。
- `gateway_agent_bootstrap` 是 tool，模型可以主动调。

因此 `gateway_agent_bootstrap` 是宿主获取 agent 人格的**主入口**，不是"仅工具型宿主的降级路径"。任何面向宿主的文案（工具描述、`initialize.instructions` 里的 workflow、agent 提示词文件、skill）都必须以它为默认动作；`prompts/get` 仅在宿主明确允许模型自主调用 prompt 面时才提。

> 历史坑：该工具的描述曾写作 "for tool-only hosts that cannot consume MCP prompt surfaces directly"。这句话常驻系统提示，对支持 prompt 的宿主等于明说"不是给你的"——主路径不可执行 + 备路径标注不适用，实测表现为 `gateway_recall_run` 偶尔被调用、人格层始终拿不到。

### 5.7 检索 query 与降级信号

渲染时日记本／冷知识库占位符按一条 query 检索后注入。query 来源优先级（canonical 实现：`policy/shared/retrievalQuery.js`）：

1. `query` —— 一级参数，调用方直接给出的检索式
2. `messages` —— 最近一条 user 消息
3. fallback —— 两者都没有时，拿提示词自身文本去检索

第 3 种是降级：命中的是与用户问题无关的片段，而占位符照样被替换，**表面完全看不出异常**。为此：

- `renderMeta` 增加 `knowledgeQuerySource`（`query` / `messages` / `fallback`）与 `knowledgeInjected`（源提示词含知识库占位符且渲染后减少）。
- fallback 且源提示词确实含检索占位符时，`warnings` 追加一条可执行文案（`RETRIEVAL_FALLBACK_WARNING`）。
- render / bootstrap 的 MCP `content` 在**有 warning 时**前置一段 `GATEWAY NOTICE`（canonical 实现：`protocols/mcp/resultShapes.js` `createRenderedPromptContent()`），正文仍是完整 `renderedPrompt`；无 warning 时输出与直接返回 `renderedPrompt` 逐字节相同。宿主模型只读 `content`，`structuredContent` 里的 `warnings` 多半到不了它眼前——不抬到 `content` 就等于没有这个信号。两个 adapter 复用同一实现，不得漂移。

另一条相关修复：Gateway 侧 RAG 渲染闸门 `needsRagRender()` 原本只匹配 `日记本`，是 RAGDiaryPlugin 自身闸门（`DirectDiaryTextProcessor.js`）的真子集，**恰好漏掉冷知识库**——提示词里只有 `[[X知识库]]` 占位符的 agent，`processMessages` 一次都不会被调用。判定已统一到 `policy/shared/promptPlaceholders.js`（日记本 ∪ 知识库），placeholder 依赖统计同源。
