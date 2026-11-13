---
phase: 05-orchestration
reviewed: 2026-11-13T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - src/orchestration/orchestrator.ts
  - src/llm/http.ts
  - src/llm/retry.ts
  - src/llm/factory.ts
  - src/llm/anthropicClient.ts
  - src/llm/openaiCompatClient.ts
  - src/llm/mockClient.ts
  - src/engine.ts
  - src/cli/main.ts
  - src/cli/bin.ts
  - src/registry/sourceManager.ts
  - src/registry/profileFile.ts
  - src/config/schema.ts
  - src/config/load.ts
  - src/filters/registry.ts
  - src/models/types.ts
  - src/index.ts
findings:
  critical: 0
  high: 1
  medium: 5
  low: 4
  info: 5
  total: 15
status: issues_found
---

# Phase 05: Code Review Report

**Reviewed:** 2026-11-13
**Depth:** standard
**Files Reviewed:** 17 source files (diff f69c48c..4766ea9), plus `package.json` and `.planning/CONTRACTS.md`. Tests were read for coverage gaps only.
**Status:** issues_found

## Summary

Several parts are sound:

- **Ordering in `generate`:** size cap, persona, author and lazy client come before the PRE pipeline. The retrieval query and the prompt input are built only from PRE output. `requireConfidentiality` checks both traces for a successful entry. Empty, non-string and oversized answers become `LlmError`. A POST failure returns no text.
- **Retry:** the attempt arithmetic is right (`maxRetries=2` gives 3 attempts). `Retry-After` is clamped. Errors are rebuilt from kind and status only, so no URL, header or body is carried.
- **HTTP size cap:** `readCapped` counts bytes after decompression and cancels the stream at the cap.
- **API key:** it is read only in `factory.ts`, validated as visible ASCII, held in a private field, and excluded from `toJSON`.
- **State files:** they are written 0600 via `wx` temp file plus rename, and validated field by field on load.
- **Anthropic SDK:** `maxRetries:0` and an explicit `timeout` are set. I checked the SDK source. With `_options.timeout` set, `_calculateNonstreamingTimeout` is not called, so a large `maxTokens` does not hit the SDK's "streaming required" throw.
- **CLI exit codes:** the mapping matches CONTRACTS.md.

The defects are in these areas:

- What counts as "redacted" at generate time.
- Persistence failure atomicity.
- Key-egress policy.
- Redirect handling on the Anthropic path.

## High

### CR-01: Retrieved exemplars bypass the confidentiality filter at generate time

**File:** `src/orchestration/orchestrator.ts:68-72`
**Issue:** Only `input` goes through the PRE pipeline. The exemplar chunks from `retrieve()` go straight into `buildPrompt` and to the provider. They are trusted to have been redacted at ingest, but that trust fails in these cases:

- The blocklist or `customRules` in `config.confidentiality` were extended after the ingest. The persisted `store.json` keeps text redacted under the old ruleset, and the new term then reaches the LLM verbatim. Config is now a real, changeable surface (the new `confidentiality` section), so this is a realistic path.
- `store.json` was produced by another tool or tampered with. The state dir is a persisted, loaded-from-disk input (Phase 4 WR-06: `load` re-validates structure but not content).

This violates the stated property that "the provider never sees text the confidentiality filter had a chance to redact".
**Fix:** Run each selected exemplar's text through `this.#d.pre` (with `requireConfidentiality`) before `buildPrompt`, in the same step as the input. Alternatively, store a ruleset fingerprint in `profiles.json` and refuse to generate (`StoreCorruptError` or "re-ingest required") on mismatch. Add a test that ingests, then adds a blocklist term, then generates, and asserts the term is absent from `llm.requests`.

## Medium

### CR-02: A failed or interrupted `remove` leaves state that bricks every later command

**File:** `src/registry/sourceManager.ts:208-214, 276-281`; `src/registry/sourceManager.ts` `#load` (`probe.length === 0` check)
**Issue:** `#persist` writes the store first, then the profiles. On `remove`, a crash or an I/O error (disk full, `EACCES`) between the two writes leaves a `store.json` without the author's chunks next to a `profiles.json` that still lists the author. `#load` then throws `StoreCorruptError("a profile has no stored chunks")` on every process start, so the CLI exits 7 for ingest, generate and profile alike. The only recovery is deleting files by hand, and no API repairs the state. The header comment argues "never a profile without chunks", which holds for ingest only.
**Fix:** Make the write order operation-specific. On remove, write the profiles file first, then the store (orphan chunks are harmless). On ingest, keep store first. Alternatively, have `#load` treat a profile without chunks as an orphan to drop, with a warning, not as corruption.

### CR-03: In-memory state runs ahead of disk when `#persist` fails

**File:** `src/registry/sourceManager.ts:167-168, 212-213`
**Issue:** `#profiles.set` (ingest) and `#profiles.delete` plus `deleteCollection` (remove) happen before `await this.#persist()`. If the save rejects, the caller gets an error but the live manager keeps the new state:

- A library `Engine` will serve the unpersisted author on later `generate` calls.
- After a failed `remove`, the author is gone in memory but comes back on the next process start. For a confidentiality tool, "I deleted it and got an error" followed by the data returning is the worst direction to fail in.
- `store.save` also runs before `saveProfiles`, so a profiles write failure leaves a disk store with new chunks but old profile data.

**Fix:** On `#persist` failure, roll back the in-memory change (restore the previous profile and collection, or reload from disk), or mark the manager as "dirty" and retry the save on the next serialized operation. At minimum, document it and make `remove` re-throw with a typed error that says the deletion is not durable.

### CR-04: Concurrent CLI processes silently lose data (unlocked read-modify-write)

**File:** `src/cli/main.ts:197-204`; `src/registry/sourceManager.ts:276-281`; `.planning/CONTRACTS.md` (Persistence)
**Issue:** Each `ghostwriter ingest` loads the whole state, ingests (CPU-bound, up to 10M characters), then overwrites both files. Two overlapping invocations for different authors, such as a shell loop with `&` or CI jobs sharing `$GHOSTWRITER_STATE_DIR`, leave only the later writer's author. There is no lock file, and no version, mtime or ETag check before replacing. Nothing reports the loss and both exit 0. The contract documents "last-writer-wins", but silent data loss on a normal usage pattern needs a guard rather than a note.
**Fix:** Take an advisory lock (`open(dir/.lock, 'wx')` with pid and stale detection) around the load-ingest-save cycle in the CLI. Alternatively, record the loaded `mtimeMs` and `size` and fail with a typed error if the files changed before the rename.

### CR-05: API key can be sent in cleartext to any host; no endpoint policy

**File:** `src/llm/openaiCompatClient.ts:51-63, 77`; `src/config/schema.ts` (`httpUrl`); `src/cli/main.ts:141-143`
**Issue:** `baseUrl` accepts any `http:` or `https:` URL, including non-loopback `http://`, link-local or metadata addresses (`169.254.169.254`), and internal hosts. `apiKeyEnv` is independently settable, and `--base-url` plus `--api-key-env ANTHROPIC_API_KEY` on the CLI is enough to point any env var's value at any endpoint. A shared or untrusted config file (`$GHOSTWRITER_CONFIG`) can therefore send `ANTHROPIC_API_KEY` or `AWS_SECRET_ACCESS_KEY` in plaintext to an attacker host, and it can make the process issue requests to internal services. Credentials embedded in the URL are only rejected at client construction (lazily, on first `generate`), not at config load, so `ghostwriter filters` accepts a config that `generate` later rejects.
**Fix:**
- Require `https:` unless the host is loopback (`localhost`, `127.0.0.0/8`, `::1`), and send `Authorization` only in that case.
- Reject `u.username` and `u.password` in `httpUrl`, so the failure is at load.
- Optionally add an allow-list for `apiKeyEnv` names, or a `--allow-insecure-endpoint` opt-in.
- Document the SSRF surface for config files from untrusted sources.

### CR-06: Anthropic requests follow redirects with the API key attached

**File:** `src/llm/anthropicClient.ts:50, 93-106`
**Issue:** The OpenAI-compat path sets `redirect: 'error'` ("a redirect cannot carry the key elsewhere"), but the Anthropic path passes the SDK's `init` to `fetch` unchanged and the SDK does not set `redirect`. Fetch strips `Authorization` on a cross-origin redirect but not custom headers, so the `x-api-key` header is forwarded to the redirect target. This matters with the `anthropicBaseUrl` override (proxy, test) and any intermediary that returns a 3xx. The documented secret-safety property therefore holds for one provider only.
**Fix:** In `boundedFetch`, call `inner(input, { ...init, redirect: 'error' })`. Add a test with a stub that returns a 302 and asserts that no second request is made.

## Low

### WR-07: `trace.llm.attempts` is always 1 for real providers

**File:** `src/orchestration/orchestrator.ts:76-83, 92`
**Issue:** `attempts++` counts calls to `llm.complete`. `AnthropicClient` and `OpenAICompatClient` retry internally via their own `withRetry` (the engine passes `maxRetries` into the client). The orchestrator's outer `withRetry` therefore sees one call, and `LlmError` passes through it. The trace metadata `attempts` is 1 even after three real HTTP attempts, and the outer retry layer is dead code for real clients. The two layers (`options.retry` in `EngineOptions` versus `llmClientOptions.retry`) are also easy to misconfigure: `EngineOptions.retry` does not reach the real client's sleeps.
**Fix:** Pick one retry owner. Either the clients stop retrying and return `LlmTransportError`, which the orchestrator wraps and counts, or the orchestrator drops its `withRetry` for real clients and reads the attempt count from the `LlmError`. Document the choice in CONTRACTS.md.

### WR-08: Truncated model output is accepted as a success

**File:** `src/llm/anthropicClient.ts:74-84`; `src/llm/openaiCompatClient.ts:117-122`
**Issue:** `stop_reason: 'max_tokens'` (Anthropic) and `finish_reason: 'length'` (OpenAI) are ignored. A rewrite cut off mid-sentence goes through POST and is printed with exit 0. `--max-tokens` is user-tunable, so this is a normal occurrence.
**Fix:** Surface a truncation signal (an `LlmTransportError('invalid-response')`, or a warning on the result and a stderr line in the CLI), at minimum so scripts can detect it.

### WR-09: `--json` stdout discipline gaps

**File:** `src/cli/main.ts:162-171, 295, 306`
**Issue:**
- `--help --json` and `--version --json` write help text to stdout (`writeOut`), so the "exactly one JSON document" contract is broken.
- `--json` is detected with `argv.includes('--json')`, so it also fires when the string is an option value (`--name --json`) or comes after `--`.
- A successful `--help` prints prose on stdout even when it should not.

**Fix:** In JSON mode, route `writeOut` to stderr, or emit `{ok:true, help:...}`. Detect JSON mode after parsing (`program.opts()` per command), or stop scanning at `--`.

### WR-10: `describeError` mislabels and echoes

**File:** `src/cli/main.ts:282-287`; `src/registry/sourceManager.ts` (`UnknownAuthorError(authorId)`)
**Issue:**
- The regex `/^E[A-Z0-9]+$/` also matches Node `ERR_*` codes (such as `ERR_STRING_TOO_LONG`), so these are reported as "file system error". A genuine filesystem error carrying the OS message is correctly suppressed.
- `generate --author <x>` does not validate the id before lookup, and `UnknownAuthorError` echoes the raw argument to stderr and into the `--json` message. This is the caller's own input, but it is the same secret-shaped-identifier path as Phase 4 CR-03, now on the CLI surface.

**Fix:** Match only known errno names, or require `typeof (err as {errno?: number}).errno === 'number'`. Apply `AUTHOR_ID` to `--author` on `generate` and `profile` and report "invalid author id" without echoing the value.

## Info

### IN-01: `writeFileAtomic` is duplicated

**File:** `src/registry/profileFile.ts:84-102`; `src/store/inMemoryVectorStore.ts:205-229`
**Issue:** The atomic 0600 write is copied. Neither copy fsyncs the parent directory, and neither tightens the mode of an already-existing state directory (`mkdir` mode applies only to directories it creates). A pre-existing 0755 `--state-dir` keeps its mode.
**Fix:** Share one helper. Optionally `chmod` the dir to 0700 when the process owns it, and fsync the dir after rename.

### IN-02: Anthropic client and `API_KEY_PATTERN` coupling

**File:** `src/llm/anthropicClient.ts:11`
**Issue:** The Anthropic adapter imports `API_KEY_PATTERN` from the OpenAI-compat module. It belongs in `http.ts` or `factory.ts`.
**Fix:** Move it to `http.ts`.

### IN-03: The SDK reads `ANTHROPIC_BASE_URL` when no `baseUrl` is given

**File:** `src/llm/anthropicClient.ts:51-57`
**Issue:** With `options.baseUrl` undefined (the normal case), the SDK falls back to `process.env.ANTHROPIC_BASE_URL`. That bypasses this file's scheme and credential checks, and it sends `x-api-key` wherever the env points, independent of the engine's injected `env`. The env is trusted, but the behavior is surprising and the injected `env` is not honored.
**Fix:** Always pass `baseURL: options.baseUrl ?? 'https://api.anthropic.com'`.

### IN-04: `readCapped` in the CLI is stat-then-read

**File:** `src/cli/main.ts:84-97`
**Issue:** The file is `stat`ed for the cap and then `readFile`d unbounded. A file that grows between the two calls defeats the cap. This is low risk because it is local and requires a race.
**Fix:** Open the file, then `fh.read` into a buffer of at most `maxBytes + 1`.

### IN-05: `OrchestratorDeps.post` is not checked to end with confidentiality

**File:** `src/orchestration/orchestrator.ts:96-98, 113-117`
**Issue:** `requireConfidentiality` proves a confidentiality entry exists, not that it ran last. Config-built pipelines are guarded by `buildPipeline`. A pipeline injected through the public `Orchestrator`/`factories` surface can run a later filter that reintroduces text.
**Fix:** Require the last non-skipped trace entry at `post` to be `confidentiality`, or document that the injected pipeline owns this.

---

_Reviewed: 2026-11-13_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
