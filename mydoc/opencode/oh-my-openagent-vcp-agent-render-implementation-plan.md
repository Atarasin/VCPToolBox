# oh-my-openagent × VCP Agent Render 双端改造实施方案

> 目标：让 `oh-my-openagent` 能使用 VCP 中定义的复杂 Agent 提示词，同时保留 VCP 自有的元思考、日记本 RAG、TagMemo、环境变量与占位符系统。

> 核心原则：**VCP 负责渲染，oh-my-openagent 负责注入。**

---

## 一、问题定义

VCP 的 Agent 提示词并不是普通静态文本，而是包含多层运行时语义：

- `{{TarSysPrompt}}`、`{{VarSystemInfo}}`、`{{VarToolList}}` 等环境变量与 TVS 变量
- `{{agent:Alias}}` 等 Agent 引用
- `[[VCP元思考::Auto::Group]]` 等元思考链
- `[[阿里阿德涅日记本::Time::TagMemo]]` 等日记本 RAG 检索语法
- `<<VCP开发日记本>>`、`《《知识日记本::TagMemo》》` 等其他 RAG 变体

这些能力依赖 VCP 内部运行时：

- `modules/agentManager.js`
- `modules/messageProcessor.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- `KnowledgeBaseManager.js`
- `TagMemoEngine.js`

因此，`oh-my-openagent` 不能直接读取 `Agent/*.txt` 后自行使用，否则会出现两个问题：

1. 无法识别 VCP DSL
2. 无法复现 VCP 内部的实际渲染结果

所以必须把集成拆成两层：

- **VCPToolBox**：把 Agent 源 prompt 渲染为最终纯文本 system prompt
- **oh-my-openagent**：在 delegating / subagent prompt 前把该纯文本注入 `system`

---

## 二、总体方案

### 2.1 架构结论

采用“**Agent Registry + Prompt Render**”双层方案：

```text
VCP Agent 源文件
  Agent/*.txt / *.md
        +
  agent_map.json
        +
  messageProcessor / RAGDiaryPlugin / TagMemo
        ↓
POST /admin_api/agents/render
        ↓
返回已展开的纯文本 renderedPrompt
        ↓
oh-my-openagent VcpAgentResolver
        ↓
delegate-task / call_omo_agent 注入 body.system
        ↓
子 Agent 在 opencode 中运行
```

### 2.2 边界划分

#### VCP 负责

- 管理 Agent 源文件与注册表
- 解析 `{{...}}` 变量
- 解析 `[[...]]` / `<<...>>` / `《《...》》` RAG 语法
- 执行元思考链
- 将复杂 prompt 编译为纯文本

#### oh-my-openagent 负责

- 按 agent 名称映射到 VCP alias
- 请求 VCP render API
- 做本地缓存和失败回退
- 将 render 结果注入到 `session.prompt({ system })`

### 2.3 不做的事

第一阶段不在 `oh-my-openagent` 中复刻以下能力：

- VCP DSL 解析器
- TagMemo 检索逻辑
- RAGDiaryPlugin 语义检索逻辑
- 元思考链执行器

这些都继续由 VCP 提供。

---

## 三、VCPToolBox 侧改造方案

## 3.1 改造目标

在现有 `routes/admin/agents.js` 基础上新增一个“编译/渲染”接口：

```http
POST /admin_api/agents/render
```

该接口输入 VCP Agent alias 与当前任务上下文，输出最终纯文本 prompt。

## 3.2 新增接口定义

### 请求体

```json
{
  "alias": "Ariadne",
  "model": "openai/gpt-5.4",
  "messages": [
    {
      "role": "user",
      "content": "请帮我分析 VCP 与 opencode 的 Agent 注入方案"
    }
  ],
  "options": {
    "target": "oh-my-openagent",
    "includeArtifacts": true,
    "strict": false
  }
}
```

### 响应体

```json
{
  "success": true,
  "data": {
    "alias": "Ariadne",
    "sourceFile": "Ariadne.txt",
    "renderedPrompt": "......最终纯文本 system prompt......",
    "artifacts": {
      "metaThinkingBlocks": [
        {
          "placeholder": "[[VCP元思考::Auto::Group]]",
          "resolved": "......元思考链输出......"
        }
      ],
      "memoryBlocks": [
        {
          "placeholder": "[[阿里阿德涅日记本::Time::TagMemo]]",
          "resolved": "......召回结果......"
        }
      ]
    },
    "unresolved": []
  }
}
```

### 失败响应

```json
{
  "success": false,
  "error": "Agent alias not found",
  "details": {
    "alias": "AriadneX"
  }
}
```

## 3.3 文件级改造建议

### 修改文件

- `routes/admin/agents.js`
- `modules/agentManager.js`
- `modules/messageProcessor.js`

### 新增文件

- `modules/agentPromptRenderer.js`

### 推荐职责拆分

#### `modules/agentPromptRenderer.js`

新模块职责：

- 读取 alias 对应 Agent 源文件
- 构造最小渲染上下文
- 调用 `messageProcessor` 展开 `{{...}}`
- 复用 `RAGDiaryPlugin` 对 `[[...]]` 等语法进行渲染
- 汇总 artifacts / unresolved
- 返回最终 `renderedPrompt`

建议接口：

```js
async function renderAgentPrompt({
  alias,
  model,
  messages,
  pluginManager,
  cachedEmojiLists,
  DEBUG_MODE,
  options = {}
}) {
  // return { alias, sourceFile, renderedPrompt, artifacts, unresolved }
}
```

## 3.4 渲染链路设计

推荐顺序如下：

### 第 1 步：校验 alias

- 使用 `agentManager.isAgent(alias)`
- 若未注册，返回 404

### 第 2 步：读取源 prompt

- 使用 `agentManager.getAgentPrompt(alias)`
- 得到原始 Agent DSL 文本

### 第 3 步：构造渲染上下文

上下文至少包含：

- `pluginManager`
- `cachedEmojiLists`
- `DEBUG_MODE`
- `messages`
- `expandedAgentName`
- `expandedToolboxes`
- `model`

示意：

```js
const context = {
  pluginManager,
  cachedEmojiLists,
  DEBUG_MODE,
  messages,
  expandedAgentName: null,
  expandedToolboxes: new Set(),
};
```

### 第 4 步：先展开 `{{...}}`

复用 `messageProcessor` 已有逻辑：

- Agent placeholder
- Tar / Var
- SarPrompt
- Toolbox

这里建议不要复制逻辑，而是给 `messageProcessor.js` 导出一个正式方法，例如：

```js
async function renderPromptText(text, model, role, context)
```

或导出：

```js
module.exports = {
  processMessages,
  renderPromptText
}
```

这样 `agentPromptRenderer` 可以直接复用。

### 第 5 步：再处理 RAG / 元思考语法

复用 `RAGDiaryPlugin` 的系统 prompt 处理能力。

关键事实：

- `RAGDiaryPlugin` 已具备 `_processSingleSystemMessage()` 处理能力
- 它能处理：
  - `[[VCP元思考...]]`
  - `[[...日记本...]]`
  - `<<...日记本...>>`
  - `《《...日记本...》》`
  - `{{...日记本...}}`

但该方法目前是内部方法，因此这里有两种改法：

#### 方案 A：轻封装导出

在 `RAGDiaryPlugin` 新增公开方法：

```js
async renderSystemPrompt(content, options)
```

内部转调 `_processSingleSystemMessage()`。

#### 方案 B：Renderer 直接调用内部方法

不推荐。虽然快，但后续维护成本高。

推荐采用方案 A。

### 第 6 步：收集 unresolved

渲染完成后，用规则检测是否仍残留未展开语法：

- `/\{\{[^{}]+\}\}/`
- `/\[\[[^\]]+\]\]/`
- `/<<[^>]+>>/`
- `/《《[^》]+》》/`

若存在残留：

- `strict = true` 时返回错误
- `strict = false` 时写入 `unresolved`

## 3.5 缓存策略

建议新增渲染缓存，避免频繁重复 RAG / 元思考开销。

缓存 key 建议：

```text
alias + model + hash(lastUserMessage) + hash(agentFileMtime) + hash(agentMapMtime)
```

缓存层级：

- 一级：进程内内存缓存
- 二级：依赖现有 promptCache 不够，因为 promptCache 只缓存源文件，不缓存渲染结果

TTL 建议：

- 默认 3 分钟

## 3.6 安全与权限

`/admin_api/agents/render` 应继承现有 `/admin_api` 权限体系，不额外裸露公开访问。

同时建议增加：

- `alias` 白名单校验
- `messages` 数量限制，例如最多 20 条
- `content` 长度限制，例如总字符数不超过 20k
- 可选 `target = "oh-my-openagent"` 审计字段

建议日志字段：

- alias
- sourceFile
- target
- model
- durationMs
- unresolvedCount

---

## 四、oh-my-openagent 侧改造方案

## 4.1 改造目标

在子 Agent system prompt 注入链路中，加入 VCP 渲染结果。

### 第一阶段必须覆盖

- `delegate-task`

### 第二阶段建议覆盖

- `call_omo_agent`

## 4.2 当前最佳注入点

现有调用链如下：

1. `src/tools/delegate-task/tools.ts`
2. `buildSystemContent()`
3. `src/tools/delegate-task/sync-prompt-sender.ts`
4. `ctx.client.session.prompt({ body.system })`

因此最佳方案是在 `tools.ts` 中先异步获取 `agentsContext`，再传给 `buildSystemContent()`。

## 4.3 配置层改造

### 修改文件

- `src/config/schema/oh-my-opencode-config.ts`
- `src/config/schema/agent-overrides.ts`

### 新增顶层配置

```jsonc
{
  "vcp_agent_registry": {
    "enabled": true,
    "base_url": "http://127.0.0.1:3000",
    "admin_api_base": "/admin_api",
    "bearer_token_env": "VCP_ADMIN_TOKEN",
    "timeout_ms": 15000,
    "cache_ttl_ms": 300000,
    "fallback_mode": "skip"
  }
}
```

### 新增 agent override 字段

```jsonc
{
  "agents": {
    "oracle": {
      "vcp_alias": "Ariadne",
      "vcp_render": true
    },
    "librarian": {
      "vcp_alias": "Ariadne",
      "vcp_render": true
    }
  }
}
```

### schema 建议

#### 顶层 schema

```ts
vcp_agent_registry: z.object({
  enabled: z.boolean().optional(),
  base_url: z.string().url(),
  admin_api_base: z.string().optional(),
  bearer_token_env: z.string().optional(),
  timeout_ms: z.number().optional(),
  cache_ttl_ms: z.number().optional(),
  fallback_mode: z.enum(["skip", "error"]).optional(),
}).optional()
```

#### agent override schema

```ts
vcp_alias: z.string().optional(),
vcp_render: z.boolean().optional(),
```

## 4.4 新增模块建议

### 新增目录

```text
src/integrations/vcp-agent-registry/
```

### 新增文件

- `types.ts`
- `client.ts`
- `resolver.ts`
- `cache.ts`

### 职责拆分

#### `client.ts`

负责 HTTP 调用 VCP：

- 组装 URL
- Bearer Token
- 超时控制
- 错误标准化

#### `resolver.ts`

负责：

- 从当前 agent override 找到 `vcp_alias`
- 决定是否要 render
- 调 client 获取 render 结果
- 返回 `agentsContext`

#### `cache.ts`

负责：

- 以内存 Map 做短 TTL 缓存
- key 由 `vcp_alias + model + prompt hash` 构成

## 4.5 注入链路改造

### 目标文件

- `src/tools/delegate-task/tools.ts`

### 建议改法

在 `buildSystemContent()` 前新增：

```ts
const agentsContext = await resolveVcpAgentsContext({
  agentName: agentToUse,
  prompt: args.prompt,
  sessionID: toolContext.sessionID,
  model: categoryModel,
  pluginConfig: options.pluginConfig,
})
```

然后传入：

```ts
const systemContent = buildSystemContent({
  skillContent,
  skillContents,
  categoryPromptAppend,
  agentsContext,
  agentName: agentToUse,
  maxPromptTokens,
  model: categoryModel,
  availableCategories,
  availableSkills,
})
```

### 注意点

- `buildSystemContent()` 目前是同步函数，不应在其中直接发 HTTP
- VCP render 必须在 `tools.ts` 外层异步调用完成

## 4.6 `call_omo_agent` 链路

第二阶段建议补到：

- `src/tools/call-omo-agent/sync-executor.ts`

当前该链路只传 `parts`，没有显式 `system`。

建议改为：

```ts
const systemContent = await resolveVcpAgentsContext({
  agentName: normalizedSubagentType,
  prompt: args.prompt,
  sessionID,
  model,
  pluginConfig,
})

await ctx.client.session.promptAsync({
  path: { id: sessionID },
  body: {
    agent: normalizedSubagentType,
    system: systemContent,
    tools: { ... },
    parts: [{ type: "text", text: args.prompt }],
    ...
  }
})
```

## 4.7 回退策略

推荐支持两种模式：

### `fallback_mode = "skip"`

- VCP render 失败时记录日志
- 不阻断子 agent 执行
- 回退到原有 opencode prompt

适合第一阶段上线。

### `fallback_mode = "error"`

- 渲染失败即中断委派
- 返回明确报错

适合强依赖 VCP prompt 的专用 agent。

---

## 五、接口交互时序

## 5.1 `delegate-task` 时序

```text
用户任务
  ↓
oh-my-openagent delegate-task
  ↓
resolveSubagentExecution()
  ↓
resolveVcpAgentsContext()
  ↓
POST VCP /admin_api/agents/render
  ↓
返回 renderedPrompt
  ↓
buildSystemContent({ agentsContext: renderedPrompt })
  ↓
session.prompt({ system: systemContent, parts: [task prompt] })
  ↓
子 Agent 执行
```

## 5.2 VCP render 时序

```text
POST /admin_api/agents/render
  ↓
校验 alias
  ↓
agentManager.getAgentPrompt(alias)
  ↓
messageProcessor.renderPromptText()
  ↓
RAGDiaryPlugin.renderSystemPrompt()
  ↓
检测 unresolved
  ↓
返回 renderedPrompt
```

---

## 六、实施步骤

## 6.1 Phase 1：打通最小链路

### VCPToolBox

1. 新增 `modules/agentPromptRenderer.js`
2. 在 `routes/admin/agents.js` 增加 `POST /agents/render`
3. 为 `messageProcessor.js` 导出可复用的 prompt 渲染函数
4. 为 `RAGDiaryPlugin` 增加公开 `renderSystemPrompt()` 包装方法

### oh-my-openagent

1. 新增 `vcp_agent_registry` 顶层配置
2. 新增 `agents.*.vcp_alias`
3. 新增 `src/integrations/vcp-agent-registry/*`
4. 改 `src/tools/delegate-task/tools.ts`

### 产出目标

- `delegate-task` 能成功把 VCP render 结果注入到 `body.system`

## 6.2 Phase 2：覆盖 `call_omo_agent`

1. 修改 `src/tools/call-omo-agent/sync-executor.ts`
2. 给 `promptAsync` 增加 `body.system`
3. 复用同一 resolver

## 6.3 Phase 3：增强可观测性

1. VCP render 返回 artifacts
2. oh-my-openagent 记录使用了哪个 `vcp_alias`
3. 增加调试日志与缓存命中日志

---

## 七、测试方案

## 7.1 VCPToolBox 侧测试

### 新增测试建议

- `test/admin-agents-render.test.js`
- 或扩展现有 admin routes 测试

### 必测场景

#### 场景 1：普通 alias 渲染

- 输入已注册 alias
- 返回 `success: true`
- `renderedPrompt` 为非空字符串

#### 场景 2：变量展开

- 源 prompt 包含 `{{Tar...}}` / `{{Var...}}`
- 返回结果不再包含对应占位符

#### 场景 3：元思考展开

- 源 prompt 包含 `[[VCP元思考::Auto::Group]]`
- 返回结果中不再出现该占位符

#### 场景 4：日记本 RAG 展开

- 源 prompt 包含 `[[...日记本::Time::TagMemo]]`
- 返回结果中不再保留原始占位符

#### 场景 5：strict 模式

- 存在无法展开的语法
- `strict = true` 时返回错误

#### 场景 6：缓存回收

- 第二次相同请求命中缓存
- 修改 `Agent` 文件后缓存失效

## 7.2 oh-my-openagent 侧测试

### 新增测试建议

- `src/integrations/vcp-agent-registry/resolver.test.ts`
- 扩展 `src/tools/delegate-task/tools.test.ts`
- 扩展 `src/tools/call-omo-agent/sync-executor.test.ts`

### 必测场景

#### 场景 1：配置命中

- `agents.oracle.vcp_alias = "Ariadne"`
- resolver 返回 render 结果

#### 场景 2：未配置 alias

- resolver 返回 `undefined`
- 旧逻辑不受影响

#### 场景 3：fallback skip

- VCP 请求失败
- 不报错，继续原始执行

#### 场景 4：fallback error

- VCP 请求失败
- 直接终止并返回错误

#### 场景 5：delegate-task 注入成功

- `buildSystemContent()` 收到 `agentsContext`
- `session.prompt()` 的 `body.system` 包含 render 内容

#### 场景 6：call_omo_agent 注入成功

- `promptAsync()` 的 `body.system` 存在 render 内容

#### 场景 7：缓存命中

- 相同任务二次调用不重复请求 VCP

---

## 八、推荐默认策略

第一版上线建议使用以下默认值：

### VCP 侧

- `strict = false`
- `includeArtifacts = true`
- 内存缓存 TTL = 3 分钟

### oh-my-openagent 侧

- `fallback_mode = "skip"`
- `cache_ttl_ms = 300000`
- 只在 `delegate-task` 启用 VCP 注入
- `call_omo_agent` 第二阶段再补

理由：

- 可以最快形成可运行闭环
- 失败时不影响原有 agent 调度
- 能先验证真实收益与稳定性

---

## 九、文件改造清单

## 9.1 VCPToolBox

### 新增

- `modules/agentPromptRenderer.js`

### 修改

- `routes/admin/agents.js`
- `modules/messageProcessor.js`
- `Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`

## 9.2 oh-my-openagent

### 新增

- `src/integrations/vcp-agent-registry/types.ts`
- `src/integrations/vcp-agent-registry/client.ts`
- `src/integrations/vcp-agent-registry/cache.ts`
- `src/integrations/vcp-agent-registry/resolver.ts`

### 修改

- `src/config/schema/oh-my-opencode-config.ts`
- `src/config/schema/agent-overrides.ts`
- `src/tools/delegate-task/tools.ts`
- `src/tools/call-omo-agent/sync-executor.ts`

---

## 十、最终结论

要把 VCP 里的复杂 Agent 提示词动态注入到 `oh-my-openagent` / opencode，中间不能省略“渲染层”。

正确的双端改造方式是：

1. **VCPToolBox 新增 `/admin_api/agents/render`**
2. **VCP 内部完成 Agent DSL 到纯文本 prompt 的编译**
3. **oh-my-openagent 新增 `VcpAgentResolver`**
4. **在 `delegate-task` 和后续 `call_omo_agent` 中把 render 结果注入 `body.system`**

这样可以同时满足：

- 复用 VCP 现有 Agent 资产
- 保留元思考 / RAG / TagMemo / 变量系统
- 避免在 oh-my-openagent 中重复实现 VCP 运行时
- 保持两边职责清晰、后续易维护

---

*本文档是实施级设计稿，目标不是描述概念，而是为双端代码改造提供直接可执行的开发蓝图。*
