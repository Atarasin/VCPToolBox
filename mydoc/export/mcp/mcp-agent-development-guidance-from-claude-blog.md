# VCP MCP 服务开发指导建议

> 基于 [Building agents that reach production systems with MCP](https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp) 博客的分析

---

## 一、背景

Anthropic 这篇博客阐述了连接 AI Agent 到外部系统的三种路径（直接 API 调用、CLI、MCP），并指出**生产级 Agent 跑在云端是大趋势，MCP 是那个"复利层"**。

月下载量已突破 **3 亿次**（年初是 1 亿），Claude Cowork、Managed Agents、Claude Code 等核心产品都基于 MCP。

---

## 二、当前 VCP MCP 实现观察

从代码结构来看，VCP 的 MCP 服务包含：

| 模块 | 路径 | 职责 |
|------|------|------|
| `mcpStdioServer.js` | `modules/agentGateway/` | Stdio 传输层 |
| `mcpAdapter.js` | `modules/agentGateway/adapters/` | 核心适配逻辑 |
| `mcpBackendProxyAdapter.js` | `modules/agentGateway/adapters/` | 后端代理适配 |
| `mcpDescriptorRegistry.js` | `modules/agentGateway/adapters/` | 工具/提示符注册 |
| `GatewayBackendClient.js` | `modules/agentGateway/` | 后端客户端 |

---

## 三、改进建议

### 1. 🌐 构建 Remote Server（远程服务器）

**现状**：当前 `mcpStdioServer` 主要是 Stdio 传输，适合本地环境。

**建议**：VCP 应该构建远程 MCP Server，让云端 Agent 能直接连接。目前的 `GatewayBackendClient` 架构已经是后端代理模式，可以考虑暴露一个远程 MCP 端点（HTTP/SSE），这样 Web、移动端的 Agent 也能连接。

**优先级**：🔴 高

---

### 2. 🎯 工具按"意图"分组，而非照搬 API

**现状**：MCP 适配器似乎是直接映射后端功能。

**建议**：检查现有工具集，对于复杂操作（如 `get_thread + parse_messages + create_issue` 这种链式调用），封装成单一的高层工具，例如：

| 高层工具 | 封装的操作 |
|----------|-----------|
| `vcp_create_diary_entry` | 创建日记 + 标签 + 索引一体化 |
| `vcp_search_and_summarize` | 搜索 + 摘要 一体化 |
| `vcp_manage_knowledge` | 知识库检索 + 更新 + 关联 |

**效果**：Agent 可以用更少的调用完成复杂任务，减少 Token 消耗。

**优先级**：🔴 高

---

### 3. 🔌 大表面场景考虑代码编排

**适用场景**：如果 VCP 未来暴露的工具很多（如完整的知识库、笔记、日程等）。

**建议**：参考 Cloudflare 的 MCP Server 模式：
- 提供 `vcp_execute_script` 工具
- Agent 写脚本在沙箱中执行，返回结构化结果
- 两个工具覆盖大量端点

```javascript
// 示例：Cloudflare 模式
tools: [
  { name: "search", description: "搜索可用API端点" },
  { name: "execute", description: "在沙箱中执行脚本" }
]
```

**优先级**：🟡 中（未来扩展用）

---

### 4. ✨ 集成 MCP Apps（Rich Semantics）

**博客要点**：返回可交互界面（图表、表单、仪表盘），用户无需离开聊天窗口。服务器返回 MCP Apps tends to see meaningfully higher adoption and retention。

**建议**：VCP 的日记、笔记功能可以返回结构化数据：
- 返回可交互的日记卡片
- 返回知识库的可视化摘要
- 任务状态用 Rich UI 展示

**优先级**：🟡 中

---

### 5. 🔐 标准化认证（CIMD）

**现状**：当前 `GatewayBackendClient` 使用 `bearerToken` / `gatewayKey`。

**建议**：如果未来要让外部 Agent 接入，考虑：
- 标准化 OAuth 流程
- 参考 CIMD（Client ID Metadata Documents）模式
- 首次认证更快，减少重复授权弹窗
- Claude Managed Agents 用 Vault 管理 Token 的模式值得参考

**优先级**：🟡 中

---

### 6. 📦 Skills + MCP 打包分发

**博客要点**："MCP gives an agent access to tools and data from external systems, while skills teach an agent the procedural knowledge of how to use those tools to accomplish real work."

**建议**：VCP 可以提供配套的 Skill 文件：
- "如何用 VCP 写日记"
- "如何用 VCP 搜索知识库"
- "VCP 日记工作流最佳实践"

让 Agent 不仅知道 VCP 能做什么，还知道怎么做。

**优先级**：🟡 中

---

### 7. ⚡ Context 效率优化

**两个关键模式**：

#### 7.1 Tool Search
- 运行时按需搜索工具，避免一次加载所有工具定义
- 实测 Token 减少 **85%+**

#### 7.2 编程式工具调用
- 在代码沙箱中聚合多步结果再返回
- Token 减少 **37%**

**建议**：在 `mcpDescriptorRegistry.js` 中实现工具的按需加载机制。

**优先级**：🟢 低（可在后续迭代中加入）

---

## 四、优先级总结

| 优先级 | 改进项 | 价值 |
|--------|--------|------|
| 🔴 高 | Remote Server 支持 | 让云端 Agent 能连接 VCP |
| 🔴 高 | 工具按意图重组 | 减少 Agent 调用次数，降低 Token 消耗 |
| 🟡 中 | MCP Apps 集成 | 提升交互体验和用户留存 |
| 🟡 中 | Skill 配套文档 | 让 Agent 更好理解 VCP 的使用方式 |
| 🟡 中 | 标准化认证 (CIMD/OAuth) | 方便外部 Agent 接入 |
| 🟢 低 | 代码编排模式 | 未来工具多时的扩展方案 |
| 🟢 低 | Tool Search | Context 优化，后续迭代考虑 |

---

## 五、核心结论

> "When building an integration, if your goal is to have production agents in the cloud reach your system, build an MCP server and make it excellent using the patterns above."

VCP 已经具备了良好的 MCP 基础架构（适配器模式、后端代理、工具注册）。下一步的重点应该是：
1. **远程服务器支持** — 打通云端 Agent 的连接
2. **工具重组** — 按意图封装，减少调用复杂度
3. **丰富语义** — 集成 MCP Apps 提升交互体验

---

## 参考链接

- [Building agents that reach production systems with MCP](https://claude.com/blog/building-agents-that-reach-production-systems-with-mcp)
- [MCP SDK](https://modelcontextprotocol.dev/)
- [MCP Official Specification](https://spec.modelcontextprotocol.io/)

---

*文档生成时间：2026-04-24*
*基于 Claude 博客分析整理*
