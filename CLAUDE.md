# CLAUDE.md

## Superpowers技能路由
- brainstorming: 需求澄清时自动触发
- writing-plans: 需求确认后自动触发
- test-driven-development: 编码阶段强制触发
- requesting-code-review: 编码完成后自动触发
- verification-before-completion: 完成前自动验证

## GStack技能路由
- /office-hours: 新项目启动时手动触发
- /plan-ceo-review /plan-eng-review /plan-design-review: 规划阶段手动触发
- /review /cso /design-review: 审查阶段手动触发
- /qa /benchmark /canary: 验证阶段手动触发
- /ship /land-and-deploy: 发布前手动触发
- /careful /freeze /guard: 安全模式技能

## GSD 技能路由
- 新项目启动 → /gsd-new-project
- 阶段规划 → /gsd-plan-phase N
- 阶段执行 → /gsd-execute-phase N
- 阶段验证 → /gsd-verify-work
- 进度查看 → /gsd-progress
- 全自动模式 → /gsd-autonomous

## 分工裁决
- 项目初始化 → gsd: /gsd-new-project
- 产品诊断 → GStack: /office-hours
- 计划撰写 → Superpowers: writing-plans
- 原子任务规格化 → gsd: /gsd-plan-phase
- 编码 → Superpowers: test-driven-development
- 规格验证 → gsd: /gsd-verify-work
- 真实环境验证 → GStack: /qa
- 调试 → Superpowers: systematic-debugging → GStack: /investigate
- 发布 → GStack: /ship
- 安全审计 → GStack: /cso
- 复盘 → GStack: /retro
