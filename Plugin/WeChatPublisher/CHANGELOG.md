# Changelog

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
