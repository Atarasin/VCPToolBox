# AdminPanel Agent 凭据管理模块设计

> 状态：已实现（v1；实现与本文 §4–§5 一致，验证记录见 §10 落地说明）
> 日期：2026-08-17
> 范围：AdminPanel 新增「Agent 对外网关」管理页 + `/admin_api/agent-gateway/*` 管理路由
> 前置阅读：[02-config-data-model.md](02-config-data-model.md) §4.4（credential 数据模型）、[agent-onboarding-walkthrough.md](agent-onboarding-walkthrough.md) §三（现有 CLI 手工流程）

---

## 1. 背景与目标

Agent 对外上线的凭据铸造 / 轮换 / 吊销目前依赖在服务器 shell 执行
`scripts/agent-gateway-credential-cli.js`（create / rotate / revoke），对非运维人员不可达，且操作记录只存在于 shell 历史与文件系统中。

本方案在 VCP 自带控制中心（AdminPanel）内实现凭据全生命周期管理，并给出 agent 与密钥的绑定总览。

### 目标

1. **页面即操作台**：创建（铸造）、轮换、吊销 agent 绑定凭据，替代 CLI 的日常使用；CLI 保留作为应急 / 脚本通道（§7）。
2. **UI 一致**：复用 AdminPanel-Vue 现有 `Ui*` 组件体系、`api/` 模式与注册机制，不引入新前端依赖。
3. **以新增文件为主**：对既有源码只做**纯追加**的注册行（后端 1 处、前端 2 处 + 可选 2 处），最大限度降低上游合并冲突（§8）。
4. **不削弱既有安全属性**：token 仍只在铸造 / 轮换响应中出现一次；文件仍只保存 HMAC digest；原子写 + 0600 权限 + 写后校验回滚（§4.4）。

### 非目标

- 不改变 `/agent_gateway` 业务面的统一授权模型。新路由属于 AdminPanel 管理路由，继续由 `adminAuth`（Basic / cookie）保护——这与 [README.md](README.md) §2「AdminPanel/system 管理路由不在统一授权模型内」的既有决议一致。
- 不管理 pepper keyring 的创建与轮换（keyring 是 secret 文件，维持手工管理；页面只读展示 kid 状态，见 §5.2）。
- 不做 guidance / memory policy / recall profile 三份策略文件的编辑器（walkthrough §二，列为 V2）。
- 不实现 unbound `admin` scope 凭据的页面创建（仅展示既有记录；此类凭据影响面跨全部 agent，维持 CLI / 手工通道，见 §4.3）。
- 不引入 OAuth、不改变 MCP/REST 协议面。

---

## 2. 现状盘点（实现依赖的事实）

| 事实 | 位置 / 值 |
|---|---|
| 凭据记录文件 | `data/agent_gateway/agent_gateway_credentials.json`（`AGENT_GATEWAY_CREDENTIALS_PATH`），仅存 `tokenDigest = HMAC-SHA256(pepper, token)`，现有 2 条：`fupeng-ext-2026-08` → `MCPFuPeng`、`midas-ext-2026-08` → `MCPMidas` |
| pepper keyring | `data/agent_gateway/agent_gateway_credential_peppers.json`（`AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH`），活跃 kid `credential-pepper-2026-08` |
| 铸造 CLI | `scripts/agent-gateway-credential-cli.js`：CSPRNG 32B base64url token；tmp+0600+fsync+rename 原子写；`create/rotate/revoke` 三动作 |
| 可复用校验/摘要函数 | `policy/credentialConfigSchema.js`（`parseCredentialFileConfig` / `parsePepperKeyringConfig`）、`policy/credentialResolver.js`（`computeTokenDigest`） |
| 认证快照热加载 | `credentialResolver` 按文件内容哈希缓存，**写文件即生效**，无需重启、无需通知 |
| 吊销传播 | `policy/revocationWatcher.js`：30s 周期重校验，空闲 SSE/WS ≤60s 断开 |
| scope 词表 | `gateway:read`、`gateway:execute`、`admin`；`admin` 仅允许 `boundAgentId: null`（02 §4.4） |
| agent 清单权威源 | `agent_map.json`，经 service bundle 的 `agentRegistryService.listAgents()` / `ports.agentDirectory` 暴露 |
| AdminPanel 架构 | Vue3+Pinia 前端（`AdminPanel-Vue/`）→ 独立管理进程 `adminServer.js`（PORT+1，adminAuth）→ 未命中本地模块的 `/admin_api/*` **兜底反代**到主进程 |
| 主进程 API 挂载 | `server.js` `app.use('/admin_api', adminPanelRoutes)`；子模块经 `routes/adminPanelRoutes.js` 的 `mount()` 列表注册 |
| 前端路由注册 | `src/app/routes/manifest.ts`（`AppRouteId` 联合类型 + `APP_ROUTE_MANIFEST` 数组）、`src/app/routes/components.ts`（组件映射） |

---

## 3. 总体架构

```text
浏览器
  │  https://host:(PORT+1)/AdminPanel/agent-gateway-manager     ← Vue 页面（新）
  ▼
adminServer.js（独立进程，adminAuth 已通过）
  │  /admin_api/agent-gateway/*  未命中 localModules → 兜底反代（既有机制，零修改）
  ▼
主进程 server.js  /admin_api（adminAuth 已通过）
  │  routes/adminPanelRoutes.js  mount("/", "agentGateway")     ← 唯一后端注册行（新）
  ▼
routes/admin/agentGateway.js（新）─ Express 路由层：参数校验 / 错误映射 / 审计
  ▼
modules/agentGateway/services/credentialAdminService.js（新）─ 领域服务
  │   复用：parseCredentialFileConfig / parsePepperKeyringConfig / computeTokenDigest
  │   新增：进程内写互斥、.bak 备份回滚、审计事件
  ▼
data/agent_gateway/agent_gateway_credentials.json（原子写，0600）
  ▼（内容哈希变化，下一次认证请求自动使用新快照）
credentialResolver → authInjection → MCP / REST / session / skill 下载全部入口生效
                         revocationWatcher（30s）→ 空闲 SSE/WS ≤60s 断开
```

### 关键决策

| 决策 | 理由 |
|---|---|
| 后端模块挂**主进程**而非 adminServer 本地模块 | 主进程持有 `getGatewayServiceBundle(pluginManager)`（快照、agent 清单、switches），天然单写者；adminServer 兜底代理已存在，`adminServer.js` 零修改 |
| 管理路由走 `/admin_api` + adminAuth，**不**走 `/agent_gateway/auth/admin-session` bridge | 该 bridge 是给浏览器访问 agent **业务面**用的过渡通道（01 §3.3）；凭据管理属于管理面，与既有 `/agent_gateway/health` 同类。复用 adminAuth 避免再碰 Origin/CSRF 部署约束 |
| 核心逻辑放 `credentialAdminService` 而非写在路由文件里 | 路由层薄（校验+编排），领域逻辑可独立评审；与 CLI 的文件约定逐条对齐，后续 CLI 可选迁移复用（§7） |
| token 只经 HTTPS 响应一次性下发，浏览器端生成 `.token.txt` 下载 | 服务端不落任何明文 token 文件（现有 `*.token.txt` 是手工流程产物，保留但不再新增） |
| 前端以 `features/agent-gateway/` 新目录组织，`views/` 只放薄壳 | 与 `features/rag-tuning` 等既有模式一致；上游几乎不会动到新目录 |

---

## 4. 后端设计

### 4.1 新增文件与注册

| 文件 | 类型 | 说明 |
|---|---|---|
| `modules/agentGateway/services/credentialAdminService.js` | 新增 | 凭据管理领域服务（§4.2） |
| `routes/admin/agentGateway.js` | 新增 | Express 子路由，处理 `/agent-gateway/*` |
| `routes/adminPanelRoutes.js` | **追加 1 行** | `mount("/", "agentGateway"); // Handles /agent-gateway/*` |

不修改：`server.js`、`adminServer.js`、`scripts/agent-gateway-credential-cli.js`、`modules/agentGateway/` 既有文件。

依赖注入沿用 `mount()` 的 `options`：只用 `options.pluginManager`（按请求惰性解析 service bundle，模式同 `composition/lazyGatewayCredentialService.js`，规避启动顺序问题）；路径与环境开关由服务自身从 `process.env` 读取，与 `createGatewayServiceBundle` 的取值口径一致。

### 4.2 credentialAdminService

```js
createCredentialAdminService({
    credentialsPath,        // process.env.AGENT_GATEWAY_CREDENTIALS_PATH
    pepperKeyringPath,      // process.env.AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH
    activePepperKid,        // process.env.AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID
    listAgentIds,           // async () => string[]，来自 agentRegistryService.listAgents()
    now = () => Date.now(),
    logger = console,
    auditSink               // infra/auditLogger 的 sink
})
```

| 方法 | 行为 |
|---|---|
| `getStatus()` | 只读。返回路径配置、kid 列表（**不含 pepper secret**）、活跃 kid、快照可用性与失败原因、记录数。供页面状态横幅 |
| `listCredentials()` | 只读。返回脱敏记录数组（credentialId、pepperKid、boundAgentId、allowedAgents、scopes、status、expiresAt、credentialRevision）。不返回 tokenDigest |
| `createCredential(input)` | 校验 → CSPRNG 生成 token（32B base64url）→ `computeTokenDigest` → 追加记录 → 持久化。返回 `{ record, token }`，token 仅此一次 |
| `rotateCredential({ credentialId, newCredentialId?, oldExpiresAt })` | 旧记录置 `rotating` + 显式 `expiresAt`（未提供则拒绝）；新 credentialId + 新 token 置 `active`。返回 `{ previous, record, token }` |
| `revokeCredential({ credentialId })` | 置 `status: "revoked"`。幂等：已 revoked 时返回现状不报错 |

持久化约定（与 CLI 逐条对齐并加强）：

1. 写前 `parseCredentialFileConfig` 校验现有文件；文件不存在视作空集（同 CLI）。
2. 写前复制 `*.bak`；tmp 文件 0600 + fsync + rename 原子替换（同 CLI `writeCredentialFile`）。
3. 写后**重读并再次校验**；失败用 `.bak` 回滚并抛错（网关对坏文件 fail-closed，等价全量 401，必须自动恢复）。
4. 进程内 promise 队列串行化全部写操作（管理员双开页面 / 连点不会交错写）。
5. 审计事件只含 `credentialId`、动作、boundAgentId、结果；`infra/auditLogger` 的 `SENSITIVE_KEY_PATTERN` 兜底脱敏 token 字段。

### 4.3 API 契约（前缀 `/admin_api/agent-gateway`）

响应信封沿用 admin 模块惯例：成功直接返回数据对象，失败 `{ error, details? }` + 明确状态码（400 参数 / 404 不存在 / 409 冲突 / 500 内部 / 503 未配置或快照不可用）。

| 方法 & 路径 | 入参 | 响应（要点） |
|---|---|---|
| `GET /status` | — | `{ configured, credentialsPath, pepperKeyringPath, pepperKids[], activeKid, activeKidMissing, snapshotAvailable, snapshotReasons[], total }` |
| `GET /agents` | — | `{ agents: [{ agentId, displayName? }] }`（绑定下拉数据源） |
| `GET /credentials` | `?status=&boundAgentId=` 过滤 | `{ credentials: CredentialView[] }` |
| `POST /credentials` | `{ boundAgentId, scopes: ["gateway:read","gateway:execute"], expiresAt, credentialId?, allowedAgents? }` | `{ credential, token }`；`credentialId` 缺省自动生成 `{agentId 小写}-ext-{YYYY-MM}`；重复 id → 409 |
| `POST /credentials/:credentialId/rotate` | `{ oldExpiresAt, newCredentialId? }` | `{ previous, credential, token }` |
| `POST /credentials/:credentialId/revoke` | — | `{ credential }` |

校验规则（路由层独立完成，不依赖前端）：

- `boundAgentId` 必须存在于 agent 清单（404 语义 → 400）。
- `scopes` ⊆ 词表白名单；本路由**拒绝** `admin` scope（unbound 凭据维持 CLI 通道，见 §1 非目标）。
- `credentialId` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`。
- `expiresAt` / `oldExpiresAt` 为合法 ISO 时间且晚于当前；`oldExpiresAt` 必填（rotation 语义要求旧凭据有明确窗口）。
- 凭据文件未配置（阶段 A）或快照不可用时，全部 mutation 返回 503 并附原因；只读接口正常返回以支撑页面引导。

### 4.4 安全设计

- **鉴权**：全部落在既有 `/admin_api` adminAuth 之后，不新增机制；adminServer 与主进程双重 adminAuth 链路不变。
- **token 一次性**：仅 create/rotate 的响应体出现；不写日志（auditLogger 脱敏）、不写文件、不出现在任何 GET 响应中。
- **CSPRNG**：`crypto.randomBytes(32).toString('base64url')`，≥256 bit，同 CLI。
- **fail-closed 兼容**：任何校验/IO 失败时不落半成品文件（tmp+rename），失败响应 503 并保留旧文件继续有效——错误配置不替换现行有效快照（02 §4.1 决议 2 的管理面延伸）。

---

## 5. 前端设计

### 5.1 新增文件与注册

```text
AdminPanel-Vue/src/
├─ api/agentGateway.ts                    # agentGatewayApi + 类型（requestWithUi 模式）
├─ features/agent-gateway/                # 全部新目录
│  ├─ AgentGatewayManager.vue             # 页面主体
│  ├─ GatewayStatusBanner.vue             # 子系统状态横幅
│  ├─ CredentialTable.vue                 # 凭据表格
│  ├─ CredentialCreateModal.vue           # 铸造表单
│  └─ TokenRevealModal.vue                # 一次性令牌出示
└─ views/AgentGatewayManager.vue          # 薄壳（同 views/RagTuning.vue 模式）
```

对既有文件的**纯追加**修改：

| 文件 | 追加内容 |
|---|---|
| `src/app/routes/manifest.ts` | `AppRouteId` 联合类型 + `"agent-gateway-manager"`；`APP_ROUTE_MANIFEST` 数组追加 `{ id: "agent-gateway-manager", routeName: "AgentGatewayManager", path: "/agent-gateway-manager", title: "Agent 对外网关", icon: "key", requiresAuth: true, navGroup: "agentContent", showInSidebar: true }`（置于 agentContent 组末尾） |
| `src/app/routes/components.ts` | `"agent-gateway-manager": () => import("@/views/AgentGatewayManager.vue")` |
| `src/api/index.ts`（可选） | `export { agentGatewayApi } from './agentGateway'` |

侧边栏无需单独改动——`buildSidebarNavItems()` 由 manifest 派生。

### 5.2 页面布局

```text
┌─ Agent 对外网关 ────────────────────────────────────────────── [新建凭据] ┐
│ ⚙ 状态横幅（GatewayStatusBanner）                                        │
│  凭据文件 data/agent_gateway/….json · 2 条记录 · 快照可用 ✓               │
│  pepper kid: credential-pepper-2026-08（活跃） ⚠ 活跃 kid 未设置时黄条提示 │
├───────────────────────────────────────────────────────────────────────┤
│ [搜索 credentialId____] [绑定 Agent ▼ 全部] [状态 ▼ 全部]                │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ 状态   │ 凭据 ID              │ 绑定 Agent │ Scope      │ 到期        │ │
│ │ ●active│ fupeng-ext-2026-08 ⧉ │ MCPFuPeng  │ readexecute│ 2027-02-01 │ │
│ │        │                      │            │            │ [轮换][吊销]│ │
│ │ ●active│ midas-ext-2026-08 ⧉  │ MCPMidas   │ readexecute│ 2027-02-01 │ │
│ │ …rotating / revoked / expired 以徽章色区分；rotating 行附剩余有效期     │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

组件复用：`UiSection` / `UiToolbar` / `UiTableFrame` / `UiBadge`（状态徽章）/ `UiButton` / `UiSelect` / `UiInput` / `BaseModal` / `ConfirmDialog`（轮换、吊销确认）/ `FeedbackHost`（`requestWithUi` 自动接入 toast 与 loading）。样式全部走既有主题 CSS 变量，无新依赖。

### 5.3 关键交互流

**铸造**：`CredentialCreateModal` —— 绑定 Agent 下拉（`GET /agents`）→ scopes 复选（默认 `read`+`execute`，`admin` 不出现）→ 有效期预设（90 / 180 / 365 天 / 自定义日期，默认 180 天）→ credentialId 自动带出 `{agent}-ext-{YYYY-MM}` 可改（前端先做格式校验）→ 提交成功进入 **TokenRevealModal**：等宽大字号 token + 复制按钮 +「下载 .token.txt」（浏览器端 Blob 生成，服务端零明文）+ 高警示文案「**令牌仅显示一次，关闭后无法找回**」，关闭需勾选「我已妥善保存」。

**轮换**：`ConfirmDialog` 说明「旧令牌将在所设时间失效，新令牌立即生效」→ 旧凭据失效窗口预设（默认 7 天）→ 成功后同样进入 TokenRevealModal，表格刷新出现 `rotating`（旧）与 `active`（新）两行。

**吊销**：危险样式 `ConfirmDialog`（展示 credentialId + 绑定 Agent）→ 成功 toast + 表格行变 `revoked`；页面文案注明「已建立的空闲连接将在约 1 分钟内断开」。

**异常引导**：状态横幅在凭据文件未配置 / keyring 缺失 / 快照不可用时显示黄/红条与配置指引（阶段 A 场景），mutation 按钮置灰。

---

## 6. 热加载与一致性

- **生效路径**：写文件 → `credentialResolver` 内容哈希变化 → 下一次认证请求构建新快照 → MCP / REST / session / skill 下载全入口一致生效。无需重启、无需调用任何 reload API。
- **吊销传播**：`revocationWatcher` 30s 周期重校验（定时读取兼任惰性重载触发），空闲 SSE/WS ≤60s 断开；新认证立即 401。
- **双进程部署形态**：模块只在主进程加载（adminServer 的 `localModules` 不含 `agentGateway`），面板请求经兜底代理到达主进程，**单一写者**；adminServer.js 不修改。
- **与 CLI 并存**：两者对同一文件做「读-改-原子写」，靠 0600 原子 rename 保证不产生交错半成品；service 的进程内互斥覆盖主进程内的并发（含本模块自身）。

---

## 7. 与 CLI 的关系

`scripts/agent-gateway-credential-cli.js` **保留不动**，定位：

- 应急通道（面板不可用时）与初始化脚本用途；
- unbound `admin` scope 凭据、pepper keyring 生成等低频高危操作的唯一入口；
- 现有 `*.token.txt`（手工流程产物）按运行数据保留，面板不读不写。

后续可选（非本方案范围）：将 CLI 的文件操作迁移为复用 `credentialAdminService`，消除两份写逻辑。迁移前两者以「文件格式 + 原子写 + schema 校验」三项契约为准，交叉操作一致性已在验收清单覆盖。

---

## 8. 上游合并策略（改动清单汇总)

| # | 文件 | 改动性质 |
|---|---|---|
| 1 | `routes/adminPanelRoutes.js` | 追加 1 行 `mount()` |
| 2 | `AdminPanel-Vue/src/app/routes/manifest.ts` | 类型联合 +1 项、数组 +1 项（纯追加） |
| 3 | `AdminPanel-Vue/src/app/routes/components.ts` | +1 行映射 |
| 4 | `AdminPanel-Vue/src/api/index.ts` | +1 行导出（可选） |
| 5 | `modules/agentGateway/docs/agent-integration/README.md` | 文档地图 +1 行（可选） |
| 新 | `modules/agentGateway/services/credentialAdminService.js`、`routes/admin/agentGateway.js`、`AdminPanel-Vue/src/api/agentGateway.ts`、`AdminPanel-Vue/src/features/agent-gateway/*`（5 个 Vue 文件）、`AdminPanel-Vue/src/views/AgentGatewayManager.vue` | 全部为新增文件 |

全部为**列表尾部 / 类型尾部追加**，无删改移动；`server.js`、`adminServer.js`、`Plugin.js`、agentGateway 既有源码零修改。上游更新时即使行号漂移，冲突形态为「两侧各加一行」，保留两侧即可。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 写坏凭据文件 → 网关 fail-closed 全局 401 | .bak 备份 → 原子写 → 重读校验 → 失败自动回滚并 503（§4.2 持久化约定 3） |
| 多页面 / 双击并发写 | 主进程单写者 + 进程内写互斥队列 |
| token 泄露（响应、日志、浏览器） | 一次性响应、审计脱敏、UI 强警示 + 主动关闭确认；传输安全依赖部署层 HTTPS（与现状 CLI 终端回显同级） |
| 误吊销 / 误轮换 | ConfirmDialog 双确认 + 审计留痕；吊销不可逆语义与 CLI 一致，轮换可平滑恢复（新旧并存的既有语义） |
| credentialId 撞名 / token 撞 digest | 前者 409；后者由 schema 的 kid+digest 唯一性加载校验兜底（02 §4.4 匹配与冲突规则） |
| 阶段 A 未配置凭据文件 | mutation 503 + 状态横幅引导，不静默降级 |

---

## 10. 验收清单

- [ ] 面板正确列出 `data/agent_gateway` 现有 2 条凭据（fupeng / midas，均 active，2027-02-01 到期）。
- [ ] 铸造：选定 agent → token 出示一次 → 用该 token `curl` `/agent_gateway/capabilities`（或 MCP `tools/list`）认证通过；文件权限 0600、JSON 可通过 `parseCredentialFileConfig`、无 `.tmp`/`.bak` 残留（成功路径）。
- [ ] 吊销：认证立即 401；已建立的空闲 SSE 流 ≤60s 断开。
- [ ] 轮换：旧记录 `rotating` + 显式 `expiresAt` 且旧 token 在窗口内仍可用；新 token 立即可用。
- [ ] 防护：重复 credentialId → 409；未知 agentId / 非法 scope / 非法日期 / `admin` scope → 400；未配置凭据文件 → mutation 503 且横幅有指引。
- [ ] 交叉一致性：CLI 侧 revoke 后刷新页面状态同步；页面铸造的凭据可被 CLI `rotate`。
- [ ] 部署形态：经 PORT+1 独立面板进程访问功能正常（兜底代理链路）。
- [ ] 审计：铸造/轮换/吊销各产生一条只含 credentialId 的审计记录。

---

## 11. 后续扩展（V2 候选，均不阻塞本方案）

1. guidance / memory policy / recall profile 三份策略文件的查看与编辑（对齐 walkthrough §二的手工流程）。
2. pepper kid 管理（生成新 kid、切换活跃 kid）与凭据侧 kid 轮换引导。
3. unbound `admin` 凭据的高级模式创建（额外确认与更严审计）。
4. skill 包下载入口对接（复用既有 `skillDownloadRoutes` 的签名下载）。
5. 页面内置「连通性自检」：铸造后一键发起一次该 credential 的认证探测。
6. CLI 迁移复用 `credentialAdminService`（§7）。

---

## 12. 实现记录（2026-08-17）

按 §4–§5 落地，与原设计的差异与增强：

- **自动命名去重**：自动命名的 credentialId 撞名时追加 `-r2/-r3…` 序号（同月多次轮换的常见场景）；用户显式指定的 ID 撞名仍返回 409。
- **rotate 增强**：接受可选 `expiresAt` 为新记录设定到期时间（缺省长期有效，CLI 同语义）；**拒绝轮换已吊销记录**（CLI 无此检查，属安全增强）。
- **revoke 幂等**：重复吊销返回当前记录而非报错。

服务端验证（冒烟脚本，全部通过）：

- 领域服务 12 组断言：铸造/列表过滤/轮换/吊销幂等/冲突与参数校验（400/404/409/503）/文件 0600 权限/无 `.tmp`/`.bak` 残留，以及**用真实 `credentialResolver` 端到端回验**——铸造的 token 认证通过、轮换后新旧 token 并存可用、吊销后立即 401（内容哈希热生效）。
- HTTP 层 11 组断言：六个端点的完整请求-响应链路、错误码映射、审计事件仅含 credentialId（无 token 字段）。

前端验证：`vue-tsc` 类型检查、`vite build`（产出 `AgentGatewayManager` 页面 chunk）、eslint 与排版守卫对新文件均零告警。

面板侧验收（§10 中浏览器相关条目）需在真实部署上运行主进程 + adminServer 后人工确认。

---

## 13. 实现记录：Skill 导出（2026-08-19，§11.4 的落地）

在凭据管理页新增「Skill 导出」区（对应 §11 V2 候选第 4 项，未走签名下载链路，
直接由管理面生成——AdminPanel 操作者本身持 adminAuth，无需 bearer capability）：

- **端点**：`GET /admin_api/agent-gateway/agents/:agentId/skill?format=`（缺省 claude，
  allowlist 同 gateway 侧）。内部与 gateway 侧认证下载同源：`agentGuidanceService`
  解析 guidance → `generateSkillArtifact`（同一 secret scan 防线）→ 零依赖 STORE zip
  （新增 `modules/agentGateway/infra/zipArchiveWriter.js`，自实现 CRC32，不引入 zip 依赖）
  → `attachment; filename="vcp-<agent>.zip"`，条目路径带 `vcp-<agent>/` 前缀，解压到
  `~/.agents/skills/` 即完成安装。错误映射：未发布 guidance 404、非法 format 400、
  `AGENT_GATEWAY_PUBLIC_BASE_URL` 未配置/非法 503。
- **agents 端点增强**：`GET /agent-gateway/agents` 每项附带 `skillName`（配置了
  `skill.name` 用配置值，否则按 agentId 派生；guidance 未发布为 `null`），供表格展示。
- **命名统一（2026-08-19 起）**：skill 目录名一律 `vcp-<agentId slug>`（如
  `vcp-nexus`）。`resolveSkillName` 缺省派生从 `vcp-agent-gateway-<slug>` 缩短为
  `vcp-<slug>`；`agentGuidanceConfig` 的 `SKILL_NAME_PATTERN` 收紧为
  `^vcp-[a-z0-9][a-z0-9-]{0,59}$`（覆盖值也必须带前缀，配置层 fail-fast）；
  移除了 `MCPFuPeng` 的旧覆盖名 `fupeng-macro-advisor`（改为派生 `vcp-mcpfupeng`）。
  OpenAPI 契约（`openapiComponents.json` 与导出产物）同步更新。
- **前端**：`AgentGatewayManager.vue` 新增「Skill 导出」小节 +
  `features/agent-gateway/AgentSkillTable.vue`（agent 清单 / skill 名 / 简介 / 导出按钮）；
  `api/agentGateway.ts` 新增 `downloadSkillArchive`（原生 fetch 取 blob，cookie 鉴权，
  从 `Content-Disposition` 取文件名）。导出中按钮 loading，其余行禁用防并发。
- **令牌边界不变**：导出物零 secret（INSTALL.md 只出现 `${AGENT_GATEWAY_TOKEN}`
  引用形态）；令牌仍只在铸造/轮换的一次性弹窗中出现，导出链路不接触令牌。

验证：`tests/agent-gateway` 全量 542 断言通过（含两个更新后的命名断言文件）；
冒烟脚本四组断言（真实配置校验 + 四 agent 派生名、zip 往返 CRC/内容/路径拒绝、
HTTP 层 200/404/400/503 与零 secret、artifact 同源一致性）全部通过；`vue-tsc` +
`vite build` + eslint + 排版守卫（改动文件）零告警。

已有安装的旧名 skill（如 `~/.agents/skills/vcp-agent-gateway-nexus`）不自动迁移：
从面板重新导出 `vcp-nexus` 并删除旧目录即可。
