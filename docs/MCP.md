# MCP server

`ghostwriter mcp` exposes the operations registry as [Model Context Protocol](https://modelcontextprotocol.io) tools: one tool per operation, same name, same strict input schema, same error codes as the CLI and the HTTP API. The tool list is generated from `src/service/operations.ts`; `tests/integration/surfaces-parity.test.ts` fails when a registry operation is missing here.

```bash
ghostwriter mcp --config config.json --state-dir ~/.local/state/ghostwriter          # stdio (default)
ghostwriter mcp --http --port 8788 --token-env GHOSTWRITER_API_TOKEN                  # streamable HTTP at /mcp
ghostwriter serve --mcp --token-env GHOSTWRITER_API_TOKEN                             # REST API and /mcp in one process
```

Claude Desktop / Claude Code style client entry (stdio):
```json
{ "mcpServers": { "ghostwriter": { "command": "ghostwriter", "args": ["mcp", "--config", "/path/config.json"] } } }
```

## Tools
| Tool | Writes | Open world | Input | Notes |
|---|---|---|---|---|
| `ingest` | yes (`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`) | no | `authorId`, `name`, `text` | replaces an earlier ingest of the same id; the only mutating tool; uses the state lock |
| `generate` | no | yes (calls the configured model) | `authorId`, `persona`, `text`, `exemplars?`, `maxTokens?`, `temperature?` | |
| `score` | no | yes if `detectors` are named (text is SENT to them) | `text`, `detectors?` | |
| `profile` | no | no | `authorId` | |
| `authors` | no | no | none | |
| `personas` | no | no | none | |
| `filters` | no | no | none | |
| `config_get` | no | no | none | redacted view, read-only |
| `capabilities` | no | no | none | operations and `pending` (humanize, Phase 8: not built) |

Results: on success `structuredContent` and the text content both hold `{ "ok": true, ...data }`, identical to `ghostwriter --json` and the HTTP body. A failure is a tool result with `isError: true` whose text content is `{ "ok": false, "error": { "code", "message" } }` (no `structuredContent`: clients validate that against the success `outputSchema`), with the same `code` as the other surfaces (table in [API.md](API.md#errors)); `_meta["ghostwriter/category"]` is one of `invalid_request`, `not_found`, `too_large`, `upstream`, `unavailable`, `denied`, `internal`. An unknown tool name is a protocol error (`InvalidParams`). A structurally malformed `tools/call` (for example `arguments: null`) is rejected by the SDK itself with `InvalidParams` and its own wording: schema paths and expected types, never the caller's values (the SDK's `Server` hard-wires that validation, so it is not replaced here).

## Transports
- **stdio**: `--host`, `--port`, `--token-env`, `--allow-origin`, `--allow-host`, `--max-body` and `--max-ingest-body` belong to `--http`; given without it, `ghostwriter mcp` refuses to start (`CONFIG_INVALID`) instead of ignoring them. stdout carries protocol frames only (this process writes nothing else there, not even with `--json`); logs go to stderr. End of input ends the session once every request already received has been answered (a one-shot `printf '<request>\n' | ghostwriter mcp` still gets its reply); SIGINT/SIGTERM stop immediately. A single message larger than the ingest cap (10 MiB) closes the connection.
- **streamable HTTP**: `POST /mcp`, stateless (a fresh server per request, JSON responses, no sessions to hijack). Clients must send `Content-Type: application/json` and `Accept: application/json, text/event-stream`. `GET`/`DELETE` are 405. One JSON-RPC message per request: a batch (array) is `400 USAGE`, because the SDK would run its elements concurrently under one concurrency slot. The body cap is the REST one: 1 MiB (`--max-body`) for every message except a `tools/call` of `ingest`, which may use `--max-ingest-body` (10 MiB); a larger message is `413`. Host/Origin checks, the bearer token, body/time/concurrency limits and security headers are the ones described in [API.md](API.md#threat-model-and-the-tokenless-default). `mcp --http` serves only `/mcp`; `serve --mcp` serves `/mcp` next to the REST routes.

## Untrusted inputs
Tool arguments come from a model that may have been steered by hostile text, so they are treated like internet input: validated against the operation's strict schema (`additionalProperties: false`; ids match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; names, persona keys and detector names reject control characters; numbers are bounded), reported without echoing the offending value, and never used as a path, command or URL. No tool accepts a path. Oversized text is stopped by the engine's size caps before any model call. Tests: `tests/unit/mcp/tools.test.ts` (rejection matrix, `__proto__`, path-like ids, no state-directory change), `tests/security/api-confidentiality.test.ts` (secrets in tool inputs never reach a result or the model).

## SDK pin and licence audit (2026-11-15)
`@modelcontextprotocol/sdk` is pinned to the exact version `1.32.2` (licence **MIT**, compatible with this project's Apache-2.0). The SDK is used through `server/index.js` (low-level `Server`: the registry owns validation and error mapping), `server/stdio.js`, `server/streamableHttp.js` and `types.js`. `@seriousme/openapi-schema-validator` `2.12.0` (MIT) is a dev dependency used only by the OpenAPI test.

Production dependency tree after this change (`package-lock.json`, 128 packages): 117 MIT, 7 ISC, 2 BSD-3-Clause (`fast-uri`, `qs`), 2 BSD-2-Clause (`json-schema-typed`, `webidl-conversions`). No GPL/AGPL/LGPL/MPL/SSPL/BUSL package is in the production tree. The SDK drags in HTTP framework packages it does not need for the entry points used here (`express`, `hono`, `cors`, `jose`, `eventsource`, ...); they are installed but not imported by this project, and every one is MIT/ISC/BSD. Development-only: `lightningcss` (MPL-2.0, via vite/vitest, present before this phase) is not shipped (`package.json` `files` publishes `dist` only). `npm audit` reported 0 vulnerabilities at install time. Re-run the audit when the SDK is bumped.
