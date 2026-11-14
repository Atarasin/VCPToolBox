# VizDevelop 插件设计：显影图像服务接入 VCPToolBox

> 版本：v1 | 日期：2026-11-14 | 状态：已定稿 | 评审轮次：3 轮（slug：2026-11-14_VizDevelop插件设计）

## 1. 目标与范围

### 1.1 目标

新增 VCPToolBox 插件 `VizDevelop`，作为 VCP 工具生态与显影（viz-develop）服务之间的薄网关：VCP 内任意 AI agent 通过标准 VCP 工具协议（`<<<[TOOL_REQUEST]>>>` 块 + `「始」「末」` 参数分隔）调用显影的图像生成与编辑能力。

插件职责仅四件事：**命令分发、参数护栏、协议转发、结果整形**。不做任何设计判断与内容加工（那是显影服务与调用方 AI 的职责）。

### 1.2 范围内（本次）

显影图像工具 5 个 + 插件自加健康检查 1 个，共 6 个命令：

| command | 对应显影能力 | 交互模式 |
|---|---|---|
| health | GET /healthz（插件自加探活） | 阻塞（秒级，30s 超时） |
| list_image_models | viz_list_image_models | 阻塞（秒级） |
| create_image_input | viz_create_image_input | 阻塞（秒级） |
| get_image_operation | viz_get_image_operation | 阻塞（秒级） |
| generate_image | viz_generate_image（付费） | submit + query |
| edit_image | viz_edit_image（付费） | submit + query |

### 1.3 范围外（留后续批次，本设计不覆盖）

- 显影文档渲染与评审闭环工具：viz_render_doc、viz_get_format、viz_create_sketch、viz_apply_feedback、viz_finalize、viz_get_history、viz_list_templates。
- AdminPanel 管理页（D7 定案：首期不做，README 提供显影 /admin 链接）。
- 任何显影服务端代码修改（纯客户端接入）。

## 2. 总体设计

### 2.1 架构与调用链

```text
AI agent（输出 VCP 工具协议块）
  → VCP 主进程 PluginManager.processToolCall("VizDevelop", args)
    → VizDevelop.js（hybridservice direct 模块，运行于 VCP 主进程内）
      ① 命令分发层：command → 显影工具映射 + 时档超时
      ② 护栏层：参数校验 / 付费开关 / operationId 与 display 检查
      ③ 协议层：lib/mcpClient.js（零依赖 JSON-RPC over fetch）
      ④ 整形层：URL 透传 / 错误脱敏 / 结果 markdown 化
        → 显影服务 POST http://127.0.0.1:8787/mcp（Authorization: Bearer）
    ← 阻塞命令：同步返回结果；submit 命令：立即返回 operationId 回执
```

- **阻塞命令**（health / list_image_models / create_image_input / get_image_operation）：同步等到结果返回。
- **submit 命令**（generate_image / edit_image）：fire-and-forget 发起 tools/call 后立即返回 operationId 与查询指引；AI 每 1~2 分钟用 `get_image_operation` 轮询（AgnesVideoGen 先例）。显影断连后仍继续执行且有幂等账本，插件本地零状态。

### 2.2 插件形态（D1 定案）

单 `hybridservice` + `communication.protocol: "direct"`：入口脚本被 `require()` 进 VCP 主进程（参照 `Plugin/UrlFetch`）。无子进程 spawn、无 stdin 管道体积限制；未来如需 HTTP 路由可补 `registerRoutes`（本次不实现）。

### 2.3 目录结构

```text
Plugin/VizDevelop/
├── plugin-manifest.json   # hybridservice + direct + capabilities + configSchema
├── VizDevelop.js          # initialize / processToolCall / shutdown；命令分发与结果整形
├── lib/
│   └── mcpClient.js       # 零依赖 MCP 客户端：Bearer、超时、SSE/JSON 双格式、initialize 兜底
├── config.env             # 真实配置（不入库）
├── config.env.example     # 5 个配置键模板
└── README.md              # 能力表、配置说明、显影 /admin 运维入口
```

## 3. 详细设计

### 3.1 plugin-manifest.json

关键字段（对齐 Plugin.js 解析逻辑）：

```json
{
  "name": "VizDevelop",
  "pluginType": "hybridservice",
  "version": "1.0.0",
  "displayName": "VizDevelop 显影图像服务",
  "description": "显影（viz-develop）图像生成与编辑服务的 VCP 网关插件",
  "entryPoint": { "type": "nodejs", "script": "VizDevelop.js" },
  "communication": { "protocol": "direct", "timeout": 60000 },
  "configSchema": {
    "VIZ_DEVELOP_MCP_URL": { "type": "string", "default": "http://127.0.0.1:8787/mcp", "description": "显影 MCP 端点" },
    "VIZ_DEVELOP_AUTH_TOKEN": { "type": "string", "required": true, "description": "Bearer 令牌" },
    "VIZ_DEVELOP_ENABLE_IMAGE": { "type": "boolean", "default": true, "description": "付费生成/编辑命令开关" },
    "VIZ_DEVELOP_TIMEOUT_FAST_MS": { "type": "integer", "default": 30000, "description": "秒级命令超时" },
    "VIZ_DEVELOP_TIMEOUT_SLOW_MS": { "type": "integer", "default": 660000, "description": "submit 受理超时上限" }
  },
  "capabilities": {
    "invocationCommands": [ "…2 条，见下…" ],
    "parameters": [ { "name": "command", "type": "string", "required": true, "description": "子命令" } ]
  }
}
```

- `communication.timeout` 取 60000：processToolCall 内部自管分级超时，慢路径均为 submit 即回，60 秒足够。
- `capabilities.parameters`：全部参数声明为 string（VCP 工具协议平铺传参；嵌套对象由插件端重组，见 §3.4）。
- 多条 invocationCommands 的组织方式参照 `Plugin/DeepWikiVCP` 先例；描述注入生成 `{{VCPVizDevelop}}` 占位符。

invocationCommands 分 2 条（D6 定案）：

1. **commandIdentifier `VizDevelop`（图像生成/编辑）**：description 必须写明——
   - 生成前必须有用户明确要求（付费操作）；
   - `operationId` 必填且为幂等键（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`，如 `img-<主题>-v1`），传输层重试必须复用同 ID，新 ID = 新付费意图；
   - `display_title`（≤60 字符）/ `display_description`（≤240 字符）必填，公开信息，禁止放密钥或隐私；
   - `prompt` 原文透传，服务端不 trim 不改写；
   - submit 立即返回，之后每 1~2 分钟用 command=get_image_operation 轮询；
   - 零自动重试；查询到 unknown 状态绝不换 ID 重发，须告知用户人工核对；
   - 模型选择默认优先（省略 model 走服务默认），不确定先查 list_image_models，不凭记忆猜模型名；
   - example 给出完整协议块（见 §3.4 示例）。
2. **commandIdentifier `VizDevelop_Query`（查询与目录）**：覆盖 health / list_image_models / create_image_input / get_image_operation；写明查询与上传零费用；上传用纯 base64（不带 `data:` 前缀）。

### 3.2 配置项

优先级：插件 config.env > 全局 config.env / process.env（Plugin.js `_getPluginConfig`，只解析 configSchema 声明的键；direct 模块经 `initialize(config)` 收到对象）。

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| VIZ_DEVELOP_MCP_URL | string | `http://127.0.0.1:8787/mcp` | Q1 已确认同机部署；若 VCP 改 Docker 运行需换宿主地址（容器内 127.0.0.1 不可达宿主服务） |
| VIZ_DEVELOP_AUTH_TOKEN | string | （必填，无默认） | Bearer 令牌，取自显影 `config/auth-token`；任何输出中脱敏 |
| VIZ_DEVELOP_ENABLE_IMAGE | boolean | true | 付费 generate/edit 总开关；false 时仅保留查询与目录命令 |
| VIZ_DEVELOP_TIMEOUT_FAST_MS | integer | 30000 | 秒级命令超时 |
| VIZ_DEVELOP_TIMEOUT_SLOW_MS | integer | 660000 | submit 发起（握手与受理）超时上限；不等待生图结果 |

仓库提交 `config.env.example`（占位值与说明），真实 `config.env` 不入库。

### 3.3 lib/mcpClient.js（零依赖 MCP 客户端，D5 定案）

- **请求**：
  ```js
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments } }),
    signal: abortController.signal
  })
  ```
- **响应双格式解析**：`Content-Type: application/json` 直接 `JSON.parse`；`text/event-stream` 逐行取 `data:` 帧并提取 `id` 匹配的 JSON-RPC 响应（Streamable HTTP 允许以 SSE 返回）。
- **结果解包**：`result.content[0].text` 为 JSON 字符串 → `JSON.parse`；`result.isError === true` 走错误路径（§3.6）。
- **initialize 兜底**：进程级一次性探测——若直接 tools/call 被拒且错误指向会话/初始化，先发 `initialize`（`protocolVersion: "2025-03-26"`、`capabilities: {}`、`clientInfo: { name: "VCP-VizDevelop", version: "1.0.0" }`）与 `notifications/initialized`，再重发 tools/call。显影为无状态实现（`sessionIdGenerator: undefined`），预期直发即可（M1.S2 实测确认）。
- **超时**：AbortController 分两档（fast/slow），由命令分发层传入。
- **health 探活不走 /mcp**：直接 `GET ${base}/healthz`（无鉴权），`base` = VIZ_DEVELOP_MCP_URL 去掉尾部 `/mcp`。
- 不使用 GET /mcp（该服务返回 405）。

### 3.4 命令契约（6 命令）

VCP 工具协议平铺参数（全部字符串），插件端重组为显影 MCP 的嵌套参数。通用必填参数：`command`。

1. **health** → GET /healthz；返回 ok / service / artifacts / projects 摘要。fast 档。
2. **list_image_models** → viz_list_image_models；无额外参数；透传 defaultModel + models 目录（含各路由 operations / outputFormats / maxN / capabilities）。fast 档。
3. **create_image_input** → viz_create_image_input；`contentBase64` 必填（纯 base64，含 `data:` 前缀直接拒绝并提示）、`filename` 可选、`mimeType` 可选（png/jpeg/webp）；返回 inputId / mimeType / width / height / bytes / sha256。fast 档。
4. **get_image_operation** → viz_get_image_operation；`operationId` 必填；透传 status / outcome / images（含公网 URL、尺寸、sha256）/ previews / upstreamAttempts / error。fast 档。
5. **generate_image**（submit）→ viz_generate_image；必填 `operationId`、`display_title`、`display_description`、`prompt`；可选 `model` / `size` / `n` / `outputFormat` / `quality` / `background` 等原样透传；插件重组 `display = { title, description }`。护栏通过后 fire-and-forget 调用（`.catch` 记日志），立即返回 operationId + 轮询指引。
6. **edit_image**（submit）→ viz_edit_image；在 5 的基础上要求源图二选一：`image_input_id`（上传的 inputId）或 `image_artifact_token`（已发布产物 token）；可选 `mask_input_id` / `markup_input_id`（至多一个）、`input_fidelity`；submit 语义同 5。

**调用示例（写进 invocationCommands.example）**：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VizDevelop「末」,
command:「始」generate_image「末」,
operationId:「始」img-海报初稿-v1「末」,
display_title:「始」项目海报初稿「末」,
display_description:「始」用户要求的项目宣传海报，用于评审选稿「末」,
prompt:「始」…图片描述原文…「末」
<<<[END_TOOL_REQUEST]>>>
```

### 3.5 付费护栏与幂等纪律（对应 R2）

- generate/edit 前置校验：`operationId` 缺失或非法、display 缺失或超长 → 插件层直接拒绝并说明要求（不发起网络请求）。
- `VIZ_DEVELOP_ENABLE_IMAGE=false` → 拦截并返回开启方法（修改插件 config.env 后生效）。
- **零自动重试**：任何失败 / 限流（QUOTA_EXCEEDED）/ 超时均不重发；`get_image_operation` 返回 `unknown` 时，回复中原样告知用户人工核对，**禁止换 ID 重发**。
- description 中写明：生成前必须有用户明确要求；模型选择默认优先，不确定先查 list_image_models。

### 3.6 错误处理与脱敏（对应 R1 / R5）

- **safeError**：任何抛出/返回的错误信息先做 token 替换（出现 `VIZ_DEVELOP_AUTH_TOKEN` 值即替换为 `[REDACTED]`），日志同理。
- **错误返回格式**：`{ status: "error", error: "<分类：网络不可达 / 未授权(401) / 超时 / 服务端错误>" }` + 指引（先用 health 探活、检查插件 config.env）。
- **显影业务/校验错误透传**：结构化错误（图像类 `{code, message, operationId, retryable:false}`；通用 `{error, errors:[{path,message}]}`）原样回传，不概括不改写。
- 插件 `initialize` 只存配置、不发网络请求；显影宕机不影响插件加载与其他插件。

### 3.7 结果整形

- 成功统一为 markdown 文本：关键信息（URL、operationId、状态、尺寸等）+ 显影公网 URL **原样透传**（D4 定案，token 即访问控制，不镜像、不落盘）。
- 不做任何内容加工：prompt / display / base64 原文透传（R3）。

## 4. 任务分解

### M1：插件骨架与服务连通

依赖：无。目标：插件在 VCP 中成功加载，并打通与显影服务的 MCP 通道。

#### M1.S1 manifest 与配置骨架

依赖：无
- [x] T1 编写 plugin-manifest.json（§3.1：hybridservice/direct、2 条 invocationCommands、configSchema 5 键）
- [x] T2 落地 config.env（真实 token，不入库）与 config.env.example（§3.2）
- [x] 验收：VCP 启动日志显示插件加载成功，AdminPanel 插件列表出现 VizDevelop 且无报错

#### M1.S2 MCP 客户端核心

依赖：M1.S1
- [x] T3 实现 callTool(name, args, timeout)：fetch POST /mcp 直发 tools/call、SSE/JSON 双格式解析、initialize 预握手兜底（§3.3）
- [x] T4 错误整形与 token 脱敏 safeError（§3.6）
- [x] 验收：独立脚本调用 viz_list_image_models 返回模型目录；401/超时错误信息中不含 token

#### M1.S3 只读命令接线

依赖：M1.S2
- [ ] T5 命令分发器 + health / list_image_models 两个只读命令（§3.4）
- [ ] 验收：VCP 对话中经「始」「末」协议调用 VizDevelop list_image_models 成功返回模型目录

里程碑门禁：
- [ ] 停掉显影服务后重启 VCP：插件加载不报错，命令返回清晰错误与 health 指引

### M2：图像命令与付费护栏

依赖：M1 全部。目标：接入上传、查询与 submit/query 付费生图/编辑命令。

#### M2.S1 免费图像命令

依赖：M1.S3
- [ ] T1 create_image_input：纯 base64 校验（拒绝 data: 前缀）（§3.4）
- [ ] T2 get_image_operation：只读查询透传（§3.4）
- [ ] 验收：上传测试图片返回 inputId；凭 operationId 查询到真实状态

#### M2.S2 付费图像 submit/query

依赖：M2.S1
- [ ] T3 generate_image / edit_image：submit 即发即回（fire-and-forget + catch 兜底日志），返回 operationId 与轮询指引（§3.4、§3.7）
- [ ] T4 VIZ_DEVELOP_ENABLE_IMAGE 开关拦截；付费纪律写入 invocationCommands description（§3.1、§3.5）
- [ ] 验收：submit 立即返回；断连场景下 get_image_operation 可查回状态；开关关闭时命令被拦截并提示开启方法

里程碑门禁：
- [ ] 无 operationId / 无 display / 非法 operationId 三种请求均被插件层拒绝且不发起网络请求

### M3：文档完善与工具分发

依赖：M2 全部。目标：让生态内 agent 能发现并正确使用该插件。

#### M3.S1 README 与工具分发

依赖：M2.S2
- [ ] T1 编写 README.md：能力表、配置说明、显影 /admin 运维入口链接（§3.2）
- [ ] T2 在 toolbox_map.json 中把 VizDevelop 加入收纳箱分组：优先现有媒体/图像类分组，无则新建 VCPVisualToolBox（Q3 定案）
- [ ] 验收：默认 agent 系统提示词可见 VizDevelop 工具条目并正确拼出调用格式

#### M3.S2 管理页（跳过，D7 定案）

依赖：M3.S1
- [ ] T3 按 D7 定案跳过 registerRoutes 管理页；README 提供显影 /admin 运维入口链接，决策记录在案
- [ ] 验收：README 含 /admin 链接；插件代码无管理页路由（与 D7 定案一致）

里程碑门禁：
- [ ] 任一默认 agent 无需特殊配置即可发现并正确调用本插件（经收纳箱分组验证）

## 5. 约束与红线

- **R1 密钥不入库、全程脱敏**：密钥只存插件 config.env，仓库只提交 config.env.example；任何错误信息、日志、返回值中 token 全程脱敏。
- **R2 付费操作零自动重试**：插件对付费图像操作零自动重试；查询到 unknown 状态时绝不换 operationId 重发（费用可能已发生），必须原样告知用户人工核对。
- **R3 不越权、不加工内容**：插件不在本地实现任何图像处理、页面生成逻辑；prompt / display / base64 原文透传，不做 trim、改写或概括。
- **R4 不新增 shell 执行面**：direct 模块纯 HTTP 调用，不新增任何 spawn / shell 执行路径（遵守 VCP 安全规范）。
- **R5 优雅降级**：显影宕机/断网时命令返回清晰错误与 health 检查指引，插件加载失败不得阻塞 VCP 其他插件。

## 6. 验收标准

| # | 场景 | 预期结果（可判定） |
|---|---|---|
| 1 | VCP 对话调用 list_image_models | 返回模型目录（默认模型与各路由能力）；响应与日志中无 token |
| 2 | create_image_input 上传图片 | 返回 inputId 与尺寸/哈希；带 data: 前缀的输入被拒绝 |
| 3 | generate_image submit | 立即返回 operationId 与查询指引，不等待生图完成 |
| 4 | 付费 submit 后断连 | 凭 operationId 用 get_image_operation 查回状态；绝不自动换 ID 重发 |
| 5 | ENABLE_IMAGE=false 调 generate/edit | 被拦截并返回开启方法提示 |
| 6 | 显影服务宕机或断网 | 命令返回清晰错误与 health 指引，其他插件不受影响 |

另：各 slice 验收项见 §4（均为可判定条件）。

## 7. 已确认的决策记录

| 编号 | 决策 | 结论 | 轮次 | 备注 |
|---|---|---|---|---|
| D1 | 插件形态 | 方案A：单 hybridservice（direct 模块） | 3 | UrlFetch 先例；超时按命令分级自管 |
| D2 | 能力范围 | 本次只接入生图服务（用户指定） | 2 | 生图/编辑 + 上传/查询/目录共 5 工具；文档与评审留后续批次；原三方案均未采纳 |
| D3 | 长任务交互 | 方案A：submit + 轮询 | 3 | 显影幂等账本天然匹配；轮询 1~2 分钟 |
| D4 | 产物 URL | 方案A：直接透传显影公网链接 | 3 | 不镜像不落盘，token 即访问控制 |
| D5 | MCP 客户端 | 方案A：零依赖手写 JSON-RPC | 3 | fetch POST /mcp；initialize 兜底；零新 npm 依赖 |
| D6 | 命令描述 | 方案A：分组描述 2 条 | 3 | 「图像生成/编辑」+「查询与目录」 |
| D7 | AdminPanel 管理页 | 方案A：首期不做 | 3 | README 挂显影 /admin 链接；hybridservice 可后续补路由 |
| Q1 | 部署关系 | 同机 | 3 | 端点 http://127.0.0.1:8787/mcp；改 Docker 需换宿主地址 |
| Q2 | 插件命名 | VizDevelop | 3 | 英文 PascalCase，符合 VCP 惯例 |
| Q3 | 工具分发 | 加入 toolbox_map.json 收纳箱分组 | 3 | 优先现有媒体/图像类分组，无则新建 VCPVisualToolBox |

## 8. 风险与开放问题

1. **SSE 响应格式需实测**：Streamable HTTP 可能以 `text/event-stream` 返回 JSON-RPC 响应，客户端已按双格式设计（§3.3），M1.S2 实测确认。
2. **公网隧道依赖**：产物 URL 走显影公网基址（frps/nginx 隧道 18790）；隧道失效时外网不可达 URL（同机 MCP 调用不受影响），运维需保证隧道存活。
3. **服务端日配额**：显影生图日配额默认 20 张/天，超限返回 QUOTA_EXCEEDED，插件如实透传、不绕过。
4. **fire-and-forget 跟踪**：submit 后若 VCP 重启，本地无在途请求记录；凭 operationId + get_image_operation 可从服务端账本找回（服务端断连后仍继续执行）。
5. **模型目录漂移**：显影图像模型路由随配置变化，manifest description 不写死模型清单，引导 AI 用 list_image_models 现查。
6. **后续批次**：文档渲染与评审闭环工具接入需另行设计评审（新开闭环，以本 md 为输入），不在本设计范围。
