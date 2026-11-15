---
phase: 09-service-surfaces
fixed_at: 2026-11-15T16:00:00Z
review_path: .planning/phases/09-service-surfaces/09-REVIEW.md
iteration: 1
findings_in_scope: 16
fixed: 15
skipped: 1
status: partial
---

# Phase 9: Code Review Fix Report

**Fixed at:** 2026-11-15
**Source review:** .planning/phases/09-service-surfaces/09-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 16 (CR-01, CR-02, WR-01..WR-07, IN-01..IN-07)
- Fixed: 15
- Skipped: 1 (IN-02: no code change, documented)

**Verification:** run in the isolated worktree (`.claude/worktrees/rf-09-...`, `node_modules` linked from the main checkout): `scripts/verify.sh` PASS (typecheck ok; smoke 4, unit 856, integration 255, system 64, security 469, torture 5; 1653 tests, 0 skipped) and `npm run build` ok. Re-run in the main checkout after the fast-forward: `scripts/verify.sh` PASS (same counts) and `npm run build` ok. The review's `printf <request> | ghostwriter mcp` repro now prints the reply (checked against the built `dist`).

Note: the review's line numbers did not match the files (they cite lines past the end of `src/cli/mcp.ts`, `src/api/server.ts`); findings were located by the code they quote.

## Fixed Issues

### CR-01: Concurrency cap released on socket close
**Files modified:** `src/api/server.ts`, `src/mcp/server.ts`, `tests/security/api-guards.test.ts`, `docs/API.md`
**Commit:** e838002
**Applied fix:** slot released in `finally` around the awaited work on the REST routes and `/mcp`. `handleMcpHttp` now waits for in-flight tool calls: the SDK transport promise never settles when the client hangs up, so it races the response `close` and then drains the tracked tool calls. Regression tests fire 10 fire-and-abort POSTs at REST and `/mcp` with `maxConcurrent: 2` and assert at most 2 handlers ever start, peak concurrency <= 2, the next caller gets 503, and slots return afterwards. Both fail on the old code (10 handlers started). Operation cancellation on disconnect was NOT added (the engine/LLM calls take no abort signal); the slot stays held until the work ends, which is the safe behaviour and is documented.
Status: fixed: requires human verification (concurrency logic; behavioural tests cover it).

### CR-02: MCP JSON-RPC batches multiply work under one slot / cap
**Files modified:** `src/api/server.ts`, `tests/security/api-guards.test.ts`, `docs/API.md`, `docs/MCP.md`
**Commit:** 8cd379c
**Applied fix:** an array body on `/mcp` is `400 USAGE` (any size, including empty). After the body is read (up to the 10 MiB ceiling), anything that is not a single `tools/call` of a mutating tool (`ingest`) and is over `--max-body` is `413`. Tests: batches of 100/2/0/1, and score/generate/ping over the small cap vs ingest over it.
Status: fixed: requires human verification (cap logic).

### WR-01: stdio drops in-flight replies at end of input
**Files modified:** `src/mcp/server.ts`, `tests/unit/mcp/stdio.test.ts` (new), `docs/MCP.md`
**Commit:** 27dee9d
**Applied fix:** unanswered request ids are tracked (hooks installed before `connect`, since buffered input is delivered as soon as the transport starts) and `server.close()` runs only after the replies have been written; an abort signal still closes immediately. Tests: one slow call, three slow calls, idle EOF, abort during work.

### WR-02: `//host/path` routed as `/path`
**Files modified:** `src/api/server.ts`, `tests/security/api-guards.test.ts`, `docs/API.md`, `docs/SURFACES.md`
**Commit:** 7716ed2 (shared with WR-03: one routing hunk)
**Applied fix:** a request target must match `^/(?![/\\])` and contain no backslash, else `400 USAGE`.

### WR-03: route-existence oracle; static hook before the token
**Files modified:** same as WR-02
**Commit:** 7716ed2
**Applied fix:** `/api/*`, `/openapi.json` and `/mcp` are a protected namespace: the token check runs before any 404 or enablement check, so a disabled `/mcp` or unknown `/api/x` is indistinguishable from an existing route without the token. The static hook is offered only GET/HEAD for paths outside that namespace; limits documented in the `StaticHandler` doc comment, `docs/API.md` and `docs/SURFACES.md`.

### WR-04: no auth throttling, no token strength, any `--token-env` name (and IN-03)
**Files modified:** `src/api/auth.ts`, `src/api/server.ts`, `src/cli/serve.ts`, `src/llm/endpoint.ts`, `src/service/errors.ts`, `src/service/openapi.ts`, `tests/integration/cli-service.test.ts`, `tests/unit/api/auth.test.ts`, `docs/API.md`, `docs/SURFACES.md`, `.planning/CONTRACTS.md`
**Commit:** 5d0f719
**Applied fix:** token needs 8+ distinct characters and 48+ empirical bits (message suggests `openssl rand -hex 24`, never echoes the token); `AuthThrottle` per remote address (3 free failures, then 250 ms doubling to 4 s, lockout of 60 s after 20 failures in 60 s, bounded to 1024 tracked addresses); new error code `RATE_LIMITED` (429, `Retry-After`) added to the shared table; a request with no `Authorization` header is not counted. `--token-env` must be UPPER_SNAKE with an underscore, not another system's credential (`isOtherSystemsEnvName`), not a provider key name, and not the config's LLM/detector `apiKeyEnv`. Trade-off documented: on loopback all local processes share one address, so a local guesser also locks out the local user for the lockout period.
Status: fixed: requires human verification (policy thresholds are judgement calls).

### WR-05: OpenAPI drift
**Files modified:** `src/service/openapi.ts`, `src/api/server.ts`, `tests/unit/service/openapi.test.ts`, `docs/API.md`
**Commit:** 2489280
**Applied fix:** `buildOpenApi` takes `serverUrl` and `tokenRequired`; the server builds the document after binding. With a token every operation (and `/openapi.json`) has `security: [{bearer: []}]`, the bearer scheme and 401/429 responses; without one, `security: []` and no scheme. `408/413/415` are listed for POST operations only. A live token-protected server is probed against its served document.

### WR-06: `callTool` falls back to the global registry
**Files modified:** `src/mcp/tools.ts`, `tests/unit/mcp/tools.test.ts`
**Commit:** b5a2897
**Applied fix:** fallback removed; tests use a read-only subset registry and prove `ingest` is neither listed nor callable (function and protocol level).

### WR-07: parity test partly tautological
**Files modified:** `tests/integration/surfaces-parity.test.ts`, `tests/unit/api/bearerCompare.test.ts` (new), `src/api/auth.ts`, `docs/SURFACES.md`
**Commit:** 65afa2d
**Applied fix:** surfaces are observed: HTTP routes and accepted input fields are probed on a live server, MCP tools/schemas come from a real MCP client over streamable HTTP, OpenAPI from the served document. Every input field must map to a CLI flag/argument in an explicit `CLI_FIELDS` table; CLI flags that are no input field must be listed in `CLI_ONLY_FLAGS` with a reason (the four `generate` LLM-override flags). New real tests: live mutant servers (extra field `topK`, rogue `/api/purge`, dropped `score`) must be caught, and adding `topK` to the real `generateInput` fails the suite (checked by hand and reverted). A `timingSafeEqual` spy (module mock) replaces the source-text check; it found that a missing `Authorization` header skipped the comparison, fixed in `auth.ts` (every header now costs one equal-length comparison).

### IN-01: detector name echoed in error
**Files modified:** `src/engine.ts`, `tests/integration/score.test.ts`, `tests/security/api-confidentiality.test.ts`
**Commit:** 123cd1d
**Applied fix:** message reports the length(s) only (`unknown detector (4 characters); configured: acme`); HTTP and MCP tests with a `sk-ant-...` name.

### IN-03: token-looking `--token-env` value echoed
Fixed with WR-04 (commit 5d0f719): no `--token-env` message repeats the name; tests with 11 bad names.

### IN-04: listener flags ignored with `mcp --stdio`
**Files modified:** `src/cli/mcp.ts`, `src/cli/serve.ts`, `tests/integration/cli-service.test.ts`, `docs/MCP.md`
**Commit:** 5bf72f2
**Applied fix:** `ConfigError` naming the (static) flag names when listener flags accompany stdio.

### IN-05: `--allow-host name:port` never matched
**Files modified:** `src/api/auth.ts`, `tests/unit/api/auth.test.ts`, `docs/API.md`
**Commit:** 625d565
**Applied fix:** the value is parsed with `hostnameOfHostHeader`; port stripped, a malformed value is a `ConfigError` that does not echo it.

### IN-06: `markLoaded()` after ingest can mask another process's write
**Files modified:** `src/service/runtime.ts`, `tests/unit/service/runtime.test.ts` (new)
**Commit:** f80a00a
**Applied fix:** after a mutating operation the signature is set to a stale marker instead of being re-stat'd, so the next read reloads from disk (one extra load per ingest). Tests: reload happens once, then not again; a foreign write right after our ingest is seen. The same-size-rewrite-within-mtime-granularity limit of the mtime+size signature is unchanged (inherent to the signature; noted, not addressed).

### IN-07: no connection cap
**Files modified:** `src/api/limits.ts`, `src/api/server.ts`, `tests/unit/api/auth.test.ts`, `docs/API.md`
**Commit:** 625d565
**Applied fix:** `server.maxConnections` = 256 (`ApiLimits.maxConnections`, validated); test drops the third socket at a cap of 2. Unread GET bodies remain bounded only by the existing per-request timeouts.

### Docs
`.planning/CONTRACTS.md` records the guards (commit aa0c29b); `docs/API.md`, `docs/MCP.md`, `docs/SURFACES.md` updated within the commits above.

## Skipped Issues

### IN-02: MCP protocol errors leak zod issue dumps
**File:** `src/mcp/server.ts`
**Reason:** not fixed in code. The SDK's `Server.setRequestHandler` hard-wires `CallToolRequestSchema` validation for `tools/call` and answers with `InvalidParams` plus the issue dump; replacing it would mean bypassing the SDK's override via its base class (pinned 1.32.2 internals). The dump contains schema paths and expected types only, never caller values (checked for `arguments: null`, numeric `name`, missing `name`, string/array `arguments`). A first attempt (loose handler schema) was reverted because the SDK validates before the handler runs. Documented in `docs/MCP.md` (commit 5bf72f2).
**Original issue:** `arguments: null` returns `-32603`/`-32602` with the multi-line zod issue JSON.

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
