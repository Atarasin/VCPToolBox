# Phase 6 Research: HTTP Compatibility Layer

**Date:** 2026-04-26
**Phase:** 06-http-compatibility-layer

## Summary

Phase 6 should be an additive transport layer, not a business-logic rewrite. The project already has the right ingredients: a shared backend-proxy MCP harness, existing dedicated auth rules, mature Express routing, and codebase-standard SSE helpers. The safest plan is to add a canonical Streamable HTTP transport on `/mcp` for Trae and similar clients, then add a separate deprecated SSE compatibility endpoint for older HTTP+SSE consumers.

## Findings

### 1. Trae compatibility makes Streamable HTTP the first-class target

From the archived validation notes and current client constraints:
- Trae does not currently support MCP over WebSocket
- Trae does support `stdio`, `SSE`, and `Streamable HTTP`

Implication:
- Phase 6 should optimize for Streamable HTTP first because it is the modern MCP HTTP transport and the shortest path to native Trae remote compatibility
- SSE compatibility is still valuable, but it should be positioned as backward compatibility rather than the primary surface

### 2. The existing MCP business runtime is already transport-agnostic enough

From `modules/agentGateway/mcpStdioServer.js` and `modules/agentGateway/mcpWebSocketServer.js`:
- both stdio and WebSocket already converge on `initializeBackendProxyMcpRuntime()`
- the shared runtime yields one `harness.handleRequest(request)` contract
- transport code owns framing, lifecycle, auth context injection, and request serialization

Implication:
- HTTP transport can follow the same architectural boundary:
  - transport layer handles HTTP method semantics, session IDs, auth extraction, and SSE framing
  - shared harness continues to own MCP lifecycle and capability behavior

### 3. Existing Express and SSE patterns reduce the amount of new machinery

From `routes/agentGatewayRoutes.js` and `publishedOpenApiDocument.js`:
- Agent Gateway already exposes an SSE endpoint at `/agent_gateway/events/stream`
- the route stack already knows how to set `text/event-stream`, flush headers, and write named SSE events
- tests already verify SSE behavior on the native event stream

Implication:
- Phase 6 does not need to invent SSE handling conventions from scratch
- transport code can reuse established response-shaping patterns and existing route test styles

### 4. MCP spec guidance favors dual publishing: canonical Streamable HTTP plus optional SSE compatibility

From the MCP transport docs queried through Context7:
- Streamable HTTP uses HTTP `POST` and `GET`
- the server may assign `MCP-Session-Id` during initialization
- follow-up requests should use that session ID
- servers may preserve backward compatibility by hosting deprecated HTTP+SSE endpoints alongside Streamable HTTP
- separate URLs are supported and simpler than overloading one path

Implication:
- the cleanest design is:
  - canonical Streamable HTTP on `/mcp`
  - deprecated SSE compatibility on a separate route such as `/sse` or `/mcp/sse`
- follow-up request validation should reject unknown or missing session IDs unless the request is a fresh `initialize`

### 5. `/mcp` can host HTTP and WebSocket together if route ownership stays clear

From `server.js`, `WebSocketServer.js`, and `mcpWebSocketServer.js`:
- `/mcp` is already reserved for MCP semantics
- WebSocket uses the HTTP upgrade path, which is separate from normal Express `POST`/`GET` handling
- the current `/mcp` WebSocket flow is intentionally isolated from the legacy mesh

Implication:
- adding Express `POST /mcp` and `GET /mcp` handlers should be compatible with the existing WebSocket upgrade handler, provided:
  - normal HTTP requests stay in Express
  - `Upgrade: websocket` continues to be intercepted by the websocket server
- this preserves a single canonical MCP URL for HTTP and WebSocket aware clients

### 6. Session state should be transport-local, lightweight, and disposable

From the MCP spec guidance and existing VCP architecture memories:
- Streamable HTTP sessions are a transport concern
- the backend-proxy harness should stay stateless with respect to transport session maps
- prior VCP architecture guidance prefers thin adapters over duplicating canonical contract state

Implication:
- a new HTTP transport module should own:
  - session ID generation
  - session map lifecycle
  - optional cleanup/expiry policy
  - any per-session transport metadata needed to inject canonical request context
- it should not push mutable session state into `createBackendProxyMcpServerHarness()`

### 7. Verification should be parity-based, not feature-exhaustive

From the completed stdio and WebSocket phases:
- the project already validated the important remote capability surface with representative methods:
  - `initialize`
  - `notifications/initialized`
  - `tools/list`
  - `prompts/get`
  - representative memory tool calls

Implication:
- Phase 6 tests should mirror that same representative parity set over HTTP transports
- this keeps scope tight while still proving Trae-ready compatibility

## Recommended Planning Split

### Plan 06-01
- Add canonical Streamable HTTP transport on `/mcp`
- Introduce session creation and validation via `MCP-Session-Id`
- Reuse dedicated auth and backend-proxy runtime bootstrap
- Add parity tests for initialize/lifecycle/capabilities over HTTP

### Plan 06-02
- Add deprecated SSE compatibility surface on a separate URL
- Keep it thin and explicitly compatibility-only
- Add parity tests for SSE compatibility flow plus docs/config examples for Trae and other HTTP clients

## Constraints To Preserve

- Do not regress existing stdio behavior
- Do not regress the existing `/mcp` WebSocket upgrade path
- Do not duplicate MCP capability logic outside the shared backend-proxy harness
- Do not broaden scope into job events, durable replay, or generalized server-push features beyond what the transport contract requires
