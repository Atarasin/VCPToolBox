# Agent 客户端集成方案：服务端指导下发与绑定身份

> 状态：设计稿（v6，已纳入代码核实评审结论：间接对象生命周期、admin 跨源、SSE 吊销与实现约束修订，待实现评审）
> 日期：2026-07-19
> 范围：`modules/agentGateway/` 面向外部 coding agent（Claude Code / Codex / Kimi 等）的集成面
> 前置阅读：`docs/refactor/02-target-architecture.md`（契约单源）、`skills/midas-vcp/`（现状样本）

## 文档地图

本方案按功能域拆分为以下文件。原方案的 §3–§8 编号在各文件内保留，跨文件引用（如 §3.2、§4.4）按下表定位：

| 文件 | 内容 | 原章节 |
|---|---|---|
| 本文件 | 背景、目标与非目标、文档地图 | §1–§2 |
| [01-identity-authorization.md](01-identity-authorization.md) | 统一身份与授权模型：术语、决议规则、凭据呈现与存量路径归一化、强制覆盖入口、scope 两层授权、吊销传播、401 映射 | §3.1–§3.7 |
| [02-config-data-model.md](02-config-data-model.md) | 配置与数据模型：agent directory 复用、guidance 配置、交叉校验与热加载、credential 配置 | §4.1–§4.4 |
| [03-transport-surfaces.md](03-transport-surfaces.md) | MCP、REST 与 transport 接线：双 adapter、instructions、guidance resource 与 bootstrap、agentId 迁移、stdio 身份 | §5.1–§5.5 |
| [04-skill-generation.md](04-skill-generation.md) | L3 skill 生成与签名下载 | §6 |
| [05-testing-gates.md](05-testing-gates.md) | 测试矩阵与发布门禁（单源清单） | §8 |
| [06-execution-plan.md](06-execution-plan.md) | 执行计划：milestone → slice → task 的层次分解与依赖图（取代原 §7 的 P0–P4 平铺） | §7 重组 |
| [07-revision-history.md](07-revision-history.md) | v2–v6 修订摘要 | 附录 |
| [agent-onboarding-walkthrough.md](agent-onboarding-walkthrough.md) | 实操手册：把一个新 agent 从零接到 Gateway 对外服务（付鹏/MCPFuPeng 真实案例）、验证清单与踩坑记录 | — |

阅读顺序建议：实现者先读 01（授权模型是全方案前提）→ 02 → 03，再按 06 领取任务；评审者按 07 了解决策演进；测试与发布以 05 为准。**只想上线一个新 agent、不改 Gateway 本身的读者，直接看 [agent-onboarding-walkthrough.md](agent-onboarding-walkthrough.md)。**

## 1. 背景与结论

Agent Gateway 通过 MCP（Streamable HTTP / WebSocket / stdio）对外暴露 recall、memory、bootstrap 等工具。当前客户端通过手写 skill 包获知何时使用这些工具：

```text
skills/midas-vcp/
|- SKILL.md                    # 工作流指导
|- agents/openai.yaml          # Codex 接口声明与 MCP endpoint
`- references/memory-policy.md # 记忆写入策略
```

这验证了“recall 先行 + 会话末写 memory”的工作流，但长期存在配置重复、客户端产物手写、endpoint 硬编码，以及 MCP `instructions` / `resources` 未被充分利用的问题。

本方案保留“指导内容由服务端维护、skill 可再生”的方向，但先解决一个前提：**agent 身份必须由可信凭据端到端绑定，并在所有 MCP、REST、session 和下载入口上统一授权。**

没有这一前提，按 agent 渲染 instructions、将 `agentId` 改为 optional、或为 agent 生成 skill 都会产生越权和行为不一致风险。

## 2. 目标与非目标

### 目标

1. **指导单源**：工作流、写入标准、日记本路由和工具提示由 Gateway guidance service 统一输出；instructions、resource、bootstrap 和 skill 仅渲染其派生结果。
2. **绑定身份**：per-agent credential 决定有效 agent。~~客户端可省略 `agentId`~~（该省略语义已由 4a65ab35 推翻——`agentId` 一律显式必填，见 §5.4 状态框）；显式传入只能与绑定身份一致。
3. **端到端授权**：MCP tool/prompt/resource/discovery、Native REST、HTTP session、WebSocket、stdio 和 skill 下载遵循同一 target-agent 校验。
4. **兼容性分层**：支持 resources 的 host 读取 guidance resource；仅支持 tools 的 host 调用 bootstrap；不把客户端是否自动消费 instructions/resources 当作协议保证。
5. **可再生 skill**：skill 是可选薄产物，只包含安全 endpoint 和最小触发说明，不包含任何 secret。
6. **漂移可检测**：agent、profile、memory policy、guidance 和 credential 的交叉引用在启动与热加载时校验，错误不替换现行有效配置。

### 非目标

- 不改变现有 7 个 MCP tool 与 1 个 prompt 的名称；`gateway_agent_render` 保持 prompt 发布形态（`publishedAsTool: false`）。
- 不引入 TypeScript 或 ESM。
- 不在本方案内实现 OAuth。
- 不承诺所有 MCP host 自动将 `instructions` 或 resource 内容注入模型上下文。
- 不在请求 `Host`、`X-Forwarded-Host` 或其他客户端 header 上推导公开 endpoint。
- 不改变 AdminPanel/system 管理路由（如 `/agent_gateway/health`）的既有认证方式；它们不在本方案的统一授权模型内，继续由 server.js 的 adminAuth 保护。注意此排除仅限管理路由本身：adminAuth 对 agent **业务**入口的兜底放行不在排除范围内，其归一化处置见 §3.3（[01-identity-authorization.md](01-identity-authorization.md)）。
