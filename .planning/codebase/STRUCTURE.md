# Structure

**Date:** 2026-04-24

## Directory Layout

```
VCPToolBox/
│
├── server.js                    # Main HTTP/SSE server entry
├── adminServer.js               # Admin panel backend
├── Plugin.js                    # Plugin runtime engine
├── WebSocketServer.js           # Distributed WebSocket protocol
├── FileFetcherServer.js         # Cross-node file fetching
├── KnowledgeBaseManager.js      # RAG / vector / tag memory
├── EmbeddingUtils.js            # Embedding generation utilities
├── TagMemoEngine.js             # Tag-based memory engine
├── ResidualPyramid.js           # Residual pyramid algorithm
├── ResultDeduplicator.js        # Result deduplication
├── TextChunker.js               # Text chunking for RAG
├── EPAModule.js                 # EPA (External Process Agent) module
├── modelRedirectHandler.js      # Multi-provider AI routing
├── vcpInfoHandler.js            # VCP info/status endpoint
├── WorkerPool.js                # Worker thread pool
│
├── modules/                     # Reusable backend modules
│   ├── logger.js                # Rotating file logger
│   ├── messageProcessor.js      # Message transformation
│   ├── roleDivider.js           # Role separation logic
│   ├── contextManager.js        # Conversation context
│   ├── chatCompletionHandler.js # LLM completion proxy
│   ├── toolboxManager.js        # Tool registry
│   ├── agentManager.js          # Agent lifecycle
│   ├── toolApprovalManager.js   # Tool execution gating
│   ├── associativeDiscovery.js  # Associative memory
│   ├── tvsManager.js            # TVS (Text Variable System)
│   ├── captchaDecoder.js        # CAPTCHA solving
│   ├── agentGateway/            # Agent gateway modular system
│   │   ├── index.js             # Gateway module exports
│   │   ├── services/            # Core services
│   │   ├── adapters/            # Transport adapters (MCP, etc.)
│   │   ├── contracts/           # API contracts
│   │   ├── policy/              # Auth/policy rules
│   │   └── infra/               # Infrastructure concerns
│   ├── vcpLoop/                 # VCP execution loop
│   │   ├── toolCallParser.js
│   │   └── toolExecutor.js
│   ├── SSHManager/              # SSH remote execution
│   └── handlers/
│       └── streamHandler.js
│
├── routes/                      # Express route definitions
│   ├── dailyNotesRoutes.js
│   ├── specialModelRouter.js
│   ├── adminPanelRoutes.js
│   ├── agentGatewayRoutes.js
│   ├── searchWorker.js
│   ├── forumApi.js
│   ├── taskScheduler.js
│   └── admin/                   # Admin sub-routes
│
├── Plugin/                      # 100+ plugins (one directory each)
│   ├── UserAuth/                # Authentication plugin
│   ├── DailyNote/               # Daily note management
│   ├── DailyNoteManager/
│   ├── DailyNotePanel/
│   ├── DailyNoteWrite/
│   ├── AgentAssistant/
│   ├── AgentDream/
│   ├── AgentMessage/
│   ├── MagiAgent/
│   ├── StoryOrchestrator/
│   ├── NovelWorkflowOrchestrator/
│   ├── VCPTaskAssistant/
│   ├── VCPCommunity/
│   ├── VCPForum/
│   ├── VCPForumAssistant/
│   ├── VCPLog/
│   ├── VCPCommunityAssistant/
│   ├── VCPTavern/
│   ├── VCPEverything/
│   ├── VSearch/
│   ├── LightMemo/
│   ├── TagFolder/
│   ├── ThoughtClusterManager/
│   ├── WorkspaceInjector/
│   ├── ToolBoxFoldMemo/
│   ├── FlashDeepSearch/
│   ├── DeepWikiVCP/
│   ├── FileServer/
│   ├── FileOperator/
│   ├── FileTreeGenerator/
│   ├── FileListGenerator/
│   ├── ImageServer/
│   ├── ImageProcessor/
│   ├── FluxGen/
│   ├── ComfyCloudGen/
│   ├── ComfyUIGen/
│   ├── ZImageGen/
│   ├── ZImageGen2/
│   ├── ZImageTurboGen/
│   ├── NanoBananaGen2/
│   ├── NanoBananaGenOR/
│   ├── NovelAIGen/
│   ├── DMXDoubaoGen/
│   ├── DoubaoGen/
│   ├── QwenImageGen/
│   ├── GeminiImageGen/
│   ├── GrokVideo/
│   ├── SunoGen/
│   ├── VideoGenerator/
│   ├── WebUIGen/
│   ├── PyCameraCapture/
│   ├── PyScreenshot/
│   ├── ChromeBridge/
│   ├── CapturePreprocessor/
│   ├── EmojiListGenerator/
│   ├── ArxivDailyPapers/
│   ├── CrossRefDailyPapers/
│   ├── PubMedSearch/
│   ├── NCBIDatasets/
│   ├── KEGGSearch/
│   ├── PaperReader/
│   ├── DailyHot/
│   ├── WeatherInfoNow/
│   ├── WeatherReporter/
│   ├── ScheduleManager/
│   ├── ScheduleBriefing/
│   ├── SerpSearch/
│   ├── TavilySearch/
│   ├── GoogleSearch/
│   ├── FlashDeepSearch/
│   ├── BilibiliFetch/
│   ├── XiaohongshuFetch/
│   ├── FeishuBridge/
│   ├── WeChatPublisher/
│   ├── IMAPIndex/
│   ├── IMAPSearch/
│   ├── SnowBridge/
│   ├── SynapsePusher/
│   ├── SVCardFinder/
│   ├── TarotDivination/
│   ├── Randomness/
│   ├── SciCalculator/
│   ├── JapaneseHelper/
│   ├── ArtistMatcher/
│   ├── AnimeFinder/
│   ├── CodeSearcher/
│   ├── ProjectAnalyst/
│   ├── LinuxShellExecutor/
│   ├── PowerShellExecutor/
│   ├── LinuxLogMonitor/
│   ├── FRPSInfoProvider/
│   ├── 1PanelInfoProvider/
│   ├── MCPO/
│   ├── MCPOMonitor/
│   ├── VCPToolBridge/
│   ├── RAGDiaryPlugin/
│   └── ... (more)
│
├── AdminPanel/                  # Web admin frontend
│   ├── js/
│   └── docs/
│
├── rust-vexus-lite/             # Rust N-API vector engine
│   ├── Cargo.toml
│   └── src/
│
├── vcp-installer-source/        # Rust Windows installer
│   └── src/
│
├── dailynote/                   # Daily note content storage
├── VectorStore/                 # Vector index storage
├── image/                       # Media assets
├── file/                        # Document storage
├── data/                        # Runtime data
├── test/                        # Test suites
│   ├── agent-gateway/           # Agent gateway tests
│   ├── rag-params/              # RAG parameter tests
│   └── helpers/
├── eval/                        # Evaluation framework
│   ├── reports/
│   ├── results/
│   └── VectorStore_baseline/
├── scripts/                     # Build/utility scripts
├── docs/                        # Documentation
├── mydoc/                       # Developer documentation
├── openspec/                    # OpenSpec workflow
│   ├── config.yaml
│   ├── specs/
│   └── changes/
├── examples/                    # Usage examples
├── DebugLog/                    # Runtime logs
│   ├── chat/
│   └── archive/
├── .claude/                     # Claude Code configuration
├── .trae/                       # Trae IDE configuration
├── .sisyphus/                   # Sisyphus notes/plans
├── VCPAsyncResults/             # Async operation results
├── VCPChrome/                   # Chrome extension
├── OpenWebUISub/                # OpenWebUI integration
├── SillyTavernSub/              # SillyTavern integration
├── VCPTimedContacts/            # Timed contact scheduler
├── TVStxt/                      # TVS text storage
└── Agent/                       # Agent data directory
```

## Key File Locations

| Concern | Location |
|---------|----------|
| Main config | `config.env` |
| Package manifest | `package.json` |
| Python deps | `pyproject.toml` / `requirements.txt` |
| Rust deps | `rust-vexus-lite/Cargo.toml` |
| Docker config | `Dockerfile`, `docker-compose.yml` |
| OpenAPI spec | `openapi.yaml` |
| Plugin manifest example | `agent_map.json.example` |
| Tool approval config | `toolApprovalConfig.json` |
| IP blacklist | `ip_blacklist.json` |
| Preprocessor order | `preprocessor_order.json` |
| Log output | `DebugLog/` |
| Daily notes | `dailynote/` |

## Naming Conventions

- **Core files:** PascalCase (`Plugin.js`, `WebSocketServer.js`)
- **Modules:** camelCase (`messageProcessor.js`, `toolboxManager.js`)
- **Routes:** camelCase ending in `Routes.js` or `Router.js`
- **Plugins:** PascalCase directory names (`Plugin/DailyNote/`, `Plugin/AgentAssistant/`)
- **Plugin manifests:** `plugin-manifest.json`
- **Tests:** `*.test.js` or `test-*.js`
- **Config files:** kebab-case or camelCase
