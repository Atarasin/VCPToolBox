# 微信公众号 AI 自动发布工作流设计文档

> **版本**: v1.0  
> **创建时间**: 2026-03-15  
> **设计者**: 阿里阿德涅  
> **状态**: 已确认

---

## 📋 需求概览

| 维度 | 需求 |
|------|------|
| **内容领域** | AI 前沿开源项目 |
| **时效要求** | ≤ 24 小时 |
| **来源要求** | 必须有引用来源 |
| **预算** | 免费 |
| **内容渠道** | GitHub |
| **触发方式** | 定时调度 + 手动触发 |
| **审核要求** | 发布前必须人工审核 |

---

## 🔄 完整工作流

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ 定时触发 │ -> │ 语料抓取 │ -> │ 内容生成 │ -> │ 人工审核 │ -> │  格式化  │ -> │  发布   │ -> │  归档   │
│GitHub API│    │筛选/去重 │    │ AI 前言 │    │通过/驳回 │    │套用模板 │    │微信推送 │    │日志记录 │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
                                                              │
                     ┌────────────────────────────────────────┼────────────────────────────────────────┐
                     │                                        │                                        │
                     ▼                                        ▼                                        ▼
              ┌─────────────┐                          ┌─────────────┐                          ┌─────────────┐
              │ 审核通过    │                          │ 编辑后发布  │                          │ 审核驳回    │
              │  直接发布   │                          │ 人工编辑    │                          │ 重新生成    │
              └─────────────┘                          └─────────────┘                          └─────────────┘
```

---

## 📊 各阶段详细设计

### 阶段 1：定时触发 & 语料抓取

**触发时间**: 08:00 / 14:00 / 20:00（每日三次）

**数据源**: GitHub（通过 `gh` 命令抓取语料）

**筛选规则**:
- Topic: `ai`, `machine-learning`, `llm`, `transformers`
- 语言: `Python`, `TypeScript`, `Jupyter Notebook`
- Stars: 新项目 >50，成熟项目 >500
- 时间: created/pushed 在 24h 内

**去重策略**: 基于 `full_name`，同一项目 7 天内不重复收录

**`gh` 抓取示例**:
```
# 过去 24 小时内创建的 AI 项目（Stars > 50）
gh search repos "topic:ai OR topic:machine-learning OR topic:llm created:>2026-03-14 stars:>50" \
  --sort stars --order desc --limit 50 --json name,description,url,stargazerCount,pushedAt

# 过去 24 小时内有更新的热门 AI 项目
gh search repos "topic:ai pushed:>2026-03-14 stars:>500" \
  --sort updated --order desc --limit 50 --json name,description,url,stargazerCount,pushedAt
```

---

### 阶段 2：内容生成

**输入**: 项目名称、描述、README 摘要、Stars/Forks 数据

**输出**: 300-500 字前言内容，包含项目亮点、应用场景、推荐理由

**风格**: 专业但易懂，适合公众号读者

**引用格式**: 自动附加 GitHub 项目链接和作者信息

**失败策略**: 最多重试 3 次，记录失败原因

---

### 阶段 3：人工审核（关键环节）

**审核入口**: 调用飞书插件 `/home/zh/projects/VCP/VCPToolBox/Plugin/FeishuBridge` 推送审核消息

**三种操作**:
- ✓ **通过并发布**: 直接进入发布流程
- ✏️ **编辑后发布**: 人工修改内容后发布
- ✗ **驳回重写**: 退回重新生成或放弃

**审核留痕**: 记录审核人、时间、决策、修改内容

**超时提醒**: 待审核内容超过 4 小时未处理，发送提醒

---

### 阶段 4：格式化 & 发布

**格式化**: 套用公众号模板，添加标题、摘要、时间戳、签名

**发布目标**: 微信公众号服务号（需申请开发者资质）

**发布类型**: 
- 模板消息（需用户订阅）
- 群发消息（每月 4 条限制）

**失败策略**: API 调用失败自动重试，超过 3 次记录错误并通知

---

### 阶段 5：归档 & 日志

**存储内容**: 原始语料、生成内容、审核记录、发布结果

**存储格式**: JSON + Markdown 双份存储

**归档策略**: 按日期分目录，保留 90 天

**日志级别**: 
- INFO: 正常流程
- WARN: 重试/驳回
- ERROR: 失败

---

## 📦 核心数据结构

### 工作流任务对象

```json
{
  "task_id": "task_20260315_001",
  "created_at": "2026-03-15T08:00:00Z",
  
  "source": {
    "type": "github",
    "project_name": "anthropics/openclaw",
    "url": "https://github.com/anthropics/openclaw",
    "stars": 2847,
    "forks": 156,
    "description": "AI-powered CLI tool...",
    "fetched_at": "2026-03-15T08:05:00Z"
  },
  
  "generated_content": {
    "title": "OpenClaw：AI 驱动的命令行工具新星",
    "body": "在人工智能快速发展的今天...",
    "word_count": 486,
    "generated_at": "2026-03-15T08:10:00Z"
  },
  
  "review": {
    "status": "approved",
    "decision": "approve",
    "reviewer": "用户",
    "reviewed_at": "2026-03-15T09:00:00Z",
    "comment": "内容很好"
  },
  
  "publish": {
    "status": "published",
    "message_id": "msg_xxx",
    "published_at": "2026-03-15T09:30:00Z"
  },
  
  "status": "published",
  "status_history": []
}
```

---

## ⚙️ 配置参数

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `schedule.cron` | `0 8,14,20 * * *` | 每日 8:00、14:00、20:00 执行 |
| `github.stars_threshold.new` | `50` | 新项目最低 Stars |
| `github.stars_threshold.mature` | `500` | 成熟项目最低 Stars |
| `github.topics` | `["ai", "machine-learning", "llm"]` | 筛选的 Topic 列表 |
| `content.max_length` | `500` | 生成内容最大字数 |
| `content.style` | `professional` | 内容风格 |
| `review.timeout_hours` | `4` | 审核超时提醒（小时） |
| `storage.retention_days` | `90` | 数据保留天数 |

---

## 🏗️ 技术架构

```
┌─────────────┬─────────────┬─────────────┬─────────────┐
│   触发层    │   数据层    │   处理层    │   输出层    │
├─────────────┼─────────────┼─────────────┼─────────────┤
│ 定时调度器  │ GitHub API  │AgentAssistant│    MCPO     │
│ (需开发)    │  语料抓取   │ AI 内容生成 │  API 桥接   │
├─────────────┼─────────────┼─────────────┼─────────────┤
│  手动触发   │ServerFile   │  审核模块   │  微信 API   │
│ VChat 命令  │  本地存储   │  (待开发)   │  消息推送   │
└─────────────┴─────────────┴─────────────┴─────────────┘
```

---

## 🛤️ 开发里程碑

1. ✅ **需求分析 & 工作流设计** - 已完成
2. 🔄 **插件骨架开发** - 进行中
3. ⏳ **GitHub 抓取模块** - 待开始
4. ⏳ **内容生成模块** - 待开始
5. ⏳ **审核模块** - 待开始
6. ⏳ **发布模块** - 待开始
7. ⏳ **定时调度 & 测试** - 待开始

---

## 📁 插件目录结构

```
Plugin/WeChatPublisher/
├── plugin-manifest.json    # 插件清单
├── index.js                # 主入口文件
├── config.env              # 配置模板
├── DESIGN.md               # 设计文档（本文件）
├── modules/
│   ├── github-fetcher.js   # GitHub 抓取模块
│   ├── content-generator.js# 内容生成模块
│   ├── reviewer.js         # 审核模块
│   ├── publisher.js        # 发布模块
│   └── scheduler.js        # 调度模块
├── templates/
│   ├── preface.md          # 前言模板
│   └── output.md           # 输出格式模板
└── data/
    ├── output/             # 生成内容
    └── logs/               # 执行日志
```

---

## 📝 更新日志

### v1.0 (2026-03-15)
- 初始设计文档
- 确定工作流架构
- 定义数据结构和配置参数
