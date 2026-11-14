# VizDevelop — 显影图像服务 VCP 网关插件

显影（viz-develop）图像生成与编辑服务接入 VCPToolBox 的薄网关。插件只做四件事：**命令分发、参数护栏、协议转发、结果整形**；不做任何设计判断与内容加工（那是显影服务与调用方 AI 的职责）。

设计文档：`docs/design/2026-11-14_VizDevelop插件设计.md`

## 能力表（6 命令）

| command | 对应显影能力 | 费用 | 交互模式 |
|---|---|---|---|
| `health` | GET /healthz（插件自加探活） | 免费 | 阻塞（秒级） |
| `list_image_models` | viz_list_image_models | 免费 | 阻塞（秒级） |
| `create_image_input` | viz_create_image_input（源图上传） | 免费 | 阻塞（秒级） |
| `get_image_operation` | viz_get_image_operation（任务查询） | 免费 | 阻塞（秒级） |
| `generate_image` | viz_generate_image | **付费** | submit + 轮询 |
| `edit_image` | viz_edit_image | **付费** | submit + 轮询 |

付费命令为 fire-and-forget submit：立即返回 operationId 回执，之后每 1~2 分钟用 `get_image_operation` 轮询。产物图片走显影公网 URL **原样透传**（不镜像、不落盘，token 即访问控制）。

### 调用示例

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

查询结果：

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」VizDevelop「末」,
command:「始」get_image_operation「末」,
operationId:「始」img-海报初稿-v1「末」
<<<[END_TOOL_REQUEST]>>>
```

### 付费纪律（调用方 AI 必须遵守）

- 生成/编辑前必须有用户明确要求。
- `operationId` 为幂等键（`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`）：重试复用同 ID，新 ID = 新付费意图。
- `display_title`（≤60 字符）/ `display_description`（≤240 字符）必填且为公开信息，禁止放密钥或隐私。
- 零自动重试；查询返回 `unknown` 状态时绝不换 ID 重发，须原样告知用户人工核对。
- 模型选择默认优先（省略 `model` 走服务默认）；不确定先 `list_image_models` 现查，不凭记忆猜模型名。

## 配置说明

复制 `config.env.example` 为 `config.env` 并填写（`config.env` 不入库）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `VIZ_DEVELOP_MCP_URL` | `http://127.0.0.1:8787/mcp` | 显影 MCP 端点（同机部署默认值；VCP 改 Docker 运行需换宿主地址） |
| `VIZ_DEVELOP_AUTH_TOKEN` | （必填） | Bearer 令牌，取自显影服务端 `config/auth-token` 文件 |
| `VIZ_DEVELOP_ENABLE_IMAGE` | `true` | 付费 generate/edit 总开关；`false` 时仅保留查询与目录命令 |
| `VIZ_DEVELOP_TIMEOUT_FAST_MS` | `30000` | 秒级命令超时 |
| `VIZ_DEVELOP_TIMEOUT_SLOW_MS` | `660000` | submit 受理超时上限（不等待生图结果） |

插件对显影的故障采取优雅降级：服务宕机/断网时命令返回清晰错误与 `health` 检查指引，插件加载不受影响（`initialize` 只存配置、不发网络请求）。

## 运维入口

- **显影管理台**：`http://127.0.0.1:8787/admin`（同机访问，需鉴权）。插件本身不提供 AdminPanel 管理页（设计决策 D7：首期不做，后续如需可补 `registerRoutes`）。
- 公网隧道（如 `…:18790`）仅暴露产物路径（`/p/…`），管理台不走公网。
- 显影生图有服务端日配额（默认 20 张/天），超限返回 `QUOTA_EXCEEDED`，插件如实透传、不绕过。

## 架构

- 单 `hybridservice` 插件 + `communication.protocol: "direct"`：`VizDevelop.js` 被 `require()` 进 VCP 主进程（UrlFetch 先例），无子进程、无 shell 执行面。
- `lib/mcpClient.js`：零依赖 MCP（Streamable HTTP）客户端——fetch POST `/mcp`、Bearer 鉴权、JSON/SSE 双格式响应解析、initialize 兜底、AbortController 分级超时；token 在任何错误信息与日志中全程脱敏（`[REDACTED]`）。
- 插件本地零状态：submit 后即使 VCP 重启，凭 `operationId` + `get_image_operation` 可从显影服务端幂等账本找回任务状态。
