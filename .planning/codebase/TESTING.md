# Testing

**Date:** 2026-04-24

## Test Framework

- **Node.js Built-in Test Runner** (`node --test`) — Primary framework
- No external test framework (Jest, Mocha, Vitest) installed
- Tests use `node:assert` for assertions

## Test Structure

```
test/
├── agent-gateway/              # Agent Gateway comprehensive tests
│   ├── adapters/
│   │   ├── agent-gateway-mcp-adapter.test.js
│   │   └── agent-gateway-mcp-transport.test.js
│   ├── contracts/
│   │   ├── agent-gateway-contract-publishing.test.js
│   │   └── agent-gateway-contracts-infra.test.js
│   ├── examples/
│   │   └── agent-gateway-node-client.test.js
│   ├── policy/
│   │   └── agent-gateway-auth-policy.test.js
│   ├── routes/
│   │   └── agent-gateway-routes.test.js
│   ├── services/
│   │   ├── agent-gateway-agent-registry.test.js
│   │   ├── agent-gateway-capability-service.test.js
│   │   ├── agent-gateway-context-runtime.test.js
│   │   ├── agent-gateway-job-runtime.test.js
│   │   ├── agent-gateway-memory-runtime.test.js
│   │   ├── agent-gateway-operability.test.js
│   │   └── agent-gateway-tool-runtime.test.js
│   └── helpers/
│       ├── agent-gateway-test-helpers.js
│       └── mcp-transport-fixture-runtime.js
├── rag-params/                 # RAG parameter evaluation tests
│   ├── time-decay.test.js
│   ├── vector-dimension-guard.test.js
│   ├── dailynote-eval-data.test.js
│   └── dynamic-params.test.js
└── helpers/                    # Shared test utilities
```

## Test Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run RAG parameter tests |
| `npm run test:rag-params` | RAG parameter test suite |
| `npm run test:agent-gateway-contracts` | Agent gateway contract tests |
| `npm run test:agent-gateway-mcp-transport` | MCP transport tests |

## Evaluation Framework

Located in `eval/`:
- **Mock evaluations:** `eval/mock-run-eval.js`
- **Real evaluations:** `eval/real-run-eval.js`
- **Scoring:** `eval/score-rag-eval.js`
- **Comparison:** `eval/compare-rag-eval.js`
- **Gating:** `eval/gate-rag-eval.js`

Evaluation commands:
- `npm run eval:all` — Full mock evaluation pipeline
- `npm run eval:all:real` — Full real evaluation pipeline
- `npm run eval:compare` — Compare baseline vs candidate
- `npm run eval:gate` — Pass/fail gate check

## Coverage

- No formal coverage measurement configured (no nyc, c8, or similar)
- Test coverage appears focused on:
  - Agent Gateway services (most comprehensive)
  - RAG parameter algorithms
  - Contract publishing and MCP transport

## Mocking

- Custom fixture runtime: `test/agent-gateway/helpers/mcp-transport-fixture-runtime.js`
- Mock eval runner for safe parameter testing without live APIs
- Baseline/candidate pattern for A/B evaluation of RAG parameters

## CI/CD

- `.github/` directory present — GitHub Actions workflows expected
- No local CI configuration visible in root
