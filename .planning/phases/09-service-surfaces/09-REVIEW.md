---
phase: 09-service-surfaces
reviewed: 2026-11-15T14:40:00Z
depth: deep
files_reviewed: 17
files_reviewed_list:
  - src/api/auth.ts
  - src/api/limits.ts
  - src/api/server.ts
  - src/cli/serve.ts
  - src/cli/mcp.ts
  - src/cli/main.ts
  - src/mcp/server.ts
  - src/mcp/tools.ts
  - src/service/errors.ts
  - src/service/openapi.ts
  - src/service/operations.ts
  - src/service/runtime.ts
  - src/service/schemas.ts
  - docs/API.md
  - docs/MCP.md
  - tests/integration/surfaces-parity.test.ts
  - tests/security/api-guards.test.ts
findings:
  critical: 2
  warning: 7
  info: 7
  total: 16
status: issues_found
---

# Phase 9: Code Review Report

**Reviewed:** 2026-11-15
**Depth:** deep (server built to a scratch dir and probed with curl/nc; mutation runs on a scratch copy; source untouched)

## Summary

Core HTTP guards hold up under live probing: bearer compare (sha256 + timingSafeEqual), Host 421 (incl. duplicate Host), Origin 403 (foreign/`null`), CORS only for allow-listed origins, 415 on non-JSON, 413 on declared and chunked oversize, 408 on a stalled body (observed at 30 s), strict-schema rejection of `__proto__` (JSON body, query, detectors), repeated query keys, path variants all 404, startup refusal (0.0.0.0, ::, "", 127.1, short/unset token, `*` origin). No ingest path takes a file path from a remote caller (authorId regex anchored, text only). Licence/pin claims in docs/MCP.md verified (sdk 1.32.2 exact, 128 prod packages, 117 MIT/7 ISC/2 BSD-3/2 BSD-2, `npm audit --omit=dev` = 0).

But the advertised concurrency cap is trivially defeated (two ways), stdio drops in-flight replies at EOF, and the parity test is partly tautological.

## Critical Issues

### CR-01: Concurrency cap released on socket close, not on operation completion (cap bypass)

**File:** `src/api/server.ts:432-433, 458-459` (release at `res.once('close', release)`), `src/api/limits.ts:224-232`
**Issue:** The slot is freed when the response/socket closes. A client that sends a full request and drops the connection frees its slot immediately while the handler (an LLM call for `generate`, a detector call for `score`, a 10 MiB `ingest`) keeps running. Repro (scratch script against the built server, `maxConcurrent: 2`, handler sleeping 1.5 s): 10 fire-and-abort POSTs -> `started 10, peak concurrent handlers 10`. An authenticated (or, in tokenless default, any local) caller can run unbounded concurrent LLM requests, defeating the documented "8 operations in flight (the ninth gets 503)" and the 503/Retry-After control. Existing test `api-guards` concurrency case holds connections open, so it does not catch this.
**Fix:** Release in a `finally` around the awaited work, not on socket events:
```ts
const release = gate.acquire();
try { ...; sendJson(res, 200, await runtime.runDocument(op, input)); } finally { release(); }
```
Do the same for the `/mcp` branch (`await handleMcpHttp(...)` in try/finally). Add a test that aborts N requests and asserts the (N+1)th still gets 503 while handlers run.

### CR-02: MCP JSON-RPC batches multiply work under one concurrency slot and one body-cap check

**File:** `src/api/server.ts:426-438`, `src/mcp/server.ts:218-226`
**Issue:** `/mcp` takes one gate slot per HTTP request, but the SDK transport accepts JSON-RPC arrays and dispatches every element concurrently. Probed: a 2 MB body with 100 `tools/call score` entries returned 200 in one request. A single slot can therefore fan out thousands of `generate`/`ingest` calls (each up to the engine caps), again voiding `maxConcurrent`, and the 10 MiB `/mcp` cap applies to the whole batch rather than per call (and ingest-sized text is allowed for `generate`/`score` through `/mcp` although the REST cap for those is 1 MiB, API-03).
**Fix:** Reject arrays in `parseJsonBody` for the MCP route (`Array.isArray(body)` -> 400/`-32600`), or count `body.length` slots; and apply the per-operation cap: after parsing, if `method==='tools/call'` and tool is not `ingest`, require the raw size <= `maxBodyBytes`.

## Warnings

### WR-01: stdio server discards in-flight replies at end of input
**File:** `src/mcp/server.ts:207-209`
**Issue:** `input.once('end'/'close', () => server.close())` closes the transport as soon as stdin ends. Repro: `printf '<tools/call ingest>\n' | ghostwriter mcp` prints nothing (the ingest still executes and is persisted, `z2` appears in profiles.json, but the caller never gets the result). `docs/MCP.md` "End of input ends the session" hides this; any one-shot/pipe client loses responses. The system test only ends stdin after reading replies.
**Fix:** On end of input, wait for pending requests (track an in-flight counter in the CallTool handler) before `server.close()`.

### WR-02: `//host/path` request targets route as `/path` (network-path reference)
**File:** `src/api/server.ts:480-481`
**Issue:** `req.url.startsWith('/')` accepts `//x/api/authors`; `new URL('//x/api/authors','http://localhost')` yields `pathname=/api/authors`. Probed: `curl --path-as-is $B//x/api/authors` -> 200 with data. Auth still applies, but route identity, the staticHandler path guard and any future path-based policy see a different path than the client sent (route-confusion primitive, and the Phase-10 static mount will serve `//x/foo` as `/foo`).
**Fix:** Reject targets starting with `//` (and any with `\`), or parse with `new URL(req.url, base)` only after checking `/^\/(?!\/)/`.

### WR-03: Unauthenticated oracle for route existence; static hook runs before the token
**File:** `src/api/server.ts:412-424`
**Issue:** `/api/nope`, `/mcp` (when enabled), `/openapi.json` answer 401 while `/nope` and a disabled `/mcp` answer 404 without a token; reveals whether `--mcp` is on. Also the `staticHandler` runs pre-auth by design (comment line 269), so Phase 10 serves UI assets unauthenticated and any bug in that handler is pre-auth surface.
**Fix:** Require the token before any non-static routing (404 only after auth for `/api/*` and `/mcp`), and document/limit what the static hook may serve.

### WR-04: No throttling of failed bearer attempts; token strength not checked
**File:** `src/api/auth.ts:17-22, 27-34`
**Issue:** Minimum 16 printable chars with no entropy check (`aaaaaaaaaaaaaaaa` is accepted), no per-source failure limit or delay, no connection cap. On a non-loopback bind (the one case the token is the only control) the token is brute-forceable at wire speed. Also, `--token-env` may name any variable (e.g. `PATH`, `ANTHROPIC_API_KEY`), silently reusing a credential or low-entropy value as the bearer.
**Fix:** Reject runs of one character / require a minimum distinct-character count, add a small failed-auth delay or lockout per remote address, refuse `--token-env` names matching the key-env policy (`isDetectorKeyEnvName`/`OTHER_SYSTEMS_ENV`), and recommend `openssl rand -hex 24` in the startup note.

### WR-05: OpenAPI document drifts from real behaviour
**File:** `src/service/openapi.ts:66, 103`
**Issue:** Every operation declares `security: [{}, {bearer: []}]`, i.e. "auth optional", even when the server enforces a token on all routes (and it is only optional on a tokenless loopback bind); `servers` is hard-coded `http://127.0.0.1:8787` regardless of `--host/--port`. Generated clients will omit credentials or call the wrong base URL. 413/415/408/421 are listed for GET ops that never produce 415/413. The tests validate schema well-formedness, not conformance to a live token-protected server.
**Fix:** Build the document per server instance: `security: [{bearer: []}]` when a token is set, `servers` from the bound url, and restrict 413/415 to POST operations.

### WR-06: `callTool` falls back to the global registry, bypassing the served operation list
**File:** `src/mcp/tools.ts:258`
**Issue:** `ops.find(...) ?? findOperation(name)` lets `tools/call` run any registry operation that `tools/list` and the HTTP routes (`ops`) do not expose. Latent today (production passes the full registry) but it breaks the invariant "served = listed" the moment a subset is passed (tests do, and a future read-only mode would silently still allow `ingest`).
**Fix:** `const op = ops.find((o) => o.name === name);` and drop the fallback.

### WR-07: Parity test is partly tautological; an undetected mutation exists
**File:** `tests/integration/surfaces-parity.test.ts:96-110`
**Issue:** HTTP routes, OpenAPI paths and MCP tools are all derived from `OPERATIONS` by the code under test, so "HTTP/OpenAPI/MCP agree with the registry" cannot fail except via the registry itself; only CLI commands/flags and Engine methods are independently observed. Mutation run on a scratch copy: adding `topK` to `generateInput` (reachable by HTTP and MCP, no CLI flag, no handler wiring) -> 18/18 parity tests pass; i.e. input-field-to-CLI-flag parity is unchecked (CLI `flags` are a hand-maintained list in the registry, not derived from the schema). Mutations that DO get caught: dropping a CLI flag, foreign-Origin check removed, content-type check removed, body cap removed, gate removed. NOT caught: replacing `timingSafeEqual` with `===` (505/505 pass; understandable but nothing guards it), and CR-01/CR-02 above.
**Fix:** Derive expected CLI flags from the input schema keys (with an explicit exemption map), and have the HTTP check compare against the server's real behaviour (e.g. probe each registry input field via a POST and each CLI `--help`), not the generated document.

## Info

### IN-01: Caller-supplied detector name echoed in error
**File:** `src/engine.ts` (CONFIG_INVALID `unknown detector "<name>"`), `docs/MCP.md` "reported without echoing the offending value"
**Issue:** `detectorNameSchema` admits `sk-ant-...`-shaped strings, which come back in the 400 message (probed). Contradicts the doc claim and the author/persona policy.
**Fix:** Report the count/hash like `UnknownAuthorError`.

### IN-02: MCP protocol errors leak zod issue dumps
**File:** `src/mcp/server.ts:182-186`
**Issue:** `arguments: null` returns `-32603` with the multi-line zod issue JSON (path/message). Not secret, but inconsistent with the bounded messages elsewhere.

### IN-03: Token-looking `--token-env` value echoed to stderr
**File:** `src/cli/serve.ts:64-66`
**Issue:** `--token-env abcdefghijklmnop1234` passes the name regex and then prints `--token-env abcdefghijklmnop1234: that environment variable is not set`, copying a mistakenly pasted token into logs. Fix: don't echo the name when it is 16+ chars / not UPPER_SNAKE.

### IN-04: Ignored listener flags with `mcp --stdio`
**File:** `src/cli/mcp.ts:137-151`
**Issue:** `mcp --host 0.0.0.0 --token-env X` silently starts stdio and ignores them; a user expecting a network listener gets none. Fix: ConfigError when listener flags accompany stdio.

### IN-05: `--allow-host name:port` never matches
**File:** `src/api/auth.ts:75`
**Issue:** extra hosts compare against hostname-without-port, so `--allow-host example.com:8787` is silently dead. Fix: strip/validate the port with `hostnameOfHostHeader` when adding.

### IN-06: `runtime.markLoaded()` after ingest can mask another process's write
**File:** `src/service/runtime.ts:325-330`
**Issue:** signature is re-statted after the local ingest; a foreign write between save and stat is recorded as "seen" and never reloaded (narrow TOCTOU; mtime+size signature also misses same-size rewrites within timestamp granularity).

### IN-07: No connection cap; unread GET bodies not bounded by the app
**File:** `src/api/server.ts:473-499`
**Issue:** only per-request timeouts (30 s read, 60 s request); no `maxConnections`. Pre-auth sockets can pin descriptors for up to 30 s each. Low severity on loopback.

---

_Reviewed: 2026-11-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
