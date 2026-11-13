---
phase: 05-orchestration
verified: 2026-11-13T18:00:00Z
status: passed
score: 3/3 must-haves verified
covered_files:
  - ".planning/phases/05-orchestration/05-01-PLAN.md"
  - ".planning/phases/05-orchestration/05-01-SUMMARY.md"
  - ".planning/phases/05-orchestration/05-02-SUMMARY.md"
  - "src/cli/bin.ts"
  - "src/cli/main.ts"
  - "src/config/schema.ts"
  - "src/engine.ts"
  - "src/index.ts"
  - "src/llm/anthropicClient.ts"
  - "src/llm/endpoint.ts"
  - "src/llm/factory.ts"
  - "src/llm/http.ts"
  - "src/llm/mockClient.ts"
  - "src/llm/openaiCompatClient.ts"
  - "src/llm/retry.ts"
  - "src/models/errors.ts"
  - "src/orchestration/orchestrator.ts"
  - "src/registry/sourceManager.ts"
  - "src/registry/stateLock.ts"
  - "tests/helpers/cli.ts"
  - "tests/helpers/llmStub.ts"
  - "tests/helpers/rig.ts"
  - "tests/integration/cli.test.ts"
  - "tests/integration/engine.test.ts"
  - "tests/integration/llm.test.ts"
  - "tests/integration/orchestrator.test.ts"
  - "tests/integration/parity.test.ts"
  - "tests/integration/persistence.test.ts"
  - "tests/integration/stateLock.test.ts"
  - "tests/system/cli.test.ts"
  - "tests/unit/endpointPolicy.test.ts"
  - "tests/unit/llmFactory.test.ts"
  - "tests/unit/retry.test.ts"
covered_digest: "v3:sha256:39f112c058cb4e19fcd1fec0148a6295858525dacf171d3fcfb25b00fd6fc1d6"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 5: Orchestration, LLM, CLI Verification Report

**Phase Goal:** Assemble the engine; the same capabilities via library and CLI. ROADMAP success criterion 5: "`ghostwriter generate` with `MockLlmClient` returns expected text + trace; LLM 429 x3 -> `LlmError`, no output."
**Verified:** 2026-11-13
**Status:** passed
**Re-verification:** No, initial verification. It covers the code after review fixes CR-05, CR-06, WR-08, WR-09 and the rest of 05-REVIEW-FIX.md, HEAD 7756d75.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | generate end-to-end with MockLlmClient returns text + trace (plan truth 1, ROADMAP SC5 part 1, ORC-01) | VERIFIED | `tests/integration/orchestrator.test.ts` "returns text, trace in order pre -> llm -> post, and a token estimate" passes (56/56 in orchestrator + parity + retry files). Independent probe against built `dist/` (below) returned `{ok:true,text,trace}` with trace order `confidentiality, llm, style, confidentiality` (pre, llm, post filters). Flow in `src/orchestration/orchestrator.ts` is size cap, persona/author lookup, PRE, retrieve with redacted query, prompt, `withRetry`, POST, banned-phrase check. |
| 2 | LLM failing 3x -> LlmError, no text (plan truth 2, ROADMAP SC5 part 2, ORC-02) | VERIFIED | Test "three transient failures -> LlmError(attempts=3), no text, no post filter" passes: `callCount` 3, `attempts` 3. Retry bound (max 2 retries, injectable sleep) is `src/llm/retry.ts` with `tests/unit/retry.test.ts`. 429 is retryable (`tests/integration/llm.test.ts` and retry unit tests exercise 429). Non-retryable 400 -> 1 attempt; empty, non-string, oversized or token-truncated answer is `LlmError`, never an empty success. System test: stub returning 500 -> exit 5, `{ok:false,error:{code:'LLM_FAILED'}}`. |
| 3 | CLI and library expose identical operations (plan truth 3, ORC-03, ORC-04) | VERIFIED | `tests/integration/parity.test.ts` parses the CONTRACTS surface table; every row has an `Engine` method and a CLI command with the listed flags, and neither surface has a capability outside the table (passes). `--help` lists all 5 commands (system test, and in the probe). `src/index.ts` exports `Engine`. |

**Score:** 3/3 plan truths verified. None are behavior-unverified; each behavior-dependent truth (ordering, retry bound, no text on failure) has a passing named test.

Requirements, beyond the three truths: ORC-05 (cap before any filter or LLM work) via "input over the cap -> InputTooLargeError and no filter ran" and CLI exit 6; LLM-01 `OpenAICompatClient` posts to `{baseUrl}/chat/completions` and works keyless (probe stub saw no `Authorization` header); LLM-02 provider selection `anthropic|openai-compat`, unknown -> `ConfigError` (`tests/unit/llmFactory.test.ts`, `tests/unit/endpointPolicy.test.ts`).

## Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `src/llm/retry.ts` (102 lines) | VERIFIED | `withRetry`, used by the orchestrator. |
| `src/llm/mockClient.ts` (34), `anthropicClient.ts` (123), `openaiCompatClient.ts` (123), `factory.ts` (61), `endpoint.ts` (38), `http.ts` (68) | VERIFIED | Real implementations; client built lazily by `createLlmClient` after persona/author/size checks. |
| `src/orchestration/orchestrator.ts` (139) | VERIFIED | Fail-closed on every step; typed errors. |
| `src/engine.ts` (177) | VERIFIED | `ingest, getProfile, listPersonas, listFilters, generate`, plus `create`/`load` persistence. |
| `src/cli/main.ts` (353), `src/cli/bin.ts` | VERIFIED | commander; `bin` in package.json -> `dist/src/cli/bin.js` (shebang present, checked in system test). |
| `src/index.ts` | VERIFIED | Library exports. |
| Tests: retry, llm, orchestrator, engine, parity, cli, persistence, stateLock, system | VERIFIED | Present and passing. |

Level 3/4: the CLI constructs a real `Engine` with the real filter pipelines, `SourceManager` and chosen LLM client; the probe shows corpus text from a separate prior process reaching the prompt (`exemplars: 2` in the llm trace entry) and a real HTTP request reaching the stub.

## Behavioral Spot-Checks and Gate

| Behavior | Command | Result | Status |
|---|---|---|---|
| Build | `npm run build` | exit 0 | PASS |
| Gate | `scripts/verify.sh` | `verify: PASS`. smoke 4/4, unit 648/648, integration 182/182, system 8/8, security 241/241, torture 4/4 (1087 vitest tests in 31 files) | PASS |
| Named files | `vitest run orchestrator.test.ts parity.test.ts retry.test.ts` | 56/56 | PASS |

### Independent CLI probe (built `dist/src/cli/bin.js`, separate node processes, local `http.createServer` stub on 127.0.0.1, clean env, no inherited keys)

| Check | Result | Status |
|---|---|---|
| `ingest --json` then `generate --json` in separate processes | ingest exit 0; generate exit 0, one JSON line `{ok:true,text:"Stub output text.",trace:[confidentiality,llm,style,confidentiality],promptTokensEstimate}`, stderr empty | PASS |
| Secret in input never reaches the provider | Input carried `AKIAIOSFODNN7EXAMPLE` and a `ghp_` token. Stub captured 1 request; neither string appears anywhere in its headers or body; body contains `REDACTED`. Trace metadata `{aws_key:1,github_token:1}`. Neither appears in stdout. | PASS |
| stdout only the result | `--json`: exactly one line of JSON. Text mode: `Stub output text.\n`. stderr empty in both. | PASS |
| No key + real client | Config with default `anthropic` provider, no `ANTHROPIC_API_KEY`: exit 2, stdout empty, stderr `error: environment variable ANTHROPIC_API_KEY is not set; ...`. Stub saw 0 requests. | PASS |
| Unknown persona | exit 3 (documented: unknown persona/author), `{ok:false,error:{code:'UNKNOWN_PERSONA',...}}`, 0 LLM requests | PASS |
| Unknown author | exit 3, `UNKNOWN_AUTHOR`, 0 LLM requests, author id not echoed | PASS |
| Keyless openai-compat | Stub request had no `Authorization` header | PASS |

Probe execution: no `scripts/*/tests/probe-*.sh` declared or present. The probe above was an ad hoc node script (not committed).

## Requirements Coverage

| Requirement | Status | Evidence |
|---|---|---|
| ORC-01 | SATISFIED | Truth 1 |
| ORC-02 | SATISFIED | Truth 2 |
| ORC-03 | SATISFIED | 5 commands, `--json`, exit codes 0-8 documented in CONTRACTS.md; every mapping spot-checked (2, 3, 5, 6 in probe/system test; 7 in system test; 4 in `tests/integration/cli.test.ts`) |
| ORC-04 | SATISFIED | Truth 3, parity test |
| ORC-05 | SATISFIED | Cap checked first in `Orchestrator.generate`; CLI exit 6 |
| LLM-01 | SATISFIED | `OpenAICompatClient`; keyless local stub works |
| LLM-02 | SATISFIED | `createLlmClient`, `--provider`, unknown -> `ConfigError`; shared `withRetry` |

No orphaned requirements: REQUIREMENTS.md maps no other ID to Phase 5.

## Anti-Patterns Found

`grep -E "TBD|FIXME|XXX" src`: none. No stubs found in the new files; empty-collection matches are initial state overwritten by real data. None blocking.

## Human Verification Required

None. Live Anthropic calls were not made (no key, no network); the adapter is exercised by unit/integration tests and the no-key and unreachable-endpoint paths in the system test.

## Gaps Summary

None. Phase goal achieved.

---

_Verified: 2026-11-13_
_Verifier: Claude (gsd-verifier)_
