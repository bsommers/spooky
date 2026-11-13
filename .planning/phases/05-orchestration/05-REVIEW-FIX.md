---
phase: 05-orchestration
fixed_at: 2026-11-13T00:00:00Z
review_path: .planning/phases/05-orchestration/05-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 05: Code Review Fix Report

**Fixed at:** 2026-11-13
**Source review:** .planning/phases/05-orchestration/05-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8 (CR-01..CR-06, WR-08, WR-09, as requested)
- Fixed: 8
- Skipped: 0
- Out of scope, untouched: WR-07, WR-10, IN-01..IN-05

**Verification:** `scripts/verify.sh` ran after every fix and ended PASS each time. Final run: smoke 4, unit 648, integration 182, system 8, security 241, torture 4 (1087 tests). It ran in the main checkout (`gsd/phase-01-foundation`), not an isolated worktree: the caller required the gate after each fix and a worktree has no `node_modules`; the caller was waiting synchronously, so there was no foreground session to race. Every new regression test was also run against the pre-fix source and failed there. Nothing was pushed.

## Fixed Issues

### CR-01: Retrieved exemplars bypass the confidentiality filter at generate time

**Files modified:** `src/orchestration/orchestrator.ts`, `tests/integration/orchestrator.test.ts`
**Commit:** cbc112b
**Applied fix:** Each retrieved exemplar is run through the same PRE pipeline as the input (`requireConfidentiality` per exemplar, fail closed with `FilterFailedError` before any LLM call) and the redacted text is what `buildPrompt` receives. Tests: a blocklist term added after ingest never appears in the provider request (user or system), and an exemplar whose PRE run has no successful confidentiality entry fails closed with zero LLM calls. The ruleset-fingerprint alternative was not taken. Status: fixed, requires human verification (security ordering).

### CR-02: A failed or interrupted `remove` leaves state that bricks every later command

**Files modified:** `src/registry/sourceManager.ts`, `tests/integration/persistence.test.ts`
**Commit:** 940c381
**Applied fix:** `#persist` takes an order: ingest and `save()` write the store first, `remove` writes the profiles first. A crash between the two writes therefore leaves new chunks next to the old or no profile (ingest) or a dropped profile with orphan chunks (remove), never a profile without chunks, and `load()` keeps its corruption check (not weakened). Tests simulate a crash right after the store write for both remove and ingest and assert a fresh process loads (the remove case failed before with `StoreCorruptError`). Status: fixed, requires human verification (write ordering). Orphan chunks of a removed author can linger on disk until the next successful save (the in-memory rollback in CR-03 deletes the collection when no profile owns it).

### CR-03: In-memory state runs ahead of disk when `#persist` fails

**Files modified:** `src/registry/sourceManager.ts`, `tests/integration/persistence.test.ts`
**Commit:** a615120
**Applied fix:** `ingest` and `remove` snapshot the profile map and call `#persistOrRollback`. On a persist failure the manager re-reads the state files (what a restart would load), falls back to the snapshot minus the touched author if they cannot be read, deletes the touched author's collection if no profile owns it, then rethrows the original error. Tests (read-only state dir, plus a store that "crashes" after writing): failed remove keeps the author and retrieval results, failed first ingest leaves no profile or chunks (and a later save does not resurrect them), failed re-ingest restores the previous profile and chunks, failed first-ever save leaves an empty manager. Status: fixed, requires human verification. Limit: when the store file was written but the profiles file was not (partial persist), memory matches the disk, not the pre-operation state (for a re-ingest that is new chunks next to the old profile); exact pre-operation restore would need a store snapshot API.

### CR-04: Concurrent CLI processes silently lose data (unlocked read-modify-write)

**Files modified:** `src/registry/stateLock.ts` (new), `src/engine.ts`, `src/models/errors.ts`, `src/cli/main.ts`, `src/index.ts`, `.planning/CONTRACTS.md`, `tests/integration/stateLock.test.ts` (new)
**Commit:** 353f00c
**Applied fix:** Advisory lock `<stateDir>/.lock` created with `O_EXCL` (mode 0600, holds pid, host, token, time). `Engine.ingest` (hence `ghostwriter ingest`) takes it, re-`load()`s the state under the lock, ingests and saves, and releases only a lock that still carries its own token. A lock whose pid is gone (same host) or older than `staleMs` (default 15 min) is reclaimed by an atomic rename claim; waiting is bounded (`waitMs` default 30 s, `pollMs` 50) and ends in the new typed `StateLockedError` (`STATE_LOCKED`, CLI exit 8, documented in CONTRACTS.md). Options are exposed as `EngineOptions.stateLock` and through `CliDeps`. Tests: two engines that loaded the same empty state and ingest different authors concurrently both survive (lost before); live holder gives `StateLockedError` after the bounded wait without deleting the winner's lock; dead-pid and over-age locks are reclaimed; a fresh live-pid lock and an unparseable fresh lock are respected; mode bits; five-way serialization; lock released after a failed ingest; CLI exits 8 with a `STATE_LOCKED` JSON document and writes nothing. Not done: readers (`generate`, `profile`) do not lock, so a read during another process's two-file save can still see an inconsistent pair and report `STORE_CORRUPT`; `remove` is not exposed on `Engine`, so only ingest is locked. Status: fixed, requires human verification (new concurrency primitive).

### CR-05: API key can be sent in cleartext to any host; no endpoint policy

**Files modified:** `src/llm/endpoint.ts` (new), `src/config/schema.ts`, `src/llm/openaiCompatClient.ts`, `src/llm/anthropicClient.ts`, `.planning/CONTRACTS.md`, `tests/unit/endpointPolicy.test.ts` (new), `tests/unit/llmFactory.test.ts`
**Commit:** 4edd4d3
**Applied fix:** One pure policy (`endpointProblem`, `isLoopbackHost`: exact matches for `localhost`, `127.0.0.0/8`, `::1`). `loadConfig` now rejects `llm.baseUrl` with embedded credentials (message never echoes the value) and rejects `apiKeyEnv` combined with a non-loopback `http:` URL. Both clients re-check at construction (key plus non-loopback http is a `ConfigError`; the Anthropic `baseUrl` override follows the same rule); keyless remote http stays allowed. The rule, the redirect refusal and the remaining SSRF surface (private and metadata addresses are not blocked; treat `$GHOSTWRITER_CONFIG` as trusted) are documented in CONTRACTS.md "LLM providers". Tests cover loopback lookalikes (`127.0.0.1.evil.com`, `localhost.evil.com`, `http://127.0.0.1@evil.com`), the config and client paths, and the factory. One existing test used `http://h/v1` with a key and was changed to `https://h/v1`. Not done: the optional `apiKeyEnv` allow-list and `--allow-insecure-endpoint` opt-in. Status: fixed, requires human verification (policy choice).

### CR-06: Anthropic requests follow redirects with the API key attached

**Files modified:** `src/llm/anthropicClient.ts`, `tests/integration/llm.test.ts`
**Commit:** 53afa8b
**Applied fix:** `boundedFetch` calls the inner fetch with `{ ...init, redirect: 'error' }`. Tests: a 307 to a second stub never produces a request there, and the underlying fetch receives `redirect: 'error'` on every request.

### WR-08: Truncated model output is accepted as a success

**Files modified:** `src/llm/retry.ts`, `src/llm/anthropicClient.ts`, `src/llm/openaiCompatClient.ts`, `.planning/CONTRACTS.md`, `tests/integration/llm.test.ts`
**Commit:** dab8cb5
**Applied fix:** New failure kind `LlmTransportError('truncated')`, non-retryable, raised for Anthropic `stop_reason: 'max_tokens'` and OpenAI `finish_reason: 'length'`, so `complete` ends in `LlmError` with no text (chose the typed error over a flagged trace entry, as instructed). Tests run against both adapters: one attempt, one request, the cut-off text absent from the error; a normal stop reason still succeeds.

### WR-09: `--json` stdout discipline gaps

**Files modified:** `src/cli/main.ts`, `.planning/CONTRACTS.md`, `tests/integration/cli.test.ts`
**Commit:** a5ce62e
**Applied fix:** The `argv.includes('--json')` scan is gone. JSON mode is set by commander's own `option:json` event (program-level `--json` before the command name via `enablePositionalOptions`, and each subcommand's `--json`), so a `--json` that is the value of another option or follows `--` does not count. In JSON mode help text is buffered and returned in one `{ok:true, help}` document (also for `--help` on a subcommand), usage errors including the bare no-command case (`commander.help`, exit 1, previously no document at all) are one `USAGE` document, and stderr stays empty. Actions read the shared setting instead of `opts.json`, so `--json personas` works. Tests cover each of those plus text-mode help unchanged. Residual: an error raised before any subcommand is reached (unknown command with extra unknown flags) has no subcommand to ask, so that single path scans argv up to `--` for `--json`; a false positive only turns a prose error into the JSON document. `--version` is not defined by the CLI, so it is an ordinary usage error. Status: fixed, requires human verification (CLI parsing semantics).

## Skipped Issues

None. WR-07, WR-10 and IN-01..IN-05 were excluded from scope by request and not attempted.

---

_Fixed: 2026-11-13_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
