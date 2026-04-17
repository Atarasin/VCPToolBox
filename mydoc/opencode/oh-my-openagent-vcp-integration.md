# oh-my-openagent × VCPToolBox 联合方案

> **你当前真正需要的不是“先桥接工具”，而是“先桥接 Agent 定义本身”。**
>  
> 目标是：**在 VCP 侧维护 Agent 提示词与注册表，oh-my-openagent 只负责读取这些已注册 Agent 并参与编排。**

> **研究范围**：VCP Agent 管理机制、`Agent/` 目录、`agent_map.json`、Admin API、占位符展开链路、oh-my-openagent 的多 Agent 编排模型
> **基于版本**：VCPToolBox VCP 7.1.2 | oh-my-openagent（code-yeongyu/oh-my-openagent）
> **更新时间**：2026-04-16

---

## 执行摘要

这次重新梳理后，核心结论发生了变化：

- **VCP 已经具备“Agent Prompt Registry”能力**，不是只有 OpenClaw Bridge
- `Agent/` 目录就是 Agent 提示词仓库
- `agent_map.json` 就是 Agent 注册表，负责把别名映射到具体提示词文件
- `modules/agentManager.js` 已经实现了**加载、缓存、热更新、文件扫描、别名解析**
- `routes/admin/agents.js` 已经提供了**读取注册表、列出 Agent 文件、读写 Agent 文件**的管理接口
- `modules/messageProcessor.js` 已经把这些 Agent 视为**可展开占位符**，说明它们在 VCP 内部是“一等公民”

因此，更贴近你预期的联合方案应该是：

1. **VCP 负责定义和注册 Agent**
2. **oh-my-openagent 从 VCP 拉取已注册 Agent**
3. **oh-my-openagent 把这些 Agent 当作 worker / specialist / role 使用**
4. **工具桥接、记忆桥接、RAG 桥接放到第二阶段**

一句话概括：

> **VCP 先做 Agent Registry，oh-my-openagent 再做 Agent Orchestrator。**

---

## 一、VCP 侧已经具备什么

### 1.1 Agent 提示词目录

VCP 当前默认把 Agent 提示词放在：

```text
/home/zh/projects/VCP/VCPToolBox/Agent
```

这里的文件可以是：

- `.txt`
- `.md`
- 子目录内的分层文件
- 符号链接文件

`modules/agentManager.js` 会递归扫描该目录，收集全部 Agent 文件，并保留文件夹结构。

### 1.2 Agent 注册表

VCP 当前的注册表文件是：

```json
{
  "Ariadne": "Ariadne.txt",
  "Aurora": "novel_workflow_v3/NovelStage0RequirementAgent_v3.txt",
  "Atlas": "novel_workflow_v3/NovelStage1SkeletonWorldviewAgent_v3.txt"
}
```

语义非常清晰：

- key：对外暴露的 Agent 名称 / 别名
- value：对应提示词文件在 `Agent/` 下的相对路径

也就是说，**VCP 已经天然支持“Agent 名称”和“Prompt 文件”解耦**。

### 1.3 Agent 运行时管理能力

`modules/agentManager.js` 已经内置以下能力：

- 启动时读取 `agent_map.json`
- 扫描 `Agent/` 目录
- 建立 `alias -> file` 映射
- 根据 alias 加载 prompt 内容
- 缓存 prompt，减少重复 IO
- 监听 `agent_map.json` 变化并自动清缓存
- 监听 `Agent/` 目录变化并自动热更新

这意味着：

> **从 VCP 视角看，Agent 并不是“散落的文本文件”，而是一套已经具备生命周期管理的资源。**

### 1.4 Admin API 已经能读写这些 Agent

当前 VCP 已经挂载了管理 API，相关接口在 `routes/admin/agents.js`：

| 方法 | 端点 | 用途 |
|------|------|------|
| `GET` | `/admin_api/agents/map` | 读取 `agent_map.json` |
| `POST` | `/admin_api/agents/map` | 保存注册表 |
| `GET` | `/admin_api/agents` | 列出全部 Agent 文件和目录结构 |
| `POST` | `/admin_api/agents/new-file` | 新建 Agent 提示词文件 |
| `GET` | `/admin_api/agents/:fileName` | 读取某个 Agent 文件内容 |
| `POST` | `/admin_api/agents/:fileName` | 保存某个 Agent 文件内容 |

这组接口虽然原本面向 AdminPanel，但**已经足够作为 oh-my-openagent 的 Agent Registry 数据源**。

### 1.5 Agent 在 VCP 内部已被正式纳入提示词系统

`modules/messageProcessor.js` 当前已经支持两种 Agent 占位符格式：

```text
{{AgentAlias}}
{{agent:AgentAlias}}
```

并且会：

- 校验该 alias 是否已注册
- 调 `agentManager.getAgentPrompt(alias)` 取真实提示词
- 做递归展开
- 防止循环引用
- 限制同一次上下文只展开一个 Agent

这说明一件很重要的事：

> **VCP 的 Agent 不是旁路配置，而是主提示词系统的一部分。**

---

## 二、这份联合方案应该如何改写

上一版文档的问题在于：**把 OpenClaw Bridge 当成了第一入口**。

但你的目标不是“让 oh-my-openagent 先调用 VCP 工具”，而是：

> **让 oh-my-openagent 直接消费 VCP 中已经注册好的 Agent。**

所以更合理的分层应该是：

### 第一层：Agent Registry

由 VCP 负责：

- 管理 Agent 提示词文件
- 管理 Agent 名称映射
- 提供读取接口
- 负责热更新

### 第二层：Agent Materialization

由 oh-my-openagent 负责：

- 拉取注册表
- 拉取具体提示词
- 转换成自身可识别的 agent/worker 配置
- 放进规划层、执行层、worker 层进行编排

### 第三层：能力扩展

后续再考虑是否接入：

- VCP 工具调用
- VCP RAG / TagMemo
- VCP ChatCompletion 工具循环
- VCP WebSocket 推送

所以推荐方案不是“OpenClaw 优先”，而是：

## 方案 A：VCP 作为 Agent Registry，oh-my-openagent 作为编排器

```text
┌──────────────────────────────────────────────────────┐
│                    VCPToolBox                        │
│                                                      │
│  Agent/                 agent_map.json               │
│  ├─ Planner.txt         {                            │
│  ├─ Researcher.txt        "Planner": "Planner.txt",  │
│  └─ Writer.txt           "Writer": "Writer.txt"      │
│                          }                           │
│                                                      │
│  modules/agentManager.js                             │
│  - 扫描 Agent 文件                                   │
│  - 解析 alias -> file                                │
│  - 缓存与热更新                                      │
│                                                      │
│  /admin_api/agents*                                  │
│  - 导出注册表                                        │
│  - 导出文件列表                                      │
│  - 导出 prompt 内容                                  │
└───────────────────────┬──────────────────────────────┘
                        │
                        │ HTTP 拉取 Agent 定义
                        ▼
┌──────────────────────────────────────────────────────┐
│                 oh-my-openagent                      │
│                                                      │
│  Agent Adapter                                       │
│  - 读取 VCP 注册表                                   │
│  - 获取 prompt 内容                                  │
│  - 生成 worker/role 定义                             │
│                                                      │
│  Planner / Atlas / Worker Layer                      │
│  - 使用来自 VCP 的注册 Agent                         │
│  - 负责任务分解和调度                                │
└──────────────────────────────────────────────────────┘
```

这个方案更符合你的原始意图：

- Agent 定义权在 VCP
- 编排权在 oh-my-openagent
- 两边职责清晰
- 不必先把工具、记忆、RAG 全接起来

---

## 三、推荐的数据流

### 3.1 定义 Agent

在 VCP 里写一个提示词文件，例如：

```text
Agent/ProductManager.txt
```

内容示例：

```text
你是产品经理 Agent。
职责：
1. 分析需求
2. 拆分任务
3. 输出验收标准
输出要求：
- 结论优先
- 结构清晰
- 不做未经验证的技术假设
```

### 3.2 注册 Agent

在 `agent_map.json` 中注册：

```json
{
  "ProductManager": "ProductManager.txt",
  "Researcher": "Researcher.txt",
  "Writer": "Writer.txt"
}
```

如果是子目录：

```json
{
  "ProductManager": "product/ProductManager.txt",
  "Researcher": "research/Researcher.md",
  "Writer": "writing/Writer.txt"
}
```

### 3.3 oh-my-openagent 同步注册表

oh-my-openagent 启动或定时刷新时：

1. 调 `GET /admin_api/agents/map`
2. 拿到 alias -> file 映射
3. 对每个 file 调 `GET /admin_api/agents/:fileName`
4. 把返回的 prompt 内容转为内部 agent 定义

### 3.4 oh-my-openagent 实例化 Agent

示意逻辑：

```ts
type VcpAgentMap = Record<string, string>;

type VcpAgentDefinition = {
  alias: string;
  file: string;
  prompt: string;
};

async function loadAgentsFromVcp(baseUrl: string, headers: HeadersInit) {
  const agentMap = await fetch(`${baseUrl}/admin_api/agents/map`, { headers }).then(r => r.json()) as VcpAgentMap;

  const entries = await Promise.all(
    Object.entries(agentMap).map(async ([alias, file]) => {
      const encoded = encodeURIComponent(file);
      const detail = await fetch(`${baseUrl}/admin_api/agents/${encoded}`, { headers }).then(r => r.json());
      return {
        alias,
        file,
        prompt: detail.content
      } satisfies VcpAgentDefinition;
    })
  );

  return entries;
}
```

然后把它们映射成 oh-my-openagent 的内部角色：

```ts
function toOpenAgentWorker(def: VcpAgentDefinition) {
  return {
    name: def.alias,
    systemPrompt: def.prompt
  };
}
```

---

## 四、最小可落地方案

如果你现在要的是**最快跑通**，不建议一上来做 MCP、OpenClaw、RAG、记忆全套。

最小闭环只需要：

### VCP 侧

- 在 `Agent/` 中维护提示词文件
- 在 `agent_map.json` 中维护注册表
- 保持现有 `/admin_api/agents*` 接口可访问

### oh-my-openagent 侧

- 增加一个 `VcpAgentRegistryAdapter`
- 启动时同步一遍 Agent 注册表
- 支持手动刷新或定时刷新
- 将拉取到的 prompt 注入到自身 Agent 定义

这样你就能得到一个清晰的职责边界：

- **VCP 改 prompt**
- **VCP 改注册**
- **oh-my-openagent 自动使用新 agent**

---

## 五、为什么这比“直接桥接工具”更适合当前目标

### 5.1 先解决 Agent 源头一致性

如果 Agent 提示词定义散落在 oh-my-openagent 侧，那么：

- VCP 里维护一套
- oh-my-openagent 里再维护一套
- 最终会出现角色漂移和版本不一致

而把 VCP 作为单一 Agent Source of Truth 后：

- 提示词统一在 `Agent/`
- 注册统一在 `agent_map.json`
- oh-my-openagent 只负责消费和编排

### 5.2 更符合 VCP 现有代码形态

VCP 现在最成熟、最直接、与你需求最贴近的，不是 OpenClaw，而是：

- `agentManager`
- `agent_map.json`
- `Agent/`
- `/admin_api/agents*`

这些能力已经存在，不需要重新发明“Agent Registry”。

### 5.3 更利于后续扩展

当 Agent Registry 跑通后，后续你再分阶段加能力：

1. 先加 VCP 工具描述注入
2. 再加 OpenClaw 工具调用
3. 再加 TagMemo 记忆读写
4. 最后考虑把复杂子任务转发给 `/v1/chat/completions`

这条路线更稳。

---

## 六、推荐的联合架构

### 阶段 1：Agent Registry 模式

```text
VCP 定义 Agent
    ↓
VCP 注册 Agent
    ↓
oh-my-openagent 拉取 Agent
    ↓
oh-my-openagent 负责编排
```

### 阶段 2：Agent + Tool 模式

在阶段 1 的基础上，再让 oh-my-openagent 为某些 VCP Agent 挂上工具能力：

- 读取 `{{VCPAllTools}}`
- 或使用 OpenClaw 调工具

### 阶段 3：Agent + Tool + Memory 模式

当你需要长期记忆时，再接：

- `/openclaw/rag/search`
- `/openclaw/rag/context`
- `/openclaw/memory/write`

也就是说：

> **Agent Registry 是第一步，不是附属品。**

---

## 七、建议的接口契约

如果**不改 VCP 代码**，直接复用现有接口，oh-my-openagent 可以这样接：

### 7.1 列出 Agent 注册表

```http
GET /admin_api/agents/map
```

返回：

```json
{
  "Planner": "planner/Planner.txt",
  "Researcher": "research/Researcher.txt",
  "Writer": "writing/Writer.md"
}
```

### 7.2 列出 Agent 文件树

```http
GET /admin_api/agents
```

返回：

```json
{
  "files": [
    "planner/Planner.txt",
    "research/Researcher.txt",
    "writing/Writer.md"
  ],
  "folderStructure": {
    "planner": {
      "type": "folder",
      "children": {
        "Planner.txt": {
          "type": "file",
          "path": "planner/Planner.txt"
        }
      }
    }
  }
}
```

### 7.3 读取 Agent Prompt

```http
GET /admin_api/agents/planner%2FPlanner.txt
```

返回：

```json
{
  "content": "你是 Planner Agent ..."
}
```

这已经足够了。

---

## 八、如果要进一步优化，建议新增一个“只读 Agent Registry API”

虽然现有 `/admin_api/agents*` 可用，但它的定位偏管理端。

如果要专门服务 oh-my-openagent，建议未来增加一个更明确的只读接口层，例如：

| 方法 | 端点 | 说明 |
|------|------|------|
| `GET` | `/admin_api/openclaw/agents` | 列出已注册 Agent |
| `GET` | `/admin_api/openclaw/agents/:alias` | 直接按 alias 返回 prompt |
| `GET` | `/admin_api/openclaw/agents/:alias/meta` | 返回 file、mtime、hash、长度等元信息 |

理想返回格式：

```json
{
  "success": true,
  "data": {
    "alias": "Planner",
    "file": "planner/Planner.txt",
    "prompt": "你是 Planner Agent ...",
    "updatedAt": "2026-04-16T10:20:30Z",
    "charCount": 1824
  }
}
```

这样 oh-my-openagent 不需要先查 map 再查 file，而可以直接按 alias 读取。

但要强调：

> **这属于体验优化，不是当前落地的前置条件。**

---

## 九、oh-my-openagent 侧的推荐实现方式

oh-my-openagent 不必把 VCP Agent 当成“外部工具”，而应该把它们当成“外部维护的角色定义”。

推荐增加一个适配层：

### 9.1 `VcpAgentRegistryAdapter`

职责：

- 拉取 `agent_map.json`
- 拉取对应 prompt 文件
- 缓存结果
- 提供 refresh
- 将 VCP Agent 转为 oh-my-openagent 的内部结构

### 9.2 两种同步策略

#### 方式 A：启动时全量同步

适合最小可用版本：

- 服务启动时同步一次
- 运行中不自动刷新

#### 方式 B：带版本检查的定时刷新

适合长期运行：

- 每隔 N 分钟刷新一次
- 或提供手动 `/reload-agents`

### 9.3 角色映射建议

VCP 里的 alias 不一定要强绑定 oh-my-openagent 固定角色名。

建议用一个映射层：

```json
{
  "Prometheus": { "category": "planning" },
  "Atlas": { "category": "execution" },
  "Aurora": { "category": "writing" }
}
```

这样：

- VCP 负责 prompt
- oh-my-openagent 负责分类和调度

---

## 十、推荐的实施顺序

### P0：跑通 Registry

1. 在 `Agent/` 里整理可复用 prompt
2. 在 `agent_map.json` 中完成注册
3. 用现有 `/admin_api/agents*` 做读取接口
4. 在 oh-my-openagent 增加 `VcpAgentRegistryAdapter`

### P1：跑通编排

1. 从 VCP 拉取 Agent
2. 转成 oh-my-openagent 内部 worker 定义
3. 在 Planner / Atlas / Worker 层使用它们

### P2：补能力

1. 需要工具时接 OpenClaw
2. 需要记忆时接 TagMemo
3. 需要复杂自动工具循环时再接 VCP ChatCompletion

### P3：做成正式协议

1. 增加只读 Agent Registry API
2. 加 alias 直读接口
3. 加 hash / version / updatedAt
4. 支持增量同步

---

## 十一、最终结论

如果按你的预期来定义方案，结论应该改成下面这句，而不是上一版那句：

> **oh-my-openagent × VCPToolBox 的第一优先级集成方式，不是把 VCP 当成工具后端，而是把 VCP 当成 Agent Prompt Registry。**

更具体地说：

- `Agent/` 是 Prompt 源文件目录
- `agent_map.json` 是 Agent 注册表
- `agentManager` 是运行时加载与热更新核心
- `/admin_api/agents*` 是现成的读取接口
- oh-my-openagent 应该消费这些注册过的 Agent，而不是在自己侧再维护一套重复定义

OpenClaw、TagMemo、工具桥接都仍然有价值，但它们应当是**第二阶段能力增强**，而不是第一阶段入口。

---

## 附录：关键源码定位

| 功能 | 文件 | 说明 |
|------|------|------|
| Agent 注册与缓存 | `modules/agentManager.js` | 读取 `agent_map.json`、扫描 `Agent/`、缓存、热更新 |
| Agent 占位符展开 | `modules/messageProcessor.js` | 支持 `{{alias}}` 与 `{{agent:alias}}` |
| Agent 管理 API | `routes/admin/agents.js` | 提供 `/agents`、`/agents/map`、文件读写 |
| Admin API 挂载 | `routes/adminPanelRoutes.js` | 将 `agents` 模块挂载到 `/admin_api` |
| 服务启动时初始化 AgentManager | `server.js` | 启动时 `setAgentDir()` + `initialize()` |
| 当前 Agent 注册表 | `agent_map.json` | alias -> file |
| 当前 Agent 提示词目录 | `Agent/` | prompt 源文件仓库 |

---

*本文档基于 VCPToolBox 当前源码重新聚焦，目标是把联合方案从“工具桥接优先”修正为“Agent Registry 优先”。*
