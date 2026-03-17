# Changelog

## v0.1.7 (2026-03-17)
- 修复阶段3偶发 502 导致整条工作流失败的问题：新增推送重试策略（默认 3 次，500ms 间隔）
- 增强阶段3容错：单条草稿推送失败时记录失败明细并继续处理后续草稿
- 新增阶段3重试配置项 `WECHAT_PUBLISHER_REVIEW_RETRY_TIMES`、`WECHAT_PUBLISHER_REVIEW_RETRY_DELAY_MS`
- 修正本地调用默认端口到 `6005`，避免未配置 `PORT` 时误打到 `8080` 造成 502

## v0.1.6 (2026-03-17)
- 升级阶段2文案生产链路：接入 AgentAssistant，通过内置 Agent 基于仓库语料动态生成文案
- 新增阶段2配置项 `WECHAT_PUBLISHER_DRAFT_AGENT_NAME`、`WECHAT_PUBLISHER_DRAFT_TIMEOUT_MS`、`WECHAT_PUBLISHER_DRAFT_RETRY_TIMES`
- 新增阶段2失败重试与回退策略：Agent失败时回退模板文案并记录生成来源
- 扩展 `GenerateDraft` 命令：改为走阶段2统一逻辑，支持动态Agent生成

## v0.1.5 (2026-03-17)
- 新增模板权重能力，抓取合并后按 `stars * 模板权重` 进行优先级排序
- 新增模板独立 limit 能力，支持通过模板默认值与配置覆盖分别控制每个模板抓取条数
- 新增 `WECHAT_PUBLISHER_TEMPLATE_LIMITS_JSON` 与 `WECHAT_PUBLISHER_TEMPLATE_WEIGHTS_JSON` 配置项
- 支持命令参数 `template_limits_json` 与 `template_weights_json` 对单次执行进行覆盖

## v0.1.4 (2026-03-17)
- 新增可配置搜索模板机制，支持按模板ID组合多视角抓取
- 内置模板扩展为高价值活跃、最新创建、近期热门、Agent 工具链、多模态等角度
- 新增 `WECHAT_PUBLISHER_SEARCH_TEMPLATE_IDS` 与 `WECHAT_PUBLISHER_SEARCH_TEMPLATES_JSON` 配置项
- 支持通过命令参数覆盖模板集合并将模板信息写入阶段1快照

## v0.1.3 (2026-03-16)
- 修复阶段1 gh search 字段兼容性，适配当前 gh 版本的 fullName/stargazersCount/forksCount/language 返回结构
- 修复仓库归一化逻辑，兼容 owner 字段对象与字符串两种形态
- 完成阶段1-3全链路实测，确认抓取、生成、飞书 markdown 推送均成功

## v0.1.2 (2026-03-16)
- 移除阶段3推送 direct 降级路径，统一通过 FeishuBridge push 接口发送
- 调整阶段3推送消息类型为 markdown，审核内容以卡片形式下发
- 修复缺少管理员凭据时的错误提示，避免走非预期分支

## v0.1.1 (2026-03-16)
- 修复阶段3推送参数字段，使用 FeishuBridge 约定的 text 字段发送文本
- 新增阶段3推送降级逻辑，admin_api 路由 404 时自动切换 direct 模块推送
- 扩展管理端认证变量解析，兼容 username/password 命名

## v0.1.0 (2026-03-16)
- 新增 WeChatPublisher 同步插件清单与入口实现
- 实现阶段1：通过 gh search repos 抓取 GitHub 语料并进行 7 天去重
- 实现阶段2：基于语料生成公众号前言草稿并落盘
- 实现阶段3：调用 FeishuBridge 管理接口推送人工审核消息并记录审核留痕
- 新增阶段调度能力，支持创建每日 08:00/14:00/20:00 任务
- 新增单元测试覆盖核心解析与阶段逻辑
