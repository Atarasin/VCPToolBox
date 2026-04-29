# T02: 03-mcp-protocol-compliance 02

**Slice:** S03 — **Milestone:** M001

## Description

Prove that the real MCP lifecycle works correctly over the remote WebSocket transport and clean up any initialize metadata that is now transport-inaccurate.

Purpose: Make remote MCP clients able to handshake confidently against `/mcp` without inventing a parallel websocket-specific lifecycle contract.
Output: transport-correct initialize metadata plus real-harness websocket tests for `initialize`, repeated `notifications/initialized`, and `ping`.

## Must-Haves

- [ ] "Remote websocket clients can complete the real MCP lifecycle: `initialize` -> `notifications/initialized` -> `ping`"
- [ ] "`initialize` returns protocol version, capabilities, and server info from the canonical backend-proxy harness rather than a websocket-only fork"
- [ ] "`notifications/initialized` remains idempotent and silent, and `ping` returns a healthy `{}` response over websocket"
- [ ] "Initialize metadata does not misdescribe the transport as stdio-only"

## Files

- `modules/agentGateway/adapters/mcpBackendProxyAdapter.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-websocket.test.js`
- `test/agent-gateway/adapters/agent-gateway-mcp-transport.test.js`
