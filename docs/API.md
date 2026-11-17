# HTTP API

`ghostwriter serve` runs the operations over HTTP. The routes, request schemas and responses are generated from the operations registry (`src/service/operations.ts`); the machine-readable description is `GET /openapi.json` (OpenAPI 3.1). Nothing on this page is hand-maintained per route except the prose: `tests/integration/surfaces-parity.test.ts` fails when a registry operation is missing here.

```bash
export GHOSTWRITER_API_TOKEN="$(openssl rand -hex 24)"      # optional on loopback, see the threat model below
ghostwriter serve --config config.json --token-env GHOSTWRITER_API_TOKEN      # http://127.0.0.1:8787
curl -s -H "Authorization: Bearer $GHOSTWRITER_API_TOKEN" http://127.0.0.1:8787/api/personas
curl -s -H "Authorization: Bearer $GHOSTWRITER_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"authorId":"ann","persona":"executive","text":"Draft to rewrite."}' http://127.0.0.1:8787/api/generate
```

## Generate: two modes
`mode` is `"rewrite"` (default; `text` is a draft to rewrite) or `"topic"` (`text` is the topic and the model writes NEW text about it in the author's voice). `notes` (facts and source material you supply) and `length` (`short`, `medium`, `long`) are topic-only: sending either without `"mode":"topic"` is `400 USAGE`. The topic and the notes are each capped at `limits.maxInputChars` (`413 INPUT_TOO_LARGE`) and redacted by the fail-closed confidentiality filter before the model sees them. A topic result carries `"mode":"topic"` and a fixed `caveat`: **there is no web search or research; the text is written from the topic, the notes and the model's own knowledge, facts are not verified, and it may state things that are wrong.** A rewrite result has `"mode":"rewrite"` and no `caveat`. The same fields exist on the MCP tool, the CLI (`--topic`, `--notes-file`, `--length`) and in `GET /openapi.json`.

```bash
curl -s -H 'Content-Type: application/json' \
  -d '{"authorId":"ann","persona":"executive","text":"Why small teams ship faster","mode":"topic","notes":"The team shipped 12 releases in 2024.","length":"short"}' http://127.0.0.1:8787/api/generate
```

## Routes
| Operation | Request | Success body (`{ "ok": true, ... }`) |
|---|---|---|
| `ingest` (writes state) | `POST /api/ingest` `{authorId, name, text}` | `profile` |
| `generate` | `POST /api/generate` `{authorId, persona, text, mode?, notes?, length?, exemplars?, maxTokens?, temperature?, humanize?, target?}` | `text`, `trace`, `promptTokensEstimate`, `mode`, `caveat?` (topic mode) |
| `humanize` | `POST /api/humanize` `{text, authorId?, target?, maxIterations?, llm?}` | `text`, `initialScore`, `finalScore`, `reachedTarget`, `iterations`, `llmCalls`, `guardRejections`, `featureDeltas`, `featuresBefore`, `featuresAfter`, `steps`, `trace`, `caveat` |
| `score` | `POST /api/score` `{text, detectors?}` | `score`, `local`, `members`, `excluded`, `trace`, `localOnly?` |
| `profile` | `GET /api/profile?authorId=ann` | `profile` |
| `authors` | `GET /api/authors` | `authors` |
| `personas` | `GET /api/personas` | `personas` |
| `filters` | `GET /api/filters` | `filters` |
| `config_get` | `GET /api/config` | `config` (redacted; `stateDir` is the state directory path, absent when in memory) |
| `capabilities` | `GET /api/capabilities` | `operations`, `pending` |
| (document) | `GET /openapi.json` | the OpenAPI 3.1 document |
| (opt-in) | `POST /mcp` with `serve --mcp` | MCP over streamable HTTP, see [MCP.md](MCP.md) |

`GET /openapi.json` is generated per running server: `servers` is the address it actually bound (`--host/--port`, so `--port 0` shows the real port), `security` is `[{bearer: []}]` with a `bearer` scheme and 401/429 responses when `--token-env` is set (and empty, with no scheme, when it is not), and `408/413/415` are listed for the POST operations only. The document is behind the token like every other route.

`humanize` (Phase 8, [HUMANIZING.md](HUMANIZING.md)) sends the redacted text to the configured model unless `llm` is `false`, so it costs up to `maxIterations` logical model calls (each retried by the transport on transient errors); its `caveat` field states that the scores are from a weak local heuristic (held-out AUC 0.694), not a detector verdict. `pending` in `capabilities` is empty now that nothing is planned-but-unbuilt. Request fields are the registry's strict schemas: an unknown field, a path-like author id, a control character or a wrong type is `400 USAGE` with a path-qualified message. Text length limits are the engine's (`limits.maxInputChars`, 10 M characters for a corpus), reported as `413 INPUT_TOO_LARGE`.

## Errors
Body: `{ "ok": false, "error": { "code": "UNKNOWN_AUTHOR", "message": "..." } }`. The status comes from the one error table (`src/service/errors.ts`), shared with the CLI exit code and the MCP error result:

| code | HTTP | CLI exit | meaning |
|---|---|---|---|
| `USAGE` | 400 | 2 | input rejected by the schema, malformed JSON, bad query |
| `CONFIG_INVALID` | 400 | 2 | for example an unknown detector name |
| `UNAUTHORIZED` | 401 | - | missing or wrong bearer token (`WWW-Authenticate: Bearer`) |
| `RATE_LIMITED` | 429 | - | too many wrong tokens from this address; `Retry-After` says when to retry |
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
`ghostwriter serve [--host 127.0.0.1] [--port 8787] [--token-env NAME] [--allow-origin URL]... [--allow-host NAME]... [--max-body BYTES] [--max-ingest-body BYTES] [--mcp] [--ui-dir DIR | --no-ui] [--config FILE] [--state-dir DIR] [--json]`

- `--port 0` picks a free port; with `--json` the startup document `{"ok":true,"listening":{"host","port","url","api","mcp","auth"}}` is printed on stdout (the "listening on" line goes to stderr).
- `--token-env NAME`: the NAME of the environment variable holding the bearer token (16 to 512 printable characters with at least 8 distinct characters and some variety, so `aaaaaaaaaaaaaaaa` is refused; make one with `openssl rand -hex 24`). The token is never taken from the command line. The name must be upper-case words joined by underscores (`GHOSTWRITER_API_TOKEN`; never `PATH`, `HOME`), and may not be another system's credential (`AWS_*`, `GITHUB_*`, `*_SECRET`, ...), a model/provider key (`ANTHROPIC_*`, `OPENAI_*`) or the variable the config names as an LLM or detector `apiKeyEnv`. If the variable is unset or empty the server does not start (it never silently falls back to "no token"). Error messages never repeat the name, so a token pasted in its place is not copied into a log.
- `--host`: anything but a loopback address needs `--token-env`, otherwise the server refuses to start (`CONFIG_INVALID`, exit 2).
- `--allow-host NAME`: an extra Host header name to accept (`example.com` or `example.com:8787`; the check compares names, not ports). A malformed value stops the server from starting.
- `--allow-origin`: an exact browser origin (`http://localhost:5173`) that may call the API cross-origin. Never `*`, never `null`, no paths.
- `--ui-dir DIR` / `--no-ui`: the web UI ([UI.md](UI.md)) is served at `/` from `ui/dist` next to the package when it is built (static, public, never token-protected; the API behind it is). `--ui-dir` picks another build and fails with exit 2 if it holds no `index.html`; `--no-ui` serves the API only. `serve` prints `web UI at /` when it is on, and `mcp --http` never serves it.
- `--max-body`: request body cap in bytes for every route except ingest (default 1 MiB); `--max-ingest-body`: cap for `ingest` and for an MCP `tools/call` of `ingest` (default 10 MiB); any other `/mcp` message is held to `--max-body` after it is read. Both range from 1 KiB to 256 MiB. A body over the cap is 413 before it is read. (The engine accepts corpora up to 10 M characters, up to 40 MB of UTF-8; raise `--max-ingest-body` if you ingest more than 10 MiB through the API, or ingest with the CLI.)
- Defaults you cannot change from the command line: 30 s to receive a request, 8 operations in flight (the ninth gets 503), 16 KiB of headers, 256 open connections (more are dropped; unauthenticated sockets are also cut off by the 30 s request timeout). A concurrency slot is held until the operation has FINISHED, not until the socket closes: a client that sends a request and hangs up keeps its slot (the model call is not cancelled), so dropped connections cannot start more work than the cap. The same holds for `/mcp`.

## Threat model and the tokenless default
The service sits in front of an LLM key and a private corpus. Threats and what stops them:

| Threat | Mitigation |
|---|---|
| A web page in your browser calls `http://127.0.0.1:8787` (CSRF) | `Origin` must be absent, this server, or allow-listed (else 403); POST must be `application/json` (a cross-site form post is 415); no `Access-Control-Allow-Origin` unless allow-listed, never `*` |
| DNS rebinding (a hostile name resolving to 127.0.0.1) | `Host` must be `localhost`, `127.0.0.1`, `[::1]`, the bind host or `--allow-host`, else 421 |
| Guessing the token | the token is compared in constant time; after 3 wrong tokens from one address each further answer is delayed (250 ms, doubling, up to 4 s) and 20 wrong tokens within 60 s lock that address out for 60 s with `429` + `Retry-After` (even the right token is refused meanwhile). A request with no `Authorization` header is not counted. Every local process shares `127.0.0.1`, so a local guesser also locks out the local user for that minute |
| Network exposure | bind `127.0.0.1` by default; a non-loopback bind requires a token |
| Probing for what exists | with a token, `/api/*`, `/openapi.json` and `/mcp` answer `401` to every caller without it, whether the route exists or `--mcp` is on; only then 404. A request target must be a single-slash absolute path: `//host/path` and backslashes are `400`, so a path is never read differently from what the client sent |
| Huge or slow bodies | `Content-Length` over the cap is 413 before a byte is read; streamed bodies are counted and cut at the cap; 408 for a stalled body; 503 beyond the concurrency limit |
| Secrets in responses, logs or errors | the confidentiality filter runs on input and output; the access log prints method, a known route, status, time (never a query, header, body or unknown path); unexpected errors name only their class; the token is compared in constant time and never echoed; an unknown author or persona is not echoed back |
| Prompt-injected agent calling the API/MCP | tools take author ids, never paths; only `ingest` writes, through the existing state lock |

**Residual risk, stated plainly: without a token, any process on this machine that can open a socket to the port can use the server** (read profiles, spend your LLM quota, ingest). Loopback-only does not separate local users or local malware. The default is tokenless on loopback for convenience (decided in [SURFACES.md](SURFACES.md#decisions-decided-2026-11-15-user-accepted-the-recommended-option-for-all-five)); the server prints a note at startup, and the recommendation is to set `--token-env` whenever the machine is shared or the port is forwarded. Plain HTTP: put TLS in front before exposing the service beyond a trusted network. `config get` is read-only; there is no `config set`.
