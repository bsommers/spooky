---
phase: 09-service-surfaces
plan: 01
subsystem: service-surfaces
tags: [operations-registry, http-api, openapi, mcp, security, uniform-surfaces]
status: complete
requires:
  - phase: 06-hardening
    provides: Engine facade, typed errors, CLI exit-code contract, confidentiality pipeline
  - phase: 07-scorer
    provides: engine.score and `ghostwriter score` (wired on every surface here)
provides:
  - OPERATIONS registry (9 operations) as the single declaration; CLI, HTTP, MCP and OpenAPI are adapters over it
  - ERROR_TABLE code -> exit / http / mcp category, shared by all surfaces (EXIT_CODES moved out of the CLI)
  - Engine.listAuthors(), Engine.getConfigView() (redacted config view)
  - node:http server (src/api) with loopback default, optional bearer token, Host/Origin/CORS policy, size/time/concurrency limits
  - MCP server (stdio and stateless streamable HTTP) on @modelcontextprotocol/sdk 1.32.2
  - `ghostwriter authors | config get | capabilities | serve | mcp`
  - GET /openapi.json generated from the registry (OpenAPI 3.1, validated in tests)
  - PENDING_CAPABILITIES with humanize (Phase 8) enumerated by the parity test, not faked
affects: [08-humanizer, 10-ui-foundation, 11-ui-features]
tech-stack:
  added: ["@modelcontextprotocol/sdk@1.32.2 (MIT)", "@seriousme/openapi-schema-validator@2.12.0 (MIT, dev)"]
  patterns:
    - "registry entries carry schema, handler, http, cli binding and text renderer; adapters never declare an operation"
    - "surface parity is a pure function over surface descriptors, so a mutation test can prove it notices a missing adapter"
    - "error results from MCP carry no structuredContent (the SDK client validates it against the success outputSchema)"
key-files:
  created:
    - src/service/{errors,schemas,operations,runtime,openapi,version}.ts
    - src/api/{server,auth,limits}.ts
    - src/mcp/{server,tools}.ts
    - src/cli/{serve,mcp}.ts
    - src/config/view.ts
    - docs/API.md
    - docs/MCP.md
    - tests/helpers/surfaces.ts
    - tests/unit/service/{errors,operations,openapi}.test.ts
    - tests/unit/api/auth.test.ts
    - tests/unit/mcp/tools.test.ts
    - tests/security/{api-guards,api-confidentiality}.test.ts
    - tests/integration/{surfaces,surfaces-parity,cli-service}.test.ts
    - tests/system/surfaces.test.ts
  modified:
    - src/cli/main.ts
    - src/engine.ts
    - src/index.ts
    - package.json
    - package-lock.json
    - .planning/CONTRACTS.md
    - docs/SURFACES.md
    - docs/ARCHITECTURE.md
    - README.md
    - tests/integration/parity.test.ts
key-decisions:
  - "DECIDED (user, 2026-11-15): node:http; config read-only; optional bearer token on loopback with a docs warning; self-hosted fontsource fonts; committed Playwright baselines (recorded in docs/SURFACES.md)"
  - "HTTP success body is {ok:true,...output}, identical to `ghostwriter --json` and MCP structuredContent"
  - "capabilities is a registry operation (service-level, no Engine method) so discovery exists on every surface"
  - "humanize is a PENDING capability: no adapter on any surface; the parity test fails when Engine.humanize appears without a registry entry"
  - "MCP uses the SDK low-level Server so the registry owns validation and error mapping (one phrasing on all surfaces)"
  - "A named but unset/short --token-env fails closed; a non-loopback bind without a token refuses to start"
metrics:
  tasks: 7
  files: 41
  duration: "about 45 min"
  completed: "2026-11-15"
actuals:
  tokens: 51600
  tasks: 7
  commits: 9
plan_head_before: bf44005f01cbf212e3eb8d08c4de0d10d24f66e1
plan_head_after: f2b56227f6e93d6ea2641adbf0c4d2e997f415ea
---
# Phase 9 Plan 01: Service surfaces Summary

One operations registry now drives the CLI, an HTTP API with a generated OpenAPI 3.1 document, and an MCP server (stdio and streamable HTTP), with one error table, loopback-only defaults and a parity test that fails when any surface and the registry disagree.

`commits: 9` is `git rev-list --count plan_head_before..plan_head_after`. 6 of them are this plan (`git log --grep='(09-01)'`); the rest belong to the concurrent Phase 7 calibration work (`1c15783`, `cf028e0`, `5ec155c`) that landed on the same branch meanwhile.

## What was built (by plan task)
1. **Error table.** `src/service/errors.ts`: `ERROR_TABLE` (code -> exit, http, mcp category), `EXIT_CODES` derived from it (the CLI re-exports it, behaviour unchanged), `describeError`, `SurfaceError`/`InputError`. A unit test reads `src/models/errors.ts` and fails if any `super('CODE'` is missing from the table.
2. **Registry.** `src/service/operations.ts`: ingest, generate, score, profile, authors, personas, filters, config_get, capabilities; strict zod inputs, zod outputs, `mutates`/`openWorld`/`readsState`. New `Engine.listAuthors()` and `Engine.getConfigView()` (`src/config/view.ts`: endpoint hosts only, env var NAMES and a set/unset boolean, counts for blocklist and rules). CONTRACTS parity table extended (3 rows) and `parity.test.ts` extended, not forked.
3. **CLI.** Every command runs through `invokeOperation`; `profile`, `authors`, `personas`, `filters`, `config get`, `capabilities` are built from their registry binding (command, arguments, text renderer); `ingest`/`generate`/`score` stay hand-written for file/stdin input and call the same path. stdout/stderr contract and exit codes unchanged (all 1125 pre-existing tests still pass).
4. **HTTP server.** `src/api/server.ts` (`node:http`, no framework), `auth.ts`, `limits.ts`. Routes derived from `op.http`; a test fails if the server source names an `/api/<x>` route. `ghostwriter serve [--host --port --token-env --allow-origin --allow-host --max-body --mcp]`; a static-handler hook for Phase 10 runs before the token check and takes its own CSP.
5. **OpenAPI.** `src/service/openapi.ts` walks the registry with `z.toJSONSchema` (draft 2020-12); validated by `@seriousme/openapi-schema-validator`; regenerating is byte-identical; no `x-` keys; a drift test removes/adds operations.
6. **MCP.** `src/mcp/{tools,server}.ts` and `ghostwriter mcp [--stdio|--http]`. One tool per operation, `ingest` the only `readOnlyHint:false`. stdio sets `maxBufferSize` to the body cap; end of input ends the session; HTTP is stateless JSON.
7. **Parity and docs.** `tests/integration/surfaces-parity.test.ts` (registry vs Engine, CLI incl. flags and arguments, HTTP routes probed on a live server, MCP tools/list, OpenAPI paths; reverse direction; per-adapter mutation check; pending capability check). `docs/API.md`, `docs/MCP.md` (SDK pin and licence audit), `docs/SURFACES.md` (decisions recorded as DECIDED).

## Verification
- `scripts/verify.sh`: PASS. smoke 4, unit 837, integration 248, system 64, security 459, torture 5; 0 skipped (1616 tests; the pre-phase suite was 1125 plus the Phase 7 additions).
- `npm run build`: clean.
- Real binary tests (`tests/system/surfaces.test.ts`): spawned `mcp --stdio` through the SDK client (every tool called, secret never comes back), raw frames check (every stdout line is JSON-RPC 2.0; end of input exits 0), `serve` with token, `serve --mcp` and `mcp --http` through the SDK streamable HTTP client, SIGTERM exits 0, wildcard bind without token exits 2.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Security] Access log leaked attacker-chosen paths**
- **Found during:** security test "secrets never leave through HTTP" (first run failed)
- **Issue:** the request log printed the raw path, so a secret-shaped URL path reached a log line.
- **Fix:** only the path of a route the server knows is logged; anything else is `(unrouted)`.
- **Files modified:** src/api/server.ts
- **Commit:** b651c1f

**2. [Rule 2 - Security] Unknown-persona error echoed the caller's persona key**
- **Found during:** designing the confidentiality test (persona key is caller input and can be secret-shaped)
- **Fix:** `describeError` reports `unknown persona (N characters); valid personas: ...` on every surface, like `UnknownAuthorError` already did. `UnknownPersonaError` itself and its pinned test are untouched.
- **Files modified:** src/service/errors.ts
- **Commit:** b651c1f

**3. [Rule 1 - Bug] MCP error results failed client-side schema validation**
- **Found during:** system test with the real SDK client (`-32602 Structured content does not match the tool's output schema`)
- **Issue:** the client validates `structuredContent` against `outputSchema` even for `isError` results.
- **Fix:** error results carry the error document in text content only; documented in docs/MCP.md.
- **Files modified:** src/mcp/tools.ts, docs/MCP.md
- **Commit:** 141efc6

### Plan interpretations (not bugs)
- **Body caps follow REQUIREMENTS API-03:** 1 MiB for every route except ingest and `/mcp`, 10 MiB for those (`--max-body`, `--max-ingest-body`); the plan text only said `--max-body`.
- **CLI "reads the registry" is partial.** Six commands are generated from their registry binding; `ingest`, `generate`, `score` keep hand-written commander wiring (positional file, `--file`, stdin, config overrides) but validate and run through the registry. Declaring those flags fully in the registry would have duplicated commander's job without a test that needs it.
- **`capabilities` is a registry operation** (the plan listed `/api/capabilities` as a route only): otherwise it would exist on one surface only, which the uniform-surface rule forbids. CONTRACTS table row uses `service registry` in the library column.
- **HTTP GET with input uses a query string** (`/api/profile?authorId=`), not a path parameter, so the OpenAPI parameters come straight from the input schema.
- **MCP uses the SDK low-level `Server`** (marked deprecated for general use, documented for advanced use) instead of `McpServer.registerTool`, so validation and error text are the registry's, not a second phrasing.
- **Dev dependency added:** `@seriousme/openapi-schema-validator` 2.12.0 (MIT) for the OpenAPI validity test, as the plan's "schema validator dev-dep".

## Authentication gates
None.

## Known Stubs
None. `humanize` is deliberately not an operation and not a stub: it is `PENDING_CAPABILITIES` data, reported by `capabilities`, enumerated by the parity test.

## Deferred / residual
- A tokenless loopback server is open to any local process; this is the decided default and is stated in docs/API.md and printed at startup.
- Plain HTTP only; TLS belongs in a reverse proxy.
- `STATE_LOCKED` and `DETECTORS_FAILED` have table rows and unit coverage of the mapping, but no cross-surface failure case (both need contrived setups); the other codes are covered across CLI, HTTP and MCP.
- The server picks up an ingest from another process by a `stat` signature (mtime+size) check before state-reading operations; two writes within one filesystem timestamp tick with identical size would not be seen until the next change.
- No MCP resources/prompts, no sessions, no SSE streaming (stateless JSON responses only).

## Threat Flags
| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-network-listener | src/api/server.ts | HTTP listener (loopback by default); mitigated by bind policy, token, Host/Origin checks, limits (threat model in docs/API.md) |
| threat_flag: new-stdio-protocol | src/mcp/server.ts | MCP stdio endpoint driven by a model; inputs are strict-schema validated, no path/command parameters |

## Licence audit
`@modelcontextprotocol/sdk` 1.32.2 MIT; production tree 128 packages: 117 MIT, 7 ISC, 2 BSD-3-Clause, 2 BSD-2-Clause; no copyleft in production. Dev-only `lightningcss` (MPL-2.0, pre-existing via vitest/vite) is not published. Detail in docs/MCP.md.

## Self-Check: PASSED
All created files exist; commits `a9b51e9`, `b651c1f`, `141efc6`, `529a343`, `99e826c`, `f2b5622` are ancestors of HEAD; verify.sh and build green.
