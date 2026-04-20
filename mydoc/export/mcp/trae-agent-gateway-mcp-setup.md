# Trae 接入 Agent Gateway MCP

## 目的

本文档说明如何把 VCPToolBox 的 Agent Gateway MCP server 作为一个本地 `stdio` MCP server 接入 Trae。

## 启动命令

在仓库根目录下，使用下面的命令启动 MCP server：

```bash
npm run start:mcp-agent-gateway
```

等价命令：

```bash
node scripts/start-agent-gateway-mcp-server.js
```

## Trae 配置示例

在 Trae 的 MCP server 配置中，添加一个 `stdio` 类型的本地 server，核心是让 Trae 运行上面的 Node 启动命令。

示例：

```json
{
  "mcpServers": [
    {
      "name": "vcp-agent-gateway",
      "command": [
        "node",
        "/home/zh/projects/VCP/VCPToolBox/scripts/start-agent-gateway-mcp-server.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  ]
}
```

如果你的 Trae 安装更偏好直接运行 npm script，也可以改成：

```json
{
  "mcpServers": [
    {
      "name": "vcp-agent-gateway",
      "command": [
        "npm",
        "run",
        "start:mcp-agent-gateway"
      ]
    }
  ]
}
```

## 最小前置条件

- 当前仓库依赖已经安装完成：`npm install`
- Rust 向量引擎已按项目要求完成构建
- `config.env` 已存在，并包含本地运行 Agent Gateway 所需的最小配置
- 仓库根目录可被本地 Node 进程访问

## 接入后可见能力

当前 transport 会把现有 Agent Gateway MCP adapter 暴露给 Trae，因此 Trae 应能发现以下 surface：

- `prompts/list`
- `prompts/get`
- `tools/list`
- `tools/call`
- `resources/list`
- `resources/read`

代表性 published capability 包括：

- prompt: `gateway_agent_render`
- tools: `gateway_agent_render`, `gateway_recall_for_coding`, `gateway_memory_commit_for_coding`, `gateway_job_get`, `gateway_job_cancel`
- resources:
  - `vcp://agent-gateway/capabilities/{agentId}`
  - `vcp://agent-gateway/memory-targets/{agentId}`
  - `vcp://agent-gateway/agents/{agentId}/profile`
  - `vcp://agent-gateway/agents/{agentId}/prompt-template`
  - `vcp://agent-gateway/jobs/{jobId}/events`

## 诊断说明

- transport 会保留 `stdout` 只输出 MCP 协议消息
- 启动日志、调试信息和报错信息都会写到 `stderr`
- 如果 Trae 连接失败，优先查看 MCP server 的 `stderr` 输出，而不是修改协议层 stdout 行为

## 验证建议

完成配置后，建议至少在 Trae 中验证以下 3 件事：

1. 能看到 `gateway_agent_render` prompt 和相关 tools。
2. 能成功执行一次 `tools/list` 或代表性工具调用。
3. 出现启动错误时，Trae 不会收到被日志污染的协议输出。
