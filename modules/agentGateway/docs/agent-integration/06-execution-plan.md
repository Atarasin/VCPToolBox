# 执行计划：Milestone → Slice → Task（§7 重组）

> 所属方案：[Agent 客户端集成方案](README.md) v6
> 本文取代原方案 §7 的 P0–P4 平铺结构。发布门禁与测试矩阵单源在 [05-testing-gates.md](05-testing-gates.md)；本文的验收项只引用，不复述。
> 引用约定：§3.x 见 [01-identity-authorization.md](01-identity-authorization.md)，§4.x 见 [02-config-data-model.md](02-config-data-model.md)，§5.x 见 [03-transport-surfaces.md](03-transport-surfaces.md)，§6 见 [04-skill-generation.md](04-skill-generation.md)。

## 层次与编号约定

- **Milestone（M0–M4）**：可独立发布/回滚的阶段，对应原 P0–P4。发布顺序硬约束：M1 先于 M2，M2 先于 M3；M0 与 M4 的部分 slice 可并行穿插（见各自依赖声明）。
- **Slice**：milestone 内可独立合并、独立验证的纵切增量。slice 之间的依赖显式声明；未声明依赖的 slice 可并行。
- **Task**：单人可在一次 PR 内完成的工作单元。每个 slice 末尾的 *验收* 任务是该 slice 的完成定义（DoD），引用 §8 矩阵行。

回滚约束（全局，适用于所有 milestone）：回滚只能关闭新 surface/行为并回到文件 credential 或阶段 A legacy credential，**不得**恢复 `outerAuthenticated` 直通、security last-known-good、静态 backend key fallback 或其他已关闭的安全旁路。

---

## M0：配置模型与可观测校验（原 P0）

目标：配置 schema、auth policy catalog 与 snapshot 协调器就位，为 M1 提供地基。无对外行为变化（除 S4 的 tool description）。

### M0.S1 配置 schema 与 example

依赖：无。

- [x] T1 新增 `config/agent_guidance.json` schema 与 example（§4.2：shared workflow / memoryWritePolicy / per-agent displayName、memoryDefaults）。
- [x] T2 新增 credential 文件 schema 与不含 secret 的 `.example`（§4.4：credentialId、pepperKid、tokenDigest、boundAgentId、allowedAgents、scopes、status、expiresAt）。
- [x] T3 新增 pepper keyring schema（§4.4：`{ keys: { kid: base64-secret } }`，256 bit 最小熵校验）。
- [x] T4 `agentGuidanceResolver` 骨架：经窄端口读取 agent directory 快照，合成只读 integration snapshot（§4.1；displayName 来自 guidance 配置，不来自目录）。
- [x] T5 验收：schema 校验用例（有效配置、未知 agent、default diary 非 allowed、损坏 JSON、未知 pepperKid）。

### M0.S2 Auth policy catalog

依赖：无（与 S1 并行）。

- [x] T1 为 canonical operation/surface catalog 增加互斥的 `credentialAction: "read"|"execute"|"authenticated"` 与 `authMechanism: "adminAuthBridge"` 字段（§3.5）；REST 与 MCP binding 引用同一 canonical action。
- [x] T2 登记不完全对应业务 operation 的 surface：initialize、discovery、resource read、skill download、admin session bridge。
- [x] T3 生成器与启动校验：两者皆无、两者并存、未知 scope/mechanism、binding action 不一致 → fail-fast（按 §3.5 定义：拒绝发布候选 snapshot，health 标记 degraded，仅 strict startup 下进程退出）。
- [x] T4 验收：§8「scope」「契约」行中 catalog 相关用例；`tools/list` descriptor 与 auth policy catalog 快照评审。

### M0.S3 Snapshot 协调与分域 fail-closed

依赖：S1、S2。

- [x] T1 实现 `integrationSnapshotCoordinator`（§4.3）：内容/调优候选变化时读取关联配置全集，交叉校验后一次性发布 `{ revision, contentHashes, agents }` 冻结快照。
- [x] T2 内容/调优配置的 last-known-good 语义：热加载失败保留旧快照，记录失败 content hash 与当前有效 revision；初始失败 health degraded + `AGW_CONFIG_UNAVAILABLE`。
- [x] T3 身份/授权配置的分域 security snapshot + fail-closed 语义（§4.3 第 2 类；实际 credential resolver 在 M1.S1 接入）。
- [x] T4 health 分域暴露：guidance 不可用 / credential 文件不可用 / pepper keyring 不可用 / authorization policy 不可用。
- [x] T5 新增 `AGW_CONFIG_UNAVAILABLE` 与 MCP `MCP_SERVICE_UNAVAILABLE` 错误码及映射。
- [x] T6 验收：§8「配置」行全部用例（初始失败/恢复、交叉引用错误、content hash、同 mtime/size、原子 rename、revision 一致性）。

### M0.S4 Tool description 重写

依赖：无。可与 M1 并行,但发布需 real-client smoke。

- [x] T1 重写 4 个核心 MCP tool description 的触发判断,不改身份与 schema 行为。
- [x] T2 验收：真实 client smoke 评审(模型行为变化,不标记为"无行为风险")。

---

## M1：身份基础设施（原 P1）

目标：credential → `effectiveAgentId` 端到端绑定,所有入口统一决议,吊销可传播。M1 完成前不得开始 M2 发布。

### M1.S1 Credential resolver 与 CLI

依赖：M0.S1、M0.S3。

- [x] T1 content-hash credential resolver：每次授权读取对 credential 文件与 pepper keyring 原始字节计算 SHA-256,两者均相同才复用解析快照(§3.6)。
- [x] T2 热路径实现约束：异步 I/O(禁止请求路径 `readFileSync`)、in-flight 读取合并(promise coalescing,无时间窗缓存)(§3.6)。
- [x] T3 HMAC-SHA256 digest 匹配:presented token 长度上限、恒时比较、命中且仅命中一条记录、跨 kid 重复 token 认证时拒绝(§4.4)。
- [x] T4 credential 生成/轮换 CLI:CSPRNG ≥256 bit token、`AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID` 仅供 CLI 选 kid(§4.4)。
- [x] T5 状态机 `active/rotating/revoked/expired` 与 credentialId 唯一性、tombstone(进程内尽早报错,正式防继承由 owner revision 承担,§4.4)。
- [x] T6 阶段 A 特例:`AGENT_GATEWAY_CREDENTIALS_PATH` 未设置 → 有效空 snapshot + migration warning;已设置但不可读 → fail-closed(§4.4)。
- [x] T7 验收:§8「credential」行全部用例 + 热路径基准(p99 附加延迟 < 5ms)。

### M1.S2 统一决议入口与错误映射

依赖：S1、M0.S2。

- [x] T1 `buildGatewayRequestContext()`:实现 §3.2 决议树(bound/unbound/admin-unbound-only),写回 `requestContext`/`authContext` 全部身份字段,丢弃客户端 body 同名字段。
- [x] T2 target candidate 冲突检测:path/query/body/URI 多来源规范化后必须相等,冲突 → `AGW_INVALID_REQUEST`(§3.2)。
- [x] T3 `authorizeTarget()` 两层授权:credentialScopes 与 agentPolicyScopes 串联交集(§3.5);scope 不足统一 `AGW_FORBIDDEN`。
- [x] T4 双通道呈现不一致 → 401(§3.3,替代现状 `gatewayKeyHeader || Bearer` 静默选边)。
- [x] T5 新增 `MCP_UNAUTHORIZED` 与 `AGW_UNAUTHORIZED → MCP_UNAUTHORIZED` 映射(§3.7)。
- [x] T6 认证失败限速:按 IP 滑动窗口、429 + `Retry-After`、结构化审计与 `authFailure` 指标(§3.3)。
- [x] T7 验收:§8「身份」「scope」行用例。

### M1.S3 Legacy 归一化与 admin session 子系统

依赖：S2。

- [x] T1 `AGENT_GATEWAY_KEY` 合成内置 legacy credential(`legacy-gateway-key`,unbound,admin scope;阶段 A 保留全量权限是有意为之,§3.3)。
- [x] T2 共享 `adminGatewaySessionStore`:多 worker 原子共享、按 expiry 清理、无生产 store 时创建返回 503(§3.3)。
- [x] T3 `POST/DELETE /agent_gateway/auth/admin-session`:adminAuth 前置验证、≥256 bit CSPRNG opaque id、HttpOnly cookie、session-bound CSRF token、`AGENT_GATEWAY_ADMIN_SUBJECT_KEY` 派生 subject(§3.3)。
- [x] T4 Origin 部署形态二选一:主端口同源反代,或 `AGENT_GATEWAY_ADMIN_ORIGINS` allowlist + 凭据 CORS + `SameSite=Lax` + Origin/CSRF 双校验;缺配置时 503(§3.3)。
- [x] T5 admin-session 映射为内置 credential(`admin-session`,unbound,admin),surface 限制:仅 Native 业务入口,`/mcp` 三 transport 拒绝;pre-credential bridge 只允许 session POST(§3.3)。
- [x] T6 三个独立开关 `AGENT_GATEWAY_LEGACY_KEY_DISABLED` / `AGENT_GATEWAY_ADMIN_FALLBACK_DISABLED` / `AGENT_GATEWAY_LEGACY_SCOPE_NAMES_DISABLED` 与 `authMigration` 指标(§3.3、§4.4)。
- [x] T7 收编 `req.agentGatewayAuth` / `req.agentGatewayDedicatedAuth` 命名裂缝:统一为单一注入点,消除 `ROUTE_REGISTRARS` 注册顺序依赖。
- [x] T8 验收:§8「REST」(admin session 部分)「迁移」行用例。

### M1.S4 Backend-proxy 凭据透传与 trusted context

依赖：S2。与 S3 并行。

- [x] T1 HTTP/WS transport 私有保存 presented token(不进 params/context/日志/审计;销毁时清引用,§3.3)。
- [x] T2 `GatewayBackendClient` request-scoped auth override,**改造 `createHeaders()` 覆盖顺序**:override 生效时互斥清除全部静态凭据通道(§3.3 点名陷阱)。
- [x] T3 HTTP/WS 生产路径禁止静态 backend key fallback,凭据丢失 fail-closed 401;静态 credential 仅限 stdio 单身份进程(§3.3)。
- [x] T4 backend 双侧解析一致性:`credentialId`/`credentialSubject`/`effectiveAgentId` 必须一致,revision 差异走 `isSessionCredentialCompatible()`(§5.1)。
- [x] T5 in-process adapter 只接受 resolver 构建的 `trustedCredentialContext`;MCP params 传入的 authContext 不得标记 trusted(§5.1;现状 `buildManagedToolContextInput` 合并 `args.requestContext` 的信任缺口在此关闭)。
- [x] T6 验收:§8「transport」行用例(含 override 与静态凭据并存组合)。

### M1.S5 Discovery 确定规则与冻结快照

依赖：S2。

- [x] T1 bound/unbound/admin 的 tools/resources/prompts list 确定规则(§3.4 补充规则;不依赖非标准 discovery agentId,越界返回空集合)。
- [x] T2 initialize-time 冻结 discovery snapshot:`{ discoveryRevision, tools, resources, prompts, visibleAgents }`,cursor 绑定 revision,保持 `listChanged:false`(§3.4)。
- [x] T3 HTTP 自愈 discovery 的短 TTL discovery session 同规则冻结。
- [x] T4 外部 HTTP/WS discovery 移除 `VCP_MCP_DEFAULT_AGENT_ID` 授权参与(仅保留 §5.5 stdio 开发兼容)。
- [x] T5 Native `/agents` 按相同可见集合过滤(§3.4)。
- [x] T6 验收:§8「discovery」行用例。

### M1.S6 间接对象所有权与吊销传播

依赖：S1、S2。

- [x] T1 job/event owner snapshot 固化:`{ credentialSubject, credentialId, credentialRevision, effectiveAgentId, trustedSessionId }`;所有 poll/cancel/resource/SSE 入口先 lookup owner 再授权(§3.4)。
- [x] T2 owner revision compatibility:仅同 token digest 的 `active -> rotating` 可继承;credentialId 重用/新 token 拒绝(§3.4)。
- [x] T3 trusted session 两情形校验与**收养**:session 存活不匹配 → 403;正常终止 → 同 subject + revision 兼容原子收养 + adoption 审计;吊销销毁不适用收养(§3.4)。
- [x] T4 HTTP session 所有权升级:从 gatewayId 比较改为 credential snapshot + 每请求 `isSessionCredentialCompatible()`(§3.6)。
- [x] T5 WS 吊销传播:逐消息校验 + 空闲连接 30s 周期重校验,`close(4401)`/`close(1013)`,≤60s 承诺(§3.6)。
- [x] T6 Native SSE 吊销传播:每事件写出前校验 + 空闲流 30s 周期重校验,≤60s 终止(§3.6)。
- [x] T7 security snapshot 不可用时的分域拒绝:HTTP 503、WS `close(1013)`、stdio `MCP_SERVICE_UNAVAILABLE`(§3.6)。
- [x] T8 验收:§8「session/job」行用例(含收养正反例)与「REST」行 SSE 用例。

### M1 里程碑门禁

- [ ] 两把不同 agent credential 的真实 HTTP/WS → backend-proxy → Native REST 链路互不可访问,审计主体不折叠。
- [ ] 发布前检查清单中标记 [M1] 的门禁项(05-testing-gates.md 第 1–4、6–7 条;第 8 条在阶段 B 关闭开关前完成)。

---

## M2：Guidance service 与 MCP surfaces（原 P2）

依赖：M1 全部。目标:guidance 单源产出,三层消费面(instructions/resource/bootstrap)一致。

### M2.S1 Guidance bundle 与 REST binding

- [x] T1 `agentGuidanceResolver` 输出完整 guidance bundle(§4.2:workflow、memoryWritePolicy、allowed/defaultDiaries 由 memory policy 注入、memoryDefaults、revision)。
- [x] T2 `GET /agent_gateway/agents/:agentId/guidance`:经 `buildGatewayRequestContext()` 校验 path agent;`restOperations.json` 注册 + OpenAPI path/schema/route binding 生成校验(§5.1、§5.4)。
- [x] T3 验收:REST guidance 用例;revision 与 snapshot 一致。

### M2.S2 MCP surfaces:resource、bootstrap、instructions

依赖：S1。

- [x] T1 guidance resource `vcp://agent-gateway/agents/{agentId}/guidance`:URI target 决议 + 绑定校验(§5.3)。
- [x] T2 bootstrap 附加 `integrationGuidance` 字段(与 resource 同 revision);绑定 credential 可省略 agentId(§5.3;schema 层 optional 化按 §5.4 顺序留在 M3.S1)。
- [x] T3 `resolveInstructions` per-request 选项贯通 harness/两 executor/三 transport;绑定 + read → ≤800 token 摘要(canonical 单点 `ceil(chars/4)` 计数);未绑定/execute-only → 通用文案不泄露 agent 内容(§5.2)。
- [x] T4 guidance/integration/mint 响应缓存头:`Cache-Control: private, no-store` + `Vary` 身份通道(§6;integration/mint endpoint 属 M4,届时复用同一头部约定)。
- [x] T5 验收:§8「guidance」行用例。

### M2.S3 双 adapter 差异收敛

依赖：S2。

- [x] T1 in-process bootstrap deferred 分支(`accepted`/`waiting_approval`)补齐 `summary`;两份 `buildBootstrapResult` 收敛到 canonical service(§5.1、§5.3)。
- [x] T2 `gateway_agent_render` 不再经 in-process `tools/call` 暴露,以 catalog `publishedAsTool: false` 为准(§5.1)。
- [x] T3 验收:§8「MCP」行用例;两 adapter 的 resource/bootstrap/REST 结果 revision 一致。

### M2.S4 真实客户端 capability smoke

依赖：S2、S3。

- [ ] T1 Claude Code、Codex、Kimi capability smoke;记录 instructions/resources 实际消费情况(填充 §5.3 兼容性矩阵)。
- [ ] T2 M2 门禁:无绑定连接只收通用 instructions;绑定连接只得所属 agent guidance;tool-only host 经 bootstrap 获取等价内容。

---

## M3：`agentId` optional 迁移（原 P3）

依赖：M2 全部。迁移顺序不可颠倒(§5.4)。

### M3.S1 Schema 与契约

- [ ] T1 修改 MCP catalog:`gateway_agent_bootstrap`、`gateway_recall_run` 的 `agentId` 改 optional(+ render prompt argument);jobs 保持 jobId-only(§5.4)。
- [ ] T2 重跑 descriptor export,更新契约快照;若放宽 Native REST 同步改 `restOperations.json`/OpenAPI(§5.4)。
- [ ] T3 验收:§8「契约」行;重生成 snapshot 零差异。

### M3.S2 行为与遥测

- [ ] T1 未绑定 credential 对直接 agent-scoped 操作保持 agentId 必填(受控 400);间接对象继续 owner lookup(§5.4)。
- [ ] T2 显式 `agentId` 调用比例 telemetry 与兼容说明;完成迁移后再评估废弃时间表。
- [ ] T3 M3 门禁:绑定省略成功/显式同 agent 成功/显式他 agent 403/未绑定省略 400/job 按 owner 授权。

---

## M4：Skill generator 与清理（原 P4）

依赖：M2(生成内容消费 guidance bundle);签名下载部分依赖 M1.S6(owner 语义)。

### M4.S1 生成器与 endpoint

- [ ] T1 Claude Code/Codex/Kimi 三 format 模板、manifest、内容哈希、固定文件清单;format allowlist(§6)。
- [ ] T2 `GET .../integration/skill` 与 `GET .../integration` endpoint,授权走 §3.2 同一决议表;`AGENT_GATEWAY_PUBLIC_BASE_URL` 校验(绝对 URL、生产 HTTPS、不从请求 host 推导)(§6)。
- [ ] T3 生成物零 secret:只含 endpoint、工具说明与安全 secret store 指引(§6)。
- [ ] T4 CLI export。

### M4.S2 签名下载

依赖：S1。

- [ ] T1 mint/redeem 权限分离:mint 按 `gateway:read` 授权;redeem 从 resolver/session store 重读 owner,校验 subject/revision 仍可用(§6)。
- [ ] T2 `AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET` 独立密钥 + `kid` 轮换(当前与前一把)(§6)。
- [ ] T3 `downloadNonceStore.consumeOnce()`:先校验后原子消费、消费后传输失败不恢复、共享跨重启 store、无生产 store 时 mint 503(§6)。
- [ ] T4 redeem 响应与链路:no-store 全套响应头、拒绝 redirect/Range/CDN 代答、代理与日志脱敏 query/signature/nonce(§6)。
- [ ] T5 验收:§8「L3」行全部用例。

### M4.S3 三格式验证与清理

依赖：S1、S2。

- [ ] T1 三 agent x 三 format 的 snapshot、manifest 校验、secret scan、真实安装 smoke(§6)。
- [ ] T2 迁移公告 + 现网确认后删除手写 `skills/midas-vcp/`(§6)。
- [ ] T3 M4 门禁:05-testing-gates.md 第 10 条。

---

## 依赖总览

```text
M0.S1 ──┬── M0.S3 ── M1.S1 ──┬── M1.S6 ──┐
M0.S2 ──┘                    │           │
M0.S2 ─────────── M1.S2 ──┬──┼───────────┼── M2.S1 ── M2.S2 ── M2.S3 ── M2.S4 ── M3 ── (发布收尾)
                          │  │           │              │
                 M1.S3 ───┤  │           │              └─ M4.S1 ── M4.S2 ── M4.S3
                 M1.S4 ───┤  │           │                    (M4.S2 另依赖 M1.S6)
                 M1.S5 ───┘  │           │
M0.S4(tool description) ── 独立,发布需 smoke
```

硬顺序:M1 → M2 → M3。M0.S4 与 M4.S1 的模板工作可提前并行,但 M4.S2 依赖 M1.S6 的 owner 语义,M4 整体发布在 M2 之后。
