# Tech Stack

**Date:** 2026-04-24

## Languages & Runtimes

| Language | Runtime | Purpose |
|----------|---------|---------|
| JavaScript (Node.js) | Node.js (>=18) | Primary backend runtime |
| Python | Python 3.11+ | ML/AI utilities, plugins, embedding pipelines |
| Rust | Cargo / N-API | High-performance vector indexing (`rust-vexus-lite/`) |
| HTML/CSS/JS | Browser | AdminPanel frontend, plugin frontends |

## Core Frameworks & Libraries

### Web Server
- **Express** `^5.1.0` — Main HTTP server and REST API framework
- **ws** `^8.17.0` — WebSocket server for distributed node communication
- **cors** `^2.8.5` — CORS middleware
- **basic-auth** `^2.0.1` — Admin panel authentication

### Data & Storage
- **better-sqlite3** `^12.4.1` — Primary SQLite database (sync, high-performance)
- **hnswlib-node** `^1.4.2` — Vector similarity search (HNSW index)
- **ioredis** `^5.6.1` — Redis client (caching, distributed state)
- **node-cache** `^5.1.2` — In-memory cache

### AI / NLP
- **@dqbd/tiktoken** `^1.0.22` — Token counting for OpenAI models
- **@node-rs/jieba** `^2.0.1` — Chinese text segmentation
- **@mozilla/readability** `^0.6.0` — Web page content extraction

### Utilities
- **axios** `^1.6.0` — HTTP client for upstream AI API calls
- **cheerio** `^1.1.2` — Server-side DOM parsing
- **puppeteer** `^22.15.0` + stealth plugins — Browser automation
- **jsdom** `^24.1.3` — DOM emulation for text extraction
- **winston** `^3.17.0` — Structured logging (though project uses custom `modules/logger.js`)
- **dayjs** + timezone/utc plugins — Date/time handling with Asia/Shanghai default
- **node-schedule** `^2.1.1` — Cron-based job scheduling
- **chokidar** `^3.5.3` — File watching for hot-reload
- **commander** `^14.0.3` — CLI argument parsing
- **uuid** `^9.0.0` — UUID generation
- **md5** `^2.3.0` — Hashing
- **turndown** `^7.2.1` — HTML to Markdown conversion

### Document Processing
- **mammoth** `^1.11.0` — .docx parsing
- **pdf-parse** `1.1.1` — PDF text extraction (pinned to avoid breakage)
- **exceljs** `^4.4.0` — Excel file processing
- **mailparser** `^3.7.4` — Email parsing
- **rss-parser** `^3.13.0` — RSS feed processing

### Dev & Quality
- **eslint** `^9.39.1` — JavaScript linting
- **stylelint** `^16.25.0` — CSS linting
- **pm2** `^6.0.11` — Process management (production deployment)

## Configuration System

- **Primary:** `config.env` — Flat key=value file (not .env standard; custom parser via `dotenv`)
- **Override:** `.env` — Standard dotenv fallback
- **Plugin config:** `toolApprovalConfig.json`, `agent_map.json`, `rag_params.json`
- **Runtime env vars:** `process.env.*` heavily used throughout

## Dependency Management

| Ecosystem | Tool | Lock File |
|-----------|------|-----------|
| Node.js | npm | `package-lock.json` |
| Python | Poetry | `poetry.lock` |
| Rust | Cargo | `Cargo.lock` |

## Build & Deployment

- **Docker:** `Dockerfile` + `docker-compose.yml` present
- **PM2:** Production process management
- **Windows installer:** `vcp-installer-source/` (Rust-based NSIS-like installer)
- **Scripts:** `scripts/` directory with OpenAPI export, MCP server starters

## Package Overrides

- `pdfjs-dist` pinned to `2.16.105` via npm overrides (compatibility with `pdf-parse`)
