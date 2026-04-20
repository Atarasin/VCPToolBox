# Agent Prompt Render Chain Diff

## 范围

本文对比两条链路：

1. `modules/agentGateway/services/agentRegistryService.js` 中 `renderAgent()` 产出的提示词渲染结果
2. VCP 主服务在 `modules/chatCompletionHandler.js` 中，消息进入模型前所经历的主渲染链路

对照目标不是“文件是否相似”，而是“最终提示词编译语义是否一致”。

## 结论摘要

- 当前两条链在 **变量替换引擎**、**RAG/TagMemo/元思考能力来源** 方面已经对齐。
- 当前两条链在 **变量展开轮次**、**是否伪造 fallback user 上下文**、**是否执行完整 message preprocessor pipeline**、**是否做 legacy brace unwrap 兼容清理** 方面仍未对齐。
- 结论上，`agentRegistryService` 已经是一个**高度贴近主服务 prompt 编译语义的受控子集**，但还不是主服务完整消息预处理链的 1:1 镜像。

## 精确对照表

| 对比项 | `agentRegistryService` | 主服务渲染链 | 对齐状态 | 风险等级 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 原始 agent prompt 来源 | 由 `agentManager` 读取 Agent 文件，再进入 `renderPrompt()` | 主服务也通过 agent 内容进入消息构造与渲染链 | 已对齐 | 低 | 两侧都以同一份 agent 模板为源头，源数据一致。 |
| 变量替换核心引擎 | 调用 `messageProcessor.replaceAgentVariables()` | 调用 `messageProcessor.replaceAgentVariables()` | 已对齐 | 低 | 两侧使用同一个变量替换实现，`Tar*` / `Var*` / 插件占位符解析语义同源。 |
| 变量展开轮次 | 最多执行 3 轮变量展开 | 通常对单条消息执行 1 轮变量替换 | 未对齐 | 中 | `agentRegistryService` 更激进，能继续展开二级/三级占位符；主服务主链通常只跑一轮。 |
| `TarSysPrompt` 二级展开 | 通过多轮变量展开完成 | 取决于主链一次替换后是否还有残留变量 | 未对齐 | 中 | 当前共享 render 对嵌套变量的收口能力强于主服务默认单轮替换。 |
| RAG/TagMemo/元思考处理入口 | 直接调用 `RAGDiaryPlugin.processMessages()` | 通过主服务 message preprocessor 链执行 `RAGDiaryPlugin` | 已对齐 | 低 | 两侧最终调用的是同源的 RAGDiaryPlugin 逻辑。 |
| RAG 执行输入形态 | 构造一组以渲染后 system prompt 为核心的消息数组 | 使用真实会话消息数组 | 未对齐 | 中 | 两侧都能触发 RAG，但输入消息上下文形态不同。 |
| fallback user query | 若没有用户上下文，会合成一条 fallback user query 供 RAG 使用 | 不会为了 render 人工合成 fallback user query | 未对齐 | 中 | 共享 render 为了生成可注入 prompt 引入了合成查询，这不是主服务自然会话语义。 |
| 记忆召回是否能真实触发 | 能，且会在 `renderedPrompt` 中落地 | 能，且在主服务会话链路中落地 | 已对齐 | 低 | TagMemo / diary recall 能力本身对齐。 |
| 元思考块是否能真实触发 | 能，且会在 `renderedPrompt` 中落地 | 能，且在主服务会话链路中落地 | 已对齐 | 低 | `[[VCP元思考...]]` 已通过同源插件逻辑被消费。 |
| 完整 message preprocessor pipeline | 仅显式接入 `RAGDiaryPlugin` | 会跑主服务的完整 preprocess 过程 | 未对齐 | 高 | 共享 render 目前不是完整会话预处理镜像，可能缺失其它插件或通用预处理副作用。 |
| `VCPTavern` / 其它预处理器副作用 | 未显式执行 | 主服务链中会参与 | 未对齐 | 中 | 如果未来其它 preprocessors 影响 system prompt，两侧可能继续漂移。 |
| 多媒体/附件相关预处理 | 不处理 | 主服务会在完整消息链中处理 | 未对齐 | 低 | 对纯文本 agent prompt 影响较小，但严格来说不一致。 |
| legacy 多行 `{{...}}` unwrap 清理 | 有 `unwrapMultilineBracePayloads()` 兼容层 | 主服务主链没有这一步 | 未对齐 | 中 | 共享 render 为历史天气/静态块残留做了额外修正，主服务未显式具备相同步骤。 |
| unresolved 检测与 warnings | 会输出 `unresolved`、`warnings`、`renderMeta` | 主服务入模前不以同样结构暴露 | 未对齐 | 低 | 这是共享 render 的附加观测能力，不是语义偏差。 |
| 输出目标 | 产出单份“可注入的最终 prompt” | 产出完整待入模消息数组 | 未对齐 | 中 | 设计目标不同，导致流程不可能完全同构。 |
| diary recall 是否依赖真实会话上下文 | 部分依赖；无上下文时使用 fallback query | 依赖真实会话消息 | 未对齐 | 中 | 某些召回结果可能因 query 来源不同而有差异。 |
| 使用同一插件管理器能力注册 | 是 | 是 | 已对齐 | 低 | 工具描述、placeholder 来源、插件能力注册是共享的。 |

## 关键证据

- 共享 render 入口：`modules/agentGateway/services/agentRegistryService.js`
- 主服务消息渲染入口：`modules/chatCompletionHandler.js`
- 共享变量替换实现：`modules/messageProcessor.js`
- 主服务 RAG/TagMemo/元思考来源：`Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js`
- 主服务 message preprocessor 调度：`Plugin.js`

## 结论判定

### 已对齐的部分

- Agent 模板源头一致
- 变量替换核心引擎一致
- RAG/TagMemo/元思考底层插件一致
- diary recall 与元思考能力都能在两侧真实触发

### 未对齐的部分

- 变量展开轮次
- `TarSysPrompt` 的嵌套展开策略
- 是否注入 fallback user query
- 是否执行完整 message preprocessor pipeline
- 是否执行 legacy brace unwrap 兼容清理
- render 输出目标不同：单 prompt vs 完整消息数组

## 风险判断

- **高风险**
  - 完整 message preprocessor pipeline 未对齐
- **中风险**
  - 多轮变量展开与主服务单轮展开存在差异
  - fallback user query 可能改变 RAG 检索结果
  - legacy brace unwrap 为共享 render 专有逻辑
- **低风险**
  - 源模板读取方式、核心变量解析器、RAG 插件来源本身已经一致

## 建议

如果目标是“让 MCP `prompts/get` 提供一份足够可靠、可直接注入的最终 prompt”，当前实现已经够接近主服务。

如果目标是“严格与 VCP 主服务入模前渲染字节级一致”，建议下一步：

1. 抽出一条共享的 canonical prompt renderer
2. 让 `chatCompletionHandler` 与 `agentRegistryService` 共用同一入口
3. 将完整 message preprocessor pipeline 受控纳入 shared render，而不是仅单独接 `RAGDiaryPlugin`
