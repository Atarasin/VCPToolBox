# Agent 上线实操手册：以付鹏（MCPFuPeng）为例

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 授权模型见 [01](01-identity-authorization.md)、配置模型见 [02](02-config-data-model.md)、transport 见 [03](03-transport-surfaces.md)
> 日期：2026-08-03 ｜ 落地 commit：`17503481`
> 定位：**实操手册 + 踩坑记录**，不是规范。规范以编号文件为准；本文只记录「把一个新 agent 从零接到 Gateway 对外服务」的真实完整路径与沿途踩到的坑。

## 适用场景

你有一个 VCP 原生 agent（或一份人设/知识资产），想让外部 AI 宿主（Claude Code、Codex、Kimi 等）通过 MCP 使用它，并且只能使用它。本文按付鹏金融顾问 agent 的真实上线过程组织，每一步都给出可复制的命令与验证方式。

不适用：仅在 VCP 内部使用的 agent（不需要凭据与 MCP 变体，配好 `agent_map.json` 即可）。

## 零、先想清楚的两个设计问题

### Q1：要不要单独做一个 MCP 变体 agent？

**要。** 付鹏最终是两个文件、两个别名：

| 别名 | 文件 | 面向 |
|---|---|---|
| `FuPeng` | `Agent/quant/FuPeng.txt` | VCP 内部（VChat 等自有前端） |
| `MCPFuPeng` | `Agent/quant/FuPeng-MCP.txt` | 外部 MCP 宿主 |

原因是两者的工具语义完全不同：内部版用 `{{VCPSearchToolBox}}`、VCP 日记占位符和 `maid:「始」…「末」` 署名规范；外部版没有这些——它要告诉宿主用**自己的**联网工具做研究，用 `gateway_memory_write` 而不是日记署名写记忆，用 `prompts/get` + `gateway_agent_render` 同步规范。把内部版直接暴露出去，外部模型会照着不存在的工具语义行事。

先例是 `Midas` / `MCPMidas`，同样的拆分。命名沿用 `MCP` 前缀。

### Q2：知识资产放日记本还是冷知识库？

**静态语料放 `knowledge/`（TDB 冷知识库），会生长的记忆放 `dailynote/`。**

付鹏的 156 个来源调研语料一开始放进了日记本，随后迁移到冷知识库。迁移理由：

- 语料是一次成型的只读资料，日记本的时间戳只能伪造，`::Time` 时间感知检索对全同日期的语料是纯噪声
- 日记本对 agent 可写，语料库被运行时写脏是真实风险；`knowledge/` 对 agent 天然只读
- TDB 占位符支持 `::Rerank` / `::Rerank+` / `::Truncate` / `::Expand`
- 更新路径更干净：丢一个 md 进目录，chokidar 自动增删索引，不需要跑导入脚本

最终布局：

```
knowledge/付鹏观点库/      48 个章节级 md（只读语料，注意 knowledge/* 在 .gitignore 内）
dailynote/付鹏/            对话记忆
dailynote/付鹏市场判断/     判断存档与复盘
```

> ⚠️ **TDB 分块粒度陷阱**：TDB 用全局 `TextChunker`，chunk 上限 = `WhitelistEmbeddingModelMaxToken × 0.85`（默认约 6800 token ≈ 10KB 中文），且**不可为单个库调小**（全局配置，改了要重嵌入全部库）。整份 18KB 的调研文档只会切成 2 块，配合 `::Expand` 每轮注入十万字级全文。做法：入库前按章节切成 1–3KB 的小文件，一文件一 chunk，检索粒度即章节（日志确认 `(1/1 chunks)`）。小文件下 `::Expand` 失去意义，改用 `:6::Rerank`。

## 一、写 MCP 变体 agent 文件

`Agent/quant/FuPeng-MCP.txt` 的骨架（顺序有讲究）：

1. **首要原则 + 规范获取优先级**：告诉宿主在新会话首次实质响应前、话题切换时，用 `prompts/get` → `gateway_agent_render` 同步规范，并附最近消息作为渲染上下文——Gateway 会按当前问题从冷知识库检索相关片段注入返回的提示词。绑定凭据下无需传 `arguments.agentId`（§5.4：以绑定身份为 target）；显式传 `MCPFuPeng` 也可，与绑定一致即接受。
2. **记忆与语料占位符**：`[[付鹏观点库知识库:6::Rerank]]`、`[[付鹏日记本::Time::TagMemo+]]`、`[[付鹏市场判断日记本::Time::TagMemo+]]`。渲染时由 RAGDiaryPlugin 填充。
3. **Memory 语义**：写哪个 diary、什么该写什么不该写。与 `mcp_agent_memory_policy.json` 的 `allowedDiaries` 必须一致。
4. **角色主体**：人设、工作流、表达规则、诚实边界。
5. **冲突优先级**：用户当前任务 > 宿主系统规则 > MCP 同步到的 guidance > 本提示词默认设定。

注册进 `agent_map.json`（热加载，无需重启）：

```json
{
  "FuPeng": "quant/FuPeng.txt",
  "MCPFuPeng": "quant/FuPeng-MCP.txt"
}
```

## 二、配三份 Gateway 策略文件

三份都在 `modules/agentGateway/config/`，均为热加载（§4.3）。三处的 agent key 必须与 `agent_map.json` 的别名逐字一致，否则启动交叉校验会把该 agent 记为 `unknownAgents`。

**`mcp_agent_memory_policy.json`** — 该 agent 能写哪些日记本（授权面，不是建议）：

```json
"MCPFuPeng": {
  "maid": "付鹏",
  "allowedDiaries": ["付鹏日记本", "付鹏市场判断日记本"],
  "defaultDiaries": ["付鹏日记本"]
}
```

**`recall_profiles.json`** — `gateway_recall_run` 的召回档案：

```json
"MCPFuPeng": {
  "defaultProfile": "FuPeng-default",
  "allowedProfiles": ["FuPeng-default"],
  "targets": ["付鹏日记本", "付鹏市场判断日记本"]
}
```

外加 `profiles.FuPeng-default`（`minScore` + `rules[].modifiers`，可直接抄 `Midas-default` 改 diaries）。

**`agent_guidance.json`** — 显示名、记忆默认标签，以及**可选的 per-agent workflow 覆盖**：

```json
"MCPFuPeng": {
  "displayName": "付鹏",
  "memoryDefaults": { "tags": ["付鹏", "宏观"], "metadata": { "project": "fupeng-advisor", "source": "external-mcp" } },
  "workflow": ["回答任何宏观、资产或行业问题前，先调用 gateway_recall_run …", "…"]
}
```

> `workflow` 覆盖是本次新增的能力（`17503481`）。缺省时回落 `shared.workflow`；显式给空数组是配置错误（意图不明确，应删字段）。`memoryWritePolicy` **不**支持按 agent 覆盖——写入红线是全局单源，不按 agent 放宽。
>
> 为什么需要它：`shared.workflow` 是给编码类 agent 写的（"bug 根因"、"仓库上下文"、"git 可查修改"），下发给金融顾问口径不对。而 workflow 会进 `initialize.instructions`，是宿主**自动**拿到的那一份，比写在 prompt 文件里更强。

## 三、铸造绑定凭据

凭据文件属于机密，放在 gitignore 覆盖的 `data/agent_gateway/` 下，不要放 `modules/agentGateway/config/`（在版本库内）。

CLI **不会**自动创建 pepper keyring，先手工生成一把 256-bit 密钥：

```bash
python3 -c "
import json, os, base64
json.dump({'keys': {'credential-pepper-2026-08': base64.b64encode(os.urandom(32)).decode()}},
          open('data/agent_gateway/agent_gateway_credential_peppers.json','w'), indent=2)"
chmod 600 data/agent_gateway/agent_gateway_credential_peppers.json
```

再铸造绑定该 agent 的凭据：

```bash
node scripts/agent-gateway-credential-cli.js create \
  --credentials data/agent_gateway/agent_gateway_credentials.json \
  --peppers     data/agent_gateway/agent_gateway_credential_peppers.json \
  --credential-id fupeng-ext-2026-08 \
  --bound-agent   MCPFuPeng \
  --scopes gateway:read,gateway:execute \
  --expires-at 2027-02-01T00:00:00.000Z \
  --kid credential-pepper-2026-08
```

输出的 token **只出现这一次**，立刻存进密钥库（本次落在 `data/agent_gateway/fupeng-ext-2026-08.token.txt`，600 权限）。文件里只留 HMAC digest，无法反推。

`scopes` 取最小集：对外只读+执行，**不要**给 `admin`——`admin` 只允许出现在未绑定凭据上（§3.2 配置校验强制）。

最后在 `config.env` 声明路径，**这两个变量是启动时读的，改完必须重启**：

```ini
AGENT_GATEWAY_CREDENTIALS_PATH=/abs/path/data/agent_gateway/agent_gateway_credentials.json
AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH=/abs/path/data/agent_gateway/agent_gateway_credential_peppers.json
```

未配置时 `credentialResolver` 只打一行 `AGENT_GATEWAY_CREDENTIALS_PATH not set; using empty credential snapshot (migration phase A)` 就继续跑，legacy key 照常工作——**文件凭据静默不生效**，表现为新 token 一律 401。排查时先确认这行日志有没有出现。

## 四、验证（照抄即可）

`initialize` 拿 session，后续请求带 `Mcp-Session-Id`：

```bash
TOKEN=$(grep -oP 'token: \K\S+' data/agent_gateway/fupeng-ext-2026-08.token.txt | tr -d '\r')
BASE=http://<host>:6005/mcp
curl -s --noproxy '*' -D /tmp/h.txt \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" -X POST "$BASE" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
SID=$(grep -i "mcp-session" /tmp/h.txt | awk '{print $2}' | tr -d '\r')
```

必须跑通的六项（本次实测结果）：

| # | 检查 | 方式 | 实测 |
|---|---|---|---|
| 1 | 绑定身份被识别 | `initialize` 返回的 `instructions` | 含 `as agent "MCPFuPeng" (付鹏)` 与 per-agent workflow |
| 2 | 语料检索生效 | `prompts/get` `gateway_agent_render`，`arguments.messages` 传消息对象数组 | 命中 6 条章节片段，最高相关性 70.3% |
| 3 | 召回档案生效 | `tools/call` `gateway_recall_run` | `profileName: FuPeng-default` |
| 4 | 跨 agent 被拒 | 同 token 渲染 `FuPeng` / `MCPMidas` | `AGW_FORBIDDEN` |
| 5 | 伪造 token 被拒 | `Authorization: Bearer bad` | 401 |
| 6 | 存量 legacy key 无回归 | legacy key 走 native REST / `/mcp` / skill 导出 | 全部 200 |

skill 导出（可选，给宿主一个冷启动入口）：

```bash
curl -s --noproxy '*' -H "Authorization: Bearer $TOKEN" \
  "http://<host>:6005/agent_gateway/agents/MCPFuPeng/integration/skill?format=claude"
```

`format` **必填**（`claude|codex|kimi`），漏了是 400 `AGW_INVALID_REQUEST`，不是 404。

## 五、外部方拿到的东西

```
MCP 端点：http://<host>:6005/mcp     （Streamable HTTP；WebSocket 同端点）
鉴权：    Authorization: Bearer <token>
Agent：   MCPFuPeng
```

`agentId` 在绑定凭据下可以省略——省略即以绑定身份为 target（§5.4：2026-08-03 起恢复绑定补全）；显式传也只有与绑定身份一致才被接受，不一致是 `AGW_FORBIDDEN`。对外宿主直接省掉即可。

**不拉 skill 也能工作**——告知链路有三层，前两层是协议自带、服务端按绑定 agent 逐请求渲染的：

1. `initialize.instructions`（主通道，握手即得，无需额外调用）：由 guidance bundle 渲染，含 workflow、写入红线、默认 diary、guidance resource URI。只有**绑定了 agent 且持 `gateway:read`** 的凭据才拿到 agent 专属文案，否则是通用文案、不泄露任何 agent 内容（§5.2）。
2. **工具描述**（兜底，永远在系统提示里）：`gateway_recall_run` 的 description 本身就写着 "Use this FIRST, before answering…"。
3. `vcp://agent-gateway/agents/MCPFuPeng/guidance` resource（支持 resources 的宿主）／ `gateway_agent_bootstrap`（仅 tools 的宿主）。

skill 是第四层可选薄产物：固化 endpoint 与触发说明，不含 secret，也不是能力来源。

## 六、踩坑记录（本次真实遇到并已修复）

### 6.1 `config.env` 是 CRLF —— shell 取值必须 `tr -d '\r'`

`LEGACY=$(grep -oP '^AGENT_GATEWAY_KEY=\K.*' config.env)` 取到的值尾部带 `\r`，curl 发出的请求头因此非法，Node 在最外层直接回 **400、空 body、无任何应用日志**，极难定位。所有从 `config.env` 取值的脚本都要 `| tr -d '\r'`。

### 6.2 外层 adminAuth 会 401 掉文件凭据（已修，`17503481`）

`server.js` 的 adminAuth 中间件对 `/agent_gateway/*` 原来是：呈现了凭据但**不等于 legacy key** → 直接 401 返回。文件凭据根本到不了 route 层的统一决议入口。已改为「呈现了凭据即放行给 `authInjection`」，由 `buildGatewayRequestContext()` 统一决议（§3.3 本就要求单一决议入口；WS 面早已如此）。无效 token 仍在该层 fail-closed 401。

### 6.3 TDB 冷知识库整库静默停用

`VectorStoreTDB/` 有数据但缺 `embedding-manifest.json` 时（老 store 升级到带 provenance 校验的新代码后必然发生），启动只打一行 `⛔ TDB_STORE_REBUILD_REQUIRED`，随后**整个冷知识库停用**，所有 `[[X知识库]]` 占位符被静默清空（日志 `TDB 冷知识库未启用，将清空占位符`）。同进程内新建索引照常工作，重启后才死，症状是「上午还好好的」。

修复：`VectorStoreTDB/` 是衍生数据（源在 `knowledge/`），清空后重启即自动写新 manifest 并按 `TDB_KNOWLEDGE_FULL_SCAN_ON_STARTUP=true` 全量重建。

### 6.4 批量写日记文件时 watcher 会漏

一次性写 48 个文件到新日记本目录，同秒内的 chokidar 批处理只索引到 32 个，且**不会自愈**。绕过：导入后 `touch` 目录下全部文件强制重触发，下一批次补齐（日志 `Diary date index cached … 48 file(s)`）。语料迁到 `knowledge/` 后此坑不再涉及，但给新 agent 播种日记本时仍会遇到。

### 6.5 契约测试与代码的历史漂移

`gateway_recall_run` 的契约测试断言 `required: ['query']`，与代码的 `['agentId','query']` 不符。考据结论：`f426ba04` 实现了 M3.S1（agentId optional），`4a65ab35`（2026-07-26）刻意推翻并改了 4 个测试文件，**漏了这一个**，且完全没动文档，造成约一周的「文档说 optional、代码是必填」漂移。本次已修正断言并同步四份文档（详见 [07-revision-history.md](07-revision-history.md) v6.1）。

教训：反转已交付 slice 时必须同步文档与全部契约测试，否则后人会把安全收紧当 bug 修掉。

## 七、新 agent 上线清单

```
[ ] Agent/<dir>/<Name>-MCP.txt          外部宿主版 prompt（gateway_* 工具语义 + RAG 占位符）
[ ] agent_map.json                      注册 MCP<Name> 别名（热加载）
[ ] knowledge/<库名>/                    静态语料，大文档先按章节切成 1–3KB 小文件
[ ] dailynote/<日记本>/                  记忆日记本，播种后 touch 一次
[ ] config/mcp_agent_memory_policy.json  allowedDiaries / defaultDiaries
[ ] config/recall_profiles.json          档案 + targets
[ ] config/agent_guidance.json           displayName / memoryDefaults /（可选）workflow 覆盖
[ ] data/agent_gateway/                  pepper keyring（手工建）+ 绑定凭据（CLI 铸造）
[ ] config.env                           两个 CREDENTIALS 路径变量 → 重启
[ ] 六项验证                              见 §四表格，含跨 agent 403 与 legacy key 回归
```

配置类改动（`agent_map.json`、三份 config、`knowledge/`、`dailynote/`）全部热加载；只有 `config.env` 的凭据路径需要重启。

## 相关文件

- 授权与凭据：[01-identity-authorization.md](01-identity-authorization.md) §3.2 决议规则、§3.3 凭据呈现、§4.4 credential 配置
- guidance bundle 与热加载：[02-config-data-model.md](02-config-data-model.md) §4.1–§4.3
- instructions / resource / bootstrap / `agentId` 语义：[03-transport-surfaces.md](03-transport-surfaces.md) §5.2–§5.4
- skill 生成与签名下载：[04-skill-generation.md](04-skill-generation.md)、[deployment-notes.md](deployment-notes.md)
