# L3 签名下载部署要求（§6 运维单源）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 设计约束见 [04-skill-generation.md](04-skill-generation.md)
> 本文是 §6 中「应用、反向代理、CDN、APM 和 access log 必须对 redeem 路径关闭缓存并脱敏」与「共享且可跨重启 nonce store」两条约束的部署侧清单。应用侧行为由代码与测试保证；本文列出的项必须在部署层落实，否则「一次性 URL」承诺失效。

## 必配环境变量

| 变量 | 作用 | 约束 |
|---|---|---|
| `AGENT_GATEWAY_PUBLIC_BASE_URL` | 生成物与签名 URL 的对外 base URL | 绝对 URL；生产必须 HTTPS；不从请求 host 推导 |
| `AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET` | 下载签名独立密钥 | ≥32 字节；JSON 数组支持 kid 轮换（首个为当前，旧 kid 在轮换期仍可验签）；经环境变量或 secret 文件注入，不进仓库 |
| `AGENT_GATEWAY_DOWNLOAD_NONCE_DIR` | 单机多 worker 的文件 nonce backend 目录 | 所有 worker 可写的同一本地目录；消费记录落盘（跨重启保持）。跨主机部署改用 `pluginManager.agentGatewayDownloadNonceBackend` 注入共享 KV backend |
| `AGENT_GATEWAY_PUBLIC_BASE_URL_ALLOW_INSECURE` | 仅 loopback 开发环境显式允许 HTTP | 生产不得设置；非 loopback HTTP 无任何豁免 |

未配置生产级 nonce store 时 mint endpoint 恒 503（fail-closed）；直接认证的在线 `GET .../integration/skill` 不受影响。

## Redeem 路径的代理 / CDN / 日志要求

redeem 路径（`GET /agent_gateway/agents/:agentId/integration/skill/download?token=…`）的 query 即 bearer capability。部署层必须：

1. **关闭缓存**：反向代理与 CDN 对该路径禁用缓存与代答（应用已发送 `Cache-Control: private, no-store, max-age=0`、`Surrogate-Control: no-store`、`Pragma: no-cache`、`Expires: 0`，代理不得覆盖或忽略）。缓存命中会绕过 origin nonce store，使一次性语义失效。
2. **脱敏 access log**：Nginx/Caddy/APM 的访问日志对该路径丢弃或脱敏完整 query（示例：Nginx `map $request_uri` 后对匹配路径记录 `$uri` 而非 `$request_uri`）。应用自身不把该路径的 query/token 写入日志、审计或 operability payload。
3. **不注入 Referer**：应用已发送 `Referrer-Policy: no-referrer`；代理不得改写。
4. **禁用 Range / redirect 改写**：应用拒绝 Range 与 HEAD；代理不得代答 206 或将请求改写成 redirect。

## 密钥轮换流程

1. 生成新 32+ 字节密钥，将其以新 kid 置于 `AGENT_GATEWAY_DOWNLOAD_SIGNING_SECRET` JSON 数组首位，旧密钥保留在第二位。
2. 滚动重启 worker；轮换期内旧 kid 签发的未过期 URL 仍可验签。
3. 下载 URL 默认 TTL（5 分钟）过后移除旧 kid。
