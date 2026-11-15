---
phase: 09-service-surfaces
verified: 2026-11-15T17:00:00Z
status: human_needed
score: 9/9 must-haves verified
covered_files:
  - ".planning/phases/09-service-surfaces/09-01-PLAN.md"
  - ".planning/phases/09-service-surfaces/09-01-SUMMARY.md"
  - "docs/API.md"
  - "docs/MCP.md"
  - "docs/SURFACES.md"
  - "src/api/auth.ts"
  - "src/api/limits.ts"
  - "src/api/server.ts"
  - "src/cli/main.ts"
  - "src/cli/mcp.ts"
  - "src/cli/serve.ts"
  - "src/engine.ts"
  - "src/llm/endpoint.ts"
  - "src/mcp/server.ts"
  - "src/mcp/tools.ts"
  - "src/service/errors.ts"
  - "src/service/openapi.ts"
  - "src/service/operations.ts"
  - "src/service/runtime.ts"
  - "tests/integration/surfaces-parity.test.ts"
  - "tests/security/api-guards.test.ts"
covered_digest: "v3:sha256:7e38f0bcd6d28cb181ac8ee0b9181a523b4cbbae13a0ef4ff77b814574e5ffd3"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Concurrency cap vs. slow clients (CR-01)"
    expected: "Slots stay held until the work ends (no operation cancellation on disconnect: engine/LLM calls take no abort signal). A burst of dropped connections can hold all 8 slots for the LLM call duration; legitimate callers get 503 meanwhile. Accept or require abort-signal plumbing."
    why_human: "Design trade-off; live probe confirmed cap holds (peak 8) but availability under abuse is a policy decision."
  - test: "Auth throttle policy (WR-04)"
    expected: "3 free failures, 250 ms doubling to 4 s, 60 s lockout after 20 failures/60 s, keyed per remote address. On loopback every local process shares one address, so a local guesser also locks out the local user."
    why_human: "Thresholds are judgement calls."
  - test: "IN-02 skipped: MCP tools/call shape errors return SDK-worded zod issue dumps (-32602)"
    expected: "Dump contains schema paths and expected types only, never caller values. Accept the SDK-pinned (1.32.2) behaviour, or require bypassing the SDK validator."
    why_human: "Left unfixed by decision; documented in docs/MCP.md."
  - test: "Tokenless loopback server"
    expected: "Any local process can reach a tokenless 127.0.0.1 server (including ingest, which replaces an author). Docs recommend a token."
    why_human: "Residual risk accepted in the plan; confirm it is acceptable as the default."
  - test: "mtime+size store-change signature (IN-06)"
    expected: "A same-size rewrite by another process within mtime granularity is not detected by a long-running server."
    why_human: "Inherent limit of the signature, noted not fixed."
  - test: "Unread GET bodies / slow-drip clients (IN-07)"
    expected: "Bounded only by per-request timeouts (30 s read) plus the 256-connection cap."
    why_human: "Resource-exhaustion posture on a shared host."
  - test: "Real LLM and real browser/agent clients"
    expected: "generate against a live provider; MCP from a real agent host (Claude Desktop/Code) over stdio and streamable HTTP; browser CORS preflight from an allowlisted origin."
    why_human: "Probed only with a mock OpenAI-compatible backend and the SDK client."
---

# Phase 9: Service surfaces Verification Report

**Phase Goal:** one operations registry; CLI, HTTP API and MCP are thin adapters over it (nothing on one surface only).
**Verified:** 2026-11-15
**Status:** human_needed (no gaps; residual risks listed above)
**Re-verification:** No, initial verification (includes review fixes from 09-REVIEW-FIX.md)

## Gate runs

| Check | Result |
|---|---|
| `scripts/verify.sh` | PASS: typecheck ok; smoke 4, unit 856, integration 255, system 64, security 469, torture 5 = 1653/1653, 0 skipped (matches REVIEW-FIX claim) |
| `npm run build` | exit 0 |
| Debt markers (TBD/FIXME/XXX) in phase source | none |
| Source modified by verifier | no (only this report) |

## Observable Truths (requirements)

| # | Truth | Status | Evidence |
|---|---|---|---|
| API-01 | One registry, adapters derived | VERIFIED | `src/service/operations.ts` registry (9 ops); `/api/capabilities`, OpenAPI, MCP tools and CLI all list the same 9; parity test observes live surfaces |
| API-02 | Loopback default, token for non-loopback, constant-time, no ACAO, Host/Origin checks | VERIFIED | `serve --host 0.0.0.0` w/o token: exit 2 "refusing to listen"; no/ wrong bearer 401; `Host: evil.com` 421; `Origin: evil.com` 403 and 0 `Access-Control-Allow-*` headers; token absent from serve stdout/stderr; timingSafeEqual spy test in suite |
| API-03 | Body caps, JSON only, content-type, timeout, bounded concurrency | VERIFIED | `--max-body 4096`: 8000 B -> 413 INPUT_TOO_LARGE; text/plain -> 415; bad JSON -> 400; 40 concurrent kept-open generate: 8x200 + 32x503, mock LLM saw started=8 peak=8; 3 waves x 40 fire-and-abort: mock started 8 total, peak 8 (<= cap), inflight drained to 0, next call 200; 300 raw sockets: 44 dropped by server at maxConnections 256 |
| API-04 | Typed error -> status table, `{ok:false,error:{code,message}}` | VERIFIED | live bodies of that shape for 401/400/413/415/421/503; table covered by unit/integration tests in verify.sh |
| API-05 | `/openapi.json` 3.1 from zod, no drift; config get redacted | VERIFIED | served `openapi: 3.1.0`, paths == the 9 ops + `/openapi.json`; no `/api/humanize` (404); `config get` shows env var NAMES/`baseUrlHost` only; CLI == HTTP == MCP config byte-equal (same `--config`); validator + drift tests green |
| API-06 | Parity test enumerates registry; CLI `authors`, `config get` exist | VERIFIED | `authors`, `config get`, `score` CLI commands present; parity test observes live HTTP/MCP/OpenAPI with mutant-server checks |
| MCP-01 | Official SDK, stdio + streamable HTTP, one tool per op | VERIFIED | SDK pinned 1.32.2; SDK client over `/mcp` lists 9 tools == registry; `ghostwriter mcp` over stdio answers initialize and `tools/call authors` with data |
| MCP-02 | Untrusted inputs, schema-validated, no paths | VERIFIED (with IN-02 caveat) | JSON-RPC batch (2-element and `[]`) -> 400 USAGE; strict schemas; security suite green; IN-02 SDK error wording left (human item) |
| MCP-03 | Annotations correct, ingest only mutator, stdout protocol only | VERIFIED | list: ingest `readOnlyHint:false` (destructive:true, replaces author), all other 8 `readOnlyHint:true`; stdio stdout only JSON-RPC frames, stderr only `ghostwriter MCP server on stdio` |

## Specific live probes requested

| Probe | Result |
|---|---|
| Auth required | PASS (401 no/wrong token; 200 with token) |
| Concurrency cap with dropped connections <= cap | PASS (peak 8 = cap; also connection cap 256) |
| MCP batch rejected | PASS (400) |
| `//x` path | PASS (400 USAGE, with and without token) |
| OpenAPI matches registry | PASS |
| `ghostwriter mcp` stdio replies | PASS |
| CLI/HTTP/MCP parity score/authors/personas/config (+profile) | PASS. `score` differs only in the per-feature `ms` timing field; others byte-identical |
| humanize pending only | PASS: only in `PENDING_CAPABILITIES` (`/api/capabilities` `pending`), no op/route/tool/CLI command; `/api/humanize` 404 |

## Anti-Patterns

None blocking. Note: review line numbers in 09-REVIEW.md did not match the files (reviewer artifact, not a code defect).

## Gaps Summary

No gaps. Status is human_needed solely because of the residual-risk decisions above (7 items). Scratch artifacts: `/tmp/claude-1000/-home-bill-src-tools-dag/19ea1097-b1be-474f-992a-4862dbce1231/scratchpad/v9/` (servers stopped).

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
