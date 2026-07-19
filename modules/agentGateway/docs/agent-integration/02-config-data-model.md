# 配置与数据模型（§4）

> 所属方案：[Agent 客户端集成方案](README.md) v6 ｜ 身份与授权模型见 [01-identity-authorization.md](01-identity-authorization.md)
> 本文保留原方案的 §4.x 编号。

## 4. 配置与数据模型

### 4.1 复用现有 Agent Directory

不新增第二份 agent registry。`agentDirectoryPort.listAgents()` / `agent_map.json` 继续作为“哪些 agent 存在”的权威来源；integration 层只为其中需要对外接入的 agent 提供 guidance、memory policy、recall profile 和 credential 引用。

`agentGuidanceResolver` 在 composition 层通过窄端口获得 agent directory 快照，并与其余配置合成为只读 integration snapshot：

```jsonc
{
  "agentId": "MCPMidas",
  "alias": "MCPMidas",
  "displayName": "Midas",
  "guidanceRef": "MCPMidas",
  "memoryPolicyRef": "MCPMidas",
  "recallProfileRef": "MCPMidas"
}
```

这样 agent 身份不在新配置中重复维护；guidance 配置中的 agent key 只是对权威目录的受校验引用。

注意 snapshot 各字段的来源边界：agent directory 只提供 `alias`、`sourceFile` 与存在性；**`displayName` 来自 §4.2 的 guidance 配置，不来自目录**——现有数据源中没有 displayName 字段（最接近的是 memory policy 的 `maid` 字段，语义不同，不复用）。

### 4.2 Guidance 配置

新增 `config/agent_guidance.json`，只存无法从已有 policy/profile 推导的表达内容。日记本授权集合、默认集合和 canonical diary name 由 memory policy 模块（`policy/mcpAgentMemoryPolicy.js`）注入，不在 guidance 中重新维护。

```jsonc
{
  "version": 1,
  "shared": {
    "workflow": [
      "任务依赖历史决策、bug、策略研究或用户偏好时，先调用 gateway_recall_run。",
      "已知日记本、确切名称或窄范围历史问题才使用 gateway_memory_search。",
      "召回为空或失败时继续使用本地仓库上下文，不中断任务。"
    ],
    "memoryWritePolicy": {
      "write": ["用户偏好与纠正", "架构或工作流决策", "非显然 bug 根因", "已验证结论"],
      "skip": ["密钥和敏感数据", "临时日志", "琐碎 git 可查修改", "未经确认的推测"]
    }
  },
  "agents": {
    "MCPMidas": {
      "displayName": "Midas",
      "memoryDefaults": {
        "tags": ["codex", "select-stock-pro"],
        "metadata": { "project": "quant-select-stock-pro", "source": "codex" }
      }
    }
  }
}
```

新增 `policy/agentGuidanceResolver.js`，输出唯一的 guidance bundle：

```jsonc
{
  "agentId": "MCPMidas",
  "displayName": "Midas",
  "workflow": ["..."],
  "memoryWritePolicy": { "write": ["..."], "skip": ["..."] },
  "allowedDiaries": ["..."],
  "defaultDiaries": ["..."],
  "memoryDefaults": { "tags": ["..."], "metadata": {} },
  "revision": "sha256:...",
  "updatedAt": "2026-07-18T00:00:00.000Z"
}
```

`initialize.instructions`、guidance resource、bootstrap tool、Native REST 和 skill generator 只消费该 bundle，禁止各自复述日记本路由或写入策略。

### 4.3 交叉校验与热加载

配置加载按风险分成两类，不能共用一种 fallback 语义：

1. **内容/调优配置**（guidance 文案与展示字段、memory defaults、skill template，以及不扩大 diary/tool 准入面的 recall 调优参数）初始加载失败时 health 标记 degraded；依赖相应配置的请求返回 `AGW_CONFIG_UNAVAILABLE`（REST 503，MCP 新增 `MCP_SERVICE_UNAVAILABLE`），不能伪装成空配置。热加载失败时可保留 last-known-good，记录结构化错误、失败 content hash 与当前有效 revision。
2. **身份/授权配置**（credential 文件、pepper keyring、agent directory 的发布身份、agent tool/diary scopes、memory policy 的 allowed/default diaries、auth policy catalog，以及这些配置的交叉引用）初始或热加载失败都按 §3.6 fail-closed，绝不保留旧身份或授权快照继续认证/授权。下载 signing keyring 与 admin session store/key 也在其各自 artifact/admin surface fail-closed，不能影响无关 surface。安全失败返回 503 / `MCP_SERVICE_UNAVAILABLE`，不是伪装成无效 token 的 401。
3. 新增 `integrationSnapshotCoordinator`。任一内容/调优候选变化时，协调器读取关联配置全集并在交叉校验后一次性发布 `{ revision, contentHashes, agents }` 冻结快照；不允许各 resolver 独立替换导致混合 revision。任一身份/授权候选变化同样必须针对当前 agent/config 候选全集完成校验后，才能发布 security snapshot；引用未知/未发布 agent 时对应安全域不可用，而不是部分接受其余 credential 或沿用旧授权。
4. 校验 agent directory、guidance、memory policy、recall profiles、credential 的所有引用；不允许未知 agent、未发布 agent credential、未知 diary route 或 default diary 非 allowed。成功恢复时记录从失败 revision/hash 到新有效 revision/hash 的结构化恢复事件。

这样保证“漂移可检测”，而不是不现实的“漂移不可能”。

### 4.4 Credential 配置

真实 credential 文件不得位于受版本控制的 `modules/agentGateway/config/` 中。仓库只提供不含 secret 的 `.example`；实际路径由 `AGENT_GATEWAY_CREDENTIALS_PATH` 指定，生产文件要求仅运行用户可读。

```jsonc
{
  "version": 1,
  "credentials": [
    {
      "credentialId": "midas-prod-2026-07",
      "pepperKid": "credential-pepper-2026-07",
      "tokenDigest": "hmac-sha256:<digest>",
      "boundAgentId": "MCPMidas",
      "scopes": ["gateway:read", "gateway:execute"],
      "status": "active",
      "expiresAt": "2026-10-01T00:00:00.000Z"
    },
    {
      "credentialId": "ci-readonly",
      "pepperKid": "credential-pepper-2026-07",
      "tokenDigest": "hmac-sha256:<digest>",
      "boundAgentId": null,
      "allowedAgents": ["Nexus"],
      "scopes": ["gateway:read"],
      "status": "active",
      "expiresAt": "2026-10-01T00:00:00.000Z"
    }
  ]
}
```

要求：

- 仅在阶段 A 且 legacy credential 仍启用时，`AGENT_GATEWAY_CREDENTIALS_PATH` 未设置可规范化为“无文件 credential”的有效空 snapshot，并产生 migration warning；此时没有文件记录就不要求 pepper keyring。环境变量已设置但文件缺失/不可读仍按 §3.6 fail-closed，不能退回空 snapshot。阶段 B 关闭 legacy 前必须配置并验证真实 credential 文件；关闭后不再接受“未设置即空”的迁移特例。
- credential 生成 CLI 必须使用 CSPRNG 生成至少 256 bit token；服务端对 presented token 设置明确长度上限并在做 HMAC 前拒绝超限输入。只保存 `HMAC-SHA256(pepper, token)` digest 并使用恒时比较；日志中仅出现 `credentialId`。pepper keyring 由 `AGENT_GATEWAY_CREDENTIAL_PEPPERS_PATH` 指向仓库外、仅运行用户可读的 JSON secret 文件，形如 `{ "keys": { "credential-pepper-2026-07": "<base64-secret>" } }`；每把解码后的 pepper 至少 256 bit，每条 credential 以 `pepperKid` 引用。缺少 keyring、未知 kid、secret 权限过宽或 secret 解码失败时按 §3.6 fail-closed，不能回退明文 hash、空 pepper 或 last-known-good keyring。
- pepper 轮换采用“新 kid + 新 token + 新 credential record”，旧 kid 只为仍处于 `rotating` 且有 `expiresAt` 的旧记录保留；迁移完成后先撤销旧记录，再删除旧 kid。服务端不持有原 token，因此不声称能够只换 pepper 自动重算旧 digest。`AGENT_GATEWAY_CREDENTIAL_ACTIVE_PEPPER_KID` 只供 credential 生成 CLI 选择当前 kid，运行时验证以记录自身的 `pepperKid` 为准。
- scope 词表为 `gateway:read`、`gateway:execute`、`admin`；`admin` 蕴含全部操作类别并允许跨 agent 操作。**`admin` scope 仅允许配置在 `boundAgentId: null` 的 credential 上**，绑定 credential 携带 `admin` 属配置错误，加载校验拒绝（§3.2）。`allowedAgents` 仅对 `boundAgentId: null` 的 credential 有意义；缺省且持 `admin` scope 表示全部 agent。旧 `mcp:read` / `mcp:execute` 只在阶段 A loader 中映射为新名称并产生 migration warning；阶段 B 使用独立开关 `AGENT_GATEWAY_LEGACY_SCOPE_NAMES_DISABLED=true` 拒绝，避免与关闭 legacy 认证路径的开关混用。
- **匹配与冲突规则**：presented token 按各记录的 pepperKid 计算 digest，必须命中且仅命中一条记录；同一 token 命中多条记录时一律拒绝（fail-closed）并记录审计。相同 pepperKid + digest 可在加载时直接判为配置错误；跨 kid 的重复 token 只能在认证时发现并拒绝。bound 与 unbound credential 之间不存在匹配优先级——token 唯一决定记录，身份由记录决定。
- `credentialId` 在 security snapshot 内必须非空且唯一；文件 credential 的 `credentialSubject` 固定等于 `credentialId`，不允许另行配置为共享 subject。credential 轮换必须创建新的 `credentialId`；运行进程维护 `credentialId -> tokenDigest` tombstone，至少保留到相关 session/job/event、签名 URL 与审计关联窗口全部结束，在该窗口内拒绝以不同 digest 重用旧 id。**tombstone 是进程内的尽早报错机制，不跨重启、不跨 worker，不是防继承的正式保证**；正式保证由 indirect owner 中的 `credentialRevision` 承担——重启后或多 worker 下即使 tombstone 缺失，revision 校验仍必须阻止新 token 继承旧对象。实现与测试按此分工，不得把 tombstone 升级为共享 store 来替代 revision 校验。
- 支持 `active`、`rotating`、`revoked`、`expired` 四种状态；`rotating` 与 `active` 同效但必须有明确 `expiresAt`，到期自动转为 `expired`。
- 吊销或过期后按 §3.6 传播：HTTP session 失效、WebSocket `close(4401)`、stdio 的下一请求被 backend 拒绝。
- credential 轮换可临时并存旧、新两把 credential，但旧 credential 必须有明确到期时间。
- 内置 legacy credential（§3.3）与文件中 credential token 冲突时拒绝发布 security snapshot。

