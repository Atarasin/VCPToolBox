# L3 Skill 生成与下载（§6）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 授权规则引用 [§3.2 决议表](01-identity-authorization.md)
> 本文保留原方案的 §6 编号。

## 6. L3 Skill 生成与下载

skill 保留为可选增强，模板变量全部来自 guidance bundle 和受信任部署配置。

```text
GET /agent_gateway/agents/:agentId/integration/skill?format=claude|codex|kimi
GET /agent_gateway/agents/:agentId/integration
```

约束：

- 对外 base URL 只能读取 `AGENT_GATEWAY_PUBLIC_BASE_URL`；不从请求 host 推导。配置必须解析为绝对 URL，不允许 userinfo、query 或 fragment；生产只允许 HTTPS。HTTP 仅限 loopback 与私网/CGNAT 字面 IP（RFC1918、100.64/10、IPv6 ULA——VPN/内网部署形态，隧道层承担加密）且必须显式 `ALLOW_INSECURE` 豁免；公网地址与无法离线判定的主机名一律拒绝 HTTP。（2026-07-20 经部署方确认放宽：原文仅允许 loopback。）
- 授权走 §3.2 同一张决议表，无特例：绑定 credential 只能取所绑 agent 的 skill；未绑定 credential 按 `allowedAgents`/`admin` scope 决议（`admin` 只存在于未绑定 credential，见 §3.2）。
- 生成物只包含 endpoint、工具说明和“从客户端安全 secret store 读取 credential”的指引；绝不包含 API key、gateway key、token、`.env` 内容或下载签名。
- guidance、integration、在线 skill 和签名 URL mint 都是按 owner 渲染的认证响应；成功与错误均设置 `Cache-Control: private, no-store`，并至少 `Vary: Authorization, Cookie, x-agent-gateway-key`。mint 响应中的一次性 URL 不进入审计 payload、APM attributes、Referer 或 access log。
- 包含 manifest、内容哈希和固定文件清单；`format` 采用 allowlist，文件名与 archive path 不接受用户输入。
- 如需离线下载，使用短时、一次性、agent-scoped 签名 URL。URL 本身是 bearer capability，签名载荷包含 artifact id、agent id、owner kind/id/subject/revision、过期时间和 nonce，但不得包含原 token、cookie 或 opaque admin session id；credential/admin session 吊销后下载立即失败。
- 签名 URL 的 mint 操作必须先按 `gateway:read` 认证并授权 agent；redeem 时无需再次传原 credential，但服务端必须从 credential resolver 或 `adminGatewaySessionStore` 重新读取载荷对应 owner，检查 subject/revision 仍存在、可用且仍可访问该 agent。`admin-session` 签发的 URL 最长不得超过该 session 剩余 TTL。签名只授予该 artifact 的短时下载权，不授予其他 Gateway API 权限。
- 下载签名使用独立密钥（`AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET`，经环境变量或 secret 文件注入，不进入仓库与配置快照）；签名载荷携带 `kid`，服务端保留当前与前一把密钥以支持轮换期验证。
- “一次性”由注入的 `downloadNonceStore.consumeOnce(nonce, expiresAt)` 保证：先完成签名、owner、expiry 和 artifact 存在性校验，再在输出任何响应 body 前原子消费 nonce；消费后的文件读取/传输失败也不得恢复 nonce。已用 nonce 保留到 `expiresAt + clockSkew` 后再 TTL 清理，多 worker 部署必须使用共享且可跨重启的 store。没有生产级 nonce store 时签名 URL mint endpoint 返回 503，不能降级为进程内 Map；直接认证的在线 artifact 下载不受影响。仓库可提供仅供单进程开发/测试的内存实现，但必须显式标记非生产。
- redeem endpoint 只接受完整 GET，不支持 redirect、Range 或由 CDN/代理代答；成功与错误响应均固定设置 `Cache-Control: private, no-store, max-age=0`、`Surrogate-Control: no-store`、`Pragma: no-cache`、`Expires: 0`、`Referrer-Policy: no-referrer` 与 `Content-Disposition: attachment`。应用、反向代理、CDN、APM 和 access log 必须对该路径关闭缓存并脱敏完整 query、signature、nonce；否则缓存命中可能绕过 origin nonce store，使“一次性”承诺失效。
- Claude Code、Codex、Kimi 三种 format 各自定义固定 manifest、MCP 注册片段与 secret 引用方式；客户端不支持安全 secret 引用时只生成指导文件，不生成含明文 token 的“可运行”配置。

现有 `skills/midas-vcp/` 只在生成产物完成、真实客户端 smoke 通过、并完成迁移公告后删除。

