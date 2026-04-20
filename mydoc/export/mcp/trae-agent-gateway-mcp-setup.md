# Trae 接入 Agent Gateway MCP

## 目的

本文档说明如何把 VCPToolBox 的 Agent Gateway MCP server 作为一个本地 `stdio` MCP server 接入 Trae，并且只复用已经运行的 VCP backend。

## 启动命令

MCP transport 本身不再初始化本地 `KnowledgeBaseManager`、`pluginManager` 或插件运行时。联调顺序必须是：

1. 先启动 VCP backend
2. 再启动 MCP transport

在仓库根目录下，使用下面的命令启动 backend-only MCP server：

```bash
VCP_MCP_BACKEND_URL=http://127.0.0.1:3000 \
VCP_MCP_DEFAULT_AGENT_ID=Ariadne \
npm run start:mcp-agent-gateway
```

等价命令：

```bash
VCP_MCP_BACKEND_URL=http://127.0.0.1:3000 \
VCP_MCP_DEFAULT_AGENT_ID=Ariadne \
node scripts/start-agent-gateway-mcp-server.js
```

可选环境变量：

- `VCP_MCP_BACKEND_URL`：必填，指向已运行 VCP backend 的 base URL
- `VCP_MCP_DEFAULT_AGENT_ID`：推荐，给 Trae 的 discovery 阶段提供默认 agent
- `VCP_MCP_BACKEND_KEY`：可选，对应 native gateway 的 `x-agent-gateway-key`
- `VCP_MCP_BACKEND_GATEWAY_ID`：可选，对应 native gateway 的 `x-agent-gateway-id`
- `VCP_MCP_BACKEND_BEARER_TOKEN`：可选，若通过 bearer token 访问 backend 可配置此项

## Trae 配置示例

在 Trae 的 MCP server 配置中，`mcpServers` 需要是一个对象，键名是 server 名称，`command` 是单个可执行命令，参数放在 `args` 数组里。

示例：

```json
{
  "mcpServers": {
    "vcp-agent-gateway": {
      "command": "node",
      "args": [
        "/home/zh/projects/VCP/VCPToolBox/scripts/start-agent-gateway-mcp-server.js"
      ],
      "env": {
        "NODE_ENV": "production",
        "VCP_MCP_BACKEND_URL": "http://127.0.0.1:3000",
        "VCP_MCP_DEFAULT_AGENT_ID": "Ariadne",
        "VCP_MCP_BACKEND_KEY": "你的_agent_gateway_key",
        "VCP_MCP_BACKEND_BEARER_TOKEN": "如果你使用BearerToken_请填这里"
      }
    }
  }
}
```

其中：

- `VCP_MCP_BACKEND_URL` 是必填项，否则 transport 会直接启动失败
- `VCP_MCP_DEFAULT_AGENT_ID` 是推荐项。因为 Trae 在 discovery 阶段通常会直接调用 `tools/list`，不会额外附带 `agentId`；如果你的环境里存在多个 agent，设置这个默认值后，Trae 才能稳定看到该 agent 作用域下的日记 RAG 闭环工具与资源
- **认证配置**：当后端启用了访问控制时（如 `gateway_agent_render` 返回 `401 Unauthorized`），你需要提供 `VCP_MCP_BACKEND_KEY`（对应 `x-agent-gateway-key` 头）或 `VCP_MCP_BACKEND_BEARER_TOKEN`（对应 `Authorization: Bearer` 头）以通过鉴权。

如果你的 Trae 安装更偏好直接运行 npm script，也可以改成：

```json
{
  "mcpServers": {
    "vcp-agent-gateway": {
      "command": "npm",
      "args": [
        "run",
        "start:mcp-agent-gateway"
      ]
    }
  }
}
```

## 最小前置条件

- 当前仓库依赖已经安装完成：`npm install`
- VCP backend 已先行启动，并可访问 `VCP_MCP_BACKEND_URL`
- backend 侧所需的 Rust 向量引擎、`config.env` 与 diary RAG 配置已经准备完成
- 仓库根目录可被本地 Node 进程访问，以便启动 stdio MCP transport

## 接入后可见能力

当前 transport 会把 backend canonical route 代理为 Trae 可消费的 MCP surface，因此 Trae 应能发现以下 surface：

- `prompts/list`
- `prompts/get`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`

第一阶段 published capability 收口为 diary RAG 闭环与 prompt-first agent injection：

- prompt: `gateway_agent_render`
- tools:
  - `gateway_memory_search`
  - `gateway_context_assemble`
  - `gateway_recall_for_coding`
  - `gateway_memory_write`
  - `gateway_memory_commit_for_coding`
  - `gateway_job_get`
  - `gateway_job_cancel`
- resources:
  - `vcp://agent-gateway/memory-targets/{agentId}`
  - `vcp://agent-gateway/jobs/{jobId}/events`

这些 MCP 能力会分别代理到 backend native route，例如：

- `prompts/get(name = gateway_agent_render)` -> `POST /agent_gateway/agents/:agentId/render`
- `gateway_recall_for_coding` -> `POST /agent_gateway/coding/recall`
- `gateway_memory_commit_for_coding` -> `POST /agent_gateway/coding/memory-writeback`
- `gateway_memory_search` -> `POST /agent_gateway/memory/search`
- `gateway_context_assemble` -> `POST /agent_gateway/context/assemble`
- `gateway_memory_write` -> `POST /agent_gateway/memory/write`

## Prompt Injection

Trae 注入 VCP agent 时，应直接消费：

- `prompts/get(name = gateway_agent_render)` 返回的 `messages[0].content[*].text`

其中：

- 这段 message content 就是 inject-ready prompt body
- `meta.hostHints.primarySurface = prompts/get` 表示该 prompt 是主注入路径
- `meta.hostHints.fallbackToolSurfaceAvailable = false` 表示不应再通过 `tools/call(name = gateway_agent_render)` 获取注入 prompt

也就是说，Trae 不应把 `gateway_agent_render` 当作一个 tool 去调用，而应把它当作一个 prompt 去获取。

## 诊断说明

- transport 会保留 `stdout` 只输出 MCP 协议消息
- 启动日志、调试信息和报错信息都会写到 `stderr`
- 如果没有配置 `VCP_MCP_BACKEND_URL`，transport 会立即退出并在 `stderr` 提示缺失配置
- 如果 Trae 连接失败，优先查看 MCP server 的 `stderr` 输出，而不是修改协议层 stdout 行为

## 验证建议

完成配置后，建议至少在 Trae 中验证以下 3 件事：

1. 能看到 `gateway_agent_render` prompt，且 `tools/list` 中不再把它作为 tool 暴露。
2. 能成功执行一次 `prompts/get(name = gateway_agent_render)`，并确认返回的 message content 可直接作为 Trae 注入 prompt 使用。
3. 能成功执行一次 `gateway_recall_for_coding`，确认请求走通 `Trae -> MCP -> backend -> diary RAG`。
4. 能成功执行一次 `gateway_memory_commit_for_coding` 或 `gateway_memory_write`，确认 writeback 也走 backend canonical route。
5. 出现启动错误时，Trae 不会收到被日志污染的协议输出。
