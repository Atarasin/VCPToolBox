# AgentDispatcher 共享接口契约

**日期：** 2026-04-30
**状态：** S01 契约裁决文档

---

## 一、现有依赖分析

### AgentDispatcher.js 当前依赖

| 依赖 | 用途 | 是否必须解耦 |
|------|------|------------|
| `AgentDefinitions.getAgentConfig(agentType, config)` | 解析 agent 配置（modelId, systemPrompt, temperature 等） | ✅ 必须解耦 — 硬编码了 StoryOrchestrator 的 agent 类型 |
| `stateManager`（构造函数参数） | **实际代码中从未使用** | ✅ 可以移除 — 虚假依赖 |
| `globalConfig.AGENT_ASSISTANT_URL` / `PORT` | AgentAssistant HTTP 端点地址 | ⚠️ 保留为配置项 |
| `globalConfig.VCP_Key` / `process.env.VCP_Key` | HTTP 请求鉴权 | ⚠️ 保留为配置项 |
| `http` 模块 | 发起 HTTP 请求到 AgentAssistant | ✅ 保留 — 核心能力 |

### 关键发现：`stateManager` 是虚假依赖

AgentDispatcher 的构造函数接收了 `stateManager` 参数：
```javascript
constructor(globalConfig, stateManager) {
  this.config = globalConfig;
  this.stateManager = stateManager;  // 存储了但从未使用
}
```

但整个类的方法中没有任何地方调用 `this.stateManager`。这意味着 `stateManager` 的耦合是**构造时传入但运行时未消费**的虚假依赖，可以直接移除而不影响功能。

---

## 二、共享接口设计

### 解耦策略：配置解析外部化

将 agent 配置解析从 `AgentDispatcher` 内部移出，通过构造函数注入 `agentResolver`：

```javascript
class AgentDispatcher {
  constructor({ agentAssistantUrl, vcpKey, agentResolver }) {
    this.agentAssistantUrl = agentAssistantUrl;
    this.vcpKey = vcpKey;
    this.agentResolver = agentResolver;  // 外部化的配置解析
  }
}
```

`agentResolver` 签名：
```javascript
(agentType) => {
  modelId: string,
  systemPrompt: string,
  maxOutputTokens: number,
  temperature: number
}
```

### 保留的公共 API

```javascript
// 串行委托
async delegate(agentType, prompt, options = {}) => Result

// 并行委托
async delegateParallel(agentTasks) => { succeeded: [], failed: [] }

// 串行委托（带进度回调）
async delegateSerial(agentTasks, onProgress) => []
```

### Result 结构

```javascript
{
  content: string,           // Agent 返回的文本内容
  raw: object,               // 原始 HTTP 响应
  markers: {
    isComplete: boolean,     // 包含 [[TaskComplete]]
    isFailed: boolean,       // 包含 [[TaskFailed]]
    hasHeartbeat: boolean    // 包含 [[NextHeartbeat]]
  }
}
```

### 选项结构

```javascript
delegate(agentType, prompt, {
  timeoutMs: number,         // 默认 600000ms
  taskDelegation: boolean,   // true = 异步委托，false = 同步委托
  temporaryContact: boolean  // 默认 true
})
```

---

## 三、StoryOrchestrator 适配层

StoryOrchestrator 使用 AgentDispatcher 时，需要提供 `agentResolver`：

```javascript
const { getAgentConfig } = require('./agents/AgentDefinitions');

const agentDispatcher = new AgentDispatcher({
  agentAssistantUrl: globalConfig.AGENT_ASSISTANT_URL,
  vcpKey: globalConfig.VCP_Key,
  agentResolver: (agentType) => getAgentConfig(agentType, globalConfig)
});
```

这样 `AgentDispatcher` 不感知 `AgentDefinitions` 的存在，而 StoryOrchestrator 保留自己的 agent 类型定义。

---

## 四、迁移路径

### Phase 1（S01）：契约确立
- 产出本契约文档
- 产出 contract tests（不依赖 StoryOrchestrator 上下文）

### Phase 2（S05）：物理提取
- 将 `AgentDispatcher.js` 从 `Plugin/StoryOrchestrator/agents/` 移动到 `modules/agentDispatcher/`
- 修改构造函数签名（移除 stateManager，增加 agentResolver）
- StoryOrchestrator 更新初始化代码，传入 `agentResolver`
- 保留旧的 import 路径作为兼容别名（一个发布周期）

### Phase 3（S06 之后）：旧路径清理
- 删除 `Plugin/StoryOrchestrator/agents/AgentDispatcher.js` 的兼容别名
- StoryOrchestrator 直接 `require('../../../modules/agentDispatcher')`
