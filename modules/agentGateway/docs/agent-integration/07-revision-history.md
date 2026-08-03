# 修订历史（附录）

> 所属方案：[Agent 客户端集成方案](README.md)。与当前正文冲突时，以 v6 正文和 v6 摘要为准。

以下条目按版本保留历史决策；与当前正文冲突时，以 v6 正文和 v6 摘要为准。

### v6.1（实现后反转记录：`agentId` 强制显式化）

2026-07-26 commit `4a65ab35`「强制显式传入 agentId，移除自动兜底逻辑」在 M3 交付**之后**推翻了 §5.4 的 optional 化方案：

- **动机**：避免将请求误导到默认或隐式 agent；身份校验显式化优先于调用方便利。
- **代码面**：MCP catalog 与生成 descriptors 恢复全部直接 agent-scoped tool/prompt 的 `agentId` 必填；移除绑定身份自动补全与 `VCP_MCP_DEFAULT_AGENT_ID` stdio 兜底；删除 `boundOmitted` 遥测埋点。`gateway_job_get`/`gateway_job_cancel` 的 jobId-only 语义不受影响。
- **文档面**（2026-08-03 本次补记）：§5.4 加状态框并保留原方案为历史记录；README 目标 2、§5.3 bootstrap 条目、执行计划 M2.S2 T2 与 M3.S1/M3.S2 同步标注。4a65ab35 当时只改了代码与 4 个测试文件，漏改 recall adapter 契约测试（后于 2026-08-03 修正断言）且未动文档，造成约一周的文档漂移——期间文档一直在描述被推翻的行为。
- **教训**：反转已交付 slice 时必须同步文档与全部契约测试，否则「文档说 optional、代码是必填」会诱导后人把安全收紧当 bug 修掉。

### v6（代码核实评审：间接对象生命周期与部署形态闭合）

本轮评审逐条核实了 v5 的现状断言（全部属实），修订集中在设计缺口与实现约束：

- **§3.4 job 孤儿修复**（本轮最重要项）：v5 规定 owner 含 trustedSessionId 时"缺失也 403"，与 HTTP MCP session 的 idle 销毁组合会把长任务 job 变成同凭据也无法访问的孤儿。v6 区分"session 存活但不匹配"（403）与"session 正常终止"（同 subject + revision 兼容可原子收养,记 adoption 审计）；credential 吊销导致的 session 销毁不适用收养。
- **§3.3 admin session Origin 与 AdminPanel 独立端口的冲突消除**：现状 `/AdminPanel` 302 到 `PORT+1` 独立进程,v5 的严格 same-origin + `SameSite=Strict` 会拒绝唯一合法调用方。v6 要求部署二选一：主端口同源反代（推荐）,或显式 `AGENT_GATEWAY_ADMIN_ORIGINS` allowlist + 凭据 CORS + `SameSite=Lax` + Origin/CSRF 双校验；缺配置时 session 创建 503。并补充 admin session 子系统对比"切断兜底 + 文件 credential"备选的规模决策记录。
- **§3.6 Native SSE 吊销传播补位**：v5 覆盖了 HTTP session/WS/backend/stdio 但漏掉 `/events/stream` 长驻响应。v6 比照 WS：每事件写出前重校验,空闲流 30s 周期重校验,吊销后 ≤60s 终止。
- **§3.6 热路径实现约束**：request-time content hash 保持不变,但明确要求异步 I/O、in-flight 读取合并（无时间窗缓存）与 p99 基准验收。
- **§3.3 认证失败限速**：credential 认证入口新增按 IP 的失败滑动窗口限速、429、结构化审计与 `authFailure` 指标。
- **§3.3 `GatewayBackendClient.createHeaders()` 覆盖顺序点名**：现实现静态 gatewayKey 后写覆盖 extraHeaders、bearer 仅缺省补写,与 request-scoped override 组合会产生不一致双通道。v6 要求 override 生效时互斥清除全部静态凭据通道,并对并存组合专门测试。
- **§4.4 tombstone 定位澄清**：tombstone 为进程内尽早报错机制,不跨重启/worker；防继承正式保证由 owner `credentialRevision` 承担,禁止以共享 tombstone store 替代 revision 校验。
- **措辞修正**："不新增客户端 header"限定为凭据呈现面（CSRF header 不违反）；§5.2 的 800 token 近似定为 canonical service 单点实现的 `ceil(chars/4)`；v3 附录的"mtime+size 现状"表述修正（现状 loader 仅比较 `mtimeMs`）。
- **P1/§8**：以上全部同步进交付项、验证段与测试矩阵（收养、Origin 部署形态、SSE 终止、限速、override 并存、热路径基准）。

### v5（安全配置、管理员会话与生命周期闭合评审）

- **§3.3 admin fallback 可实现化**：明确现有 `admin_auth` 只是 Basic 凭据副本，不是服务器会话，除 session bridge 外不能直接访问 agent 业务；新增 Native-only Gateway admin session store/endpoint、opaque cookie、subject key、same-origin/CSRF、subject/revision 与独立关闭开关，`/mcp` 三 transport 不接受 admin-session。
- **§3.4 owner 与 discovery 生命周期闭合**：job/event owner 增加 credential revision 和 trusted session，禁止 credentialId 换 token 后继承旧对象；文件 admin 与 Native admin-session 的跨 owner 能力分离。MCP 保持 `listChanged:false`，initialize 时冻结 discovery snapshot，调用时仍按当前安全策略授权。
- **§3.6/§4.3 安全配置 fail-closed**：last-known-good 只用于 guidance 文案、展示字段和不扩大准入面的调优配置；credential/keyring、agent publication 与 tool/diary authorization policy 的初始或热加载失败在对应安全域返回 service unavailable，并销毁受影响 session/connection，不再让损坏的撤销或授权文件延续旧 token/权限。
- **§4.4 credential 身份强化**：CLI/token/pepper 增加最小熵要求和输入上限；credentialId 强制唯一且不可换 token 重用，owner revision 提供第二层防继承保护。
- **§6 签名下载的一次性语义闭合**：URL 明确视为 bearer capability；补充 admin-session owner 复核、原子 nonce 消费顺序、HTTPS/public URL 校验、no-store 响应、代理缓存旁路和 query 日志脱敏，避免缓存绕过 nonce store。
- **P0-P4/§8**：实施项、故障注入、迁移开关、discovery snapshot、owner revision、缓存重放和真实客户端门禁同步更新。

### v4（实现前安全与契约闭合评审）

- **§3.3/§5.1 proxy 身份闭合**：HTTP / WebSocket 改为逐请求透传原始客户端 credential，canonical backend 再解析并以 backend 结果为准；静态 `VCP_MCP_BACKEND_KEY` 仅保留给 stdio，禁止外部 proxy 缺凭据时回退。in-process 只接受 resolver 构建的 trusted context。
- **§3.4 间接对象授权**：job/event 固化 credential subject、effective agent 与 session owner snapshot，读取、取消、resource 和 SSE 均先 lookup owner 再授权；同 agent 跨 credential 默认拒绝。
- **§3.4 discovery 语义闭合**：不再依赖非标准 discovery agentId。bound 返回单 agent 动态能力；unbound tools 只返回 canonical 公共集合、resources 分页枚举 allowedAgents；Native `/agents` 使用相同可见集合，外部 default-agent 不参与授权。
- **§3.5 scope 单源**：scope 重命名为协议无关的 `gateway:read` / `gateway:execute`，为每个 canonical operation/surface 增加 `credentialAction`，由 REST 与 MCP binding 共同引用并在生成/启动时校验；旧 scope 名使用独立迁移开关，不复用 legacy 认证关闭开关。
- **§3.6/§4.4 credential 生命周期**：强制每次授权读取计算 content hash，移除 mtime+size 作为充分重载判据；token digest 增加 pepperKid keyring、显式轮换流程与 fail-closed 规则。
- **§3.3 admin subject**：`admin-session` 只用于迁移聚合，session/job ownership 使用服务端验证 session 派生的不可逆 `credentialSubject`，避免不同 admin session 共用固定主体。
- **§6 下载语义**：签名 URL mint/redeem 权限分离，引入原子、TTL、共享、跨重启的 nonce store port；无生产 store 时禁用 mint。Claude Code、Codex、Kimi 三种生成格式全部进入 snapshot、secret scan 与真实安装门禁。
- **P0-P4/§8**：将以上决议同步为明确交付物、真实 proxy 链路测试、同 mtime/size 吊销测试、跨 credential job 测试和三客户端发布门禁。

### v3（第二轮代码核实评审）

事实修正：

- **§5.1/§5.3 `summary` 现状更正**：v2 称"仅 proxy 路径附加"不属实——in-process 与 proxy 均有 `buildBootstrapResult` 并附加 `summary`；真实缝隙是 in-process 的 deferred（`accepted`/`waiting_approval`）分支缺失。对齐工作改写为补齐该分支并收敛两份重复实现。
- **§3.4 discovery 现状更正**：v2 称"枚举全部 agent 的 per-agent resource"不属实——现状经 `resolveDiscoveryAgentId` 解析单个 agent（显式 → `VCP_MCP_DEFAULT_AGENT_ID` → 唯一发布 agent），泄漏面是"无关凭据可见 default agent 资源"而非全量枚举。可见集合对策不变，并补充显式越界 agentId 的 list/read 语义。

设计缺口修补：

- **§3.3 admin 兜底路径归一化**（本轮最重要项）：server.js adminAuth 对 agent gateway 路径存在第二条认证路径（未呈现 gateway key 时落 admin Basic auth/cookie 兜底，合成 `outerAuthenticated` 放行），v2 未处置。v3 将其映射为内置 `admin-session` credential 进入同一决议表与审计，`authMigration` 同步观测，阶段 B 开关同时关闭 legacy 与 admin 兜底两条内置路径；并修正"只有一条认证路径"的表述为"只有一个决议入口"。
- **§3.2/§4.4/§6 admin scope 与绑定凭据的矛盾消除**：v2 中 §3.2 决议树对绑定凭据无 admin 分支，§6 却允许"绑定一致或持 admin scope"。v3 规定 `admin` scope 只允许出现在 `boundAgentId: null` 的 credential 上（配置校验 fail-fast），决议树保持唯一，skill 下载授权改为引用同一张表。
- **§3.6 WS 失效通知与惰性重载的矛盾消除**：`hotJsonConfigLoader` 是纯被动机制，v2 的"注册失效通知"对空闲连接永不触发。v3 改为：活跃连接逐消息校验，空闲连接 30s 周期重校验（兼作重载触发源），承诺吊销后空闲连接 ≤60s 断连；不采用 `fs.watch`。

次要收紧：

- **§3.3**：双通道（`x-agent-gateway-key` 与 Bearer）同时呈现且不一致时 401，替代现状静默选边；明示阶段 A legacy credential 保留全量权限是有意为之。
- **§3.6**：重载判据定为 mtime+size 并注明 mtime 粒度边界（当时现状 `hotJsonConfigLoader` 仅比较 `mtimeMs`；该判据已被 v4 的 request-time content hash 取代）。
- **§4.3**：`AGW_CONFIG_UNAVAILABLE` 的 MCP 侧从复用 `MCP_RUNTIME_ERROR` 改为新增 `MCP_SERVICE_UNAVAILABLE`。
- **P1**：命名裂缝条目补充现状细节（systemRoutes 桥接 + `ROUTE_REGISTRARS` 注册顺序依赖）。
- **§8**：测试矩阵与门禁同步以上全部变更。

### v2（第一轮评审）

相对 v1 的主要变更：

- **事实修正**：“8 个 MCP 工具”更正为 7 tool + 1 prompt（§2）；bootstrap `summary` 字段标注为仅 proxy 现状并纳入对齐工作（§5.1、§5.3）；`createMcpHarness` 现状更正为“静态 instructions 选项未被使用”而非“隐含 session 参数”（§5.2）；`displayName` 来源澄清为 guidance 配置而非 agent directory（§4.1）；“memory policy service”更正为 memory policy 模块（§4.2）。
- **新增 §3.3**：凭据呈现通道（复用现有 header，不新增）、存量 `AGENT_GATEWAY_KEY` 归一化为内置 legacy credential、观察/执行两阶段上线策略。
- **新增 §3.4 入口行**：MCP discovery（list 面）纳入授权模型，定义可见集合规则；补充 JSON-RPC batch 逐项授权与 AdminPanel 路由范围声明；session 现状补充 gatewayId 默认值导致比较失效的问题。
- **新增 §3.5**：credentialScopes（认证面）与既有 agentPolicyScopes（业务面）的串联交集语义。
- **新增 §3.6**：吊销传播机制与时效——mtime 惰性重载无缓存窗口、session 每请求校验与轮换期行为、WS `close(4401)`、stdio 次请求拒绝。
- **新增 §3.7**：补齐 `AGW_UNAUTHORIZED` 的 MCP 映射缺口，新增 `MCP_UNAUTHORIZED`。
- **§4.3**：初始加载失败的受控错误明确为新增的 `AGW_CONFIG_UNAVAILABLE`（REST 503）。
- **§4.4**：给出 token 冲突 fail-closed 规则、scope 词表与 `allowedAgents` 语义；明确 legacy 冲突 fail-fast。
- **§5.4**：标注 `agentId` 改 optional 的实际 schema 改动面（bootstrap 与 recall_run 两处），并补充 mcpDescriptors 为构建产物需重跑 export。
- **§5.5**：补充 stdio 单进程单身份约束。
- **§6**：补充下载签名密钥管理（独立 secret、`kid` 轮换、nonce 一次性）。
- **P1/P2 与 §8**：同步扩充 legacy 迁移、discovery 过滤、吊销传播、双 adapter 对齐的交付物与测试门禁。
