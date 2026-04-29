# T01: 03-mcp-protocol-compliance 01

**Slice:** S03 — **Milestone:** M001

## Description

Upgrade the dedicated `/mcp` websocket manager from single-request-only JSON-RPC handling to protocol-correct WebSocket framing with bounded batch support.

Purpose: Close the largest Phase 3 gap without changing Gateway Core business logic or stdio behavior.
Output: Updated `mcpWebSocketServer.js` batch handling plus endpoint tests that prove WebSocket frame semantics and batch correctness.

## Must-Haves

- [ ] "WebSocket MCP continues to treat one text frame as one JSON-RPC envelope while adding bounded batch-array support"
- [ ] "Batch support is WebSocket-only and does not change stdio transport behavior"
- [ ] "Batch responses preserve request-item order, omit notification-only entries, and reject empty or oversized batches deterministically"

## Files

- `modules/agentGateway/mcpWebSocketServer.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
