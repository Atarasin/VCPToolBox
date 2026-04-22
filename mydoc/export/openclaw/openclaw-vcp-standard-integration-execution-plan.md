# OpenClaw 标准接口迁移执行计划

> 历史执行计划：本文记录的是迁移阶段计划。`/admin_api/openclaw/*` 已在后续 change 中退役，当前受支持接口以 `/agent_gateway/*` 为准。

> 文档目标：基于 `openclaw-vcp-standard-integration-design.md`，给出一份可直接执行、可排期、可验收的迁移计划，使 `openclaw-vcp-plugin` 统一通过 canonical `/agent_gateway/*` 使用 VCP 能力。

---

## 1. 结论先行

推荐采用下面这条主线推进：

1. **坚持 `agent_gateway` 作为唯一标准 HTTP contract**
2. **坚持 `openclaw-vcp-plugin` 只做 OpenClaw 宿主适配层**
3. **先补齐 health 与主链路迁移，再做命名和兼容面收缩**
4. **每阶段都要求 OpenClaw adapter、native gateway、MCP 三者语义不分叉**

一句话概括：

**先补 `GET /agent_gateway/health`，再把 OpenClaw 的 health/tool/memory/context/write 全部切到 `/agent_gateway/*`，随后补齐 parity tests 和认证边界，最后再清理 legacy bridge 命名与旧兼容面。**

---

## 2. 执行目标

本执行计划要达成的最终状态如下：

1. `openclaw-vcp-plugin` 不再依赖 `/admin_api/openclaw/*` 作为主线协议
2. OpenClaw 仍保留自身宿主生命周期接入能力：
   - `registerTool()`
   - `registerMemoryRuntime()`
   - `registerMemoryPromptSection()`
   - `registerMemoryFlushPlan()`
   - `registerContextEngine()`
3. 所有底层远程能力统一改为消费 `/agent_gateway/*`
4. health、capabilities、tool invoke、memory、context、writeback 主链路具备完整测试覆盖
5. 认证模型明确区分：
   - `gatewayKey`
   - `bearer`
   - `basic`
6. Phase 1 期间不破坏旧 `/admin_api/openclaw/*`

---

## 3. 非目标

本次执行计划明确不包含以下目标：

1. 不把 OpenClaw 完全改造成纯 MCP 客户端
2. 不在第一阶段下线 `/admin_api/openclaw/*`
3. 不在第一阶段重做 OpenClaw 宿主装配结构
4. 不在第一阶段强制引入全部 DTO 重命名
5. 不在第一阶段补齐所有 jobs / events / prompt 高层体验

---

## 4. 执行原则

### 4.1 先标准 contract，后命名清理

优先把调用面迁移到 `/agent_gateway/*`，再处理 `bridge -> gateway` 的命名收敛。

### 4.2 先主链路，后扩展链路

优先级顺序固定为：

1. `health`
2. `capabilities`
3. `tool invoke`
4. `memory targets/search/write`
5. `context assemble`
6. `agent render`
7. `jobs/events`

### 4.3 先兼容迁移，后回收旧面

Phase 1 和 Phase 2 期间，旧 `/admin_api/openclaw/*` 仍视为兼容面，不能被意外破坏。

### 4.4 服务端主控，客户端补充收紧

1. tool scope 以 `agent_gateway` 为主
2. diary scope 以 `agent_gateway` 为主
3. OpenClaw 插件本地 allow/deny 只允许额外收紧，不允许放宽

### 4.5 认证语义必须分层表述

必须显式区分：

1. 外层挂载认证：`basic`
2. 内层 native gateway 认证：`gatewayKey` / `bearer`

不允许在计划、代码或测试中把两者直接当成同一语义。

---

## 5. 总体阶段划分

推荐拆成五个阶段：

1. **Phase 0：基线冻结与 OpenSpec 收口**
2. **Phase 1：VCPToolBox 补齐 canonical health 与迁移前置能力**
3. **Phase 2：OpenClaw 插件主链路切换到 `/agent_gateway/*`**
4. **Phase 3：测试补齐、parity 校验与认证收口**
5. **Phase 4：命名清理、文档收口与 legacy 兼容面治理**

推荐依赖关系如下：

```text
Phase 0
  |
  v
Phase 1
  |
  v
Phase 2
  |
  v
Phase 3
  |
  v
Phase 4
```

---

## 6. Phase 0：基线冻结与 OpenSpec 收口

### 6.1 目标

在动代码前先冻结当前外部行为，确保后续迁移能做回归对照。

### 6.2 工作项

1. 创建 OpenSpec change
   - 变更名建议：`migrate-openclaw-to-agent-gateway`
2. 在 change 中补齐：
   - `proposal.md`
   - `design.md`
   - `tasks.md`
3. 把当前设计文档中的关键结论收敛进 OpenSpec
4. 冻结旧插件当前能力面：
   - health
   - capabilities
   - tool invoke
   - memory targets/search/write
   - context assemble
5. 冻结当前认证现实：
   - `/agent_gateway` 挂载于 `server.js`
   - 当前仍经过 `adminAuth`
   - native gateway 内部另有 `gatewayKey` / bearer 语义
6. 记录现有测试基线
   - `openclaw-vcp-plugin` 现有单测
   - `agent_gateway` native route 测试
   - MCP / native parity 测试

### 6.3 输出物

1. OpenSpec change 目录
2. 基线能力清单
3. 迁移范围边界说明

### 6.4 退出条件

1. OpenSpec 已创建
2. `tasks.md` 的任务足够可核销
3. 已确认本次迁移不直接删除旧兼容路由

---

## 7. Phase 1：VCPToolBox 补齐 canonical health 与迁移前置能力

### 7.1 目标

在服务端补齐 OpenClaw 迁移所必需但当前 `agent_gateway` 还缺少的标准能力。

### 7.2 核心缺口

当前最关键缺口只有一个：

1. `/agent_gateway/health` 尚不存在

而旧插件的 `startupHealthcheck` 默认开启，并依赖 `/admin_api/openclaw/health`。

### 7.3 工作项

#### VCPToolBox 侧

1. 新增 `GET /agent_gateway/health`
   - 路由位置：`routes/agentGatewayRoutes.js`
   - 复用现有 native response envelope
   - 返回建议字段：
     - `status`
     - `serverTime`
     - `pluginManagerReady`
     - `knowledgeBaseReady`
     - `gatewayVersion`
2. 明确 `/agent_gateway/health` 的认证行为
   - 保持与其他 `/agent_gateway/*` 路径一致
   - 不单独发明一套额外豁免逻辑，除非后续明确需要
3. 为 health route 补集成测试
   - 200 成功
   - 认证失败
   - meta / version 字段
4. 检查 OpenAPI / 对外交付文档是否需要同步
   - 若 `publishedOpenApiDocument.js` 已维护已发布路径，则同步补入 `/agent_gateway/health`
5. 检查 `server.js` 中 `/agent_gateway` 的挂载说明与日志
   - 避免遗漏说明 health 已成为 canonical route

### 7.4 推荐触达文件

1. `routes/agentGatewayRoutes.js`
2. `modules/agentGateway/contracts/publishedOpenApiDocument.js`
3. `test/agent-gateway/routes/agent-gateway-routes.test.js`
4. 必要时：
   - `mydoc/export/agent-gateway.openapi.json`

### 7.5 验收标准

1. `/agent_gateway/health` 可被标准客户端访问
2. 返回结构满足 OpenClaw 启动探活需求
3. 与 native gateway 现有 envelope、version 字段风格一致
4. 不影响现有 `/agent_gateway/*` 路由测试

---

## 8. Phase 2：OpenClaw 插件主链路切换到 `/agent_gateway/*`

### 8.1 目标

将 `openclaw-vcp-plugin` 的远程能力消费面从 `/admin_api/openclaw/*` 切换到 canonical `/agent_gateway/*`，但不改变宿主装配层形态。

### 8.2 迁移策略

推荐采用：

1. 新增 `AgentGatewayClient`
2. 保留 `VcpToolRegistry` / `VcpMemoryAdapter` / `VcpContextEngine` / `createVcpBootstrapService`
3. 逐步把底层 client 从 `VcpClient` 切换到新 client

### 8.3 工作项

#### 插件客户端层

1. 新增 `src/client/agent-gateway-client.ts`
2. 定义最小 client API：
   - `getHealth()`
   - `getCapabilities()`
   - `invokeTool()`
   - `getMemoryTargets()`
   - `searchMemory()`
   - `assembleContext()`
   - `writeMemory()`
   - `renderAgent()`
   - `getJob()`
   - `cancelJob()`
   - `streamEvents()` 可选
3. 优先复用 gateway 已有 envelope 结构
4. 客户端错误对象统一对齐 native gateway：
   - `status`
   - `code`
   - `details`
   - `requestId`
   - `gatewayVersion`

#### 配置层

1. 调整 `src/config.ts`
2. 配置主线收敛到：
   - `gatewayBaseUrl`
   - `gatewayVersion`
   - `gatewayAuth`
3. 保留旧字段兼容：
   - `baseUrl`
   - `bridgeVersion`
   - `auth`
4. 兼容解析顺序明确化：
   - 新字段优先
   - 旧字段作为 fallback
5. 认证模式显式拆分：
   - `gatewayKey`
   - `bearer`
   - `basic`
   - `none`

#### 业务适配层

1. `VcpToolRegistry`
   - capabilities 改走 `GET /agent_gateway/capabilities`
   - execute 改走 `POST /agent_gateway/tools/:toolName/invoke`
2. `VcpMemoryAdapter`
   - targets 改走 `GET /agent_gateway/memory/targets`
   - search 改走 `POST /agent_gateway/memory/search`
   - write 改走 `POST /agent_gateway/memory/write`
3. `VcpContextEngine`
   - assemble 改走 `POST /agent_gateway/context/assemble`
4. `createVcpBootstrapService`
   - health check 改走 `GET /agent_gateway/health`
5. 如后续启用高层 prompt 能力
   - `renderAgent` 改走 `POST /agent_gateway/agents/:agentId/render`

#### 兼容策略

1. Phase 2 内允许旧 `VcpClient` 仍存在
2. 但所有主流程调用应切到 `AgentGatewayClient`
3. 旧 client 只作为过渡兼容层或测试辅助，不再作为主线

### 8.4 推荐触达文件

1. `openclaw-vcp-plugin/src/client/agent-gateway-client.ts`
2. `openclaw-vcp-plugin/src/config.ts`
3. `openclaw-vcp-plugin/src/service.ts`
4. `openclaw-vcp-plugin/src/tools/vcp-tool-registry.ts`
5. `openclaw-vcp-plugin/src/memory/vcp-memory-adapter.ts`
6. `openclaw-vcp-plugin/src/context/vcp-context-engine.ts`
7. 视实现策略决定是否保留：
   - `openclaw-vcp-plugin/src/client/vcp-client.ts`

### 8.5 验收标准

1. OpenClaw 插件主链路请求全部切到 `/agent_gateway/*`
2. health 不再调用 `/admin_api/openclaw/health`
3. tool/memory/context/write 行为与原插件一致
4. 不影响 OpenClaw 宿主注册流程

---

## 9. Phase 3：测试补齐、parity 校验与认证收口

### 9.1 目标

证明迁移后的 OpenClaw adapter 和 canonical native gateway 在语义上保持一致，并把认证边界讲清楚、测完整。

### 9.2 测试分层

推荐维持三层测试：

1. OpenClaw 插件单测
2. `agent_gateway` native route 集成测试
3. parity tests

### 9.3 P0 测试项

以下是必须优先通过的测试：

1. `AgentGatewayClient` 单测
   - health
   - capabilities
   - tool invoke
   - memory targets
   - memory search
   - memory write
   - context assemble
2. 认证请求头测试
   - `gatewayKey`
   - `bearer`
   - `basic`
3. parity tests
   - health
   - capabilities
   - tool invoke
   - memory targets/search/write
   - context assemble
4. 回归测试
   - 旧 OpenClaw 宿主入口注册不回退
   - `vcp_memory_write` 写回行为不回退

### 9.4 P1 测试项

可以在主链路稳定后补：

1. `renderAgent`
2. `job get / cancel`
3. `events stream`
4. 更细的 snapshot / bootstrap 服务行为

### 9.5 认证测试要求

必须明确区分两层认证：

1. 外层挂载认证
   - 当前由 `server.js` 的 `adminAuth` 控制
2. 内层 native gateway 认证
   - `x-agent-gateway-key`
   - bearer

测试结论必须能回答：

1. 只给 `basic` 是否可访问 `/agent_gateway/*`
2. 只给 `gatewayKey` 是否可访问 `/agent_gateway/*`
3. 两者同时存在时，最终行为是什么
4. 当前默认部署下 OpenClaw 插件推荐配置是什么

### 9.6 `/memory/write` 重点验证

必须单独验证：

1. `/agent_gateway/memory/write`
2. 旧 `invokeTool("vcp_memory_write")`

在以下语义上是否一致：

1. target 选择
2. tags 校验
3. 幂等键
4. deduplicate
5. requestId / audit 元数据

### 9.7 验收标准

1. P0 测试全绿
2. parity tests 能证明 OpenClaw adapter 与 native gateway 不分叉
3. 认证边界有明确测试结论
4. `/memory/write` 与旧写回路径行为一致或差异已文档化

---

## 10. Phase 4：命名清理、文档收口与 legacy 兼容面治理

### 10.1 目标

在主链路稳定之后，把命名、文档和兼容面整理干净，避免后续继续出现“bridge / gateway”双心智。

### 10.2 工作项

1. 更新插件命名
   - `VCP Bridge` -> `VCP Agent Gateway Adapter`
2. 更新日志文案
   - 减少 “bridge” 主表述
   - 强化 “agent gateway” 主表述
3. 更新 `openclaw.plugin.json`
4. 更新 `CHANGELOG.md`
5. 更新设计文档与用户使用说明
6. 标记 `/admin_api/openclaw/*` 为 legacy compatibility surface
7. 视实际调用情况决定是否进入下线窗口

### 10.3 退出条件

1. 新命名在代码、日志、manifest、文档中基本一致
2. legacy 路径已被标记为兼容面
3. 已形成后续下线策略建议

---

## 11. 推荐任务拆分

推荐拆成下面这些可核销任务。

### 11.1 VCPToolBox 侧

1. 新增 `/agent_gateway/health`
2. 补 `/agent_gateway/health` 测试
3. 如有需要，同步 OpenAPI 文档
4. 确认 `/agent_gateway` 当前挂载与认证行为

### 11.2 openclaw-vcp-plugin 侧

1. 新增 `AgentGatewayClient`
2. 调整 `config.ts` 支持 `gatewayBaseUrl/gatewayVersion/gatewayAuth`
3. 保留旧配置兼容解析
4. 改造 `service.ts` health check
5. 改造 `VcpToolRegistry`
6. 改造 `VcpMemoryAdapter`
7. 改造 `VcpContextEngine`
8. 评估 `renderAgent/jobs/events` 的接入时机

### 11.3 测试侧

1. `AgentGatewayClient` 单测
2. auth 兼容性测试
3. parity tests
4. `/memory/write` 语义一致性测试
5. OpenClaw 宿主入口回归测试

### 11.4 文档侧

1. 更新设计文档
2. 生成执行计划
3. 更新 manifest / README / CHANGELOG
4. 明确 legacy 路径说明

---

## 12. 风险矩阵

### 风险 1：health 未先补齐，导致迁移被迫保留旧接口

影响：

1. Phase 2 无法真正完成“全主链路切到 `/agent_gateway/*`”

缓解：

1. 把 `/agent_gateway/health` 固定为最先完成项

### 风险 2：Basic Auth 与 gatewayKey 混淆

影响：

1. 文档误导
2. 客户端配置错误
3. 测试结论失真

缓解：

1. 配置字段显式拆分
2. 测试按两层认证组织
3. 不把 basic password 直接定义成 gateway key

### 风险 3：迁移后 OpenClaw adapter 与 native gateway 行为不一致

影响：

1. 多宿主语义再次分叉

缓解：

1. 以 parity tests 作为主验收门禁

### 风险 4：过早清理旧 `/admin_api/openclaw/*`

影响：

1. 兼容回归
2. 难以快速回滚

缓解：

1. Phase 4 之前不做清理
2. 保留版本窗口与 shim

### 风险 5：DTO / 命名清理过早介入，放大改动面

影响：

1. 主链路迁移和命名重构耦合

缓解：

1. 先迁主链路，再清理命名

---

## 13. 交付与验收清单

当下面这些条件成立时，可认为本次执行计划的主要目标完成：

1. `GET /agent_gateway/health` 已上线并通过测试
2. OpenClaw 插件主链路不再依赖 `/admin_api/openclaw/*`
3. OpenClaw 插件仍完整注册：
   - tool
   - memory runtime
   - memory prompt section
   - memory flush plan
   - context engine
4. health/tool/memory/context/write 的 P0 测试通过
5. OpenClaw adapter 与 native gateway parity tests 通过
6. `gatewayKey / bearer / basic` 的行为边界已文档化并测试化
7. `/memory/write` 与旧写回路径的语义差异已确认
8. 新旧命名和兼容面治理有明确后续计划

---

## 14. 推荐排期顺序

如果按最小风险推进，推荐排期如下：

### Sprint 1

1. OpenSpec change 建立
2. `/agent_gateway/health`
3. health route 测试
4. 确认认证现实与部署约束

### Sprint 2

1. `AgentGatewayClient`
2. config 兼容解析
3. `service.ts` health 迁移
4. `VcpToolRegistry` 迁移
5. `VcpMemoryAdapter` 迁移
6. `VcpContextEngine` 迁移

### Sprint 3

1. client 单测补齐
2. auth 测试补齐
3. parity tests
4. `/memory/write` 语义一致性验证

### Sprint 4

1. 命名清理
2. 文档收口
3. legacy compatibility surface 标记
4. 评估后续 jobs/events/render 扩展或旧路由下线窗口

---

## 15. 最终建议

如果只给一个执行建议，那就是：

**把这次工作当成“OpenClaw 宿主适配层迁移到 canonical `agent_gateway` contract”的项目，而不是一次普通的客户端改 URL。**

因为真正要收口的是三件事：

1. contract 收口
2. 认证语义收口
3. 多宿主一致性收口

只要这三件事收住，后续无论是继续扩展 OpenClaw，还是补强 MCP、自研 SDK、更多宿主，都会建立在同一套 VCP 标准能力面之上，而不会再次长出第二套桥接语义。
