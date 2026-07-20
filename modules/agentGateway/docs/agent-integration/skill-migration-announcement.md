# 迁移公告：手写 `midas-vcp` skill → 生成式 L3 skill（M4）

> 发布日期：2026-07-20 ｜ 所属方案：[Agent 客户端集成方案](README.md) v6 §6

自 M4 起，agent 集成 skill 由 Agent Gateway 按 guidance bundle 单源生成，不再手工维护。手写样本 `modules/agentGateway/skills/midas-vcp/` 的全部内容（recall workflow、diary routing、memory write policy、工具速查）已由生成物覆盖，且生成物随 guidance 配置自动保持一致。

## 获取方式（三选一）

1. **在线 endpoint**（需 `gateway:read` credential）：
   `GET /agent_gateway/agents/MCPMidas/integration/skill?format=claude|codex|kimi`
2. **一次性签名下载**（先 mint 后 redeem，redeem 无需 credential）：
   `GET /agent_gateway/agents/MCPMidas/integration/skill/download-url?format=…` → 打开返回的 `downloadUrl`
3. **离线 CLI**：
   `node scripts/agent-gateway-skill-export.js --agent MCPMidas --out <dir> --format all`

## 各客户端安装

- **Claude Code**：将生成的 `SKILL.md` 放入 `<项目>/.claude/skills/vcp-agent-gateway-<agent>/SKILL.md`。
- **Codex**：将生成的 `SKILL.md` 放入 `<项目>/.agents/skills/vcp-agent-gateway-<agent>/SKILL.md`（Agent Skills 规范目录，`~/.agents/skills/` 为用户级、跨客户端共享）；MCP 注册按其中 `config.toml` 片段写入 `~/.codex/config.toml`。三种 format 均为 SKILL.md，Codex 不再生成 AGENTS.md——skill 按需装载，也不与项目已有 `AGENTS.md` 产生合并/共存问题。
- **Kimi**：将生成的 `SKILL.md` 放入 Kimi skills 目录（如 `kimi --skills-dir` 指定目录）；MCP 注册按其中 `mcp.json` 片段（Kimi 仅消费 MCP tools）。

凭据一律经客户端 secret store / 环境变量（`AGENT_GATEWAY_TOKEN`）注入，生成物零 secret。

## 删除计划

按 §6 与执行计划 M4.S3.T2，`modules/agentGateway/skills/midas-vcp/` 在**现网确认**（确认所有在用客户端已切换到生成物）后删除。生成产物验证与真实客户端安装 smoke 已完成（见 [smoke-records.md](smoke-records.md) M4 条目）；现网确认由部署运维方执行。
