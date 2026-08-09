# 安装：Midas（MCPMidas）

给安装这份 skill 的人看；模型运行时只读 `SKILL.md`。

## 1. 放置

把 `SKILL.md` 放到 `~/.agents/skills/vcp-agent-gateway-mcpmidas/SKILL.md` —— Codex 与 Kimi 自动发现该目录。
Claude Code 读 `~/.claude/skills/`，链同一份即可：

```bash
ln -s ~/.agents/skills/vcp-agent-gateway-mcpmidas ~/.claude/skills/vcp-agent-gateway-mcpmidas
```

项目级等价路径：`<project>/.agents/skills/…` 与 `<project>/.claude/skills/…`。

## 2. 凭据（绝不内联）

网关凭据是 bearer secret。不要写进这份 skill、仓库文件或 shell history——
从客户端的 secret store 读取，并以环境变量 `AGENT_GATEWAY_TOKEN` 引用。
向网关运维方申请**绑定该 agent** 的凭据（scope 取最小集 `gateway:read,gateway:execute`）。

## 3. 注册 MCP server

三种客户端选其一；token 一律从环境变量读，明文不进任何配置文件。

### Claude Code（`.mcp.json` 或 `claude mcp add --transport http`）

```json
{
  "mcpServers": {
    "vcp-agent-gateway": {
      "type": "http",
      "url": "http://10.126.126.2:6005/mcp",
      "headers": {
        "Authorization": "Bearer ${AGENT_GATEWAY_TOKEN}"
      }
    }
  }
}
```

### Codex（`~/.codex/config.toml`）

```toml
[mcp_servers.vcp-agent-gateway]
url = "http://10.126.126.2:6005/mcp"
http_headers = { "Authorization" = "Bearer ${AGENT_GATEWAY_TOKEN}" }
```

### Kimi（`.kimi-code/mcp.json`）

```json
{
  "mcpServers": {
    "vcp-agent-gateway": {
      "url": "http://10.126.126.2:6005/mcp",
      "bearerTokenEnvVar": "AGENT_GATEWAY_TOKEN"
    }
  }
}
```

## 4. 验证

```bash
curl -s --noproxy '*' -H "Authorization: Bearer $AGENT_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -X POST "http://10.126.126.2:6005/mcp" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
```

返回的 `instructions` 里应出现 `MCPMidas`；出现的是通用文案说明凭据没有绑定该 agent。

## 出处

- guidance revision：`sha256:c91681e1e0040da438bd9c2ddd306fc6a9bae51542fdbe8bbe89b9b5e99cfb06`
- 生成时间：`2026-08-04T15:48:45.958Z`

本文件与 `SKILL.md` 由网关按 guidance 渲染生成，不要手改——改配置后重新导出。