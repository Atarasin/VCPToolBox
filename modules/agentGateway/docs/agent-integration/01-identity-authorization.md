# 统一身份与授权模型（§3）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 执行计划见 [06-execution-plan.md](06-execution-plan.md)
> 本文保留原方案的 §3.x 编号，其他文件以 §3.x 交叉引用本文。

## 3. 统一身份与授权模型

### 3.1 术语

| 名称 | 含义 |
|---|---|
| `credentialId` | 凭据的非敏感稳定标识，用于审计、轮换与吊销 |
| `credentialRevision` | 单条 credential 规范化内容的稳定 hash；bound agent、scope、状态或有效期变化时改变 |
| `credentialSubject` | 用于 session、job 和事件所有权比较的不可变主体；文件 credential 缺省等于在安全对象最长保留窗口内唯一且不可复用的 `credentialId`，对象所有权同时记录 `credentialRevision` |
| `boundAgentId` | credential 显式绑定的 agent；为空表示服务型（shared）credential |
| `allowedAgents` | 未绑定 credential 可触及的 agent 集合；缺省且持 `admin` scope 表示全部 agent |
| `targetAgentId` | 本次操作目标，由 MCP 参数、resource URI、REST path、间接对象 owner 或下载签名载荷取得 |
| `effectiveAgentId` | 最终生效 agent；后续业务逻辑只消费它 |
| `requestContext` | 统一入口构建的上下文，包含 trace、credential、身份和授权结果 |
| `credentialScopes` | 凭据级授权范围（认证面）：操作类别（`gateway:read` / `gateway:execute` / `admin`）与可触及 agent 集合 |
| `indirectOwner` | job、event stream 等只携带 object id 的操作从服务端存储读取的不可变 owner snapshot |
| `agentPolicyScopes` | 既有 agent 级策略（业务面）：`agentPolicyResolver` 的 toolScopes / diaryScopes，本方案不改其语义 |
| `legacyCredential` | 由存量 `AGENT_GATEWAY_KEY` 合成的内置 shared credential（`credentialId: "legacy-gateway-key"`，见 §3.3），用于过渡期 |
| `adminSessionCredential` | adminAuth 成功后由 Gateway 专用服务端会话合成的 Native REST shared credential（`credentialId: "admin-session"`，见 §3.3）；原始 Basic/`admin_auth` cookie 本身不是 session |

### 3.2 决议规则

所有入口在 schema 校验、`ensureAgentId` 和 service 调用之前，先调用同一个 `buildGatewayRequestContext()`：

```text
解析 credential
  |- 无效、过期或已吊销
  |    `- AGW_UNAUTHORIZED
  |
  |- 绑定 boundAgentId
  |    |- 无 targetAgentId: effectiveAgentId = boundAgentId
  |    |- targetAgentId 等于 boundAgentId: effectiveAgentId = boundAgentId
  |    `- targetAgentId 不同: AGW_FORBIDDEN
  |
  `- 未绑定 credential
       |- 需要 agent 作用域但没有 targetAgentId: AGW_INVALID_REQUEST
       |- target 不在 credential scope / allowedAgents: AGW_FORBIDDEN
       `- effectiveAgentId = targetAgentId
```

实现要求：

- `agentId` 是输入兼容字段，不是授权依据。
- 同一请求若从 path、query、body、resource URI 等位置得到多个非空 target candidate，所有 candidate 必须规范化后完全相等；任何冲突均返回 `AGW_INVALID_REQUEST`，不得使用“path 优先”或“body 覆盖”的静默选边规则。
- 写回 `requestContext.agentId = effectiveAgentId` 和 `authContext.agentId = effectiveAgentId` 后，才可进入既有 `ensureAgentId` 或 operation validator。
- `requestContext` / `authContext` 同时写入 `credentialId`、`credentialRevision`、`credentialSubject`、`boundAgentId`、`targetAgentId` 与 `effectiveAgentId`；来自客户端 body 的同名字段一律丢弃，不能覆盖认证结果。
- 不新增 `AGW_PERMISSION_DENIED`。有效凭据访问错误 target 一律使用已存在的 `AGW_FORBIDDEN`，并映射为 MCP `MCP_FORBIDDEN` / REST 403。
- 管理员跨 agent 操作必须具备显式 `admin` scope；不能借由未绑定 credential 隐式放行。
- **`admin` scope 只允许出现在 `boundAgentId: null` 的 credential 上**（配置校验强制，违例时拒绝发布 security snapshot）。绑定 credential 的决议树无 admin 分支——target 不同即 `AGW_FORBIDDEN`，无例外。这保证决议树只有上面一张，跨 agent 能力与单 agent 身份不会叠加在同一把凭据上；需要两种能力的运维方持有两把 credential。

### 3.3 凭据呈现、proxy 透传与存量认证路径归一化

- 外部**凭据呈现**复用现有两个通道，不为凭据呈现新增 header：`Authorization: Bearer <token>` 或 `x-agent-gateway-key: <token>`，两者解析为同一个 presented token。stdio 由 `VCP_MCP_BACKEND_KEY` 注入为 backend client 的同一 header。（admin session bridge 的 `x-agent-gateway-csrf` 属 CSRF 面而非凭据呈现面，不违反本条。）
- **双通道同时呈现且值不一致时返回 401**（`AGW_UNAUTHORIZED`），不再沿用现状 `x-agent-gateway-key` 静默胜出（`protocolGovernance.js` 当前为 `gatewayKeyHeader || Bearer`）的行为——静默选边会在客户端配错时产生难以定位的身份歧义。两者一致或只呈现其一均正常解析。
- **HTTP / WebSocket backend-proxy 必须逐请求透传原始客户端 credential。** transport 在私有 connection/session state 中保留 presented token，只用于后续 backend 请求；token 不进入 MCP params、`requestContext`、`authContext`、日志或审计。`GatewayBackendClient` 必须支持 request-scoped auth override，backend 收到请求后重新运行 credential resolver 与 `buildGatewayRequestContext()`，不能信任 proxy body 中的 agent 或 auth 字段。
- **request-scoped override 必须改造 `createHeaders()` 的覆盖顺序**（点名现状陷阱）：`clients/GatewayBackendClient.js` 现实现先 spread 请求级 `extraHeaders`，之后无条件写入构造期静态 `gatewayKey`——经 extraHeaders 传 per-request 凭据会被静态 key 覆盖，而 bearer 又只在无 `authorization` 时补写。若实现者以 extraHeaders 承载透传、同时保留静态 gatewayKey 配置，backend 会收到值不一致的双通道并按本节规则 401。改造要求：request-scoped auth override 生效时**互斥地**清除全部静态凭据通道（gatewayKey 与 bearerToken 均不写入），仅呈现 override 的单一通道；HTTP/WS proxy 实例在生产配置下不得设置静态 credential（见下一条 fail-closed 规则），静态构造参数仅供 stdio 使用。该组合的专门测试归属 M1.S4（见 06-execution-plan.md）。
- `VCP_MCP_BACKEND_KEY` / `VCP_MCP_BACKEND_BEARER_TOKEN` 的静态 backend 身份**仅用于 stdio 单身份进程**。HTTP / WebSocket 生产路径不得回退到该静态 credential，否则所有外部连接会在 canonical backend 折叠成同一个 shared/admin 主体。若 request-scoped credential 丢失，proxy 必须 fail-closed 返回 401，不能使用静态 key 补位。
- HTTP session / WebSocket connection 销毁时必须清除对 presented token 的引用；任何错误对象、debug dump 和 transport logger 都不得序列化该私有字段。JavaScript 字符串无法保证物理清零，因此实现与运维文档必须明确其仅驻留于进程内存、不得进入 heap dump 的常规采集链路。
- 存量 `AGENT_GATEWAY_KEY` 不再作为独立认证路径存在。启动时将其合成为内置 credential：`credentialId: "legacy-gateway-key"`、`boundAgentId: null`、`scopes: ["admin"]`，与文件中定义的 credential 走同一个 resolver 和同一张决议表。**阶段 A 期间该 credential 持有全量跨 agent 权限是有意为之**——与现状单一 gateway key 的实际权限等价，实现时不得擅自收紧，否则会破坏迁移期兼容。
- **admin 兜底路径同样归一化，但不能把现有 cookie 误当作 session。** 现状 server.js 的 adminAuth 中间件对 `/agent_gateway/*` 存在第二条认证路径：请求未呈现 gateway key 时，落到管理员 Basic auth/`admin_auth` cookie 兜底，认证成功后合成 `outerAuthenticated` 放行。现有 `admin_auth` cookie 保存的是 Basic Authorization 值，不是独立、可区分的服务器会话；`/mcp` HTTP 与 WebSocket 也不经过 adminAuth。处置规则：
  - 新增 Gateway 专用 `adminGatewaySessionStore`（交付归属 M1.S3，见 06-execution-plan.md） 与 `POST /agent_gateway/auth/admin-session`、`DELETE /agent_gateway/auth/admin-session`。endpoint 先由既有 adminAuth 验证，再签发/撤销至少 256 bit CSPRNG opaque session id；生产 cookie 使用 `HttpOnly`、`Secure`、`SameSite=Strict`、`Path=/agent_gateway` 和短 TTL。POST 响应 body 单独返回一次 session-bound CSRF token，客户端后续 mutation 通过 `x-agent-gateway-csrf` 呈现；服务端只保存 session id digest、状态、创建/到期时间、CSRF digest 和 revision。AdminPanel 登出流程必须先调用 DELETE，禁用兜底或会话到期也必须撤销记录。所有 cookie-authenticated mutation 校验 `Origin` 和 CSRF token。
  - **Origin 校验必须兼容 AdminPanel 独立端口的现状部署**：server.js 当前把 `/AdminPanel` 302 重定向到 `PORT+1` 的独立后台进程，将来消费 admin session 的前端与 Gateway 主端口不同源（端口不同即不同 origin），严格 same-origin 会把唯一合法调用方拒之门外；`SameSite=Strict` cookie 在跨端口 fetch 下也不会被携带。实现必须二选一并在部署文档写明：(a) AdminPanel 对 Gateway 的请求经主端口同源反代（推荐，cookie/CSRF 语义最简单）；(b) `Origin` 校验使用服务端配置的显式 allowlist（`AGENT_GATEWAY_ADMIN_ORIGINS`，含 admin 端口 origin，不允许通配），同时 Gateway 对该 allowlist 开启携带凭据的 CORS（`Access-Control-Allow-Credentials`），cookie 的 `SameSite` 相应降为 `Lax` 并以 Origin+CSRF 双校验补偿。缺少任一配置时 admin session 创建返回 503，不得默认放宽为接受任意 Origin。
  - `adminGatewaySessionStore` 在多 worker 部署中必须共享、原子且支持按 expiry 清理；没有生产 store 时 session 创建返回 503，不能回退进程内 Map。subject 派生使用独立、仓库外、至少 256 bit 的 `AGENT_GATEWAY_ADMIN_SUBJECT_KEY`；轮换该 key 时原子撤销全部旧 admin session，不保留无法稳定比较的新旧 subject。
  - 有效 Gateway admin session 在 `buildGatewayRequestContext()` 中映射为内置 credential：`credentialId: "admin-session"`、`boundAgentId: null`、`scopes: ["admin"]`。`credentialSubject` 派生为 `admin-session:<HMAC(subject-key, opaque-session-id)>`，`credentialRevision` 取 session record revision；审计不得记录 cookie、Basic secret、opaque id、CSRF token 或其 digest。
  - 仅有已验证 Basic/`admin_auth`、但尚未建立 Gateway admin session 的请求，只允许调用上述 POST 创建 session；不得读取任何 agent 业务数据，也不得执行其他 read/execute、job/event、artifact 或状态操作。`POST /agent_gateway/auth/admin-session` 是唯一的 pre-credential bridge surface，在 auth policy catalog 中声明 `authMechanism: "adminAuthBridge"`，不伪装成普通 `credentialAction`。
  - `admin-session` **仅适用于 Native `/agent_gateway/*` 业务入口**。`/mcp` HTTP、WebSocket 和 stdio 不接受该 cookie/session；这些 transport 必须使用文件 credential 或阶段 A 的 legacy token。backend-proxy 不透传 admin cookie，也不合成 admin-session。
  - `authMigration` 分别观测 `legacy-gateway-key` 与 `admin-session`。使用两个独立开关：`AGENT_GATEWAY_LEGACY_KEY_DISABLED=true` 只关闭 legacy token；`AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED=true` 关闭 Gateway admin session 的新建与使用。关闭后管理路由认证不受影响（见 §2 非目标）。
  - 准确表述是：系统只有一个决议入口 `buildGatewayRequestContext()`；文件 credential、legacy key 和 Native admin session 都以规范化 credential record 进入，但各自允许的 transport/surface 由 auth policy catalog 明确约束。
  - **规模决策记录**：admin session 子系统（store、CSRF、subject key、Origin allowlist、双开关）是为一条过渡路径新建的一批安全关键代码。评审时考虑过的更小备选是阶段 A 即切断 admin 兜底对 agent 业务面的访问，AdminPanel 需要 Gateway 业务数据时改用一把服务端配置的文件 `admin` credential。本方案仍选择 session 方案，理由：AdminPanel 现有页面依赖这些业务数据，切断即回归；而给浏览器前端派发长期文件 credential 等于把 bearer token 落入前端可达存储，安全性劣于 HttpOnly session cookie。若实现期确认 AdminPanel 对 agent 业务面无真实依赖，可提请评审降级为"切断 + 文件 credential"方案并删除本子系统。
- 上线不做 flag-day 切换，分两阶段：
  - **阶段 A（观察）**：legacy credential 继续放行；admin 兜底先迁移为上述 Gateway admin session，审计与指标按 `credentialId` 区分 legacy、admin-session 与 per-agent credential。
  - **阶段 B（执行）**：客户端迁移完成后分别打开 `AGENT_GATEWAY_LEGACY_KEY_DISABLED=true` 与 `AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED=true`。两个开关独立演练、独立回滚；全部关闭后 agent 业务入口只接受文件 credential。
- 内置 legacy credential 与文件中 credential 的 token 相同属于配置错误：拒绝发布 security snapshot，不静默选边。（`admin-session` 由服务端 opaque session record 合成，无文件 token，不存在该冲突面。）
- **认证失败的限速与观测**：token 具备 256 bit 熵不代表撞库流量可以不设防。所有 credential 认证入口（HTTP、WS 握手、admin session bridge）对认证失败按 client IP 做滑动窗口限速（复用现有 `slidingWindowRateLimit` 模式；阈值可配置，超限返回 429 并带 `Retry-After`），并输出结构化审计事件与 `authFailure` 指标（按入口与失败类别分维度，不记录 presented token）。限速只作用于**失败**请求计数，不影响正常流量；admin session bridge 沿用 adminAuth 现有 IP 封禁语义，不重复计数。

### 3.4 强制覆盖入口

| 入口 | target 来源 | 必须执行的校验 |
|---|---|---|
| MCP tool | `arguments.agentId` 或 bound credential | 绑定一致性与 scope |
| MCP prompt | prompt arguments 或 bound credential | 绑定一致性与 scope |
| MCP resource | `vcp://.../{agentId}/...` URI | URI agent 与绑定身份一致 |
| MCP job / job-event resource | `jobId` 对应的服务端 owner snapshot | owner credential subject/revision、agent 与受信任 session 校验 |
| MCP discovery | credential 的可见 agent 集合 | 按下述确定规则生成 list；不依赖非标准 agent 参数 |
| Native REST | `req.params.agentId`、query 或 body | path/query/body target 与绑定身份一致 |
| Native job / event | `jobId` 对应 owner；无 jobId 时为可见 owner 集合 | 先查 owner 再授权，客户端 agent 仅作一致性断言 |
| Native agent list | credential 的可见 agent 集合 | `/agents` 只返回可见 agent，不返回全 registry |
| HTTP MCP session | session 的 credential snapshot | 创建与后续请求均验证 credential identity |
| WebSocket | 握手 credential 与每条消息 target | 握手认证、逐请求授权、吊销时断连 |
| stdio | 启动时的 backend credential | backend 以该 credential 绑定身份，不依赖 `VCP_MCP_DEFAULT_AGENT_ID` 授权 |
| skill 下载 | mint owner 与签名载荷中的 agent；redeem 时读取对应 credential/admin-session record | mint 授权、agent、owner subject/revision、签名有效期与 nonce 状态一致 |

补充规则：

- **MCP discovery 不把自定义 `agentId` list 参数当作正确性前提。** 标准 host 通常只发送 cursor，服务端按 credential 决定结果：绑定 credential 的 `tools/list` 返回 canonical gateway tools 与该 agent 可见的动态工具，`resources/list` 只返回该 agent 资源；未绑定 credential 的 `tools/list` 仅返回所有 agent 共享且名称/输入 schema 稳定的 canonical gateway tools，不合并 per-agent 动态工具，`resources/list` 按稳定 agentId 排序、分页枚举 `allowedAgents` 对应资源；`prompts/list` 始终只返回不含 agent 内容的 canonical prompt descriptor。`admin` 按全量可见集合执行同一规则。服务端可兼容自定义 discovery agentId 作为**收窄扩展**，但越界时 list 返回空集合，且不得在文档或客户端生成物中依赖该扩展。
- **本阶段继续发布 `tools/resources/prompts.listChanged: false`，因此 discovery 必须按 session 冻结。** initialize 成功时生成 `{ discoveryRevision, tools, resources, prompts, visibleAgents }` 只读快照；HTTP 自愈 discovery 在首次无 session list 请求时创建短 TTL discovery session，并在该 session 创建时生成同样的冻结快照。同一 HTTP/discovery session、WebSocket connection 或 stdio 进程后续 list/pagination 均读取该快照，cursor 绑定 `discoveryRevision`，不能跨 revision 或跨 credential subject 使用。agent policy、动态工具、guidance 发布状态或 agent directory 变化只影响新 session；credential 的 bound agent、allowedAgents 或 scope 变化仍按 §3.6 立即使旧 session/connection 失效。即使旧快照仍列出某项能力，实际 tool/resource 调用必须按当前 auth/policy 再授权。未来若要热推送列表变化，必须单独启用 `listChanged:true` 并实现三 transport 的标准通知，不在本阶段半实现。
- `VCP_MCP_DEFAULT_AGENT_ID` 不再参与外部 HTTP / WebSocket discovery 授权；只保留给 §5.5 的无绑定本地 stdio 开发兼容。生产环境使用未绑定 MCP credential 时，具体 tool/prompt 调用仍须显式提供 agentId，resource read 则从 URI 取得 agent。
- **Native discovery 同步过滤**：`GET /agent_gateway/agents` 按相同可见集合返回；`capabilities`、agent detail/render/guidance/integration 等 detail 操作继续走单 target 决议。不得把“REST 没有 MCP list 方法”当作返回全 registry 的理由。
- **job / event 是间接对象授权，不信任调用方声明 owner。** 创建 job 时固化 `{ credentialSubject, credentialId, credentialRevision, effectiveAgentId, trustedSessionId }` owner snapshot，event 继承同一 owner。`trustedSessionId` 只能来自服务端创建的 MCP transport session 或 Gateway admin session；客户端 body/query 中的 `sessionId` 仅作一致性断言，不能建立所有权边界。直接 Native REST + 文件 credential 没有受信任 session 时，`trustedSessionId` 为 null，该对象按 credential subject/revision 归属。
- 读取、取消或读取 job-event resource 时先按 jobId 查 owner，再将 owner 的 effectiveAgentId 作为 target 执行 §3.2。非 admin credential 必须匹配 `credentialSubject`，并通过 owner revision compatibility：只允许同 token digest 的 `active -> rotating` 过渡，credentialId 重用、新 token 或其他 revision 变化均不能继承旧对象。owner 含非空 `trustedSessionId` 时的校验分两种情形，避免 session 生命周期比 job 短造成孤儿对象：
  - owner 的受信任 session **仍存活**：请求必须携带并匹配同一受信任 session，缺失或不匹配返回 403。
  - owner 的受信任 session **已按正常生命周期终止**（idle/TTL 到期、客户端主动关闭；服务端能区分"已不存在"与"存在但不是你"）：允许同 `credentialSubject` 且通过 revision compatibility 的请求**收养**该对象——首次收养把 owner 的 `trustedSessionId` 原子替换为当前请求的受信任 session（Native 无 session 时置 null），并记录结构化 adoption 审计事件。因 credential 吊销/失效被销毁的 session 不适用收养：其对象随 credential 一起按 revision 校验拒绝。收养把边界收敛回"同一把凭据"，这正是 HTTP MCP session 空闲销毁后客户端重连轮询长任务的合法路径。
  文件 `admin` credential 可跨 owner 执行运维操作并记录原 owner；Native `admin-session` 不能跨另一个 admin session 的 owner，也不能收养其对象。不存在返回 404，存在但 owner 不匹配返回 403。无 jobId 的事件流只能返回当前 subject/revision/effectiveAgentId/trustedSessionId 可见事件（含已收养对象）；文件 `admin` credential 除外。
- **JSON-RPC batch**：仅对 transport 已声明支持的 batch 生效；batch 中每个 item 独立构建 context 并逐项授权，单项失败以该项的错误返回，不影响其他 item。本方案不顺带改变 HTTP / stdio 当前拒绝 batch 的兼容策略。
- **AdminPanel/system 管理路由**不经过本模型（见 §2 非目标）。排除清单固定为 `/agent_gateway/health` 与 `/agent_gateway/metrics`；它们继续由 `adminAuth` 保护。`/agent_gateway/auth/admin-session` 是单独登记的 pre-credential bridge，只负责 session 创建/撤销，不得承载 agent 业务数据。`/agents`、`/capabilities`、`/events/stream`、guidance 和 integration 均属于 agent 业务面，不在排除清单。新增排除或 bridge surface 必须经过单独契约评审，不能按目录名或 registrar 名称自动继承。
- HTTP session 所有权必须从仅比较 `gatewayId` 升级为比较 `credentialId`（或不可变 credential subject）与 credential 记录状态。现状除此之外还有一个更弱的问题：请求方缺省 `x-agent-gateway-id` 头时两侧同落默认值 `'vcp-gateway'`，现有比较实际形同虚设，不同 credential 可复用同一 session id。每请求的校验规则见 §3.6。

### 3.5 Scope-operation 单源映射与两层授权

scope 使用协议无关名称，避免 Native REST 被迫解释 `mcp:*`：

| credential action | 所需 scope | canonical operations / surfaces |
|---|---|---|
| `authenticated` | 任一有效 credential | MCP `initialize`、`notifications/initialized`、`ping`；只返回协议元数据或通用 instructions |
| `read` | `gateway:read` 或 `admin` | discovery、prompt get、resource read、capabilities、agent list/detail/render、guidance、integration/skill、memory targets/search、context assemble、recall run、job get、event read |
| `execute` | `gateway:execute` 或 `admin` | memory write、动态 tool invoke、job cancel |

要求：

- `gateway:execute` **不隐含** `gateway:read`，反之亦然；需要完整交互能力的 agent credential 显式配置两者。`admin` 蕴含两者并允许跨 agent，但仍受 §3.2 的 unbound-only 配置约束。
- `admin` 的跨 agent 语义不自动等于跨间接对象 owner：文件 `admin` credential 可执行 §3.4 明示的运维跨 owner 操作；Native `admin-session` 仍受自身 session owner 限制。该 surface 差异必须登记在 auth policy catalog，不能散落为 route 特判。
- 授权依据是 canonical operation 的 action，而不是 HTTP method 或 MCP method。例如经 `tools/call` 执行 `gateway_recall_run` 仍是 `read`，`gateway_memory_write` 才是 `execute`。
- 每个 credential-authenticated operation/surface 必须声明 `credentialAction: "read" | "execute" | "authenticated"`；REST 与 MCP binding 引用同一 canonical action。initialize、discovery、resource、skill download 等不完全对应业务 operation 的 surface 也必须在同一 auth policy catalog 登记。唯一的 pre-credential admin session bridge 声明 `authMechanism: "adminAuthBridge"` 且不得同时声明 credentialAction。生成器和启动校验对两者皆无、两者并存、未知 scope/mechanism 或 binding action 不一致执行 fail-fast。
- 本文“fail-fast”指候选 catalog/config 在对外服务前即被拒绝，不能发布部分或矛盾 snapshot；默认允许主进程继续运行并通过 health 暴露 degraded/unavailable。只有部署显式启用 strict startup 时才升级为进程退出，不能让不同实现自行解释。
- scope 不足统一返回 `AGW_FORBIDDEN` / 403 / `MCP_FORBIDDEN`，不伪装为 401。§3.4 排除的 health/metrics 继续使用 adminAuth，不进入 credential action catalog。

生效授权 = `credentialScopes` 与 `agentPolicyScopes` **串联、取交集语义**：

1. 凭据层（认证面）：credential 是否有效、能否以 targetAgent 身份操作、操作类别是否被 scopes 允许。
2. agent 策略层（业务面）：既有 `agentPolicyResolver` 的 toolScopes / diaryScopes 保持不变，继续约束 effectiveAgent 自身可调用哪些工具与日记本。

任何一层拒绝即整体拒绝；不引入并集、优先级或互相豁免。两层各自独立演进：凭据层管“谁能以该身份做什么类别的操作”，agent 策略层管“该身份本身能做什么”。

### 3.6 吊销传播与时效

- credential resolver 对 credential 文件与 pepper keyring 的**原始字节内容在每次授权读取时计算 SHA-256**，只有两者 content hash 均相同才复用已解析安全快照；mtime、size 和 inode 仅作诊断字段，不能作为跳过内容读取的充分条件。这样同秒、同大小替换也能被首个后续请求看到。文件很小，本方案接受该 I/O 成本以换取明确的吊销语义；若未来引入主动 reload 服务，仍必须保留 request-time revision 校验，不得退化为分钟级缓存。
- **热路径实现约束**：该校验位于每条 WS 消息、每次 SSE 事件写出与 backend-proxy 双侧解析的路径上，一次逻辑操作可能触发 2-3 次读取。实现必须使用异步 I/O（禁止在请求处理路径调用 `fs.readFileSync` 阻塞事件循环），并允许并发请求共享同一次 in-flight 读取（promise coalescing）：合并的是"正在进行的这一次读取"，不引入任何时间窗缓存，"下一请求可见变更"的语义不变。该路径的基准验收归属 M1.S1（目标：单次校验 p99 附加延迟 < 5ms，见 06-execution-plan.md）。
- credential 文件或 pepper keyring 的内容发生变化后，必须先完成读取、解析、schema、交叉引用、token 冲突和权限校验，再发布新的 security snapshot。**变更后的内容不可读、损坏或校验失败时不得继续使用 last-known-good credential/keyring**：Gateway agent 业务入口进入 `AGW_CONFIG_UNAVAILABLE`（REST 503 / MCP `MCP_SERVICE_UNAVAILABLE`），HTTP session 在下一请求销毁，WS 活跃连接下一消息拒绝并 `close(1013)`，空闲连接在周期检查时 `close(1013)`。修复配置并成功发布新 security snapshot 后恢复。运维更新必须采用同目录临时文件写完、fsync 后原子 rename，减少安全性优先策略带来的瞬时不可用。
- 所有入口经共享 `securityStateProvider` 读取 credential、agent publication 与授权策略域的当前状态。某安全域不可用时，受影响操作不得沿用旧授权；HTTP/Native 返回 503，stdio/in-process 返回 `MCP_SERVICE_UNAVAILABLE`，WebSocket 升级返回 HTTP 503，既有 WS 按下一条规则 `close(1013)`。有效的新 policy snapshot 可即时收紧或扩展调用授权，但不改写已冻结的 discovery list；agent 被取消发布或 credential identity/scope 变化则使相关 transport session 失效。
- loader 只在读取时发现变化，本身不产生主动通知。因此凡是依赖“吊销后主动动作”的场景（WebSocket 断连），必须叠加主动触发源，见下。
- **HTTP session**：创建时记录 credential owner snapshot；每请求按 content hash 重载后执行 `isSessionCredentialCompatible(snapshot, current)`：`credentialId`、`credentialSubject`、token digest、`boundAgentId`、`allowedAgents` 和 scopes 必须不变，当前状态只能为 `active`/`rotating` 且未过期。唯一允许的语义变化是同 token digest 的 `active -> rotating`，旧 session 最长存活到当前记录与 snapshot 两个 `expiresAt` 的较早者（缺省 expiry 按正无穷处理）；其他 credential 变化返回 401 并销毁 session，security snapshot 不可用则按上一条返回 503 并销毁。
- **WebSocket**：每条消息复用握手时建立的 context 做轻量状态校验，resolver 仍检查当前 content hash；credential 状态失效即拒绝该消息并 `close(4401)`。对**空闲连接**，WS 层每 30 秒对已注册 `credentialId` 做一次状态重校验（该定时读取同时充当惰性重载的触发源），credential 被吊销或过期时主动 `close(4401)`，security snapshot 不可用时 `close(1013)`。时效承诺：**吊销写入有效凭据文件后，空闲 WS 连接在 ≤60 秒内断开**（一个校验周期 + 重载判定余量）；活跃连接在下一条消息即被拒绝。不依赖 `fs.watch`（跨平台语义不一致，且与既有 hotJsonConfigLoader 模式不合）。
- **Native SSE / 长驻事件流**（`/agent_gateway/events/stream` 及后续同类 endpoint）：连接建立时的认证不能覆盖整个响应生命周期。每次向流写出事件前必须重校验 credential 状态（复用同一 content-hash resolver）；对无事件可写的空闲流，比照 WS 每 30 秒周期重校验一次。credential 被吊销、过期或 owner revision 不再兼容时立即终止响应流（写出终止事件后 end），security snapshot 不可用时同样终止。时效承诺与 WS 一致：吊销后空闲 SSE 流 ≤60 秒内终止，活跃流在下一事件写出前被拒绝。
- **backend-proxy / stdio**：每次 backend 调用都由 canonical backend 按同一 content-hash 规则重新校验。HTTP / WS 透传的 credential 或 stdio backend credential 被吊销后，下一请求即被拒绝；proxy 边缘检查不是 backend 校验的替代品。

### 3.7 401 的 MCP 映射

现状 `errorMapping.js` 没有 `AGW_UNAUTHORIZED` 的 case，会落 default 退化为 `MCP_RUNTIME_ERROR`，且 `MCP_ERROR_CODES` 中没有对应码——客户端无法区分“认证失败”与“服务端运行时错误”。本方案新增 `MCP_UNAUTHORIZED` 并建立 `AGW_UNAUTHORIZED → MCP_UNAUTHORIZED` 映射：

- transport 层认证失败维持现状：HTTP 401、WebSocket 握手拒绝。
- 业务层（in-process executor、WS 逐消息校验、stdio 经 backend 返回）统一映射为 `MCP_UNAUTHORIZED`。

