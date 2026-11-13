---
phase: 05-orchestration
plan: 01
subsystem: llm
tags: [typescript, llm, retry, anthropic, openai-compat, fetch, vitest]

requires:
  - phase: 01-foundation
    provides: LlmClient / LlmRequest / ProviderConfig types, LlmError, ConfigError, verify.sh
provides:
  - withRetry(): bounded exponential backoff, Retry-After honored and clamped, terminal LlmError(attempts)
  - LlmTransportError(kind, status, retryAfterMs): secret-free per-attempt failure type
  - MockLlmClient: scripted (string | Error | function) responses, records request copies
  - AnthropicClient: official SDK with retries off, timeout, size-capped fetch wrapper
  - OpenAICompatClient: built-in fetch, optional bearer key, timeout, size cap, redirect:error, strict shape validation
  - createLlmClient(ProviderConfig, options): env-only key resolution
affects: [05-orchestration tasks 3-5 (orchestrator, engine, CLI)]

status: partial
scope: "Tasks 1-2 of 5 only. Orchestrator, Engine facade and CLI (tasks 3-5) are NOT in this summary."
actuals:
  tasks: 2
  commits: 2
plan_head_before: f69c48c27201e3750546e5ffa87c70d63ceea743
plan_head_after: 37d7e22d5c552405c225502b029a1ac1eefcc68c

key-files:
  created:
    - src/llm/retry.ts
    - src/llm/http.ts
    - src/llm/mockClient.ts
    - src/llm/anthropicClient.ts
    - src/llm/openaiCompatClient.ts
    - src/llm/factory.ts
    - tests/unit/retry.test.ts
    - tests/unit/llmFactory.test.ts
    - tests/integration/llm.test.ts
    - tests/helpers/llmStub.ts
  modified:
    - src/index.ts

key-decisions:
  - "Real clients retry internally (withRetry) and end in LlmError; withRetry passes an LlmError through untouched, so the orchestrator may wrap any client in withRetry (needed for MockLlmClient scripted failures) without multiplying attempts"
  - "Only LlmTransportError (kind + HTTP status) is kept as LlmError.cause; any other thrown error is reduced to its class name, so URLs, headers and bodies cannot carry the key into logs"
  - "Empty/whitespace output, malformed JSON, wrong shape and oversized responses are terminal (not retried); 429, 5xx, network and timeout are retried"
  - "Timeouts count as network failures and are retried"
  - "AnthropicClient sets SDK maxRetries:0 and wraps fetch to enforce the size cap and drop error bodies; baseUrl is overridable so the SDK path is tested against the local stub"
  - "apiKeyEnv must look like an env var name; a pasted key there is a ConfigError that does not echo it"
---

# Phase 5 Plan 01: LLM layer (Tasks 1-2 only) Summary

LLM client layer: bounded `withRetry`, a scripted `MockLlmClient`, Anthropic and OpenAI-compatible adapters with timeout/size-cap/shape validation, and an env-only-key factory. This summary covers Tasks 1 and 2 of 05-01-PLAN.md; Tasks 3-5 (orchestrator, engine, CLI) remain.

## Commits

| Task | Commit | Description |
|---|---|---|
| 1 | 5b3f50d | `withRetry`, `LlmTransportError`, `parseRetryAfter`, 15 unit tests |
| 2 | 37d7e22 | Mock + Anthropic + OpenAI-compat clients, factory, http helpers, stub-server tests, index exports |

## Behavior notes for the next executor

- `createLlmClient(config, { env?, retry?, timeoutMs?, maxResponseBytes?, fetch?, anthropicBaseUrl? })` throws `ConfigError` (CLI exit 2) when the anthropic key env var is unset/empty; the message names the variable only. openai-compat with no/unset/empty `apiKeyEnv` sends no Authorization header.
- Defaults: 2 retries (3 attempts), 500 ms base, 30 s max wait, 60 s request timeout, 4 MiB response cap. `maxRetries` is clamped to 10.
- `MockLlmClient(script)`: array entries are consumed one per call (string returned, `Error` thrown, function called with `(req, callNumber)`); a function script answers every call; running past the end throws a plain `Error`. `.requests` holds copies of every request (including failed calls); `.callCount`. Empty-string output is returned as-is: the orchestrator (task 3) owns the "empty -> LlmError" check for mock clients (real clients already enforce it).
- Orchestrator should call `withRetry(() => llm.complete(req), opts)`; scripted `LlmTransportError('http', {status: 503})` errors from the mock are then retried, other `Error`s are terminal.
- All of the above is exported from `src/index.ts`.

## Test counts

- `tests/unit/retry.test.ts`: 15 (success first try; fail,fail,ok with 1x/2x delays; 3 fails -> attempts=3; 400 not retried; Retry-After bounded; clamps; sanitized cause; Retry-After parsing)
- `tests/integration/llm.test.ts`: 39 (same matrix against both adapters over a local `http.createServer` stub: 200, 429-then-200, 500x3, 4xx, malformed JSON, non-JSON 200, empty output, connection refused, timeout, stalled body, oversize chunked + Content-Length, huge Retry-After, key never in errors; OpenAI-compat: Authorization only when key set, keyless local server, 14 malformed shapes, redirect not followed, inspect/JSON hides key, ctor validation; Anthropic: x-api-key, block joining, shape rejection, SDK does not self-retry)
- `tests/unit/llmFactory.test.ts`: 12 (factory env handling + MockLlmClient)
- Total new: 66. verify.sh: typecheck ok, 903 tests pass (unit 609, integration 45, security 241, smoke 4, torture 4, system 0), PASS.

## Deviations from Plan

None - plan executed as written. Additions beyond the plan text, all within Rule 2 (security requirements stated by the caller): `src/llm/http.ts` (shared capped reader), ctor validation of baseUrl/key/model, `redirect: 'error'`, rejecting a key-shaped `apiKeyEnv`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. Accepted residual: the Anthropic SDK path only caps response size via the wrapped fetch (applies to the body the SDK sees); documented provider-receives-redacted-text risk is unchanged and still belongs in the README (later task).

## Self-Check: PASSED

All created files exist; commits 5b3f50d and 37d7e22 are ancestors of HEAD; `scripts/verify.sh` PASS.
