# VCP Agent Gateway Checklist

> 说明：本清单由 `agent-gateway-detailed-task-list.md` 转换而来，面向实际执行。建议严格按阶段顺序推进，并在每项完成后直接打勾。

***

## 使用规则

- [ ] 每次开始新阶段前，确认上一阶段的回归测试已通过
- [ ] 每次提交阶段性代码前，记录已完成项、未完成项和已知风险
- [ ] 每次新增对外能力时，确认其复用了同一套 Gateway Core
- [ ] 每次重构后，先跑 OpenClaw 兼容测试，再继续下一步

***

## M0 基线冻结与准备

- [x] `AGW-M0-01` 记录当前 OpenClaw bridge 对外行为基线
- [x] `AGW-M0-01.1` 记录 `capabilities` 典型响应
- [x] `AGW-M0-01.2` 记录 `rag/search` 典型响应
- [x] `AGW-M0-01.3` 记录 `rag/context` 典型响应
- [x] `AGW-M0-01.4` 记录 `memory/write` 典型响应
- [x] `AGW-M0-01.5` 记录 `tools/:toolName` 典型响应
- [x] `AGW-M0-01.6` 记录当前 header、状态码、错误码和审计行为
- [x] `AGW-M0-01.7` 运行 `test/openclaw-bridge-routes.test.js` 并确认全绿
- [x] `AGW-M0-02` 梳理当前 `agentGatewayCore.js` 切分点
- [x] `AGW-M0-02.1` 标出 `contracts` 归属函数
- [x] `AGW-M0-02.2` 标出 `infra` 归属函数
- [x] `AGW-M0-02.3` 标出 `services` 归属函数
- [x] `AGW-M0-02.4` 标出 `adapters` 归属函数
- [x] `AGW-M0-02.5` 标记纯函数、状态函数、路由耦合逻辑和 OpenClaw 特有逻辑
- [x] `AGW-M0-03` 固定后续开发顺序
- [x] `AGW-M0-03.1` 确认优先级为 `contracts -> infra -> capability -> memory/context -> tool runtime -> registry -> native gateway`
- [x] `AGW-M0-03.2` 明确本轮暂不做完整独立 auth
- [x] `AGW-M0-03.3` 明确本轮暂不做完整 jobs
- [x] `AGW-M0-03.4` 明确本轮暂不做 MCP 正式实现

***

## M1 Gateway Core 第二阶段拆分

- [x] `AGW-M1-01` 新建 `modules/agentGateway/` 目录骨架
- [x] `AGW-M1-01.1` 新建 `index.js`
- [x] `AGW-M1-01.2` 新建 `contracts/`
- [x] `AGW-M1-01.3` 新建 `policy/`
- [x] `AGW-M1-01.4` 新建 `services/`
- [x] `AGW-M1-01.5` 新建 `infra/`
- [x] `AGW-M1-01.6` 预留 `adapters/`
- [x] `AGW-M1-02` 抽离统一请求上下文契约
- [x] `AGW-M1-02.1` 新建 `contracts/requestContext.js`
- [x] `AGW-M1-02.2` 定义 `requestId`
- [x] `AGW-M1-02.3` 定义 `sessionId`
- [x] `AGW-M1-02.4` 定义 `agentId`
- [x] `AGW-M1-02.5` 定义 `source`
- [x] `AGW-M1-02.6` 定义 `runtime`
- [x] `AGW-M1-02.7` 实现 normalize / sanitize / default fill
- [x] `AGW-M1-02.8` 补充对应测试
- [x] `AGW-M1-03` 抽离统一响应包络
- [x] `AGW-M1-03.1` 新建 `contracts/responseEnvelope.js`
- [x] `AGW-M1-03.2` 实现 success 响应构造
- [x] `AGW-M1-03.3` 实现 error 响应构造
- [x] `AGW-M1-03.4` 支持 meta 注入
- [x] `AGW-M1-03.5` 补充对应测试
- [x] `AGW-M1-04` 抽离错误码定义
- [x] `AGW-M1-04.1` 新建 `contracts/errorCodes.js`
- [x] `AGW-M1-04.2` 定义 `AGW_*` 错误码
- [x] `AGW-M1-04.3` 预留 `OCW_*` 映射关系
- [x] `AGW-M1-04.4` 补充对应测试
- [x] `AGW-M1-05` 抽离基础错误映射器
- [x] `AGW-M1-05.1` 新建 `infra/errorMapper.js`
- [x] `AGW-M1-05.2` 处理 validation error
- [x] `AGW-M1-05.3` 处理 forbidden error
- [x] `AGW-M1-05.4` 处理 timeout error
- [x] `AGW-M1-05.5` 处理 internal error
- [x] `AGW-M1-05.6` 补充对应测试
- [x] `AGW-M1-06` 抽离 trace 与 requestId 工具
- [x] `AGW-M1-06.1` 新建 `infra/trace.js`
- [x] `AGW-M1-06.2` 实现 requestId 自动生成
- [x] `AGW-M1-06.3` 实现 requestId 回用
- [x] `AGW-M1-06.4` 实现 duration 计算
- [x] `AGW-M1-06.5` 补充对应测试
- [x] `AGW-M1-07` 抽离审计日志工具
- [x] `AGW-M1-07.1` 新建 `infra/auditLogger.js`
- [x] `AGW-M1-07.2` 统一 capability 审计格式
- [x] `AGW-M1-07.3` 统一 memory 审计格式
- [x] `AGW-M1-07.4` 统一 context 审计格式
- [x] `AGW-M1-07.5` 统一 tool invoke 审计格式
- [x] `AGW-M1-07.6` 补充对应测试
- [x] `AGW-M1-08` 让 `agentGatewayCore.js` 降级为组装层
- [x] `AGW-M1-08.1` 用新模块替换原内联实现
- [x] `AGW-M1-08.2` 保留旧 OpenClaw 路由兼容输出
- [x] `AGW-M1-08.3` 跑 `test/openclaw-bridge-routes.test.js`
- [x] `AGW-M1-08.4` 检查 `agentGatewayCore.js` 是否明显变薄

***

## M2 Capability / Memory / Context 服务化

- [x] `AGW-M2-01` 实现 `CapabilityService`
- [x] `AGW-M2-01.1` 新建 `services/capabilityService.js`
- [x] `AGW-M2-01.2` 统一生成 server info
- [x] `AGW-M2-01.3` 统一生成 tools 描述
- [x] `AGW-M2-01.4` 统一生成 memory 描述
- [x] `AGW-M2-01.5` 统一生成 context 描述
- [x] `AGW-M2-01.6` 预留 jobs / events 描述
- [x] `AGW-M2-01.7` 引入 agent scope 过滤
- [x] `AGW-M2-01.8` 补 capability 测试
- [x] `AGW-M2-02` 实现 `MemoryRuntimeService`
- [x] `AGW-M2-02.1` 新建 `services/memoryRuntimeService.js`
- [x] `AGW-M2-02.2` 拆出 memory target 枚举
- [x] `AGW-M2-02.3` 拆出 memory search
- [x] `AGW-M2-02.4` 拆出 durable memory write
- [x] `AGW-M2-02.5` 接入幂等控制
- [x] `AGW-M2-02.6` 补 memory 测试
- [x] `AGW-M2-03` 实现 `ContextRuntimeService`
- [x] `AGW-M2-03.1` 新建 `services/contextRuntimeService.js`
- [x] `AGW-M2-03.2` 接管 recent messages -> query 生成
- [x] `AGW-M2-03.3` 接管 retrieval 逻辑
- [x] `AGW-M2-03.4` 接管 recall blocks 组装
- [x] `AGW-M2-03.5` 统一 token budget 处理
- [x] `AGW-M2-03.6` 统一 min score / truncation 处理
- [x] `AGW-M2-03.7` 补 context 测试
- [x] `AGW-M2-04` 抽离 schema 推导与注册工具
- [x] `AGW-M2-04.1` 新建 `infra/schemaRegistry.js`
- [x] `AGW-M2-04.2` 支持 manifest 推导 schema
- [x] `AGW-M2-04.3` 预留显式 schema 接入能力
- [x] `AGW-M2-04.4` 补 schema registry 测试
- [x] `AGW-M2-05` 完成 M2 集成回归
- [x] `AGW-M2-05.1` 回归 `capabilities`
- [x] `AGW-M2-05.2` 回归 `rag/targets`
- [x] `AGW-M2-05.3` 回归 `rag/search`
- [x] `AGW-M2-05.4` 回归 `rag/context`
- [x] `AGW-M2-05.5` 回归 `memory/write`
- [x] `AGW-M2-05.6` 核对审计日志字段
- [x] `AGW-M2-05.7` 运行 `test/openclaw-bridge-routes.test.js`

***

## M3 Tool Runtime 服务化

- [x] `AGW-M3-01` 实现 `ToolRuntimeService`
- [x] `AGW-M3-01.1` 新建 `services/toolRuntimeService.js`
- [x] `AGW-M3-01.2` 接入 schema 校验
- [x] `AGW-M3-01.3` 接入 `PluginManager.processToolCall()`
- [x] `AGW-M3-01.4` 接入 approval policy
- [x] `AGW-M3-01.5` 统一 `completed`
- [x] `AGW-M3-01.6` 统一 `accepted`
- [x] `AGW-M3-01.7` 统一 `waiting_approval`
- [x] `AGW-M3-01.8` 统一 `failed`
- [x] `AGW-M3-01.9` 补 tool runtime 测试
- [x] `AGW-M3-02` 统一内部执行上下文
- [x] `AGW-M3-02.1` 设计 `__agentGatewayContext`
- [x] `AGW-M3-02.2` 兼容保留 `__openclawContext`
- [x] `AGW-M3-02.3` 统一向下游工具透传
- [x] `AGW-M3-02.4` 补兼容透传测试
- [x] `AGW-M3-03` 将 `vcp_memory_write` 重新归类为 memory runtime bridge
- [x] `AGW-M3-03.1` 保留桥接 tool 兼容入口
- [x] `AGW-M3-03.2` 内部重定向到 `MemoryRuntimeService`
- [x] `AGW-M3-03.3` 补 memory bridge 测试
- [x] `AGW-M3-04` 完成工具链路回归
- [x] `AGW-M3-04.1` 回归 validation failed
- [x] `AGW-M3-04.2` 回归 approval required
- [x] `AGW-M3-04.3` 回归 timeout 映射
- [x] `AGW-M3-04.4` 回归参数透传
- [x] `AGW-M3-04.5` 回归 memory bridge
- [x] `AGW-M3-04.6` 运行 `test/openclaw-bridge-routes.test.js`

***

## M4 Agent Registry 导出

- [x] `AGW-M4-01` 设计 Agent Registry 输出模型
- [x] `AGW-M4-01.1` 定义 list 输出字段
- [x] `AGW-M4-01.2` 定义 detail 输出字段
- [x] `AGW-M4-01.3` 定义 render 输出字段
- [x] `AGW-M4-01.4` 明确 alias / sourceFile / mtime / hash / summary / defaultPolicies
- [x] `AGW-M4-02` 实现 `AgentRegistryService`
- [x] `AGW-M4-02.1` 新建 `services/agentRegistryService.js`
- [x] `AGW-M4-02.2` 封装 agent list
- [x] `AGW-M4-02.3` 封装 agent detail
- [x] `AGW-M4-02.4` 封装 agent render
- [x] `AGW-M4-02.5` 对接 prompt 读取
- [x] `AGW-M4-02.6` 对接缓存
- [x] `AGW-M4-02.7` 对接 hash / mtime 获取
- [x] `AGW-M4-02.8` 补 registry 测试
- [x] `AGW-M4-03` 补齐 render 变量与依赖信息
- [x] `AGW-M4-03.1` 设计 render 输入变量
- [x] `AGW-M4-03.2` 输出依赖说明
- [x] `AGW-M4-03.3` 输出 warning / truncation 信息
- [x] `AGW-M4-03.4` 补 render 测试
- [x] `AGW-M4-04` 完成 Agent Registry 回归验证
- [x] `AGW-M4-04.1` 验证 list 输出结构
- [x] `AGW-M4-04.2` 验证 detail 输出结构
- [x] `AGW-M4-04.3` 验证 render 输出结构
- [x] `AGW-M4-04.4` 验证与 policy / capability hint 一致性

***

## M5 Native Gateway Beta

- [x] `AGW-M5-01` 冻结 Native Gateway beta 路由清单
- [x] `AGW-M5-01.1` 确认 `capabilities`
- [x] `AGW-M5-01.2` 确认 `agents`
- [x] `AGW-M5-01.3` 确认 `memory`
- [x] `AGW-M5-01.4` 确认 `context`
- [x] `AGW-M5-01.5` 确认 `tools`
- [x] `AGW-M5-02` 新增 `routes/agentGatewayRoutes.js`
- [x] `AGW-M5-02.1` 新建路由文件
- [x] `AGW-M5-02.2` 挂接 core services
- [x] `AGW-M5-02.3` 使用统一 response envelope
- [x] `AGW-M5-02.4` 保持 route 只做协议适配
- [x] `AGW-M5-03` 在 `server.js` 中挂载 Native Gateway
- [x] `AGW-M5-03.1` 挂载 `/agent_gateway`
- [x] `AGW-M5-03.2` 初期复用现有 admin 鉴权
- [x] `AGW-M5-03.3` 内部生成独立 `authContext`
- [x] `AGW-M5-03.4` 确认不影响 `/admin_api/openclaw/*`
- [x] `AGW-M5-04` 实现 Native Gateway 集成测试
- [x] `AGW-M5-04.1` 新增 `test/agent-gateway-routes.test.js`
- [x] `AGW-M5-04.2` 覆盖 `capabilities`
- [x] `AGW-M5-04.3` 覆盖 `agents`
- [x] `AGW-M5-04.4` 覆盖 `memory/search`
- [x] `AGW-M5-04.5` 覆盖 `context/assemble`
- [x] `AGW-M5-04.6` 覆盖 `tools/:toolName/invoke`
- [x] `AGW-M5-04.7` 运行 `node --test test/agent-gateway-routes.test.js`
- [x] `AGW-M5-05` 验证双 adapter 复用同一套 core
- [x] `AGW-M5-05.1` 对比 OpenClaw 和 Native 的内部调用路径
- [x] `AGW-M5-05.2` 确认 capabilities 共用 service
- [x] `AGW-M5-05.3` 确认 memory 共用 service
- [x] `AGW-M5-05.4` 确认 context 共用 service
- [x] `AGW-M5-05.5` 确认 tool invoke 共用 service
- [x] `AGW-M5-05.6` 运行 OpenClaw + Native 两套测试

***

## M6 Auth / Policy / Job Runtime / MCP 预留

- [x] `AGW-M6-01` 实现 `authContextResolver`
- [x] `AGW-M6-01.1` 新建 `policy/authContextResolver.js`
- [x] `AGW-M6-01.2` 提取 gateway identity
- [x] `AGW-M6-01.3` 提取 agent identity
- [x] `AGW-M6-01.4` 提取 session identity
- [x] `AGW-M6-01.5` 兼容当前 Basic Auth 过渡状态
- [x] `AGW-M6-01.6` 补对应测试
- [x] `AGW-M6-02` 实现 `agentPolicyResolver`
- [x] `AGW-M6-02.1` 新建 `policy/agentPolicyResolver.js`
- [x] `AGW-M6-02.2` 解析 tool scope
- [x] `AGW-M6-02.3` 解析 diary scope
- [x] `AGW-M6-02.4` 让 capabilities / memory / tool runtime 复用统一 policy
- [x] `AGW-M6-02.5` 补对应测试
- [x] `AGW-M6-03` 实现 `toolScopeGuard` 与 `diaryScopeGuard`
- [x] `AGW-M6-03.1` 新建 `policy/toolScopeGuard.js`
- [x] `AGW-M6-03.2` 新建 `policy/diaryScopeGuard.js`
- [x] `AGW-M6-03.3` 统一抛出标准 `AGW_FORBIDDEN`
- [x] `AGW-M6-03.4` 补越权测试
- [x] `AGW-M6-04` 实现 `JobRuntimeService` 最小骨架
- [x] `AGW-M6-04.1` 新建 `services/jobRuntimeService.js`
- [x] `AGW-M6-04.2` 定义 `accepted` 结构
- [x] `AGW-M6-04.3` 定义 `waiting_approval` 结构
- [x] `AGW-M6-04.4` 定义 poll 基础结构
- [x] `AGW-M6-04.5` 定义 cancel 基础结构
- [x] `AGW-M6-04.6` 补 job runtime 骨架测试
- [x] `AGW-M6-05` 设计 MCP Adapter 最小接入清单
- [x] `AGW-M6-05.1` 明确第一版 MCP tools 范围
- [x] `AGW-M6-05.2` 明确第一版暂不接入的能力
- [x] `AGW-M6-05.3` 冻结 MCP 对接边界说明

***

## 横向公共项

- [x] `AGW-CROSS-01` 每个里程碑结束后同步文档
- [ ] `AGW-CROSS-02` 持续收敛 core 内部命名，减少 `OpenClaw` 泄漏
- [x] `AGW-CROSS-03` 为新增模块补充简洁职责注释
- [x] `AGW-CROSS-04` 每阶段记录回归结果与已知风险

***

## 测试清单

- [x] 新增 `test/agent-gateway-capability-service.test.js`
- [x] 新增 `test/agent-gateway-memory-runtime.test.js`
- [x] 新增 `test/agent-gateway-context-runtime.test.js`
- [x] 新增 `test/agent-gateway-tool-runtime.test.js`
- [x] 新增 `test/agent-gateway-agent-registry.test.js`
- [x] 新增 `test/agent-gateway-routes.test.js`
- [x] 新增 `test/agent-gateway-auth-policy.test.js`
- [x] 新增 `test/agent-gateway-job-runtime.test.js`
- [x] 覆盖 requestContext 默认值与归一化
- [x] 覆盖 response envelope 一致性
- [x] 覆盖 error code 稳定性
- [x] 覆盖 capabilities 输出结构
- [x] 覆盖 agent scope 对 capability 的过滤
- [x] 覆盖 memory target 枚举
- [x] 覆盖 memory search 过滤
- [x] 覆盖 memory write 幂等
- [x] 覆盖 write 后检索命中
- [x] 覆盖 context recall blocks 生成
- [x] 覆盖 context budget 截断
- [x] 覆盖 tool validation
- [x] 覆盖 approval required
- [x] 覆盖共享 authContext 与 policy scope guard
- [x] 覆盖 job runtime accepted / waiting_approval / poll / cancel 骨架
- [x] 覆盖 timeout
- [x] 覆盖 registry list / detail / render
- [x] 覆盖不存在 agent 场景
- [x] 覆盖 OpenClaw 与 Native 双 adapter 集成路径

***

## 阶段完成确认

- [x] `M1` 完成：contracts / infra 已落地，OpenClaw 兼容测试全绿
- [x] `M2` 完成：capability、memory、context 已进入 service 层
- [x] `M3` 完成：tool runtime 主链路已服务化，memory bridge 已归位
- [x] `M4` 完成：agent list / detail / render 可用
- [x] `M5` 完成：`/agent_gateway/*` 可访问，且有独立集成测试
- [x] `M6` 完成：authContext、policy resolver、scope guard、job runtime 骨架到位

***

## 最终完成确认

- [x] OpenClaw 兼容行为无回归
- [x] Native Gateway 已成为正式 beta 入口
- [x] 至少两个 adapter 复用同一套 Gateway Core
- [x] Agent Registry 可稳定导出 agent 定义
- [x] Memory / Context / Tool Runtime 全部完成服务化
- [x] requestContext、responseEnvelope、errorCodes 已统一
- [x] 关键链路具备自动化测试
- [x] 已记录残余风险与后续待办
