# M3.S1 guidance / skill 行为描述审计（差异清单）

> 日期：2026-10-09 | 依据：设计方案 §2.3、§3.3.1（T2：审计 guidance/skill 中「最多 N 条」类行为描述，失真处标记，M4.S4 重导出生效）

## 审计范围与方法

- `modules/agentGateway/config/agent_guidance.json`（guidance 配置单源，skill 包由 skillGeneratorService 据此渲染）
- 预生成 skill 包：`modules/agentGateway/skills/MCPFuPeng/`、`modules/agentGateway/skills/MCPMidas/`、`modules/agentGateway/skills/midas-vcp/`

检索模式：对全部 JSON 值与 SKILL.md / INSTALL.md / manifest.json 文本做正则与关键词扫描（`最多`、`至少`、`条结果`、`条记忆`、`前 N 条`、`top-k`、`k=`、`默认 k`、`上限`、`截断`、`20 条`、`5 条` 及数字型召回量表述）。

## 结论：零失真项（差异清单为空）

guidance 与三个预生成 skill 包中**不存在任何召回数量/预算类的行为数字描述**（无「最多 N 条」「默认 k=N」「上限 N」等表述）。工具使用说明只描述语义（检索记忆/组装上下文），不承诺具体取数规模。因此 M3.S1 的预算变更（默认 k 5→8、上限 20→50）对 skill 导出面**无需任何文本同步**；M4.S4 重导出时仅需同步新增的 `gateway_knowledge_search` 工具说明。

## 备注

- 该结论基于 2026-10-09 的快照；若后续 guidance 增补了数量表述，重导出前应重新审计。
- rag_params.json 的 `riverMemo.enabled` 为死键（设计 R4），不作为行为描述依据。
