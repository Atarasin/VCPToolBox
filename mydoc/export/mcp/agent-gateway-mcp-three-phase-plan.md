# VCP Agent Gateway + MCP 三阶段计划

> 文档目标：在明确 `agent_gateway` 作为主线 canonical contract、`MCP` 作为首个高优先级 adapter 的前提下，整理一份便于排期、起 OpenSpec change、分阶段验收的执行计划。
>
> 当前判断：VCP 已具备稳定的原生 `agent_gateway` 能力面，包含 `memory/targets`、`memory/search`、`context/assemble`、`memory/write` 等原生记忆能力；MCP 侧已有最小适配骨架，但尚未完整承接这些 canonical memory/context 能力。

---

## 1. 结论先行

推荐采用下面的总体策略：

1. **坚持 `agent_gateway` 作为唯一主线 contract**
2. **坚持 `Gateway Core` 作为唯一共享业务语义来源**
3. **坚持 `MCP` 只做首个高优先级 adapter，不复制第二套 runtime**
4. **优先让编码工具可用，再逐步补齐异步、观测和运营能力**

一句话概括：

**先冻结 native `agent render` 的 canonical contract，再把 VCP 原生记忆能力和 `gateway_agent_render` 稳定映射进 MCP，最后扩展异步、观测和生态运营能力。**

---

## 2. 总体设计原则

### 2.1 `agent_gateway` 继续定义 canonical contract

所有对外稳定能力都应首先在 `/agent_gateway/*` 和共享 Gateway Core 中定义，再由 MCP 做协议映射。不能在 MCP 单独发明一套 memory、context、job、auth 或 error 语义。

### 2.2 MCP 只做 adapter，不做第二套业务核心

MCP 层只负责：

- 映射 tools / resources / prompts
- 映射 canonical request/response/error
- 为宿主工具提供更适合消费的交互形态

MCP 层不应该：

- 直接读底层插件目录
- 重新实现 diary scope / policy / auth 判断
- 绕过 operability、trace、metrics、idempotency 这些 shared 语义

### 2.3 优先服务编码工具使用场景

首个高优先级 adapter 的目标宿主是 `Trae`、`Claude Code`、其他 MCP-aware 编码工具。因此阶段设计要围绕：

- 如何召回项目相关长期记忆
- 如何把 recall context 组织成更适合编码场景消费的形式
- 如何把重要实现结论和项目决策写回长期记忆

### 2.4 每阶段都要求 native 与 MCP 语义一致

每新增一个 MCP capability，都要验证它与对应 native capability 在以下方面保持一致：

- 输入字段
- 错误语义
- 授权与 diary scope 约束
- 幂等与 rejection 语义
- trace / retry / observability 元数据

### 2.5 `render` 作为高层记忆入口，`memory/context` 作为解释层

如果 agent prompt 模板在渲染时会经过 VCP 真实的变量与记忆展开链路，并且模板内部已经使用 `TagMemo` / 日记本语法，那么 `rendered prompt` 本身就天然携带记忆召回后的上下文。

这意味着后续 MCP 设计不应只把 prompt render 视为“模板输出”，而应将其视为一种更高层的能力：

- 高层入口：直接为编码工具返回可消费的 rendered prompt
- 底层入口：继续保留 `memory-search`、`context-assemble`、`memory-write` 等能力，作为调试、治理、解释和精细控制入口

后续 contract 设计应尽量同时保留：

- `renderedPrompt`：给客户端直接使用
- `renderMeta`：用于说明是否命中记忆、是否发生策略过滤、是否发生截断、使用了哪些变量或召回来源

---

## 3. 推荐总路线

推荐把后续工作拆成三个阶段：

1. **第一阶段：MCP 补齐记忆最小闭环**
2. **第二阶段：面向编码工具补语义包装**
3. **第三阶段：补齐异步、观测和运营能力**

推荐关系如下：

```text
Phase 1: MCP Memory Minimum Loop
    |
    v
Phase 2: Coding-Oriented Memory Experience
    |
    v
Phase 3: Async / Observability / Operability Expansion
```

---

## 4. 第一阶段：冻结 Native Render Contract 并补齐 MCP 记忆最小闭环

这是最值得优先落地的阶段。

### 4.1 目标

- 在 native `agent_gateway` 中冻结 `agent render` 的 canonical contract
- 让 `Trae`、`Claude Code` 等 MCP 客户端可以直接使用 VCP 的原生记忆能力
- 让 MCP 首次具备完整的“发现目标 -> 检索记忆 -> 组装上下文 -> 写回记忆”闭环
- 明确 MCP 侧仍然复用 canonical `agent_gateway` 语义，而不是引入第二套 memory 模型

### 4.2 范围

本阶段建议至少补齐下面这些 MCP 能力：

- `resource`: `vcp://agent-gateway/capabilities/{agentId}`
- `resource`: `vcp://agent-gateway/memory-targets/{agentId}`
- `tool`: `gateway_memory_search`
- `tool`: `gateway_context_assemble`
- `tool`: `gateway_memory_write`

必要时补一层最小 MCP server transport，使外部 MCP client 可以实际连接，而不只是使用测试 harness。

### 4.3 核心工作

- 为 MCP 新增 memory/context/write 相关 tool descriptor 和 input schema
- 将 `gateway_memory_search` 映射到 canonical memory search 能力
- 将 `gateway_context_assemble` 映射到 canonical context assembly 能力
- 将 `gateway_memory_write` 映射到 canonical durable memory write 能力
- 在 native `agent_gateway` 中冻结 `agent render` 的 canonical contract，并明确它是否属于已发布 external surface
- 为后续 `gateway_agent_render` 统一 `requestContext`、`authContext`、`renderMeta` 等最小稳定边界
- 统一 MCP 侧的 `agentId`、`sessionId`、`requestContext`、`authContext` 入口
- 将 canonical gateway 错误语义映射到 MCP-facing 错误对象
- 明确保留 trace、retry、payload rejection、rate limit 等关键元数据
- 增加 focused tests，验证 native 与 MCP 在 memory/context/write 上的一致性

### 4.4 本阶段不做

- 不引入 MCP 专属 memory backend
- 不在 MCP 层直接读 diary 文件或底层插件
- 不单独设计一套与 native 不兼容的 schema
- 不在第一阶段直接发布 MCP `prompt: gateway_agent_render`
- 不把 jobs、events、完整 prompts 能力一次性全部塞进第一阶段

### 4.5 验收标准

- native `agent render` contract 已冻结，并定义了最小 `renderMeta` 稳定字段
- 至少一个真实 MCP client 能成功完成 memory search / context assemble / memory write
- MCP tool 输入输出与 native canonical contract 保持一致
- diary scope、policy、auth 约束在 MCP 路径上保持一致
- 关键 rejection 语义能被 MCP client 识别和区分
- 至少补齐一轮 MCP route/adapter contract tests

### 4.6 推荐 change 切分

- `agent-gateway-m12-agent-render-contract`
- `agent-gateway-m12-mcp-memory-core`
- 如果 transport 需要独立收口，可拆为 `agent-gateway-m12-mcp-server-transport`

---

## 5. 第二阶段：面向编码工具补语义包装

这是把“通用 RAG 能力”升级成“编码工具可高效使用的记忆体验”的阶段。

### 5.1 目标

- 让编码工具不必理解全部底层 memory/context 参数，就能稳定使用项目记忆
- 让 VCP 的记忆能力从“通用 RAG 工具”升级成“编码场景的项目长期记忆层”
- 让 recall 输出更贴近代码任务、文件上下文、项目决策沉淀

### 5.2 建议新增能力

- `prompt`: `gateway_agent_render`
- `tool`: `gateway_agent_bootstrap`
- `tool`: `gateway_memory_search`
- `tool`: `gateway_context_assemble`
- `tool`: `gateway_memory_write`

### 5.3 核心工作

- 定义面向编码场景的最小输入模型
  - 当前任务描述
  - 仓库标识
  - 相关文件路径
  - 相关符号名
  - 最近对话或编辑上下文
- 在 MCP 中保留 `prompt: gateway_agent_render` 作为主入口
- 新增 `tool: gateway_agent_bootstrap` 作为 tool-only 宿主的正式降级入口
- 让 `gateway_memory_search` / `gateway_context_assemble` 成为显式的记忆召回工具面
- 为 agent render / bootstrap 设计可观察元数据
  - 是否启用了记忆召回
  - 命中了哪些 recall source
  - 是否发生截断或策略过滤
  - 使用了哪些主要变量分组
- 设计面向编码场景的 recall 输出格式
  - 历史设计决策
  - 接口约束
  - 已知坑点
  - 相关文件线索
  - 推荐回写标签
- 为 `gateway_memory_search` / `gateway_context_assemble` 增加项目/仓库维度隔离语义，避免跨项目记忆污染
- 设计“实现后写回”的轻量能力，用于沉淀修改摘要、设计理由、关键约束
- 评估 prompts 与 tools 的职责边界，确保编码工具体验自然

### 5.4 关键难点

- 如何在不引入第二套索引模型的情况下表达项目/仓库隔离
- 如何让 recall 结果对编码任务足够有用，而不是只是返回通用 diary 片段
- 如何在不泄露内部模板细节的前提下，对外暴露稳定的 rendered prompt contract
- 如何控制写回质量，避免把临时噪音写入长期记忆

### 5.5 验收标准

- 编码工具可以用单个高层 tool 获取“适合编码任务”的 recall context
- 编码工具可以通过 `gateway_agent_render` 直接拿到可消费的高层 prompt，并且能观测其记忆注入状态
- recall 结果能够体现项目/仓库隔离
- 写回能力可以沉淀实现结论、决策依据和关键约束
- 至少有一轮面向编码工作流的端到端验证

### 5.6 推荐 change 切分

- `agent-gateway-m13-mcp-coding-recall`
- `agent-gateway-m13-mcp-agent-render`
- `agent-gateway-m13-mcp-coding-memory-writeback`

---

## 6. 第三阶段：补齐异步、观测和运营能力

这是让 MCP adapter 从“能用”走向“可运营、可治理、可扩展”的阶段。

### 6.1 目标

- 让 MCP 能承接更长耗时、更高频、更需要治理的记忆能力
- 将 native 已有或规划中的 operability / jobs / events / metrics 语义映射进 MCP
- 为后续更广泛生态接入打下稳定的运行基础

### 6.2 建议新增能力

- `prompt`: `gateway_agent_render`
- `resource`: `vcp://agent-gateway/agents/{agentId}/profile`
- `resource`: `vcp://agent-gateway/agents/{agentId}/prompt-template`
- `tool` 或 `resource`: `gateway_metrics_read`
- `tool`: `gateway_job_get`
- `tool`: `gateway_job_cancel`
- 可选事件流映射
- 可选 approval / deferred execution 映射

### 6.3 核心工作

- 将 native operability rejection 语义稳定映射到 MCP
  - rate limit
  - concurrency limit
  - payload too large
  - retry guidance
- 在客户端支持成熟后补 `prompt: gateway_agent_render`
- 增加只读 `resource` 形式的 profile / template preview，但不让 `resource` 承载最终 render 主入口
- 映射 native `traceId`、`operationName`、`retryAfterMs` 等元数据
- 评估 jobs / deferred execution 是否需要通过 MCP 暴露
- 设计 MCP 下的 metrics / observability 暴露方式
- 增加运营视角测试，覆盖限流、并发保护、异常释放、长任务和事件相关路径

### 6.4 适用场景

- 大量编码工具并发使用共享记忆服务
- recall / writeback 出现异步化或审批化需求
- 需要对外提供稳定的调试、治理、审计与回放能力

### 6.5 验收标准

- MCP 客户端可以识别治理性 rejection，并给出合理重试或回退行为
- MCP 客户端可以消费 `prompt: gateway_agent_render` 或等效高层 prompt 能力
- 只读 `resource` 仅承载 profile / template preview，不替代最终 render 主入口
- 至少一个 deferred 或 async 场景可以通过 MCP 稳定使用
- metrics / trace 元数据可用于排障和运营观察
- native 与 MCP 在 operability 语义上保持一致

### 6.6 推荐 change 切分

- `agent-gateway-m14-mcp-operability-alignment`
- `agent-gateway-m14-mcp-agent-prompt-publishing`
- `agent-gateway-m14-mcp-job-event-runtime`

---

## 7. 推荐实施顺序

建议按下面的顺序推进：

1. **先完成第一阶段**
   - 冻结 native render contract，并让 MCP 真正用上 canonical memory/context/write
2. **再做第二阶段**
   - 先以 `tool: gateway_agent_render` 让编码工具用起来更自然，而不是暴露过多底层参数
3. **最后做第三阶段**
   - 再补 `prompt` / `resource` 与治理、异步、观测等平台化能力

原因是：

- 第一阶段直接决定“contract 稳不稳定、能不能接入”
- 第二阶段决定“编码工具主入口好不好用”
- 第三阶段决定“能不能以更自然的 MCP 形态大规模稳定使用”

---

## 8. 风险与注意事项

- **MCP 反客为主风险**：如果在 MCP 层重新定义业务语义，会导致 native 与 MCP 漂移
- **编码语义过度定制风险**：如果第二阶段包装过重，后续可能不利于其他 MCP client 复用
- **上下文污染风险**：如果项目/仓库隔离没有收口，编码记忆会互相污染
- **治理缺口放大风险**：如果第三阶段长期不做，高频编码工具接入后会放大限流、并发、观测等问题

---

## 9. 最终建议

如果以 `Trae`、`Claude Code` 这类编码工具为首批目标宿主，推荐路线如下：

1. **用第一阶段尽快打通可用闭环**
2. **用第二阶段把体验做成“适合编码任务”的形态**
3. **用第三阶段把 adapter 升级成可运营能力**

最终应形成下面的稳定边界：

```text
Gateway Core / Native agent_gateway
    -> 定义 canonical memory / context / render / tool / job / operability contract

MCP Adapter
    -> 先将 canonical contract 映射成编码工具可消费的 tools
    -> 再补 prompts / resources 作为高层与辅助发布形态

Coding Tools
    -> 通过 MCP 使用 VCP 原生记忆能力，而不是直接耦合 native HTTP 细节
```

一句话总结：

**`agent_gateway` 负责定义“真正的能力”，`MCP` 负责把这些能力送进编码工具生态。**
