# SDK 与代码示例

本文档提供可直接使用的 TypeScript SDK 源码和调用示例。

---

## VCPClient SDK

```typescript
// vcp-client.ts

export interface VCPRequestContext {
  agentId: string;
  sessionId: string;
  requestId?: string;
  source?: string;
}

export interface VCPMemoryTarget {
  diary: string;
  maid?: string;
}

export interface VCPMemoryPayload {
  text: string;
  tags?: string[];
  timestamp?: string;
  metadata?: Record<string, any>;
}

export interface VCPRagOptions {
  diary?: string;
  diaries?: string[];
  mode: 'rag' | 'hybrid' | 'auto';
  groupAware?: boolean;
  tagMemo?: boolean;
  timeAware?: boolean;
  rerank?: boolean;
  k?: number;
}

export interface VCPContextOptions {
  diary: string;
  maid?: string;
  maxBlocks?: number;
  tokenBudget?: number;
  minScore?: number;
  maxTokenRatio?: number;
}

export interface VCPDelegationOptions {
  async?: boolean;
  tools?: string[];
  scheduleTime?: string; // YYYY-MM-DD-HH:mm
  context?: VCPRequestContext;
}

export class VCPClient {
  constructor(
    private baseUrl: string,
    private vcpKey: string
  ) {}

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.vcpKey}`
    };
  }

  private async post(path: string, body: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body)
    });
    return res.json();
  }

  private async get(path: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        'Authorization': `Bearer ${this.vcpKey}`
      }
    });
    return res.json();
  }

  /**
   * 获取能力清单
   */
  async getCapabilities(agentId: string, maid?: string): Promise<any> {
    const params = new URLSearchParams({ agentId });
    if (maid) params.append('maid', maid);
    return this.get(`/admin_api/openclaw/capabilities?${params.toString()}`);
  }

  /**
   * 获取 RAG 目标列表
   */
  async getRagTargets(agentId: string, maid?: string): Promise<any> {
    const params = new URLSearchParams({ agentId });
    if (maid) params.append('maid', maid);
    return this.get(`/admin_api/openclaw/rag/targets?${params.toString()}`);
  }

  /**
   * 执行 RAG 搜索
   */
  async searchRag(
    query: string,
    options: VCPRagOptions,
    context: VCPRequestContext
  ): Promise<any> {
    const { diary, diaries, ...ragOptions } = options;
    return this.post('/admin_api/openclaw/rag/search', {
      query,
      diary,
      diaries,
      maid: context.agentId,
      requestContext: context,
      ...ragOptions
    });
  }

  /**
   * 召回上下文
   */
  async recallContext(
    recentMessages: Array<{ role: string; content: string }>,
    options: VCPContextOptions,
    context: VCPRequestContext
  ): Promise<any> {
    return this.post('/admin_api/openclaw/rag/context', {
      recentMessages,
      target: { diary: options.diary, maid: options.maid },
      options: {
        maxBlocks: options.maxBlocks ?? 3,
        tokenBudget: options.tokenBudget ?? 800,
        minScore: options.minScore ?? 0.7,
        maxTokenRatio: options.maxTokenRatio ?? 0.6
      },
      requestContext: context
    });
  }

  /**
   * 写入记忆
   */
  async writeMemory(
    target: VCPMemoryTarget,
    memory: VCPMemoryPayload,
    context: VCPRequestContext,
    options?: { idempotencyKey?: string; deduplicate?: boolean }
  ): Promise<any> {
    return this.post('/admin_api/openclaw/memory/write', {
      target,
      memory: {
        ...memory,
        timestamp: memory.timestamp ?? new Date().toISOString()
      },
      options: {
        idempotencyKey: options?.idempotencyKey,
        deduplicate: options?.deduplicate ?? true
      },
      requestContext: context
    });
  }

  /**
   * 调用任意插件
   */
  async invokeTool(
    toolName: string,
    args: Record<string, any>,
    context: VCPRequestContext
  ): Promise<any> {
    return this.post(`/admin_api/openclaw/tools/${toolName}`, {
      args,
      requestContext: {
        ...context,
        source: context.source ?? 'ohmy-openagent'
      }
    });
  }

  /**
   * 委托 VCP Agent 执行任务
   */
  async delegateAgent(
    agentName: string,
    prompt: string,
    options: VCPDelegationOptions = {}
  ): Promise<any> {
    return this.invokeTool(
      'AgentAssistant',
      {
        agent_name: agentName,
        prompt,
        task_delegation: options.async ?? true,
        inject_tools: options.tools?.join(','),
        timely_contact: options.scheduleTime,
        maid: options.context?.agentId
      },
      options.context ?? { agentId: 'unknown', sessionId: 'unknown' }
    );
  }

  /**
   * 查询委托状态
   */
  async queryDelegation(
    delegationId: string,
    context: VCPRequestContext
  ): Promise<any> {
    return this.invokeTool(
      'AgentAssistant',
      { query_delegation: delegationId },
      context
    );
  }

  /**
   * 即时通讯（不委托）
   */
  async chatWithAgent(
    agentName: string,
    prompt: string,
    context: VCPRequestContext,
    tools?: string[]
  ): Promise<any> {
    return this.invokeTool(
      'AgentAssistant',
      {
        agent_name: agentName,
        prompt,
        task_delegation: false,
        inject_tools: tools?.join(','),
        maid: context.agentId,
        session_id: context.sessionId
      },
      context
    );
  }
}
```

---

## 使用示例

### 示例 1：初始化客户端并发现能力

```typescript
import { VCPClient } from './vcp-client';

const vcp = new VCPClient(
  'http://localhost:5890',
  process.env.VCP_KEY!
);

async function discover() {
  const caps = await vcp.getCapabilities('nova');
  console.log('可用插件:', caps.data.tools.map((t: any) => t.name));
  console.log('记忆目标:', caps.data.memory.targets);
}

discover();
```

### 示例 2：对话前召回记忆上下文

```typescript
async function enrichContext(sessionId: string, messages: any[]) {
  const recentMessages = messages.slice(-4); // 最近 4 条

  const result = await vcp.recallContext(
    recentMessages,
    {
      diary: 'Nova日记本',
      maxBlocks: 3,
      tokenBudget: 600
    },
    { agentId: 'nova', sessionId }
  );

  if (result.success && result.data.contextBlocks.length > 0) {
    const memoryContext = result.data.contextBlocks
      .map((b: any) => b.content)
      .join('\n---\n');

    return [
      {
        role: 'system',
        content: `以下是与当前对话相关的记忆：\n${memoryContext}`
      },
      ...messages
    ];
  }

  return messages;
}
```

### 示例 3：对话结束后写入记忆

```typescript
async function saveMemory(sessionId: string, conversation: any[]) {
  // 由 LLM 或规则引擎提取关键信息
  const keyInsight = "用户提到下周要去深圳出差，喜欢住在福田区";

  await vcp.writeMemory(
    { diary: 'Nova日记本' },
    {
      text: keyInsight,
      tags: ['出差', '深圳', '福田区', '偏好'],
      metadata: { source: 'ohmy-openagent', sessionId }
    },
    { agentId: 'nova', sessionId },
    { idempotencyKey: `${sessionId}-travel-pref` }
  );
}
```

### 示例 4：委托 VCP Agent 执行异步研究任务

```typescript
async function delegateResearch(topic: string, sessionId: string) {
  // 1. 提交委托
  const result = await vcp.delegateAgent(
    '小克',
    `帮我搜索关于"${topic}"的最新论文，并总结3篇的核心观点`,
    {
      async: true,
      tools: ['VCPVSearch', 'VCPArxivSearch'],
      context: { agentId: 'nova', sessionId }
    }
  );

  const match = result.data.result.result.content[0].text
    .match(/ID: (aa-delegation-[\w-]+)/);
  const delegationId = match?.[1];

  console.log('委托已提交:', delegationId);
  return delegationId;
}

// 2. 轮询查询状态
async function pollDelegation(delegationId: string, sessionId: string) {
  const interval = setInterval(async () => {
    const status = await vcp.queryDelegation(delegationId, {
      agentId: 'nova',
      sessionId
    });

    const text = status.data?.result?.result?.content?.[0]?.text || '';

    if (text.includes('已经完成') || text.includes('任务完成')) {
      console.log('委托完成:', text);
      clearInterval(interval);
    } else if (text.includes('仍在进行中')) {
      console.log('进行中...');
    }
  }, 10000);
}
```

### 示例 5：调用文生图插件

```typescript
async function generateImage(prompt: string, sessionId: string) {
  const result = await vcp.invokeTool(
    'VCPFluxGen',
    {
      prompt,
      width: 1024,
      height: 1024,
      seed: 42
    },
    { agentId: 'nova', sessionId }
  );

  if (result.success) {
    return result.data.result; // 通常包含图片 URL 或 base64
  }

  throw new Error(result.error);
}
```

### 示例 6：WebSocket 实时订阅

```typescript
class VCPWebSocketSubscriber {
  private ws: WebSocket | null = null;

  constructor(
    private vcpHost: string,
    private vcpKey: string,
    private onMessage: (data: any) => void
  ) {}

  connect() {
    const url = `ws://${this.vcpHost}/vcpinfo/VCP_Key=${this.vcpKey}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[VCP WS] Connected');
    });

    this.ws.on('message', (raw: any) => {
      try {
        const data = JSON.parse(raw.toString());
        this.onMessage(data);
      } catch (e) {
        console.error('[VCP WS] Parse error:', e);
      }
    });

    this.ws.on('close', () => {
      console.log('[VCP WS] Disconnected, reconnecting in 5s...');
      setTimeout(() => this.connect(), 5000);
    });

    this.ws.on('error', (err) => {
      console.error('[VCP WS] Error:', err);
    });
  }

  disconnect() {
    this.ws?.close();
  }
}

// 使用
const subscriber = new VCPWebSocketSubscriber(
  'localhost:5890',
  process.env.VCP_KEY!,
  (data) => {
    if (data.type === 'AGENT_PRIVATE_CHAT_PREVIEW') {
      console.log(`[VCP Agent ${data.agentName}]: ${data.response}`);
    }
  }
);

subscriber.connect();
```

---

## 错误处理模式

```typescript
async function safeVcpCall<T>(
  call: () => Promise<any>,
  fallback: T
): Promise<T> {
  try {
    const result = await call();
    if (result.success) {
      return result.data;
    }

    // 记录 VCP 返回的业务错误
    console.error('[VCP Error]', result.code, result.error, result.details);
    return fallback;
  } catch (err) {
    // 记录网络或解析错误
    console.error('[VCP Network Error]', err);
    return fallback;
  }
}

// 使用
const memoryBlocks = await safeVcpCall(
  () => vcp.recallContext(messages, options, context),
  { contextBlocks: [] }
);
```

---

## OhMyOpenCode Agent 集成示例

假设 OhMyOpenCode 的 Agent 结构如下：

```typescript
interface OhMyAgent {
  id: string;
  name: string;
  systemPrompt: string;
  tools: string[];
}
```

初始化时动态加载 VCP 工具：

```typescript
async function loadAgentWithVCPCapabilities(agent: OhMyAgent) {
  const caps = await vcp.getCapabilities(agent.id);

  // 将 VCP 插件动态注册为 OhMyOpenCode 的 tools
  const vcpTools = caps.data.tools.map((tool: any) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));

  // 将记忆目标注入 system prompt
  const memoryTargets = caps.data.memory.targets;
  const enhancedPrompt = `${agent.systemPrompt}\n\n你的记忆库：${memoryTargets.join('、')}`;

  return {
    ...agent,
    systemPrompt: enhancedPrompt,
    tools: [...agent.tools, ...vcpTools]
  };
}
```

Agent 执行循环中的工具调用：

```typescript
async function executeToolCall(
  agentId: string,
  sessionId: string,
  toolName: string,
  args: any
) {
  // 如果工具名以 VCP 开头，说明是 VCP 插件
  if (toolName.startsWith('VCP')) {
    return vcp.invokeTool(toolName, args, { agentId, sessionId });
  }

  // 否则执行 OhMyOpenCode 原生工具
  return executeNativeTool(toolName, args);
}
```
