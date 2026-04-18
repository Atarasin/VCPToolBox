# VCP Agent Gateway 详细任务清单

> 目标：基于 `agent-gateway-rollout-plan.md`，将分层 Agent Gateway 的落地工作拆解成可执行任务树，明确每项任务的目标、依赖、交付物、验收标准和测试要求。
>
> 使用方式：建议按阶段推进，并以“任务编号”为单位跟踪实施进度、风险和回归验证结果。

---

## 1. 任务拆解原则

本清单遵循以下原则：

1. 先做**保护性任务**，再做结构性重构
2. 先拆 **Core 内部结构**，再推出 **新协议出口**
3. 先保证 **OpenClaw 兼容不回归**，再推进 **Native Gateway**
4. 每个阶段都要有明确交付物和验收标准
5. 每个关键阶段都要附带测试任务，避免“代码拆完但不可验证”

---

## 2. 里程碑总览

建议按以下 7 个里程碑推进：

- `M0` 基线冻结与任务准备
- `M1` Gateway Core 第二阶段拆分
- `M2` Capability / Memory / Context 服务化
- `M3` Tool Runtime 服务化
- `M4` Agent Registry 导出
- `M5` Native Gateway Beta
- `M6` Auth / Policy / Job Runtime / MCP 预留

---

## 3. 任务依赖图

```text
M0 基线冻结
  -> M1 Core 骨架拆分
    -> M2 Capability / Memory / Context
      -> M3 Tool Runtime
        -> M4 Agent Registry
          -> M5 Native Gateway Beta
            -> M6 Auth / Job / MCP 扩展
```

说明：

- `M3` 之前不建议直接做 MCP adapter
- `M4` 完成前不建议把“agent 对外导出”当作已完成
- `M5` 完成前，OpenClaw 仍然是唯一兼容适配层

---

## 4. M0：基线冻结与任务准备

### `AGW-M0-01` 记录当前对外行为基线

- 目标：冻结当前 OpenClaw bridge 行为，作为后续重构的对照基线
- 前置依赖：无
- 主要工作：
  - 记录 `capabilities`、`rag/search`、`rag/context`、`memory/write`、`tools/:toolName` 的典型响应
  - 记录当前 header、状态码、错误码和审计行为
- 交付物：
  - 一份接口基线说明或响应样例集合
- 验收标准：
  - 后续重构能逐项对照是否回归
- 测试要求：
  - 运行现有 `openclaw-bridge-routes` 测试并确认全绿

### `AGW-M0-02` 梳理当前 `agentGatewayCore.js` 模块切分点

- 目标：给后续拆分建立明确边界，避免边写边改导致反复返工
- 前置依赖：`AGW-M0-01`
- 主要工作：
  - 按 `contracts` / `infra` / `services` / `adapters` 标出当前函数归属
  - 标记纯函数、状态函数、路由耦合逻辑、OpenClaw 特有逻辑
- 交付物：
  - 模块切分映射表
- 验收标准：
  - 主要函数都有归属，不存在“大块未知区域”
- 测试要求：
  - 无新增测试，但要确保切分分析不影响现有代码

### `AGW-M0-03` 确认阶段性交付顺序

- 目标：固定后续开发顺序，防止并行修改互相打架
- 前置依赖：`AGW-M0-02`
- 主要工作：
  - 确认优先级：`contracts -> infra -> capability -> memory/context -> tool runtime -> registry -> native gateway`
  - 明确暂不做项：完整 auth 独立、完整 jobs、MCP 正式实现
- 交付物：
  - 阶段开发顺序说明
- 验收标准：
  - 团队成员对顺序和边界一致
- 测试要求：
  - 无

---

## 5. M1：Gateway Core 第二阶段拆分

### `AGW-M1-01` 新建 `modules/agentGateway/` 目录骨架

- 目标：建立正式 Gateway Core 目录结构
- 前置依赖：`AGW-M0-03`
- 主要工作：
  - 新建 `index.js`
  - 新建 `contracts/`
  - 新建 `policy/`
  - 新建 `services/`
  - 新建 `infra/`
  - 预留 `adapters/`
- 交付物：
  - 空目录和基础模块文件
- 验收标准：
  - 目录结构与实施方案一致
- 测试要求：
  - 基础 require 不报错

### `AGW-M1-02` 抽离统一请求上下文契约

- 目标：形成统一 `requestContext` 模型
- 前置依赖：`AGW-M1-01`
- 主要工作：
  - 新建 `contracts/requestContext.js`
  - 定义 requestId、sessionId、agentId、source、runtime 等字段
  - 提供 normalize / sanitize / default fill 逻辑
- 交付物：
  - `requestContext` 契约模块
- 验收标准：
  - OpenClaw adapter 可复用该契约
- 测试要求：
  - 覆盖默认值、非法值裁剪、缺省回填

### `AGW-M1-03` 抽离统一响应包络

- 目标：统一 success/error 响应结构，避免各路径自行拼装
- 前置依赖：`AGW-M1-01`
- 主要工作：
  - 新建 `contracts/responseEnvelope.js`
  - 提供 success / error 工具函数
  - 支持 metadata 注入
- 交付物：
  - 响应包络模块
- 验收标准：
  - OpenClaw 路由行为保持兼容
- 测试要求：
  - 覆盖成功响应、错误响应、meta 字段生成

### `AGW-M1-04` 抽离错误码定义

- 目标：形成 canonical 错误码层
- 前置依赖：`AGW-M1-01`
- 主要工作：
  - 新建 `contracts/errorCodes.js`
  - 定义 `AGW_*` 错误码
  - 预留 OpenClaw `OCW_*` 映射关系
- 交付物：
  - 错误码常量与映射定义
- 验收标准：
  - 不再依赖自由文本作为主要错误识别依据
- 测试要求：
  - 校验错误码常量存在且映射稳定

### `AGW-M1-05` 抽离基础错误映射器

- 目标：将异常到标准错误响应的转换从业务逻辑中拿出来
- 前置依赖：`AGW-M1-04`
- 主要工作：
  - 新建 `infra/errorMapper.js`
  - 统一处理参数错误、权限错误、工具超时、内部错误
- 交付物：
  - 错误映射器
- 验收标准：
  - 业务 service 不直接拼最终 HTTP 错误响应
- 测试要求：
  - 覆盖 timeout、validation、forbidden、internal error

### `AGW-M1-06` 抽离 trace 与 requestId 工具

- 目标：统一追踪链路
- 前置依赖：`AGW-M1-02`
- 主要工作：
  - 新建 `infra/trace.js`
  - 提供 requestId 生成、trace metadata、duration 计算
- 交付物：
  - trace 基础设施
- 验收标准：
  - 不同 service 可复用同一 trace 逻辑
- 测试要求：
  - 覆盖 requestId 回用、自动生成、duration 计算

### `AGW-M1-07` 抽离审计日志工具

- 目标：让审计格式统一，便于后续扩展 adapter
- 前置依赖：`AGW-M1-06`
- 主要工作：
  - 新建 `infra/auditLogger.js`
  - 统一 capability、memory、context、tool invoke 的审计事件格式
- 交付物：
  - 审计日志模块
- 验收标准：
  - 各操作审计字段结构一致
- 测试要求：
  - 校验关键字段包含 requestId、agentId、operation、status、durationMs

### `AGW-M1-08` 让 `agentGatewayCore.js` 降级为组装层

- 目标：把过渡态单体文件从“实现中心”降为“拼装入口”
- 前置依赖：`AGW-M1-02` 至 `AGW-M1-07`
- 主要工作：
  - 用新模块替换原内联实现
  - 保留对旧 OpenClaw 路由的兼容输出
- 交付物：
  - 变薄后的 `agentGatewayCore.js`
- 验收标准：
  - 文件体积明显下降
  - 外部协议零回归
- 测试要求：
  - 运行 `test/openclaw-bridge-routes.test.js`

---

## 6. M2：Capability / Memory / Context 服务化

### `AGW-M2-01` 实现 `CapabilityService`

- 目标：让 capability 构建从 route / adapter 中彻底独立
- 前置依赖：`AGW-M1-08`
- 主要工作：
  - 新建 `services/capabilityService.js`
  - 统一生成 server info、tools、memory、context、jobs、events 能力描述
  - 引入 agent scope 过滤
- 交付物：
  - `CapabilityService`
- 验收标准：
  - OpenClaw `capabilities` 接口不再直接依赖旧内联逻辑
- 测试要求：
  - 覆盖 bridgeable tool 过滤
  - 覆盖 memory metadata 返回
  - 覆盖按 agent policy 过滤 diary target

### `AGW-M2-02` 实现 `MemoryRuntimeService`

- 目标：把 memory search / write 从桥接逻辑中独立出来
- 前置依赖：`AGW-M2-01`
- 主要工作：
  - 新建 `services/memoryRuntimeService.js`
  - 拆出 memory target 枚举
  - 拆出 memory search
  - 拆出 durable memory write
  - 接入幂等控制接口
- 交付物：
  - `MemoryRuntimeService`
- 验收标准：
  - `rag/targets`、`rag/search`、`memory/write` 的核心逻辑进入 service
- 测试要求：
  - 覆盖 diary scope 限制
  - 覆盖重复写入幂等
  - 覆盖 write 后 search 命中

### `AGW-M2-03` 实现 `ContextRuntimeService`

- 目标：把 recall query 和上下文组装逻辑沉淀成独立服务
- 前置依赖：`AGW-M2-02`
- 主要工作：
  - 新建 `services/contextRuntimeService.js`
  - 接管 recent messages -> query -> retrieval -> recall blocks 逻辑
  - 统一 token budget、min score、truncation 处理
- 交付物：
  - `ContextRuntimeService`
- 验收标准：
  - `rag/context` 不再依赖旧大段内联逻辑
- 测试要求：
  - 覆盖 recall blocks 生成
  - 覆盖 token budget 截断
  - 覆盖 diary 过滤
  - 覆盖 query 缺失校验

### `AGW-M2-04` 抽离 schema 推导与注册工具

- 目标：把参数 schema 推导从具体工具执行逻辑中解耦
- 前置依赖：`AGW-M1-08`
- 主要工作：
  - 新建 `infra/schemaRegistry.js`
  - 管理 manifest 推导 schema
  - 预留未来显式 machine-readable schema 接入能力
- 交付物：
  - `schemaRegistry`
- 验收标准：
  - tool runtime 通过 registry 获取 schema，而不是现场推导
- 测试要求：
  - 覆盖从描述中提取参数
  - 覆盖无 schema 场景

### `AGW-M2-05` 完成 M2 集成回归

- 目标：确保 service 化没有破坏已有行为
- 前置依赖：`AGW-M2-01` 至 `AGW-M2-04`
- 主要工作：
  - 回归 OpenClaw capabilities / rag / memory 路径
  - 核对审计日志字段
- 交付物：
  - 回归验证结果
- 验收标准：
  - 现有 OpenClaw 测试持续通过
- 测试要求：
  - 运行并记录 `test/openclaw-bridge-routes.test.js`

---

## 7. M3：Tool Runtime 服务化

### `AGW-M3-01` 实现 `ToolRuntimeService`

- 目标：统一工具调用主链路
- 前置依赖：`AGW-M2-04`
- 主要工作：
  - 新建 `services/toolRuntimeService.js`
  - 接入 schema 校验
  - 接入 `PluginManager.processToolCall()`
  - 接入 approval policy
  - 统一结果状态模型
- 交付物：
  - `ToolRuntimeService`
- 验收标准：
  - 工具执行主链路不再依赖旧桥接实现
- 测试要求：
  - 覆盖参数透传
  - 覆盖 validation failed
  - 覆盖 approval required
  - 覆盖 timeout 映射

### `AGW-M3-02` 统一内部执行上下文

- 目标：逐步把 `__openclawContext` 提升为更通用的 core context
- 前置依赖：`AGW-M3-01`
- 主要工作：
  - 设计 `__agentGatewayContext`
  - 在兼容期同时保留 `__openclawContext`
  - 统一向下游工具透传
- 交付物：
  - 通用内部执行上下文规范
- 验收标准：
  - 非 OpenClaw adapter 未来也可复用
- 测试要求：
  - 覆盖兼容期双上下文字段透传

### `AGW-M3-03` 将 `vcp_memory_write` 重新归类为 memory runtime bridge

- 目标：明确 durable memory 写入属于 memory runtime，而不是长期正式 tool
- 前置依赖：`AGW-M3-01`
- 主要工作：
  - 保留对现有桥接 tool 的兼容
  - 但内部实现走 `MemoryRuntimeService`
- 交付物：
  - 兼容桥接层重定向
- 验收标准：
  - `vcp_memory_write` 行为不变
  - 内部路径统一
- 测试要求：
  - 覆盖 durable memory bridge 写入

### `AGW-M3-04` 完成工具链路回归

- 目标：确保工具服务化后旧行为不漂移
- 前置依赖：`AGW-M3-01` 至 `AGW-M3-03`
- 主要工作：
  - 运行 tools 相关全部回归测试
  - 核对 timeout、approval、validation、memory bridge
- 交付物：
  - 回归结果记录
- 验收标准：
  - OpenClaw tools 相关测试全绿
- 测试要求：
  - 运行 `test/openclaw-bridge-routes.test.js`

---

## 8. M4：Agent Registry 导出

### `AGW-M4-01` 设计 Agent Registry 输出模型

- 目标：明确 agent 对外导出的字段模型
- 前置依赖：`AGW-M3-04`
- 主要工作：
  - 定义 list/detail/render 三类输出
  - 明确元信息字段：alias、sourceFile、mtime、hash、summary、defaultPolicies
- 交付物：
  - Agent Registry 数据模型说明
- 验收标准：
  - 对外字段与后台管理字段分离
- 测试要求：
  - 无独立测试，作为后续实现前置设计

### `AGW-M4-02` 实现 `AgentRegistryService`

- 目标：复用 `agentManager`，导出 agent-first 视角的定义能力
- 前置依赖：`AGW-M4-01`
- 主要工作：
  - 新建 `services/agentRegistryService.js`
  - 封装 agent list / detail / render
  - 对接 prompt 读取、缓存、hash/mtime 获取
- 交付物：
  - `AgentRegistryService`
- 验收标准：
  - 不直接暴露后台目录扫描逻辑
- 测试要求：
  - 覆盖 list
  - 覆盖 detail
  - 覆盖 render
  - 覆盖 agent not found

### `AGW-M4-03` 补齐 render 变量与依赖信息

- 目标：让外部 agent 宿主能拿到真正可消费的 render 结果
- 前置依赖：`AGW-M4-02`
- 主要工作：
  - 设计 render 输入变量
  - 输出依赖说明、可能的警告、截断信息
- 交付物：
  - render 结果增强版输出
- 验收标准：
  - render 不只是“读 prompt 文件原文”
- 测试要求：
  - 覆盖变量渲染和 metadata 输出

### `AGW-M4-04` 完成 Agent Registry 回归验证

- 目标：确保 registry 输出与核心能力模型一致
- 前置依赖：`AGW-M4-02`、`AGW-M4-03`
- 主要工作：
  - 验证 agent detail / render 输出结构
  - 检查与 policy / capability hint 的一致性
- 交付物：
  - registry 验证结果
- 验收标准：
  - 可以作为 Native Gateway 正式对外能力的一部分
- 测试要求：
  - 新增 registry 测试文件

---

## 9. M5：Native Gateway Beta

### `AGW-M5-01` 设计 Native Gateway 路由清单

- 目标：冻结 beta 版原生协议范围
- 前置依赖：`AGW-M4-04`
- 主要工作：
  - 确认第一批开放资源：
    - `capabilities`
    - `agents`
    - `memory`
    - `context`
    - `tools`
- 交付物：
  - Native Gateway beta 路由清单
- 验收标准：
  - 范围稳定，不在 beta 里混入未成熟的 jobs/events 全量能力
- 测试要求：
  - 无

### `AGW-M5-02` 新增 `routes/agentGatewayRoutes.js`

- 目标：正式提供 `/agent_gateway/*` 入口
- 前置依赖：`AGW-M5-01`
- 主要工作：
  - 新建路由文件
  - 挂接 core services
  - 使用统一 response envelope
- 交付物：
  - `routes/agentGatewayRoutes.js`
- 验收标准：
  - route 只做协议适配，不承载核心业务
- 测试要求：
  - 覆盖基本路由可达与响应结构

### `AGW-M5-03` 在 `server.js` 中挂载 Native Gateway

- 目标：让新协议实际可访问
- 前置依赖：`AGW-M5-02`
- 主要工作：
  - 在 `server.js` 挂载 `/agent_gateway`
  - 初期可复用现有 admin 鉴权
  - 但内部生成独立 `authContext`
- 交付物：
  - 服务入口挂载完成
- 验收标准：
  - 不影响现有 `/admin_api/openclaw/*`
- 测试要求：
  - 覆盖并行访问旧入口和新入口

### `AGW-M5-04` 实现 Native Gateway 集成测试

- 目标：为 canonical protocol 建立第一套集成测试
- 前置依赖：`AGW-M5-03`
- 主要工作：
  - 新增 `test/agent-gateway-routes.test.js`
  - 覆盖 capabilities、agents、memory search、context assemble、tool invoke
- 交付物：
  - Native Gateway 测试文件
- 验收标准：
  - 新协议关键路径可自动验证
- 测试要求：
  - `node --test test/agent-gateway-routes.test.js`

### `AGW-M5-05` 验证双 adapter 复用同一套 core

- 目标：证明“Core + Adapter”架构已经真正成立
- 前置依赖：`AGW-M5-04`
- 主要工作：
  - 对比 OpenClaw 和 Native Gateway 的内部 service 调用路径
  - 确认不存在两份平行实现
- 交付物：
  - 双 adapter 复用验证记录
- 验收标准：
  - 至少 capabilities、memory、context、tool invoke 共用 service
- 测试要求：
  - 运行 OpenClaw + Native 两套测试

---

## 10. M6：Auth / Policy / Job Runtime / MCP 预留

### `AGW-M6-01` 实现 `authContextResolver`

- 目标：将现有鉴权逻辑与 runtime 身份逻辑分离
- 前置依赖：`AGW-M5-05`
- 主要工作：
  - 新建 `policy/authContextResolver.js`
  - 从请求中提取 gateway identity、agent identity、session identity
  - 兼容当前 admin 鉴权过渡状态
- 交付物：
  - `authContextResolver`
- 验收标准：
  - route 不再直接散落身份解析逻辑
- 测试要求：
  - 覆盖缺省 agentId、非法 agentId、兼容 Basic Auth 场景

### `AGW-M6-02` 实现 `agentPolicyResolver`

- 目标：统一 agent 的 tool scope / diary scope 解析
- 前置依赖：`AGW-M6-01`
- 主要工作：
  - 新建 `policy/agentPolicyResolver.js`
  - 汇总 agent 对工具和 diary 的访问边界
- 交付物：
  - `agentPolicyResolver`
- 验收标准：
  - capabilities、memory、tool runtime 全部复用同一 policy 结果
- 测试要求：
  - 覆盖不同 agentId 获得不同 scope

### `AGW-M6-03` 实现 `toolScopeGuard` 与 `diaryScopeGuard`

- 目标：将授权判断从 service 主逻辑中剥离
- 前置依赖：`AGW-M6-02`
- 主要工作：
  - 新建两个 guard 模块
  - 统一抛出标准 `AGW_FORBIDDEN` 类错误
- 交付物：
  - guard 模块
- 验收标准：
  - 各 service 不再各自写权限判断分支
- 测试要求：
  - 覆盖越权访问被拒绝

### `AGW-M6-04` 实现 `JobRuntimeService` 最小骨架

- 目标：为异步任务和审批等待预留正式模型
- 前置依赖：`AGW-M6-03`
- 主要工作：
  - 新建 `services/jobRuntimeService.js`
  - 定义 `accepted` / `waiting_approval` / poll / cancel 基础结构
- 交付物：
  - `JobRuntimeService` 骨架
- 验收标准：
  - 异步模型不再依赖未来重写 tool runtime
- 测试要求：
  - 覆盖 job handle 创建和状态查询骨架

### `AGW-M6-05` 设计 MCP Adapter 对接清单

- 目标：在不立即编码的前提下，先冻结 MCP 最小接入范围
- 前置依赖：`AGW-M6-04`
- 主要工作：
  - 明确哪些能力先映射成 MCP tools
  - 明确哪些能力暂不进入 MCP 第一版
- 交付物：
  - MCP adapter 最小落地清单
- 验收标准：
  - MCP 接入范围与 core 能力模型一致
- 测试要求：
  - 无实现测试，属于设计冻结

---

## 11. 横向公共任务

### `AGW-CROSS-01` 文档同步

- 目标：确保架构文档与代码结构同步演进
- 触发时机：每个里程碑结束后
- 主要工作：
  - 更新实施方案文档
  - 更新任务状态
  - 记录已落地模块与未完成项

### `AGW-CROSS-02` 命名收敛

- 目标：逐步减少 `OpenClaw` 命名在 core 中的扩散
- 触发时机：M1 开始持续进行
- 主要工作：
  - 将 core 内部通用对象改名为 `agentGateway*`
  - 仅在 adapter 层保留 `OpenClaw` 特定命名

### `AGW-CROSS-03` 注释与边界说明

- 目标：确保新增模块有符合项目风格的简洁注释
- 触发时机：每次新增模块时
- 主要工作：
  - 在复杂逻辑前补充简短职责说明
  - 标注兼容层与正式协议层的区别

### `AGW-CROSS-04` 回归基线记录

- 目标：每次阶段结束时都能回答“改动是否回归”
- 触发时机：每个阶段合并前
- 主要工作：
  - 记录测试结果
  - 记录关键响应样例变化
  - 记录已知残余风险

---

## 12. 推荐测试任务清单

建议至少补以下测试文件：

- `test/agent-gateway-capability-service.test.js`
- `test/agent-gateway-memory-runtime.test.js`
- `test/agent-gateway-context-runtime.test.js`
- `test/agent-gateway-tool-runtime.test.js`
- `test/agent-gateway-agent-registry.test.js`
- `test/agent-gateway-routes.test.js`

建议覆盖点如下：

### 核心契约测试

- requestContext 默认值与归一化
- response envelope 一致性
- error code 稳定性

### 能力测试

- capabilities 输出结构
- agent scope 对 capability 的过滤

### memory 测试

- target 枚举
- search 过滤
- write 幂等
- write 后检索命中

### context 测试

- recall blocks 生成
- budget 截断
- diary 限制

### tool runtime 测试

- 参数校验
- approval required
- timeout
- memory bridge

### registry 测试

- list / detail / render
- 不存在 agent
- 元信息字段完整性

### 路由集成测试

- OpenClaw 兼容路由
- Native Gateway 路由
- 双 adapter 共用同一 core service

---

## 13. 每阶段验收门槛

### `M1` 验收门槛

- `agentGatewayCore.js` 开始明显变薄
- contracts / infra 已落地
- OpenClaw 兼容测试全绿

### `M2` 验收门槛

- capability、memory、context 已进入 service 层
- 路由层不再内联主要业务逻辑
- search / context / memory write 测试全绿

### `M3` 验收门槛

- tools 主链路进入 `ToolRuntimeService`
- validation / timeout / approval 行为稳定
- `vcp_memory_write` 已走 memory runtime

### `M4` 验收门槛

- agent list / detail / render 可用
- registry 不依赖后台编辑接口语义

### `M5` 验收门槛

- `/agent_gateway/*` 可访问
- Native Gateway 有独立集成测试
- OpenClaw 与 Native 共用 service

### `M6` 验收门槛

- authContext、policy resolver、scope guard 已就位
- job runtime 有最小骨架
- MCP 适配边界清晰

---

## 14. 推荐执行顺序

如果按照最稳妥的方式推进，建议实际执行顺序如下：

1. `AGW-M0-01`
2. `AGW-M0-02`
3. `AGW-M1-01` 到 `AGW-M1-08`
4. `AGW-M2-01` 到 `AGW-M2-05`
5. `AGW-M3-01` 到 `AGW-M3-04`
6. `AGW-M4-01` 到 `AGW-M4-04`
7. `AGW-M5-01` 到 `AGW-M5-05`
8. `AGW-M6-01` 到 `AGW-M6-05`

---

## 15. 一句话总结

这份任务清单的核心目的，不是把大方案再说一遍，而是把它转换成一组**可以逐项勾选、逐项验收、逐项测试**的落地任务。

最重要的执行纪律只有两条：

1. **每拆一层，都先保住 OpenClaw 兼容测试**
2. **每加一个新出口，都必须复用同一套 Gateway Core**

只要这两条不丢，分层 Agent Gateway 就会是一次“稳定演进”，而不是一次“高风险重写”。
