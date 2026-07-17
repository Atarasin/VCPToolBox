# M0-M7 implementation closure

The M0-M7 refactor preserves the 15 REST paths, eight MCP tools, response envelopes,
environment variables, HTTP/stdio batch rejection, WebSocket batch limit, and serial
recall rule execution. Legacy module paths remain CommonJS re-export entrypoints for at
least one release.

Audit output defaults to the existing console format. `AGENT_GATEWAY_AUDIT_FILE` adds an
append-only file sink; directory creation and sink failures are isolated. Rotation is
intentionally delegated to container logging or external `logrotate`. The composition
bootstrap registers a process `beforeExit` flush for pending asynchronous sink writes.

D5 is waived for this refactor. Jobs remain process-local because there is no current
cross-process consumer. A future multi-instance requirement must separately define the
state model, persistence lifecycle, ownership, and consistency guarantees before adding
a store injection point.

M8 remains out of scope. Rule concurrency and HTTP/stdio batch behavior require a
separate compatibility decision and performance review.
