# FeishuBridge

## 概述

FeishuBridge 是一个飞书消息桥接插件，负责将飞书消息接入 VCP 的 `/v1/chat/completions`，并把模型回复回写到飞书会话。当前版本为 `0.6.2`。

## 主要能力

- 飞书长连接接收消息并桥接到模型流式接口
- 会话级 Agent 切换、记忆开关与会话重置（`/new`）
- 入站图片/文件下载与本地落盘（`state/attachments/<chat>/<date>/`）
- 入站附件多模态注入上下文（图片 `image_url`、文档 `data URI`）
- 工具调用卡片回写（`TOOL_REQUEST` 结构块）
- 普通自动回复中的二进制下发（`BINARY_REPLY` 结构块）
- 管理接口：状态查询、会话查看、Agent 映射重载、主动推送
- 会话状态持久化、事件去重、DeepMemo 归档

## 模块结构

- `FeishuBridge.js`：生命周期、路由注册、消息流程编排
- `lib/bridgeState.js`：配置与状态管理、会话持久化、归档/通知
- `lib/messageHelpers.js`：消息解析、命令解析、结构块提取、卡片构建
- `lib/feishuGateway.js`：飞书 API 与 VCP API 网络交互（上传、下载、发送）

## 会话指令

- `/agent`：查看当前 Agent
- `/agent list`：列出可用 Agent
- `/agent <Alias>`：切换当前会话 Agent
- `/memory on`：开启记忆增强
- `/memory off`：关闭记忆增强
- `/new`：清空当前会话历史并重建会话 ID

## 自动回复中的结构化能力

### 1) 工具调用卡片

模型可输出：

```text
<<<[TOOL_REQUEST]>>>
tool_name:...
...
<<<[END_TOOL_REQUEST]>>>
```

插件会提取并渲染为飞书卡片。

### 2) 二进制自动下发

模型可输出：

```text
<<<[BINARY_REPLY]>>>
message_type: image 或 file
mime_type: 可选，例如 image/png 或 application/pdf
file_name: 可选文件名
binary_base64: 可选，data:...;base64,...
attachment_path: 可选，本地绝对路径（与 binary_base64 二选一）
<<<[END_BINARY_REPLY]>>>
```

说明：

- `message_type` 必填，且只支持 `image` 或 `file`
- `binary_base64` 与 `attachment_path` 至少提供一个
- 当前发送逻辑会先尝试 `binary_base64`，为空时再使用 `attachment_path`
- 二进制发送失败时会回写失败提示，避免用户侧无感失败

## 管理接口

- `GET /admin_api/feishu-bridge/status`
- `GET /admin_api/feishu-bridge/sessions`
- `POST /admin_api/feishu-bridge/reload-agent-map`
- `POST /admin_api/feishu-bridge/push`
- `GET /api/feishu-bridge/status`

### `/admin_api/feishu-bridge/push` 请求示例

#### `receiveIdType` / `receiveId` 如何填写

- `receiveIdType` 仅支持两种值：
  - `chat_id`：发到群聊或会话
  - `open_id`：发给单个用户
- `receiveId` 需要与 `receiveIdType` 对应：
  - 当 `receiveIdType=chat_id` 时，填写飞书会话 ID（通常形如 `oc_xxx`）
  - 当 `receiveIdType=open_id` 时，填写用户 OpenID（通常形如 `ou_xxx`）
- 不匹配会导致接口报错（例如把 `ou_xxx` 搭配 `chat_id`）。

#### ID 获取方式

- 从飞书入站消息事件中获取：
  - `chat_id`：`event.message.chat_id`
  - `open_id`：`event.sender.sender_id.open_id`
- 也可以在你现有的业务侧持久化这两个 ID，再用于主动推送。

文本消息：

```json
{
  "receiveIdType": "chat_id",
  "receiveId": "oc_xxx",
  "messageType": "text",
  "text": "hello"
}
```

图片/文件消息：

```json
{
  "receiveIdType": "open_id",
  "receiveId": "ou_xxx",
  "messageType": "image",
  "binaryBase64": "data:image/png;base64,...",
  "mimeType": "image/png",
  "fileName": "demo.png"
}
```

## 配置项

复制 `config.env.example` 到 `config.env`，并至少配置飞书凭据。

- `FEISHU_ENABLE_WS`：是否启用飞书长连接
- `FEISHU_APP_ID`：飞书应用 App ID
- `FEISHU_APP_SECRET`：飞书应用 App Secret
- `FEISHU_DEFAULT_AGENT`：默认 Agent 别名
- `FEISHU_ALLOWED_AGENTS`：允许切换的 Agent 别名列表（逗号分隔）
- `FEISHU_MODEL`：转发给 VCP 的模型名
- `FEISHU_REPLY_TARGET`：回复目标，`chat` 或 `user`
- `FEISHU_ENABLE_MEMORY_HINT`：是否注入记忆增强提示
- `FEISHU_ENABLE_DEEPMEMO_ARCHIVE`：是否开启归档
- `FEISHU_MAX_CONTEXT_MESSAGES`：上下文保留条数
- `FEISHU_REQUEST_TIMEOUT_MS`：请求超时时间
- `FEISHU_MAX_INLINE_ATTACHMENT_BYTES`：入站附件内联到上下文的最大字节数（默认 `2097152`）

## 本地状态目录

- `state/sessions.json`：会话持久化数据
- `state/attachments/`：入站附件存储
- `state/deepmemo_archive/*.jsonl`：归档输出
