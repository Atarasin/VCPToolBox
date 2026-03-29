# VCP Bridge OpenAPI 3.1 草案

## 1. 文档定位

本文将“方案B可开发规格版”中的接口契约整理为接近 OpenAPI 3.1 的草案文档，便于后续：

- 转换为正式 `openapi.yaml`
- 生成后端路由契约测试
- 生成 OpenClaw 侧客户端代码

本文是**接口草案**，不是最终发布版本。字段允许在 `v1` 收敛前做小幅调整，但不建议改变资源模型。

---

## 2. OpenAPI 顶层草案

```yaml
openapi: 3.1.0
info:
  title: VCP Bridge API
  version: 1.0.0-draft
  summary: OpenClaw 到 VCPToolBox 的原生工具与记忆桥接接口
  description: |
    该 API 作为 OpenClaw 与 VCPToolBox 之间的本机桥接层，负责能力发现、
    工具调用、RAG 检索、上下文召回与记忆写回。
servers:
  - url: http://127.0.0.1:6005
    description: Local VCPToolBox server
security:
  - basicAuth: []
tags:
  - name: Health
  - name: Capabilities
  - name: Tools
  - name: Rag
  - name: Memory
```

---

## 3. 安全方案草案

```yaml
components:
  securitySchemes:
    basicAuth:
      type: http
      scheme: basic
```

说明：

- 当前最适合直接复用 `admin_api` 的 Basic Auth 边界
- 若后续要给 OpenClaw 单独发放 bridge token，可再增加 `bearerAuth`

---

## 4. 统一响应模型草案

```yaml
components:
  schemas:
    BridgeMeta:
      type: object
      additionalProperties: false
      required: [requestId, bridgeVersion, durationMs]
      properties:
        requestId:
          type: string
        bridgeVersion:
          type: string
          const: v1
        durationMs:
          type: integer
          minimum: 0

    ErrorResponse:
      type: object
      additionalProperties: false
      required: [success, error, code, meta]
      properties:
        success:
          type: boolean
          const: false
        error:
          type: string
        code:
          type: string
        details:
          type: object
          additionalProperties: true
        meta:
          $ref: '#/components/schemas/BridgeMeta'

    SuccessEnvelope:
      type: object
      additionalProperties: false
      required: [success, data, meta]
      properties:
        success:
          type: boolean
          const: true
        data: {}
        meta:
          $ref: '#/components/schemas/BridgeMeta'
```

统一响应头：

```yaml
components:
  headers:
    XRequestId:
      required: true
      schema:
        type: string
      description: Server generated request id
    XOpenClawBridgeVersion:
      required: true
      schema:
        type: string
        const: v1
      description: Active bridge version
```

---

## 5. 通用对象模型草案

```yaml
components:
  schemas:
    RequestContext:
      type: object
      additionalProperties: false
      required: [source, agentId, sessionId, requestId]
      properties:
        source:
          type: string
          const: openclaw
        agentId:
          type: string
        sessionId:
          type: string
        requestId:
          type: string

    ToolDescriptor:
      type: object
      additionalProperties: false
      required:
        - name
        - displayName
        - pluginType
        - distributed
        - approvalRequired
        - timeoutMs
        - description
        - inputSchema
      properties:
        name:
          type: string
        displayName:
          type: string
        pluginType:
          type: string
          enum: [synchronous, asynchronous, hybridservice]
        distributed:
          type: boolean
        approvalRequired:
          type: boolean
        timeoutMs:
          type: integer
          minimum: 0
        description:
          type: string
        inputSchema:
          type: object
          additionalProperties: true

    RagTarget:
      type: object
      additionalProperties: false
      required: [id, displayName, type]
      properties:
        id:
          type: string
        displayName:
          type: string
        type:
          type: string
          enum: [diary, knowledge_base]
        allowed:
          type: boolean

    RagItem:
      type: object
      additionalProperties: false
      required:
        - id
        - text
        - score
        - sourceDiary
        - sourceFile
      properties:
        id:
          type: string
        text:
          type: string
        score:
          type: number
        sourceDiary:
          type: string
        sourceFile:
          type: string
        timestamp:
          type: string
        tags:
          type: array
          items:
            type: string

    RecallBlock:
      type: object
      additionalProperties: false
      required: [id, text, score, estimatedTokens, metadata]
      properties:
        id:
          type: string
        text:
          type: string
        score:
          type: number
        estimatedTokens:
          type: integer
          minimum: 0
        metadata:
          type: object
          additionalProperties: true
```

---

## 6. 路径草案

## 6.1 `GET /admin_api/openclaw/health`

```yaml
paths:
  /admin_api/openclaw/health:
    get:
      tags: [Health]
      operationId: getBridgeHealth
      summary: Check VCP Bridge health
      responses:
        '200':
          description: Bridge is reachable
          headers:
            x-request-id:
              $ref: '#/components/headers/XRequestId'
            x-openclaw-bridge-version:
              $ref: '#/components/headers/XOpenClawBridgeVersion'
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required:
                      [status, serverTime, pluginManagerReady, knowledgeBaseReady, bridgeVersion]
                    properties:
                      status:
                        type: string
                        const: ok
                      serverTime:
                        type: string
                      pluginManagerReady:
                        type: boolean
                      knowledgeBaseReady:
                        type: boolean
                      bridgeVersion:
                        type: string
                        const: v1
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
        '401':
          description: Unauthorized
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

## 6.2 `GET /admin_api/openclaw/capabilities`

```yaml
  /admin_api/openclaw/capabilities:
    get:
      tags: [Capabilities]
      operationId: getCapabilities
      summary: Get bridge capabilities for an OpenClaw agent
      parameters:
        - name: agentId
          in: query
          required: true
          schema:
            type: string
        - name: includeDisabled
          in: query
          required: false
          schema:
            type: boolean
            default: false
        - name: includeMemoryTargets
          in: query
          required: false
          schema:
            type: boolean
            default: true
      responses:
        '200':
          description: Capabilities loaded
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [server, tools, memory]
                    properties:
                      server:
                        type: object
                        additionalProperties: false
                        required: [name, version, bridgeVersion]
                        properties:
                          name:
                            type: string
                          version:
                            type: string
                          bridgeVersion:
                            type: string
                            const: v1
                      tools:
                        type: array
                        items:
                          $ref: '#/components/schemas/ToolDescriptor'
                      memory:
                        type: object
                        additionalProperties: false
                        required: [targets, features]
                        properties:
                          targets:
                            type: array
                            items:
                              $ref: '#/components/schemas/RagTarget'
                          features:
                            type: object
                            additionalProperties: false
                            required: [timeAware, groupAware, rerank, tagMemo, writeBack]
                            properties:
                              timeAware:
                                type: boolean
                              groupAware:
                                type: boolean
                              rerank:
                                type: boolean
                              tagMemo:
                                type: boolean
                              writeBack:
                                type: boolean
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
        '400':
          description: Invalid query
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

## 6.3 `POST /admin_api/openclaw/tools/{toolName}`

```yaml
  /admin_api/openclaw/tools/{toolName}:
    post:
      tags: [Tools]
      operationId: invokeTool
      summary: Invoke a VCP tool from OpenClaw
      parameters:
        - name: toolName
          in: path
          required: true
          schema:
            type: string
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [args, requestContext]
              properties:
                args:
                  type: object
                  additionalProperties: true
                requestContext:
                  $ref: '#/components/schemas/RequestContext'
      responses:
        '200':
          description: Tool invocation succeeded
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [toolName, result, audit]
                    properties:
                      toolName:
                        type: string
                      result:
                        type: object
                        additionalProperties: true
                      audit:
                        type: object
                        additionalProperties: false
                        required: [approvalUsed, distributed]
                        properties:
                          approvalUsed:
                            type: boolean
                          distributed:
                            type: boolean
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
        '400':
          description: Invalid arguments
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '403':
          description: Approval required or forbidden
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '404':
          description: Tool not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '504':
          description: Tool timeout
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

## 6.4 `GET /admin_api/openclaw/rag/targets`

```yaml
  /admin_api/openclaw/rag/targets:
    get:
      tags: [Rag]
      operationId: listRagTargets
      summary: List available RAG targets for an OpenClaw agent
      parameters:
        - name: agentId
          in: query
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Targets loaded
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [targets]
                    properties:
                      targets:
                        type: array
                        items:
                          $ref: '#/components/schemas/RagTarget'
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
```

## 6.5 `POST /admin_api/openclaw/rag/search`

```yaml
  /admin_api/openclaw/rag/search:
    post:
      tags: [Rag]
      operationId: searchRag
      summary: Search VCP memory targets with structured RAG options
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [query, requestContext]
              properties:
                query:
                  type: string
                diary:
                  type: string
                k:
                  type: integer
                  minimum: 1
                  default: 5
                mode:
                  type: string
                  enum: [rag, hybrid, auto]
                  default: rag
                options:
                  type: object
                  additionalProperties: false
                  properties:
                    timeAware:
                      type: boolean
                    groupAware:
                      type: boolean
                    rerank:
                      type: boolean
                    tagMemo:
                      type: boolean
                requestContext:
                  $ref: '#/components/schemas/RequestContext'
      responses:
        '200':
          description: Search completed
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [items, diagnostics]
                    properties:
                      items:
                        type: array
                        items:
                          $ref: '#/components/schemas/RagItem'
                      diagnostics:
                        type: object
                        additionalProperties: true
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
        '400':
          description: Invalid query
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '403':
          description: Target forbidden
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
        '404':
          description: Target not found
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ErrorResponse'
```

## 6.6 `POST /admin_api/openclaw/rag/context`

```yaml
  /admin_api/openclaw/rag/context:
    post:
      tags: [Rag]
      operationId: buildRecallContext
      summary: Build structured recall blocks for OpenClaw context assembly
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [conversation, budget, policy, requestContext]
              properties:
                conversation:
                  type: object
                  additionalProperties: false
                  required: [recentMessages]
                  properties:
                    lastUserMessage:
                      type: string
                    lastAssistantMessage:
                      type: string
                    recentMessages:
                      type: array
                      items:
                        type: object
                        additionalProperties: false
                        required: [role, content]
                        properties:
                          role:
                            type: string
                            enum: [system, user, assistant]
                          content:
                            type: string
                memoryTargets:
                  type: array
                  items:
                    type: string
                budget:
                  type: object
                  additionalProperties: false
                  required: [maxBlocks, maxTokens]
                  properties:
                    maxBlocks:
                      type: integer
                      minimum: 1
                    maxTokens:
                      type: integer
                      minimum: 1
                policy:
                  type: object
                  additionalProperties: false
                  required: [minScore]
                  properties:
                    minScore:
                      type: number
                    allowTimeAware:
                      type: boolean
                    allowGroupAware:
                      type: boolean
                    allowRerank:
                      type: boolean
                requestContext:
                  $ref: '#/components/schemas/RequestContext'
      responses:
        '200':
          description: Recall blocks built
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [recallBlocks, estimatedTokens, appliedPolicy]
                    properties:
                      recallBlocks:
                        type: array
                        items:
                          $ref: '#/components/schemas/RecallBlock'
                      estimatedTokens:
                        type: integer
                      appliedPolicy:
                        type: object
                        additionalProperties: true
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
```

## 6.7 `POST /admin_api/openclaw/memory/write`

```yaml
  /admin_api/openclaw/memory/write:
    post:
      tags: [Memory]
      operationId: writeMemory
      summary: Write durable OpenClaw memory into VCP diary system
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [target, memory, requestContext]
              properties:
                target:
                  type: object
                  additionalProperties: false
                  required: [diary]
                  properties:
                    diary:
                      type: string
                memory:
                  type: object
                  additionalProperties: false
                  required: [text]
                  properties:
                    text:
                      type: string
                    tags:
                      type: array
                      items:
                        type: string
                    timestamp:
                      type: string
                options:
                  type: object
                  additionalProperties: false
                  properties:
                    idempotencyKey:
                      type: string
                    deduplicate:
                      type: boolean
                requestContext:
                  $ref: '#/components/schemas/RequestContext'
      responses:
        '200':
          description: Memory written
          content:
            application/json:
              schema:
                type: object
                additionalProperties: false
                required: [success, data, meta]
                properties:
                  success:
                    type: boolean
                    const: true
                  data:
                    type: object
                    additionalProperties: false
                    required: [writeStatus, diary, entryId, deduplicated]
                    properties:
                      writeStatus:
                        type: string
                        enum: [created, updated, skipped_duplicate]
                      diary:
                        type: string
                      entryId:
                        type: string
                      deduplicated:
                        type: boolean
                  meta:
                    $ref: '#/components/schemas/BridgeMeta'
```

---

## 7. 错误码枚举草案

```yaml
components:
  schemas:
    ErrorCode:
      type: string
      enum:
        - OCW_AUTH_UNAUTHORIZED
        - OCW_AUTH_FORBIDDEN
        - OCW_TOOL_NOT_FOUND
        - OCW_TOOL_INVALID_ARGS
        - OCW_TOOL_APPROVAL_REQUIRED
        - OCW_TOOL_TIMEOUT
        - OCW_TOOL_EXECUTION_ERROR
        - OCW_RAG_INVALID_QUERY
        - OCW_RAG_TARGET_FORBIDDEN
        - OCW_RAG_TARGET_NOT_FOUND
        - OCW_RAG_SEARCH_ERROR
        - OCW_CONTEXT_INVALID_INPUT
        - OCW_CONTEXT_TARGET_FORBIDDEN
        - OCW_CONTEXT_BUILD_ERROR
        - OCW_MEMORY_INVALID_PAYLOAD
        - OCW_MEMORY_TARGET_FORBIDDEN
        - OCW_MEMORY_WRITE_ERROR
        - OCW_INTERNAL_UNKNOWN
```

---

## 8. 生成正式 `openapi.yaml` 时的补充建议

1. 将 `SuccessEnvelope` 进一步拆成具体 envelope，例如：
   - `HealthResponse`
   - `CapabilitiesResponse`
   - `InvokeToolResponse`
2. 将 `inputSchema` 明确标为任意 JSON Schema 对象
3. 为每个错误响应增加标准 example
4. 为 `401/403/404/500/504` 统一挂载错误响应组件
5. 增加 `examples` 节点，方便前后端联调

---

## 9. 与当前规格文档的映射关系

- 接口与字段来源：[方案B可开发规格版-接口模块状态测试.md](file:///home/zh/projects/VCP/VCPToolBox/mydoc/openclaw/方案B可开发规格版-接口模块状态测试.md)
- 底层工具执行入口：[Plugin.js:L778-L852](file:///home/zh/projects/VCP/VCPToolBox/Plugin.js#L778-L852)
- 当前插件发现接口：[adminPanelRoutes.js:L380-L462](file:///home/zh/projects/VCP/VCPToolBox/routes/adminPanelRoutes.js#L380-L462)
- 当前 RAG 能力基础：[KnowledgeBaseManager.js:L314-L354](file:///home/zh/projects/VCP/VCPToolBox/KnowledgeBaseManager.js#L314-L354)

---

## 10. 下一步建议

如果继续推进，最自然的下一步是二选一：

1. 把本文直接转成正式 `openapi.yaml`
2. 继续生成 OpenClaw 插件侧的 `bridge.ts` / `config.ts` / `client.ts` TypeScript 类型草案
