# 测试与发布门禁（§8）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 各里程碑的验证任务见 [06-execution-plan.md](06-execution-plan.md)
> 本文保留原方案的 §8 编号。测试矩阵按类别组织，是发布门禁的单源清单。

## 8. 测试与发布门禁

| 类别 | 必测案例 |
|---|---|
| 身份 | 省略 agent、同 agent、不同 agent、未知/禁用 agent、path/query/body/URI target 冲突、双通道 token 不一致 401、认证失败限速 429 与 `authFailure` 指标 |
| credential | 有效、无效、过期、撤销、轮换、同 mtime/size 内容替换、损坏/不可读变更后旧 token 立即失效、阶段 A 未设置 path 的空 snapshot 与显式坏 path fail-closed、pepper 缺失/未知 kid/轮换、token 跨 kid 多记录冲突、credentialId 重复/换 token 重用、内置与文件 credential 冲突、绑定 credential 配 `admin` scope |
| scope | 每个 credential surface 的 authenticated/read/execute 映射；admin session bridge 仅有 `adminAuthBridge` 且与 credentialAction 互斥；`gateway:read` 与 `gateway:execute` 不互相蕴含；REST/MCP action 一致 |
| MCP | initialize、tool、prompt、resource、bootstrap（含 deferred 分支 `summary`）、job owner lookup、受支持 transport 的 batch 混合 target 逐项授权；旧 discovery snapshot 中已撤销能力在调用时被当前策略拒绝 |
| discovery | bound/unbound/admin 列表规则；initialize 后同 session 列表稳定、新 session 看到新配置；cursor 不能跨 discovery revision/credential subject；`listChanged:false` 与实际通知行为一致；外部 default-agent 不参与授权 |
| transport | HTTP、WebSocket、stdio、backend-proxy、in-process；request-scoped credential 端到端保持，override 与静态凭据并存不产生双通道，静态 backend key fallback 被拒绝，client auth 字段无法伪造 trusted context；security snapshot 不可用时 HTTP 503、WS `close(1013)`、SSE 流终止 |
| REST | 每个 `:agentId` path、query/body target、过滤后的 `/agents`、job/event owner lookup、guidance 与 integration endpoint；Gateway admin session 创建/撤销、共享 store、subject key 轮换、Origin allowlist（含独立端口 AdminPanel）/CSRF；无 Gateway session 的 Basic 除 session POST 外不能访问业务；health/metrics 排除清单固定；SSE 流吊销后 ≤60s 终止 |
| session/job | 跨 credential session 重用、同 agent 跨 credential/credential revision/job 访问、受信任 session 缺失与冲突、正常终止 session 后同 subject 收养成功且异 subject/吊销 credential 收养被拒、adoption 审计与 owner 原子替换、Native 无 trusted session 时 credential-owned 语义、不同 admin session subject、轮换期连续性、WS 吊销 `close(4401)` 与配置不可用 `close(1013)` |
| 迁移 | legacy 观察/执行两阶段、admin 兜底升级为 Gateway admin session、legacy/admin 两个关闭开关独立生效和回滚、旧 scope 名开关独立生效、`/mcp` 始终拒绝 admin-session、`authMigration` 指标准确 |
| guidance | resource/bootstrap/REST 内容和 revision 一致；无绑定不泄露 agent 内容；guidance/integration/online skill/mint 响应 no-store 且 Vary 身份通道 |
| 配置 | 内容/调优配置初始失败/last-known-good/恢复；身份/授权配置初始或热加载失败均 fail-closed；交叉引用错误、content hash、同 mtime/size、原子 rename、integration/security snapshot revision 一致性 |
| L3 | Claude Code/Codex/Kimi format、Host header 污染、public URL 校验、format allowlist、path traversal、签名过期/并发复用/缓存重放/跨进程与重启复用/owner 吊销/kid 轮换、nonce store 缺失、no-store 响应、代理缓存旁路、URL 日志脱敏、secret scan |
| 契约 | MCP descriptor/catalog 同源；REST 修改后的 OpenAPI；所有 operation/surface 恰有一个 credentialAction 或受允许的 authMechanism；重生成 snapshot 零差异 |

发布前必须满足（编号供 06-execution-plan.md 的里程碑门禁引用；方括号为主要归属 milestone）：

1. **[M1]** 所有 agent-scoped 入口都调用统一 context builder；不存在只相信客户端 `agentId` 的路径，也不存在绕过决议表直通业务逻辑的认证旁路（含 admin 兜底，§3.3）。
2. **[M1]** HTTP / WebSocket backend-proxy 在真实链路中逐请求透传原始 credential，canonical backend 重新解析且审计主体不折叠；静态 backend credential 仅用于 stdio。
3. **[M1]** direct target 的所有输入位置执行冲突检测；job/event 等 indirect object 只从含 credential revision 与 trusted session 的服务端 owner snapshot 决议，不相信调用方声明，也不允许新 token 继承旧对象。
4. **[M1]** discovery 面不存在跨 agent 泄漏；bound/unbound/admin list 结果与 §3.4 的确定规则一致，Native `/agents` 同步过滤；MCP session 内冻结 snapshot 与 `listChanged:false` 一致，实际调用仍按当前安全策略复核。
5. **[M2]** 两个 MCP adapter 公布一致的 guidance 资源与 bootstrap 行为（含所有分支的 `summary` 字段与 render 暴露形态）。
6. **[M1]** 审计事件包含 `credentialId`、`credentialRevision`、`credentialSubject`、`boundAgentId`、`targetAgentId`、`effectiveAgentId`、indirect owner、credentialAction、授权结果、request/trace id 与配置 revision；不包含 token、digest、pepper 或 admin session 原始标识。
7. **[M1]** 内容/调优配置 last-known-good 与身份/授权配置 fail-closed 已通过故障注入验证；损坏 credential/keyring/policy 不能让任何旧 token、授权、session、SSE 流或连接继续工作。credential 校验热路径通过基准验收（异步 I/O、in-flight 合并、p99 附加延迟达标）。
8. **[M1 阶段 B 前]** legacy 归一化、Gateway admin session 迁移和两个独立关闭开关均经过演练，`/mcp` 不接受 admin fallback，`authMigration` 指标确认存量客户端已完成迁移。
9. **[M2（M0.S4 含 description smoke）]** `npm run test:agent-gateway` 通过，并在受控环境运行 Claude Code、Codex、Kimi 的真实 MCP smoke。
10. **[M4]** 所有三种格式生成的 skill/archive 通过真实安装、secret scan、manifest checksum 和下载授权测试；生产签名 URL 具备原子、共享、跨重启 nonce store，并以 no-store 响应、代理缓存旁路和 URL 日志脱敏维持一次性语义。
