# MCP Agent Render 设计说明

> 文档目标：单独说明 `gateway_agent_render` 的设计方向，回答为什么 `render` 可以成为高层记忆入口，以及在 `resource`、`prompt`、`tool` 三种 MCP 暴露方式之间应该如何选择。
>
> 适用背景：VCP 已确定 `agent_gateway` 做主线 canonical contract，`MCP` 做首个高优先级 adapter；同时 VCP 内置 agent 模板在真实渲染时可能包含 `TagMemo` / 日记本语法，因此 render 不只是模板输出，而是潜在的“带记忆召回的 prompt 编译能力”。

---

## 1. 结论先行

推荐的总体方向如下：

1. **将 `agent render` 定义为 `agent_gateway` 的 canonical 高层能力**
2. **将 `MCP` 侧的 `gateway_agent_render` 作为编码工具主入口**
3. **优先把它暴露为 `prompt` 或 `tool`，而不是直接暴露原始模板文件**
4. **保留 `memory-search` / `context-assemble` 作为解释层和治理层**

一句话概括：

**`gateway_agent_render` 应该代表“按当前 agent 模板、变量、环境和记忆召回规则编译最终 prompt”的高层能力，而不是简单地读出 `Agent/*.txt` 原文。**

---

## 2. 为什么 `render` 天然可以带记忆能力

如果 VCP 的 agent 模板在真实渲染链路里会执行下面几类展开：

- 变量替换
- 环境信息注入
- 工具能力注入
- `TagMemo` / 日记本语法展开
- 其他记忆或知识库相关插槽展开

那么最终产出的 `rendered prompt` 本质上已经包含了：

- agent persona
- 当前环境信息
- 当前可用工具与边界
- 和记忆系统召回得到的上下文

在这种情况下，`render` 不再是一个普通的模板预览能力，而是更接近：

- prompt compilation
- memory-aware agent bootstrap
- coding-oriented context hydration

这对 `Trae`、`Claude Code`、其他 MCP-aware 编码工具非常合适，因为它们不需要理解底层 `TagMemo` 语法，只需要消费一个已经按 VCP 规则编译好的 prompt。

---

## 3. 为什么不建议直接暴露 `Agent/*.txt`

以 `Agent/Ariadne.txt` 为例，这类文件通常同时混合了几层语义：

- 稳定 persona 内容
- 内部占位符协议
- 运行时环境注入位
- 日记本或记忆系统语法
- 可能的内部实现约束

直接通过 MCP 原样暴露原始模板文件，会带来几个问题：

- **客户端无法直接消费**：读到的是未渲染模板，而不是可立即使用的 prompt
- **泄露内部模板细节**：包括变量名、系统占位符、内部注入协议
- **稳定边界不清晰**：原始模板文件不应天然被视为外部稳定 contract
- **调试与运行目标混淆**：模板预览和最终执行 prompt 是两类不同能力

因此不建议把 `Agent/*.txt` 直接视为 MCP 对外 contract。

---

## 4. 推荐的能力分层

建议把与 agent prompt 相关的能力拆成四层：

### 4.1 原始模板层

- 内部文件，例如 `Agent/Ariadne.txt`
- 用于维护、版本管理、内部调试
- 不直接对外暴露

### 4.2 模板预览层

- 受控的 template preview
- 可用于审查、对比、治理
- 应做脱敏或结构化收口

### 4.3 渲染结果层

- 真实的 `rendered prompt`
- 已经过模板展开、变量注入、记忆召回、必要策略过滤
- 这是最适合 MCP 客户端直接消费的层

### 4.4 解释与治理层

- `memory-search`
- `context-assemble`
- `memory-write`
- render meta / trace / recall source / truncation info

这层不是为了普通使用者，而是为了调试、治理、可解释性和精细控制。

---

## 5. `resource`、`prompt`、`tool` 三种暴露方式怎么选

这里不建议只选一种，而是建议明确主次。

## 5.1 `resource`

适合暴露什么：

- agent profile
- 模板预览
- 静态或半静态的 prompt 元数据

优点：

- 语义清晰，适合只读内容
- 适合被客户端缓存
- 适合做调试和治理视图

缺点：

- 不适合复杂参数输入
- 不适合动态渲染
- 不适合强调“执行一次 render 动作”

结论：

- **适合作为辅助能力**
- **不适合作为 `gateway_agent_render` 的主入口**

推荐示例：

- `vcp://agent-gateway/agents/{agentId}/profile`
- `vcp://agent-gateway/agents/{agentId}/prompt-template`

## 5.2 `prompt`

适合暴露什么：

- 给宿主 LLM 直接消费的 rendered prompt
- 参数相对稳定的高层 prompt 入口
- 编码工具中的 bootstrap / recall / agent persona prompt

优点：

- 最符合 MCP 在 agent 生态里的自然语义
- 对 `Trae`、`Claude Code` 这类工具最友好
- 客户端不需要理解太多底层参数

缺点：

- 某些 MCP 客户端对 prompts 的支持成熟度不一定一致
- 如果后续输入参数变多，prompt 形态可能不如 tool 灵活

结论：

- **如果宿主端 prompt 支持成熟，`prompt` 是首选主入口**

推荐示例：

- `prompt`: `gateway_agent_render`
- `prompt`: `coding_agent_render`

## 5.3 `tool`

适合暴露什么：

- 带较多参数的 render 动作
- 需要返回结构化 meta 的 render 结果
- 需要更细控制输入和输出的客户端

优点：

- 参数和结构化返回最灵活
- 更容易附带 `renderMeta`
- 更适合作为第一版稳定实现

缺点：

- 对某些客户端来说不如 prompt 自然
- 容易被误用成“所有东西都是 tool”

结论：

- **如果要优先保证实现稳定与兼容性，`tool` 是最稳妥的第一版入口**

推荐示例：

- `tool`: `gateway_agent_render`

## 5.4 推荐选型

建议按下面的优先级落地：

1. **第一版先做 `tool: gateway_agent_render`**
2. **第二版在客户端支持成熟后补 `prompt: gateway_agent_render`**
3. **同时补只读 `resource`，但只用于 profile / template preview，不用于最终渲染主入口**

一句话说：

**主执行入口优先 `tool`，理想形态是 `prompt`，辅助观察用 `resource`。**

---

## 6. 推荐 contract 形态

## 6.1 输入

建议 `gateway_agent_render` 最小输入包含：

- `agentId`
- `requestContext`
- `authContext`
- `sessionContext`
- `task`
- `repository`
- `files`
- `symbols`
- `recentMessages`
- `options`

说明：

- `agentId` 用于定位 canonical agent template
- `requestContext` / `authContext` 保持与 native 语义一致
- `task` / `files` / `symbols` / `recentMessages` 面向编码场景
- `options` 用于控制 render 深度、记忆注入强度、是否返回 meta

## 6.2 输出

建议返回结构至少包含：

- `renderedPrompt`
- `renderMeta`

其中 `renderMeta` 建议至少包括：

- `agentId`
- `templateVersion`
- `memoryRecallApplied`
- `recallSources`
- `truncated`
- `filteredByPolicy`
- `requestId`
- `traceId`

如果走 tool 返回，建议结构类似：

```json
{
  "renderedPrompt": "....",
  "renderMeta": {
    "agentId": "Ariadne",
    "templateVersion": "v1",
    "memoryRecallApplied": true,
    "recallSources": ["tagmemo", "agent-knowledge-diary"],
    "truncated": false,
    "filteredByPolicy": false,
    "requestId": "req-123",
    "traceId": "agwop_xxx"
  }
}
```

---

## 7. 与底层记忆能力的关系

`gateway_agent_render` 不应替代底层能力，而应建立清晰分工：

- `gateway_agent_render`
  - 面向编码工具主流程
  - 直接返回可消费 prompt
- `gateway_memory_search`
  - 面向显式检索与调试
- `gateway_context_assemble`
  - 面向 recall block 级别解释
- `gateway_memory_write`
  - 面向长期记忆回写

推荐理解方式：

- `render` 是高层入口
- `memory/context/write` 是控制面与解释面

---

## 8. 安全与边界

设计 `gateway_agent_render` 时应重点约束下面这些边界：

- **不要原样暴露内部模板文件**
- **不要无约束返回内部占位符协议**
- **不要让客户端绕过 canonical auth / policy / diary scope**
- **不要把内部记忆源名称和实现细节无选择暴露出去**
- **不要把 render 输出和 template preview 混成同一个 contract**

建议对外只暴露稳定的：

- rendered output
- 必要 meta
- 脱敏后的 preview

---

## 9. 推荐实施顺序

### 9.1 第一阶段

- 在 native `agent_gateway` 中冻结 agent render 的 canonical contract
- 明确 render 是否属于已发布 external surface
- 定义 `renderMeta` 的最小稳定字段

### 9.2 第二阶段

- 在 MCP 中实现 `tool: gateway_agent_render`
- 与 memory/context/write 共用统一 context / auth / error / trace 入口
- 增加 native vs MCP render 一致性测试

### 9.3 第三阶段

- 视客户端成熟度补 `prompt: gateway_agent_render`
- 补 `resource` 形式的 profile / template preview
- 再评估是否需要更高层的 coding-specialized render 能力

---

## 10. OpenSpec 建议切分

如果后续要落成 change，建议按下面方式切：

- `agent-gateway-m13-agent-render-contract`
  - 冻结 native canonical render contract
- `agent-gateway-m13-mcp-agent-render`
  - 增加 MCP tool 版 render
- `agent-gateway-m13-mcp-agent-prompt-publishing`
  - 视情况增加 prompt / resource publishing

---

## 11. 最终建议

如果目标是让 `Trae`、`Claude Code` 这类编码工具使用 VCP 内置 agent 提示词与记忆能力，推荐选择如下：

- **主线 contract：`agent_gateway` 的 canonical render**
- **首个 MCP 暴露形态：`tool: gateway_agent_render`**
- **理想长期形态：补 `prompt: gateway_agent_render`**
- **辅助能力：增加 profile / template preview resource**

一句话总结：

**不要把 `Agent/*.txt` 直接发布给 MCP；要发布的是“经过 canonical render 链路编译后的、带记忆能力的 agent prompt”。**
