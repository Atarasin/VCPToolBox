# FeishuBridge

## 功能

- 通过 `@larksuiteoapi/node-sdk` 接入飞书能力
- 飞书长连接接收消息并桥接到 `/v1/chat/completions`（流式输出）
- 会话级 Agent 选择与切换（读取 `agent_map.json`）
- 会话级记忆增强开关
- 工具调用块（`<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>`）卡片渲染
- DeepMemo 归档数据输出（`state/deepmemo_archive/*.jsonl`）
- 会话状态落盘与幂等去重
- 管理接口查看状态与会话

## 指令

- `/agent`
- `/agent list`
- `/agent <Alias>`
- `/memory on`
- `/memory off`

## 管理接口

- `GET /admin_api/feishu-bridge/status`
- `GET /admin_api/feishu-bridge/sessions`
- `POST /admin_api/feishu-bridge/reload-agent-map`
- `GET /api/feishu-bridge/status`

## 配置

复制 `config.env.example` 到 `config.env` 并填入飞书凭据。
