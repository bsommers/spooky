# HTTP API

`ghostwriter serve` runs the operations over HTTP. The routes, request schemas and responses are generated from the operations registry (`src/service/operations.ts`); the machine-readable description is `GET /openapi.json` (OpenAPI 3.1). Nothing on this page is hand-maintained per route except the prose: `tests/integration/surfaces-parity.test.ts` fails when a registry operation is missing here.

```bash
export GHOSTWRITER_API_TOKEN="$(openssl rand -hex 24)"      # optional on loopback, see the threat model below
ghostwriter serve --config config.json --token-env GHOSTWRITER_API_TOKEN      # http://127.0.0.1:8787
curl -s -H "Authorization: Bearer $GHOSTWRITER_API_TOKEN" http://127.0.0.1:8787/api/personas
curl -s -H "Authorization: Bearer $GHOSTWRITER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"authorId":"ann","persona":"executive","text":"Draft to rewrite."}' http://127.0.0.1:8787/api/generate
```

## Routes
| Operation | Request | Success body (`{ "ok": true, ... }`) |
|---|---|---|
| `ingest` (writes state) | `POST /api/ingest` `{authorId, name, text}` | `profile` |
| `generate` | `POST /api/generate` `{authorId, persona, text, exemplars?, maxTokens?, temperature?}` | `text`, `trace`, `promptTokensEstimate` |
| `score` | `POST /api/score` `{text, detectors?}` | `score`, `local`, `members`, `excluded`, `trace`, `localOnly?` |
| `profile` | `GET /api/profile?authorId=ann` | `profile` |
| `authors` | `GET /api/authors` | `authors` |
| `personas` | `GET /api/personas` | `personas` |
| `filters` | `GET /api/filters` | `filters` |
| `config_get` | `GET /api/config` | `config` (redacted) |
| `capabilities` | `GET /api/capabilities` | `operations`, `pending` |
| (document) | `GET /openapi.json` | the OpenAPI 3.1 document |
| (opt-in) | `POST /mcp` with `serve --mcp` | MCP over streamable HTTP, see [MCP.md](MCP.md) |

`humanize` (Phase 8) is not built; it appears under `pending` in `capabilities` and has no route. Request fields are the registry's strict schemas: an unknown field, a path-like author id, a control character or a wrong type is `400 USAGE` with a path-qualified message. Text length limits are the engine's (`limits.maxInputChars`, 10 M characters for a corpus), reported as `413 INPUT_TOO_LARGE`.

## Errors
Body: `{ "ok": false, "error": { "code": "UNKNOWN_AUTHOR", "message": "..." } }`. The status comes from the one error table (`src/service/errors.ts`), shared with the CLI exit code and the MCP error result:

| code | HTTP | CLI exit | meaning |
|---|---|---|---|
| `USAGE` | 400 | 2 | input rejected by the schema, malformed JSON, bad query |
| `CONFIG_INVALID` | 400 | 2 | for example an unknown detector name |
| `UNAUTHORIZED` | 401 | - | missing or wrong bearer token (`WWW-Authenticate: Bearer`) |
| `FORBIDDEN` | 403 | - | `Origin` not allowed |
| `UNKNOWN_AUTHOR`, `UNKNOWN_PERSONA`, `NOT_FOUND` | 404 | 3 | |
| `METHOD_NOT_ALLOWED` | 405 | - | `Allow` header names the method |
| `REQUEST_TIMEOUT` | 408 | - | body not received within `readTimeoutMs` (30 s) |
| `INPUT_TOO_LARGE` | 413 | 6 | body over `--max-body`, or text over the engine limit |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | - | POST body must be `application/json` (utf-8) |
| `MISDIRECTED_REQUEST` | 421 | - | `Host` header does not name this server |
| `PROFILE_INVALID` | 422 | 2 | corpus yields no profile |
| `FILTER_FAILED`, `STORE_CORRUPT`, `INTERNAL`, `IO_ERROR` | 500 | 4, 7, 1, 1 | unexpected errors report the class name only |
| `LLM_FAILED`, `DETECTORS_FAILED` | 502 | 5, 9 | upstream failure |
| `STATE_LOCKED`, `OVERLOADED` | 503 | 8 | `OVERLOADED` carries `Retry-After: 1` |

## Options
`ghostwriter serve [--host 127.0.0.1] [--port 8787] [--token-env NAME] [--allow-origin URL]... [--allow-host NAME]... [--max-body BYTES] [--max-ingest-body BYTES] [--mcp] [--config FILE] [--state-dir DIR] [--json]`

- `--port 0` picks a free port; with `--json` the startup document `{"ok":true,"listening":{"host","port","url","api","mcp","auth"}}` is printed on stdout (the "listening on" line goes to stderr).
- `--token-env NAME`: the NAME of the environment variable holding the bearer token (16 to 512 printable characters). The token is never taken from the command line. If the variable is unset or empty the server does not start (it never silently falls back to "no token").
- `--host`: anything but a loopback address needs `--token-env`, otherwise the server refuses to start (`CONFIG_INVALID`, exit 2).
- `--allow-origin`: an exact browser origin (`http://localhost:5173`) that may call the API cross-origin. Never `*`, never `null`, no paths.
- `--max-body`: request body cap in bytes for every route except ingest (default 1 MiB); `--max-ingest-body`: cap for `ingest` and `/mcp` (default 10 MiB). Both range from 1 KiB to 256 MiB. A body over the cap is 413 before it is read. (The engine accepts corpora up to 10 M characters, up to 40 MB of UTF-8; raise `--max-ingest-body` if you ingest more than 10 MiB through the API, or ingest with the CLI.)
- Defaults you cannot change from the command line: 30 s to receive a request, 8 operations in flight (the ninth gets 503), 16 KiB of headers.

## Threat model and the tokenless default
The service sits in front of an LLM key and a private corpus. Threats and what stops them:

| Threat | Mitigation |
|---|---|
| A web page in your browser calls `http://127.0.0.1:8787` (CSRF) | `Origin` must be absent, this server, or allow-listed (else 403); POST must be `application/json` (a cross-site form post is 415); no `Access-Control-Allow-Origin` unless allow-listed, never `*` |
| DNS rebinding (a hostile name resolving to 127.0.0.1) | `Host` must be `localhost`, `127.0.0.1`, `[::1]`, the bind host or `--allow-host`, else 421 |
| Network exposure | bind `127.0.0.1` by default; a non-loopback bind requires a token |
| Huge or slow bodies | `Content-Length` over the cap is 413 before a byte is read; streamed bodies are counted and cut at the cap; 408 for a stalled body; 503 beyond the concurrency limit |
| Secrets in responses, logs or errors | the confidentiality filter runs on input and output; the access log prints method, a known route, status, time (never a query, header, body or unknown path); unexpected errors name only their class; the token is compared in constant time and never echoed; an unknown author or persona is not echoed back |
| Prompt-injected agent calling the API/MCP | tools take author ids, never paths; only `ingest` writes, through the existing state lock |

**Residual risk, stated plainly: without a token, any process on this machine that can open a socket to the port can use the server** (read profiles, spend your LLM quota, ingest). Loopback-only does not separate local users or local malware. The default is tokenless on loopback for convenience (decided in [SURFACES.md](SURFACES.md#decisions-decided-2026-11-15-user-accepted-the-recommended-option-for-all-five)); the server prints a note at startup, and the recommendation is to set `--token-env` whenever the machine is shared or the port is forwarded. Plain HTTP: put TLS in front before exposing the service beyond a trusted network. `config get` is read-only; there is no `config set`.
