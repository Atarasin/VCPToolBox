# M0-M7 实现闭合报告

## 最终状态

M0-M7 的实现已**符合目标架构及自动化发布门禁要求**。
目前唯一的发布限制是真实 Codex MCP 冒烟测试；该测试依赖外部认证，继续作为文档约定的发布前人工门禁。M8 仍不在本轮范围内。

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| M0 | 已完成 | `npm run test:agent-gateway`：731/731；CI 聚合测试运行器 |
| M1 | 已完成 | 超时、认证和 discovery 回归测试套件 |
| M2 | 已完成 | 统一的 MCP 语义、执行器和一致性测试套件 |
| M3 | 已完成 | 共享 codec/context/rate limit；拆分后的 HTTP/WS runtime |
| M4 | 已完成 | 冻结的窄端口；宿主/私有 API 访问及配置提取收口于 `composition/`；部分启用但绑定不完整的 RAG 会快速失败 |
| M5 | 已完成 | 六个独立 stage 模块、短编排器、函数身份兼容测试及共享后端串行测试 |
| M6 | 已完成 | 统一的 operation/schema、确定性生成流程及覆盖八个操作的 AJV 兼容语料 |
| M7 | 已完成 | 共享审计 sink，以及真实 HTTP MCP → backend proxy → Native route → service → audit 链路追踪测试 |

## M4 闭合证据

- `composition/vcpPortBindings.js` 是唯一了解宿主字段、RAG 私有 API、历史 `1.33` 搜索系数、根级宿主模块及旧测试夹具适配逻辑的模块。
- Core、service、policy、protocol 和 route 代码仅接收端口或冻结的配置/就绪状态快照；扫描确认 composition 之外不存在直接访问宿主属性或 RAG 私有 API 的代码。
- RAG 端口仅暴露方法和能力标志，不暴露 `knowledgeBaseManager` 或 `ragPlugin`。
- 对于已部分启用但缺少 `searchDiary` 的 RAG 宿主，绑定阶段会立即失败，不会提供直到实际操作时才报错的延迟包装器。
- 记忆写入幂等状态由 service 自身维护，日记写入端口返回 DTO，而不是原始插件对象。

## M5 闭合证据

- `core/recall/pipeline.js` 是短编排器，并从以下模块重导出完全相同的函数对象：`resolveProfile`、`precomputeVector`、`executeRules`、`mergeResults`、`applyBudget` 和 `applyAiMemo`。
- `executeRulesStage` 使用串行 `for` 循环并执行 `await executeRuleStage(...)`；未引入规则级 `Promise.all`。
- 旧 recall service/projection 路径继续保持 CommonJS 函数身份重导出。
- S01-S05 夹具及完整聚合测试套件证明 items、diagnostics、执行顺序和错误语义保持不变。

## 兼容性与发布说明

- 保留原有 15 个 REST 路径、8 个 MCP 操作、响应 envelope 和环境变量。
- HTTP 和 stdio 仍拒绝 batch 请求；WebSocket batch 上限仍为 20。
- Recall 规则继续串行执行，并保持稳定的输出顺序。
- SSE 背压默认限制为 30 秒。
- Discovery session 使用独立且有界的 LRU 池，TTL 为 60 秒。
- WebSocket idle 清理仍为可选功能，默认关闭。
- `AGENT_GATEWAY_AUDIT_FILE` 用于启用只追加文件 sink；日志轮转继续交由容器日志系统或外部 `logrotate` 负责。
- D5 已按设计豁免：在单独设计跨进程状态模型之前，job 继续保留在进程内。
- M8 仍不在本轮范围内；规则并发以及 HTTP/stdio batch 行为需要单独进行兼容性决策。

## 验证结果

| 检查项 | 结果 |
| --- | --- |
| `npm run test:agent-gateway` | 731/731，0 项失败 |
| S01-S05 | 424/424，0 项失败 |
| OpenAPI/MCP 生成 | 重新生成后零差异 |
| REST/MCP 发布集合 | 15 个 REST 路径；8 个 MCP 操作 |
| 函数规模 | 没有函数超过 150 行 |
| 文件规模 | 范围内没有文件超过 800 行；最大为 798 行 |
| 宿主/私有 API 扫描 | `composition/` 之外零命中 |
| 深层根级 require 扫描 | `composition/` 之外零命中 |
| 真实 Codex 冒烟测试 | 未运行；需要外部认证 |

实现闭合提交：`5f42fc12`。
