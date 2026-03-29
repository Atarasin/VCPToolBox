# OpenClaw 插件侧 TypeScript 类型草案

## 1. 文档定位

本文将“方案B可开发规格版”进一步展开为 OpenClaw 插件侧可落地的 TypeScript 类型草案。

目标：

- 为插件开发前提供稳定的类型边界
- 作为后续 `src/types/bridge.ts`、`src/types/config.ts`、`src/client/VcpClient.ts` 的初稿来源
- 让 OpenClaw 插件开发与 VCP Bridge 后端开发可以并行

本文是**类型草案文档**，不是最终代码文件，但结构已经尽量贴近可直接复制的 `.ts` 文件形式。

---

## 2. 建议文件拆分

建议最终拆成以下文件：

```text
src/types/
  bridge.ts
  config.ts
  tooling.ts
  memory.ts
  context.ts
  errors.ts
```

如果希望先最小化实现，也可先压成：

```text
src/types/
  bridge.ts
  config.ts
```

---

## 3. `bridge.ts` 草案

```ts
export type BridgeVersion = "v1";

export type BridgeErrorCode =
  | "OCW_AUTH_UNAUTHORIZED"
  | "OCW_AUTH_FORBIDDEN"
  | "OCW_TOOL_NOT_FOUND"
  | "OCW_TOOL_INVALID_ARGS"
  | "OCW_TOOL_APPROVAL_REQUIRED"
  | "OCW_TOOL_TIMEOUT"
  | "OCW_TOOL_EXECUTION_ERROR"
  | "OCW_RAG_INVALID_QUERY"
  | "OCW_RAG_TARGET_FORBIDDEN"
  | "OCW_RAG_TARGET_NOT_FOUND"
  | "OCW_RAG_SEARCH_ERROR"
  | "OCW_CONTEXT_INVALID_INPUT"
  | "OCW_CONTEXT_TARGET_FORBIDDEN"
  | "OCW_CONTEXT_BUILD_ERROR"
  | "OCW_MEMORY_INVALID_PAYLOAD"
  | "OCW_MEMORY_TARGET_FORBIDDEN"
  | "OCW_MEMORY_WRITE_ERROR"
  | "OCW_INTERNAL_UNKNOWN";

export interface BridgeMeta {
  requestId: string;
  bridgeVersion: BridgeVersion;
  durationMs: number;
}

export interface RequestContext {
  source: "openclaw";
  agentId: string;
  sessionId: string;
  requestId: string;
}

export interface BridgeSuccess<T> {
  success: true;
  data: T;
  meta: BridgeMeta;
}

export interface BridgeFailure {
  success: false;
  error: string;
  code: BridgeErrorCode;
  details?: Record<string, unknown>;
  meta: BridgeMeta;
}

export type BridgeResponse<T> = BridgeSuccess<T> | BridgeFailure;

export interface HealthData {
  status: "ok";
  serverTime: string;
  pluginManagerReady: boolean;
  knowledgeBaseReady: boolean;
  bridgeVersion: BridgeVersion;
}

export interface ToolDescriptor {
  name: string;
  displayName: string;
  pluginType: "synchronous" | "asynchronous" | "hybridservice";
  distributed: boolean;
  approvalRequired: boolean;
  timeoutMs: number;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RagTarget {
  id: string;
  displayName: string;
  type: "diary" | "knowledge_base";
  allowed?: boolean;
  modes?: Array<"rag" | "context" | "write">;
}

export interface CapabilitiesData {
  server: {
    name: string;
    version: string;
    bridgeVersion: BridgeVersion;
  };
  tools: ToolDescriptor[];
  memory: {
    targets: RagTarget[];
    features: {
      timeAware: boolean;
      groupAware: boolean;
      rerank: boolean;
      tagMemo: boolean;
      writeBack: boolean;
    };
  };
}

export interface InvokeToolRequest {
  args: Record<string, unknown>;
  requestContext: RequestContext;
}

export interface InvokeToolData {
  toolName: string;
  result: Record<string, unknown>;
  audit: {
    approvalUsed: boolean;
    distributed: boolean;
  };
}

export interface RagTargetsData {
  targets: RagTarget[];
}

export interface RagSearchOptions {
  timeAware?: boolean;
  groupAware?: boolean;
  rerank?: boolean;
  tagMemo?: boolean;
}

export interface RagSearchRequest {
  query: string;
  diary?: string;
  k?: number;
  mode?: "rag" | "hybrid" | "auto";
  options?: RagSearchOptions;
  requestContext: RequestContext;
}

export interface RagItem {
  id: string;
  text: string;
  score: number;
  sourceDiary: string;
  sourceFile: string;
  timestamp?: string;
  tags?: string[];
}

export interface RagSearchData {
  items: RagItem[];
  diagnostics: {
    resultCount?: number;
    timeAwareApplied?: boolean;
    groupAwareApplied?: boolean;
    rerankApplied?: boolean;
    tagMemoApplied?: boolean;
    [key: string]: unknown;
  };
}

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RagContextRequest {
  conversation: {
    lastUserMessage?: string;
    lastAssistantMessage?: string;
    recentMessages: ConversationMessage[];
  };
  memoryTargets?: string[];
  budget: {
    maxBlocks: number;
    maxTokens: number;
  };
  policy: {
    minScore: number;
    allowTimeAware?: boolean;
    allowGroupAware?: boolean;
    allowRerank?: boolean;
  };
  requestContext: RequestContext;
}

export interface RecallBlock {
  id: string;
  text: string;
  score: number;
  estimatedTokens: number;
  metadata: {
    sourceDiary?: string;
    sourceFile?: string;
    strategy?: string[];
    [key: string]: unknown;
  };
}

export interface RagContextData {
  recallBlocks: RecallBlock[];
  estimatedTokens: number;
  appliedPolicy: Record<string, unknown>;
}

export type MemoryWriteStatus = "created" | "updated" | "skipped_duplicate";

export interface MemoryWriteRequest {
  target: {
    diary: string;
  };
  memory: {
    text: string;
    tags?: string[];
    timestamp?: string;
  };
  options?: {
    idempotencyKey?: string;
    deduplicate?: boolean;
  };
  requestContext: RequestContext;
}

export interface MemoryWriteData {
  writeStatus: MemoryWriteStatus;
  diary: string;
  entryId: string;
  deduplicated: boolean;
}
```

---

## 4. `config.ts` 草案

```ts
export type SecretRef = string;

export interface VcpAuthConfig {
  type: "basic";
  username: string;
  passwordRef: SecretRef;
}

export interface VcpTimeoutsConfig {
  healthMs: number;
  toolInvokeMs: number;
  ragSearchMs: number;
  ragContextMs: number;
  memoryWriteMs: number;
}

export interface VcpToolsConfig {
  allowList?: string[];
  denyList?: string[];
}

export interface VcpMemoryConfig {
  diaryMap: Record<string, string[]>;
  defaultK?: number;
}

export interface VcpRecallConfig {
  enabled: boolean;
  maxBlocks: number;
  maxTokens: number;
  minScore: number;
}

export interface VcpPluginConfig {
  baseUrl: string;
  auth: VcpAuthConfig;
  timeouts: VcpTimeoutsConfig;
  tools: VcpToolsConfig;
  memory: VcpMemoryConfig;
  recall: VcpRecallConfig;
}

export interface OpenClawVcpPluginConfigRoot {
  vcp: VcpPluginConfig;
}
```

---

## 5. `errors.ts` 草案

```ts
import type { BridgeErrorCode, BridgeFailure, BridgeMeta } from "./bridge";

export class VcpBridgeError extends Error {
  public readonly code: BridgeErrorCode;
  public readonly details?: Record<string, unknown>;
  public readonly meta: BridgeMeta;

  constructor(payload: BridgeFailure) {
    super(payload.error);
    this.name = "VcpBridgeError";
    this.code = payload.code;
    this.details = payload.details;
    this.meta = payload.meta;
  }
}

export class VcpAuthError extends VcpBridgeError {
  constructor(payload: BridgeFailure) {
    super(payload);
    this.name = "VcpAuthError";
  }
}

export class VcpToolError extends VcpBridgeError {
  constructor(payload: BridgeFailure) {
    super(payload);
    this.name = "VcpToolError";
  }
}

export class VcpRagError extends VcpBridgeError {
  constructor(payload: BridgeFailure) {
    super(payload);
    this.name = "VcpRagError";
  }
}

export class VcpContextError extends VcpBridgeError {
  constructor(payload: BridgeFailure) {
    super(payload);
    this.name = "VcpContextError";
  }
}

export class VcpMemoryError extends VcpBridgeError {
  constructor(payload: BridgeFailure) {
    super(payload);
    this.name = "VcpMemoryError";
  }
}
```

建议错误映射规则：

- `OCW_AUTH_*` -> `VcpAuthError`
- `OCW_TOOL_*` -> `VcpToolError`
- `OCW_RAG_*` -> `VcpRagError`
- `OCW_CONTEXT_*` -> `VcpContextError`
- `OCW_MEMORY_*` -> `VcpMemoryError`
- 其余 -> `VcpBridgeError`

---

## 6. `tooling.ts` 草案

```ts
import type { ToolDescriptor } from "./bridge";

export interface RegisteredTool {
  name: string;
  displayName: string;
  description: string;
  schema: Record<string, unknown>;
  source: "vcp";
  distributed: boolean;
  approvalRequired: boolean;
  timeoutMs: number;
}

export interface ToolMapper {
  mapToolDescriptorToRegisteredTool(input: ToolDescriptor): RegisteredTool;
}
```

建议 `mapToolDescriptorToRegisteredTool` 保持纯函数，方便快照测试。

---

## 7. `memory.ts` 草案

```ts
import type {
  MemoryWriteData,
  MemoryWriteRequest,
  RagItem,
  RagSearchRequest,
} from "./bridge";

export interface MemorySearchResult {
  id: string;
  text: string;
  score: number;
  source: {
    diary: string;
    file: string;
    timestamp?: string;
    tags?: string[];
  };
}

export interface DiaryResolver {
  resolveAgentDiaries(agentId: string): string[];
  resolveDefaultDiary(agentId: string): string | null;
}

export interface VcpMemoryAdapter {
  search(
    query: string,
    agentId: string,
    options?: Partial<Omit<RagSearchRequest, "query" | "requestContext">>
  ): Promise<MemorySearchResult[]>;

  normalizeRagItems(items: RagItem[]): MemorySearchResult[];

  write(request: MemoryWriteRequest): Promise<MemoryWriteData>;
}
```

---

## 8. `context.ts` 草案

```ts
import type { RagContextRequest, RecallBlock } from "./bridge";

export interface RecallBudgetInput {
  maxBlocks: number;
  maxTokens: number;
  minScore: number;
}

export interface RecallBudgetResult {
  accepted: RecallBlock[];
  dropped: RecallBlock[];
  usedTokens: number;
}

export interface RecallBudgetCalculator {
  apply(blocks: RecallBlock[], budget: RecallBudgetInput): RecallBudgetResult;
}

export interface AssembleInput {
  agentId: string;
  sessionId: string;
  recentMessages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
}

export interface AssembleResult {
  systemPromptAddition?: string;
  recallBlocks?: RecallBlock[];
  degraded?: boolean;
}

export interface VcpContextEngine {
  buildRequest(input: AssembleInput): RagContextRequest;
  formatRecallBlocks(blocks: RecallBlock[]): string;
  assemble(input: AssembleInput): Promise<AssembleResult>;
}
```

---

## 9. `client/VcpClient.ts` 草案

```ts
import type {
  BridgeResponse,
  CapabilitiesData,
  HealthData,
  InvokeToolData,
  InvokeToolRequest,
  MemoryWriteData,
  MemoryWriteRequest,
  RagContextData,
  RagContextRequest,
  RagSearchData,
  RagSearchRequest,
  RagTargetsData,
} from "../types/bridge";

export interface VcpClient {
  health(): Promise<BridgeResponse<HealthData>>;
  getCapabilities(agentId: string): Promise<BridgeResponse<CapabilitiesData>>;
  invokeTool(
    toolName: string,
    body: InvokeToolRequest
  ): Promise<BridgeResponse<InvokeToolData>>;
  listRagTargets(agentId: string): Promise<BridgeResponse<RagTargetsData>>;
  ragSearch(body: RagSearchRequest): Promise<BridgeResponse<RagSearchData>>;
  buildContext(body: RagContextRequest): Promise<BridgeResponse<RagContextData>>;
  writeMemory(
    body: MemoryWriteRequest
  ): Promise<BridgeResponse<MemoryWriteData>>;
}
```

如果采用抛异常风格而不是 union response，可再加一层：

```ts
export interface StrictVcpClient {
  health(): Promise<HealthData>;
  getCapabilities(agentId: string): Promise<CapabilitiesData>;
  invokeTool(toolName: string, body: InvokeToolRequest): Promise<InvokeToolData>;
  listRagTargets(agentId: string): Promise<RagTargetsData>;
  ragSearch(body: RagSearchRequest): Promise<RagSearchData>;
  buildContext(body: RagContextRequest): Promise<RagContextData>;
  writeMemory(body: MemoryWriteRequest): Promise<MemoryWriteData>;
}
```

推荐做法：

- 底层 HTTP client 返回 `BridgeResponse<T>`
- 上层 facade 转换成抛异常风格，方便业务层使用

---

## 10. `tools/VcpToolRegistry.ts` 草案

```ts
import type { CapabilitiesData } from "../types/bridge";
import type { RegisteredTool } from "../types/tooling";

export interface OpenClawToolApi {
  registerTool(definition: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (input: Record<string, unknown>) => Promise<unknown>;
  }): void;
}

export interface VcpToolRegistry {
  capabilities: CapabilitiesData | null;
  refresh(agentId: string): Promise<void>;
  toRegisteredTools(): RegisteredTool[];
  registerAll(api: OpenClawToolApi, agentId: string): Promise<void>;
}
```

关键约束：

1. `registerAll` 不直接做网络发现以外的业务判断
2. 工具过滤交给 `PolicyGuard`
3. handler 内部只负责：
   - 构建 `InvokeToolRequest`
   - 调用 `VcpClient.invokeTool`
   - 规范化返回

---

## 11. `policy/VcpPolicyGuard.ts` 草案

```ts
import type { VcpPluginConfig } from "../types/config";

export interface RecallPolicy {
  enabled: boolean;
  maxBlocks: number;
  maxTokens: number;
  minScore: number;
}

export interface VcpPolicyGuard {
  allowTool(toolName: string, agentId: string): boolean;
  allowDiary(diary: string, agentId: string): boolean;
  getAgentDiaries(agentId: string): string[];
  getRecallPolicy(agentId: string): RecallPolicy;
}

export interface VcpPolicyGuardFactory {
  create(config: VcpPluginConfig): VcpPolicyGuard;
}
```

规则建议：

1. `denyList` 优先级高于 `allowList`
2. `agentId` 无映射时回退 `default`
3. recall policy 至少强制：
   - `maxBlocks >= 1`
   - `maxTokens >= 128`
   - `minScore` 范围 `0 ~ 1`

---

## 12. 最小实现顺序建议

如果要按文件从最容易到最难落地，建议顺序如下：

1. `src/types/bridge.ts`
2. `src/types/config.ts`
3. `src/types/errors.ts`
4. `src/client/VcpClient.ts`
5. `src/tools/VcpToolRegistry.ts`
6. `src/memory/VcpMemoryAdapter.ts`
7. `src/context/VcpContextEngine.ts`
8. `src/policy/VcpPolicyGuard.ts`

原因：

- 先定类型，后定 client
- 再上工具层
- 再上 memory/context
- policy 最后收口

---

## 13. 与文档体系的衔接关系

- 可行性方案：[openclaw接入VCPToolBox可行性方案.md](file:///home/zh/projects/VCP/VCPToolBox/mydoc/openclaw/openclaw接入VCPToolBox可行性方案.md)
- 实施路径：[方案B实施路径-OpenClaw原生工具与记忆双桥接.md](file:///home/zh/projects/VCP/VCPToolBox/mydoc/openclaw/方案B实施路径-OpenClaw原生工具与记忆双桥接.md)
- 可开发规格版：[方案B可开发规格版-接口模块状态测试.md](file:///home/zh/projects/VCP/VCPToolBox/mydoc/openclaw/方案B可开发规格版-接口模块状态测试.md)

---

## 14. 下一步建议

如果继续推进到“可以直接开始编码”的状态，下一步最合适的是：

1. 将本文拆成实际的 `.ts` 草稿文件
2. 为 `bridge.ts` 生成接口 fixture
3. 让 OpenAPI 草案与 TypeScript 类型草案做一次字段对齐检查
