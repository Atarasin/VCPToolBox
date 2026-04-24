# Integrations

**Date:** 2026-04-24

## AI Model APIs (Upstream)

VCP acts as a proxy/middleware to various AI service providers:

- **OpenAI-compatible APIs** — Primary target; configurable `API_URL` + `API_Key`
- **DashScope (Alibaba)** — `https://dashscope.aliyuncs.com/compatible-mode`
- **Local models** — `http://localhost:3001` (common setup for local inference)
- **Model routing** — `ModelRedirect.json` / `modelRedirectHandler.js` for multi-provider failover
- **Circuit breaker** — Configurable upstream failure threshold (`UpstreamCircuitFailureThreshold=3`) and health probing

## External Services

### Search
- **Tavily** (`@tavily/core`) — AI search API
- **SerpAPI** (`serpapi`) — Google search results
- **Google Search** (custom plugin)

### Communication
- **Lark (Feishu)** (`@larksuiteoapi/node-sdk`) — Enterprise messaging bridge
- **IMAP** (`node-imap`, `mailparser`) — Email indexing and search
- **RSS** (`rss-parser`) — Feed aggregation

### Content Platforms
- **Bilibili** — Video/content fetch
- **Xiaohongshu** — Content fetch
- **WeChat** — Publishing bridge (`Plugin/WeChatPublisher/`)
- **ArXiv / PubMed / CrossRef** — Academic paper search

### Image Generation
- **ComfyUI** — Local SD workflow execution
- **Flux** — Image generation
- **Gemini Image Gen** — Google image generation
- **Qwen Image Gen** — Alibaba image generation
- **Doubao / DMXDoubao** — ByteDance image generation

### Storage & Cloud
- **Tencent COS** — Backup target (`Plugin/TencentCOSBackup/`)
- **Local filesystem** — Extensive file-based storage (`file/`, `image/`, `dailynote/`)

## Database & Persistence

- **SQLite** (`better-sqlite3`) — Primary structured data store
- **HNSW** (`hnswlib-node`) — Vector index for RAG/semantic search
- **Redis** (`ioredis`) — Cache, session store, distributed coordination
- **File-based JSON** — Configuration, plugin state, agent memory

## Auth & Security

- **Basic Auth** — Admin panel protection (`basic-auth`)
- **API Key** — `Key`, `Image_Key`, `File_Key`, `VCP_Key` for different endpoints
- **Plugin UserAuth** — `Plugin/UserAuth/` with encrypted auth codes
- **IP Blacklist** — `ip_blacklist.json` for rate-limiting/abuse prevention

## WebSocket Distributed Network

- Custom protocol over `ws` for inter-node communication
- Tool execution across nodes
- File fetching from remote nodes (`FileFetcherServer.js`)
- Agent directory synchronization

## Browser Integration

- **Puppeteer** with stealth plugins — Web scraping, screenshot, PDF generation
- **VCPChrome** — Chrome extension for browser integration
- **jsdom** — Lightweight DOM parsing for content extraction
