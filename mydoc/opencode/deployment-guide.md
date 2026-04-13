# 部署与配置指南

## 环境要求

### VCP 主服务器

- **Node.js**: ≥ 18.x
- **Python**: 3.9+（部分插件依赖）
- **Rust**: 1.70+（用于构建 rust-vexus-lite 向量引擎）
- **SQLite**: 内置，无需单独安装
- **PM2**: 推荐用于生产部署

### OhMyOpenCode 侧

- 任何能发起 HTTP 请求和 WebSocket 连接的运行时（Node.js、Python、Go 等）
- 建议具备异步/事件驱动能力以处理实时推送

---

## 1. VCP 主服务器部署

### 1.1 基础安装

```bash
git clone https://github.com/lioensky/VCPToolBox.git
cd VCPToolBox
npm install
pip install -r requirements.txt
```

### 1.2 构建 Rust 向量引擎

```bash
cd rust-vexus-lite
npm run build
cd ..
```

### 1.3 配置文件

复制模板并编辑：

```bash
cp config.env.example config.env
```

**必须配置的关键项**（OpenClaw 集成相关）：

```env
# 服务器端口
PORT=5890

# API 访问密钥（OpenCode 调用 VCP 时使用）
VCP_Key=your_secure_random_key_here

# 可选：Agent 目录和 TVStxt 目录
AGENT_DIR_PATH=Agent
TVSTXT_DIR_PATH=TVStxt

# 调试模式
DebugMode=false
```

### 1.4 验证 OpenClaw Bridge 已加载

```bash
# 启动服务器
node server.js &

# 验证能力发现接口
curl "http://localhost:5890/admin_api/openclaw/capabilities?agentId=test"
```

如果返回 JSON（包含 `success`、`data`、`meta`），说明 Bridge 已就绪。

> **注意**：`openclawBridgeRoutes.js` 当前挂载在 `adminPanelRoutes.js` 下（通过 `/admin_api` 路径）。如果你访问 `/admin_api/openclaw/capabilities` 成功，说明路由已正确注册。

---

## 2. AgentAssistant 插件配置

AgentAssistant 是实现 OOC ↔ VCP Agent 通讯的核心插件。

### 2.1 确认插件已启用

检查 `Plugin/AgentAssistant/` 目录下是否存在 `plugin-manifest.json`（非 `.block`）。

### 2.2 配置 Agent 定义

编辑 `Plugin/AgentAssistant/config.json`：

```json
{
    "maxHistoryRounds": 7,
    "contextTtlHours": 24,
    "globalSystemPrompt": "",
    "delegationMaxRounds": 15,
    "delegationTimeout": 300000,
    "delegationSystemPrompt": "[异步委托模式]...",
    "delegationHeartbeatPrompt": "[系统提示:]...",
    "agents": [
        {
            "baseName": "KE",
            "chineseName": "小克",
            "modelId": "gpt-4o",
            "systemPrompt": "你是一个擅长信息检索和学术研究的AI助手，名叫{{MaidName}}。",
            "maxOutputTokens": 40000,
            "temperature": 0.7,
            "description": "擅长搜索、阅读、总结"
        },
        {
            "baseName": "NOVA",
            "chineseName": "Nova",
            "modelId": "claude-3-5-sonnet",
            "systemPrompt": "你是一个温柔细心的AI助手，名叫{{MaidName}}。",
            "maxOutputTokens": 40000,
            "temperature": 0.8,
            "description": "擅长对话、创意、情感交流"
        }
    ]
}
```

### 2.3 热重载配置

修改 `config.json` 后，可通过管理面板或 API 触发热重载：

```bash
curl -X POST "http://localhost:5891/admin_api/agent-assistant/config" \
  -H "Content-Type: application/json" \
  -u "admin:password" \
  -d '{"config": { ... }}'
```

---

## 3. OhMyOpenCode 侧集成配置

### 3.1 环境变量

在 OOC 项目中配置：

```env
# VCP 主服务器地址
VCP_BASE_URL=http://localhost:5890

# 必须与 VCP config.env 中的 VCP_Key 一致
VCP_KEY=your_secure_random_key_here

# 默认 Agent ID（用于与 VCP 交互时的身份标识）
VCP_DEFAULT_AGENT_ID=ohmy-master
```

### 3.2 连接测试脚本

```typescript
// test-connection.ts
import { VCPClient } from './vcp-client';

async function test() {
  const vcp = new VCPClient(
    process.env.VCP_BASE_URL!,
    process.env.VCP_KEY!
  );

  console.log('测试 1: 能力发现');
  const caps = await vcp.getCapabilities('ohmy-master');
  console.log('状态:', caps.success ? '✅ 成功' : '❌ 失败');
  if (caps.success) {
    console.log('插件数:', caps.data.tools.length);
    console.log('记忆目标:', caps.data.memory.targets);
  }

  console.log('\n测试 2: 记忆写入');
  const mem = await vcp.writeMemory(
    { diary: '测试日记本' },
    { text: '连接测试成功', tags: ['测试'] },
    { agentId: 'ohmy-master', sessionId: 'test-session' }
  );
  console.log('状态:', mem.success ? '✅ 成功' : '❌ 失败');

  console.log('\n测试 3: RAG 召回');
  const rag = await vcp.searchRag(
    '连接测试',
    { mode: 'rag', diary: '测试日记本' },
    { agentId: 'ohmy-master', sessionId: 'test-session' }
  );
  console.log('状态:', rag.success ? '✅ 成功' : '❌ 失败');
  if (rag.success) {
    console.log('召回结果数:', rag.data.results.length);
  }
}

test().catch(console.error);
```

---

## 4. 日记本（记忆空间）初始化

VCP 的记忆以日记本为单位存储在 `dailynote/` 目录下。

### 4.1 创建日记本

```bash
mkdir -p dailynote/Nova日记本
mkdir -p dailynote/公共日记本
mkdir -p dailynote/辩论室_量子计算
```

### 4.2 权限控制

VCP 的 OpenClaw Bridge 通过 `resolveOpenClawAllowedDiaries()` 控制访问权限。默认逻辑通常允许：
- Agent 访问以自己名字命名的日记本
- 访问 `公共日记本`

如需自定义权限，检查 `routes/openclawBridgeRoutes.js` 中的 `resolveOpenClawAllowedDiaries` 实现。

### 4.3 向量索引初始化

新日记本首次写入记忆后，VCP 的 `KnowledgeBaseManager` 会自动完成向量化。如果手动批量导入历史文件，建议重启服务器触发索引重建，或通过管理面板的 RAG 管理功能操作。

---

## 5. WebSocket 实时连接

### 5.1 连接地址

```
ws://<vcp-host>:<port>/vcpinfo/VCP_Key=<your_vcp_key>
```

### 5.2 连接示例（Node.js）

```typescript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:5890/vcpinfo/VCP_Key=your_key');

ws.on('open', () => {
  console.log('[VCP WS] 已连接');
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('[VCP WS] 收到消息:', msg.type);
  // 处理各类消息...
});

ws.on('close', () => {
  console.log('[VCP WS] 连接关闭');
});
```

### 5.3 防火墙与反向代理

如果使用 Nginx 反向代理 WebSocket：

```nginx
location /vcpinfo/ {
    proxy_pass http://127.0.0.1:5890;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
}
```

---

## 6. 生产部署建议

### 6.1 使用 PM2

```bash
pm2 start server.js --name vcp-main
pm2 start adminServer.js --name vcp-admin
pm2 save
pm2 startup
```

### 6.2 Docker Compose

项目已提供 `docker-compose.yml`，可直接使用：

```bash
docker-compose up --build -d
docker-compose logs -f
```

### 6.3 安全建议

| 项目 | 建议 |
|------|------|
| `VCP_Key` | 使用 32 字节以上随机字符串，定期轮换 |
| Admin 密码 | `config.env` 中设置强密码，不要使用默认 `admin/123456` |
| 网络隔离 | VCP 管理面板和 Bridge API 建议限制内网访问或使用 VPN |
| 审批策略 | 对 `VCPPowerShell`、`VCPFileOperate` 等高危工具启用审批 |
| HTTPS | 生产环境务必启用 HTTPS，保护 API 密钥和记忆数据 |

---

## 7. 常见故障排查

### 7.1 OpenClaw Bridge 返回 404

**现象**：访问 `/admin_api/openclaw/capabilities` 返回 404。

**排查**：
1. 确认 `server.js` 或路由挂载文件中已引入 `openclawBridgeRoutes.js`
2. 检查是否使用了正确的端口（主服务端口，非管理面板端口+1）
3. 查看 `routes/adminPanelRoutes.js` 中是否已 `mount('/', 'openclawBridge')` 或等效挂载

### 7.2 AgentAssistant 返回 "Agent 未找到"

**现象**：调用 `AgentAssistant` 时返回 `请求的 Agent '小克' 未找到`。

**排查**：
1. 检查 `Plugin/AgentAssistant/config.json` 中是否存在 `chineseName` 为 `小克` 的 Agent
2. 检查 `config.json` 是否已热重载生效
3. 查看 VCP 启动日志中 Agent 加载数量

### 7.3 RAG 召回结果为空

**现象**：`rag/search` 返回 `results: []`。

**排查**：
1. 确认目标日记本中已有内容（不是空目录）
2. 确认 Agent ID 有权限访问该日记本
3. 尝试降低 `minScore` 阈值
4. 检查 `KnowledgeBaseManager` 是否正常初始化（查看启动日志）
5. 如果是新导入的文件，可能需要等待向量化完成或重启服务器

### 7.4 异步委托超时

**现象**：`task_delegation` 任务最终返回超时失败。

**排查**：
1. 检查被委托 Agent 使用的模型 API 是否可用
2. 检查 `Plugin/AgentAssistant/config.json` 中的 `delegationTimeout` 是否足够
3. 查看 VCP 日志确认 Agent 是否生成了 `[[TaskComplete]]` 标记
4. 如果是长任务，确保 Agent 正确使用了 `[[NextHeartbeat::秒数]]`

### 7.5 WebSocket 连接被拒绝

**现象**：WebSocket 连接后立即断开。

**排查**：
1. 确认 URL 中的 `VCP_Key` 与服务器 `config.env` 中的完全一致
2. 检查防火墙是否放行对应端口
3. 如果使用 Nginx 反向代理，确认 `Upgrade` 和 `Connection` 头已正确转发
4. 查看 `WebSocketServer.js` 日志中的认证信息

---

## 8. 配置检查清单

在正式上线前，请确认以下项目：

- [ ] `config.env` 中的 `VCP_Key` 已设置为强随机字符串
- [ ] `AdminUsername` 和 `AdminPassword` 已修改默认值
- [ ] `Plugin/AgentAssistant/config.json` 中已配置至少 1 个可用 Agent
- [ ] 目标日记本已在 `dailynote/` 下创建
- [ ] `rust-vexus-lite` 已编译成功
- [ ] OpenClaw Bridge 的 `/capabilities` 接口可正常访问
- [ ] OhMyOpenCode 侧可通过 SDK 成功写入记忆并召回
- [ ] WebSocket 连接稳定，能收到实时推送
- [ ] 高危工具已启用审批策略（如需要）
- [ ] 生产环境已启用 HTTPS
