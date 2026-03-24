# VCPCommunity Wiki → 日记目录映射同步方案

## 1. 目标

在 `VCPCommunity` 插件中增加“Wiki 子路径到 VCP 日记目录”的映射能力。  
当检测到映射关系且 Wiki 文档发生变更（新建或更新）时，自动同步写入对应日记目录，保证社区知识与日记知识库一致。

示例映射：

- `data/VCPCommunity/wiki/jue-ji-xian-tu/00_requirements`  
  → `dailynote/小说创作需求`

## 2. 现状与切入点

当前 Wiki 写入统一经过 `WikiManager.updateWiki`，包括两条路径：

1. 直接 `UpdateWiki` 命令调用。
2. 提案通过后由 `ProposalManager.reviewProposal/proposeUpdate` 调用 `wikiManager.updateWiki(...)` 完成合并。

因此，只要在 `WikiManager.updateWiki` 成功落盘后追加同步逻辑，即可覆盖“新建 + 更新 + 提案合并更新”全场景。

## 3. 设计原则

1. **非侵入**：保留现有 Wiki 权限、版本备份、提案流程不变。
2. **映射显式配置**：使用独立配置文件声明映射，不写死在代码里。
3. **最佳努力同步**：Wiki 主流程成功优先；同步失败不影响 Wiki 更新成功，但需记录错误。
4. **幂等覆盖**：同一 Wiki 页面重复更新时，目标文件直接覆盖写入。
5. **路径安全**：严格校验映射路径，阻止目录穿越。

## 4. 配置模型

新增配置文件：

- `data/VCPCommunity/config/wiki_dailynote_mappings.json`

建议结构：

```json
{
  "enabled": true,
  "mappings": [
    {
      "community_id": "jue-ji-xian-tu",
      "wiki_prefix": "00_requirements",
      "dailynote_dir": "小说创作需求"
    }
  ]
}
```

字段语义：

- `enabled`: 总开关。
- `community_id`: 社区 ID，精确匹配。
- `wiki_prefix`: Wiki 子目录前缀（标准化后匹配，支持多级目录）。
- `dailynote_dir`: 相对 `PROJECT_BASE_PATH/dailynote` 的目标目录。

匹配规则：

1. `community_id` 必须一致。
2. `normalizedPageName` 必须满足：
   - 等于 `wiki_prefix` 对应页面；
   - 或以 `wiki_prefix/` 开头。
3. 命中后将“前缀后的剩余路径”转换为**扁平文件名**写入 `dailynote_dir`，不再创建多级子目录。
4. `dailynote` 目录下最多只存在一层业务文件夹（即 `dailynote_dir`）。

路径映射示例：

- Wiki 页面：`00_requirements/story/outline.md`
- 命中前缀：`00_requirements`
- 相对剩余：`story/outline.md`
- 扁平文件名：`story_outline.md`
- 输出文件：`dailynote/小说创作需求/story_outline.md`

## 5. 实现改造点

### 5.1 常量与配置加载

在 `lib/constants.js` 增加：

- `DAILYNOTE_DIR = path.join(PROJECT_BASE_PATH, 'dailynote')`
- `WIKI_DAILYNOTE_MAPPINGS_FILE = path.join(CONFIG_DIR, 'wiki_dailynote_mappings.json')`

在 `communityManager.initStorage()` 中补充：

- 若不存在映射配置文件，初始化为默认空配置：
  - `{ "enabled": false, "mappings": [] }`

### 5.2 新增同步管理器（必选）

新增 `lib/managers/wikiDailynoteSyncManager.js`：

核心职责：

1. 读取并缓存映射配置。
2. 校验映射项合法性（社区、路径、目录安全）。
3. 计算目标日记文件路径。
4. 执行目录创建与文件写入。
5. 返回结构化同步结果（成功/跳过/失败原因）。

建议接口：

- `syncWikiPage({ communityId, pageName, content, agentName, editSummary, updatedAt })`

返回：

```json
{
  "status": "synced|skipped|failed",
  "target_path": "....md",
  "reason": "..."
}
```

### 5.3 接入 Wiki 更新流程（统一使用独立管理器）

在 `WikiManager.updateWiki` 的主文件写入成功后，调用同步管理器：

1. 传入 `community_id`、`normalizedPageName`、`fullContent`。
2. 只捕获同步异常，不中断主流程。
3. 将同步结果打印到 `console.warn/console.log`（便于排障）。
4. 若 `dailynote` 或目标 `dailynote_dir` 不存在，自动创建。

实现约束：

1. 不在 `WikiManager` 内内联路径匹配与文件同步细节。
2. 所有映射解析、目标路径计算、目录创建、落盘写入、错误归类均在 `wikiDailynoteSyncManager` 中实现。
3. `WikiManager` 仅负责在写 Wiki 成功后调用同步管理器并处理返回结果。

## 6. 关键细节

1. **内容一致性**
   - 建议同步 `fullContent`（含 `Last updated` 尾注），确保 Wiki 与日记内容完全一致。
2. **文件扩展名**
   - 延续 Wiki 现状，统一使用 `.md`。
3. **字符与路径处理**
   - 对 `wiki_prefix`、`dailynote_dir` 做标准化；
   - 禁止绝对路径与 `..` 路径跳转。
   - 将相对剩余路径按规则扁平化：目录分隔符 `/` 替换为 `_`。
4. **并发写入**
   - Node 异步写文件天然可并发；同文件竞争按“最后一次写入生效”处理即可。

## 7. 测试方案

在 `Plugin/VCPCommunity/test/unit` 增加映射同步相关单测，覆盖：

1. **命中映射并新建文件**
   - 更新 `00_requirements/a.md` 后，生成 `dailynote/小说创作需求/a.md`。
2. **命中映射并覆盖更新**
   - 二次更新同一页面后，目标文件内容被覆盖为最新内容。
3. **路径扁平化**
   - 更新 `00_requirements/story/outline.md` 后，生成 `dailynote/小说创作需求/story_outline.md`。
4. **目录自动创建**
   - 目标 `dailynote` 与 `dailynote/小说创作需求` 不存在时，自动创建并写入文件。
5. **未命中映射**
   - 只更新 Wiki，不产生日记文件。
6. **映射开关关闭**
   - `enabled=false` 时跳过同步。
7. **非法映射路径拦截**
   - 含 `../` 或绝对路径时拒绝写入并记录失败原因。
8. **提案合并路径覆盖**
   - 通过 `ReviewProposal` 合并后同样触发同步（验证从 `updateWiki` 统一入口生效）。

## 8. 回滚与兼容

1. 默认 `enabled=false`，上线后可灰度开启。
2. 关闭开关即可即时停用，无需改代码。
3. 该方案仅增加旁路同步能力，不改变现有命令入参与返回结构，对现有 Agent 调用兼容。

## 9. 建议迭代顺序

1. 先实现配置读取与路径计算。
2. 接入 `WikiManager.updateWiki` 并完成单测。
3. 在测试沙箱验证提案合并链路触发。
4. 通过后再在真实社区配置映射并灰度开启。
