# CreativeWritingAssistant 插件

CreativeWritingAssistant 用于阶段化小说创作辅助，当前保持以下四项核心能力：

1. `CountChapterLength`：章节字数统计与阈值达标判断（支持 `range` 与 `min_only` 策略）  
2. `RequestExternalReview`：通过 AgentAssistant 联动外部审查 Agent，输出审查与修订建议  
3. `RequestChapterDraft`：通过 AgentAssistant 联动外部创作 Agent，生成章节草稿与自检内容  
4. `EditChapterContent`：针对问题段落执行定向修订，避免整章重写

## 重构后架构

入口仍为 `CreativeWritingAssistant.js`，插件协议与命令名保持不变。内部拆分为以下职责层：

- 输入层：`parseRequest`、`processInputData` 负责解析 stdin 输入与统一错误输出  
- 调度层：`executeCommand` 负责命令路由  
- 统计层：`buildCountChapterLengthResult` 负责文本统计与达标判断  
- Agent 协作层：`runAgentRequest` 统一外部 Agent 请求流程（包含 dryRun、超时、默认 Agent 回退）  
- 传输层：`callHumanToolApi` 负责调用 `/v1/human/tool`

重构后的内部实现增加了更强的参数归一化与错误边界处理，同时通过减少重复扫描和中间集合构造，降低内存占用并优化处理时延。

## 配置

在 `config.env` 中可选配置：

```env
DEFAULT_REVIEW_AGENT=NovelStage4ExternalReviewAgent
REVIEW_AGENT_LIST=NovelStage4ExternalReviewAgent,小雨
DEFAULT_DRAFT_AGENT=NovelStage4ChapterCreationAgent
DRAFT_AGENT_LIST=NovelStage4ChapterCreationAgent,长篇叙事总编
DEFAULT_EDIT_AGENT=NovelStage4ChapterRevisionAgent
EDIT_AGENT_LIST=NovelStage4ChapterRevisionAgent,章节修订总编
```

`RequestExternalReview` 未传 `agentName` 时，优先取 `REVIEW_AGENT_LIST` 第一项，若为空则取 `DEFAULT_REVIEW_AGENT`，最终默认值为 `NovelStage4ExternalReviewAgent`。  
`RequestChapterDraft` 未传 `agentName` 时，优先取 `DRAFT_AGENT_LIST` 第一项，若为空则取 `DEFAULT_DRAFT_AGENT`，最终默认值为 `NovelStage4ChapterCreationAgent`。  
`EditChapterContent` 未传 `agentName` 时，优先取 `EDIT_AGENT_LIST` 第一项，若为空则取 `DEFAULT_EDIT_AGENT`，最终默认值为 `NovelStage4ChapterRevisionAgent`。

## 超时机制

本插件存在两层超时控制：

1. 插件外层执行超时：由 `plugin-manifest.json` 的 `communication.timeout` 控制。  
2. 命令内层 API 超时：由 `RequestChapterDraft`/`RequestExternalReview`/`EditChapterContent` 的 `timeoutMs` 控制，并传入 `/v1/human/tool` 请求。

若只把命令参数 `timeoutMs` 提高到 600000，但外层 `communication.timeout` 仍较小，插件仍会被宿主提前终止。  
当前版本已将 `communication.timeout` 提升为 `660000`，可覆盖 600 秒请求并预留传输与收尾时间。

## 使用示例

对于 `CountChapterLength`、`RequestExternalReview`、`EditChapterContent`，`text` 必须提供完整章节正文全文，禁止仅传标题或摘要（例如“【二次修订后章节正文·第 1 章 钥匙】（3781 字）”这类非正文文本）。

阶段4字数策略建议对 `CountChapterLength` 传 `targetMin=2500`、`targetMax=3500`、`lengthPolicy=min_only`：仅当低于 `targetMin` 时触发回炉，高于 `targetMax` 不触发回炉，且必须满足最低 2500 字要求。

### RequestExternalReview

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」CreativeWritingAssistant「末」,
command:「始」RequestExternalReview「末」,
text:「始」这里放章节全文正文……「末」,
agentName:「始」NovelStage4ExternalReviewAgent「末」,
reviewFocus:「始」重点检查节奏断点与人设OOC风险「末」
<<<[END_TOOL_REQUEST]>>>
```

### RequestChapterDraft

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」CreativeWritingAssistant「末」,
command:「始」RequestChapterDraft「末」,
text:「始」这里放章节创作上下文（锁死项摘要+本章大纲+局部限定内容+上一章结尾）……「末」,
agentName:「始」NovelStage4ChapterCreationAgent「末」,
targetLength:「始」2500-3500字「末」,
draftingFocus:「始」重点强化冲突升级与结尾钩子「末」
<<<[END_TOOL_REQUEST]>>>
```

### EditChapterContent

```text
<<<[TOOL_REQUEST]>>>
tool_name:「始」CreativeWritingAssistant「末」,
command:「始」EditChapterContent「末」,
text:「始」这里放待修订章节全文正文……「末」,
editInstructions:「始」优先修复逻辑断裂与人物OOC，保持主线与关键伏笔不变「末」,
editTargets:「始」2,5,7「末」,
issues:「始」人物A动机不成立；第三幕转折突兀「末」,
mustKeep:「始」主线事件节点不可改写；关键伏笔“黑匣子编号”必须保留「末」,
maxRewriteRatio:「始」0.35「末」
<<<[END_TOOL_REQUEST]>>>
```

## 单元测试

插件新增了可直接运行的单元测试文件：

- `CreativeWritingAssistant.test.js`

执行方式：

```bash
node --test Plugin/CreativeWritingAssistant/CreativeWritingAssistant.test.js
```

覆盖范围包括：

- 字数统计达标判定与参数校验
- `RequestChapterDraft` 与 `RequestExternalReview` 的兼容输出结构
- `EditChapterContent` 参数校验与返回结构
- dryRun 与依赖注入调用路径
- 非法 JSON 与未知命令的错误路径

## 回归验证建议

在现有系统中回归验证时，建议按以下顺序：

1. 用历史调用模板分别触发四个命令，确认输出字段与旧版本兼容  
2. 对 `RequestChapterDraft` / `RequestExternalReview` / `EditChapterContent` 先执行 `dryRun=true`，验证 payload 结构  
3. 在有 `Key` 与本地 `/v1/human/tool` 环境下执行真实联调  
4. 确认阶段4 Agent 编排链路（草稿→字数检查→外部审查→定向修订→复检）结果正常
