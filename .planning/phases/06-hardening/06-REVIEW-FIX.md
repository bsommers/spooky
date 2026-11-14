---
phase: 06-hardening
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/06-hardening/06-REVIEW.md
iteration: 1
findings_in_scope: 10
fixed: 10
skipped: 0
status: all_fixed
---

# Phase 6: Code Review Fix Report

**Fixed at:** 2026-11-14
**Source review:** .planning/phases/06-hardening/06-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 10 (WR-01..WR-06, IN-02..IN-05 as requested)
- Fixed: 10
- Skipped: 0 (IN-01 deliberately left out of scope, see below)

**Verification location:** per-fix checks (targeted vitest runs, `tsc --noEmit`) and a full `scripts/verify.sh` ran in an isolated git worktree (node_modules symlinked, `dist` built there): typecheck ok, smoke 4, unit 648, integration 184, system 43, security 241, torture 5 (1125 tests), skipped 0. The final `scripts/verify.sh` was re-run in the main checkout after the fast-forward (result in the hand-off message).

## Fixed Issues

### WR-01: Perf budget fails under CPU contention
**Files modified:** `tests/system/perf.test.ts`, `docs/AS-BUILT.md`
**Commit:** 5772562
**Applied fix:** primary assertion is now `t(200k)/t(50k) < 8` (linear about 4, quadratic about 16). Absolute ceilings (11 ms / 45 ms x factor) are checked only when `GHOSTWRITER_PERF_SCALE` is set; `parseScale` throws a clear error on `abc`, `0`, negatives and `Infinity`, and has its own test. AS-BUILT perf section rewritten. Status: fixed: requires human verification (threshold of 8 chosen from the measured ratio of about 4; confirm it is stable on your CI runner).

### WR-02: Torture padding hides a real leak class; AS-BUILT misstates it
**Files modified:** `docs/AS-BUILT.md`, `README.md`, `tests/torture/engine-torture.test.ts` (comment only)
**Commit:** b278011
**Applied fix:** probed `dist` with each format preceded by `W`, a word, a digit, `=` and `_`. Not redacted when glued: npm, Hugging Face, `sk-`, Stripe (`sk_live_`), SendGrid (`SG.`) and JWT (JWT also after `_`). Redacted: AWS, GitHub, GitLab, Slack, Google. AS-BUILT Known limits corrected (the review's list omitted Stripe and SendGrid); README privacy section now states the gap. The confidentiality filter was not changed, as instructed. No pin test was added.

### WR-03: asBuilt guard only proves the title appears somewhere
**Files modified:** `tests/system/asBuilt.test.ts`
**Commit:** b30b3e2
**Applied fix:** new exported `hasActiveTest(src, title)` requires the title to be the entire string literal of an active `it(`/`test(`/`it.each(...)(` call; rejects `.skip`, `.todo`, `skipIf`, line and block comments, `describe` names, longer titles. Applied to every reference in every row (each ref must pass, each row needs at least one). 15 self-tests for the matcher. Status: fixed: requires human verification (regex-based, not a JSON-reporter run; the review's type-level tests for defects 1 and 2 were not added because both rows already map a behaviour test).

### WR-04: README snippet and its test can drift
**Files modified:** `tests/integration/readmeExample.test.ts`, `README.md`
**Commit:** a72fa48
**Applied fix:** new test extracts the README ```ts block that defines `noEmoji` and compares it, whitespace-squashed, with the code between the markers (confirmed it fails when README is edited). Step 2 reworded in both places: insert `{ name: 'noEmoji', stage: 'post' }` between the `style` entry and the final `confidentiality` entry.

### WR-05: e2e persona-structure assertions test the mock script
**Files modified:** `tests/system/e2e.test.ts`, `docs/AS-BUILT.md`
**Commit:** 69d9e51
**Applied fix:** AS-BUILT and test header/title reworded (mandates reach the prompt; the scripted model only mirrors it). Added e2e cases: a banned phrase inside inline code survives the style filter and yields the `persona-banned` trace entry (count only, no phrase); a transient network failure is retried (`attempts: 2`); a persistent 503 rejects with `LlmError` (`LLM_FAILED`, 2 attempts) and returns no text. CLI-visible stderr warning is not exercised here (e2e is in process).

### WR-06: Coverage-mode skip invisible to the gate; fragile trigger
**Files modified:** `vitest.config.ts`, `tests/unit/chunker.test.ts`, `scripts/verify.sh`
**Commit:** 63ebaab
**Applied fix:** removed the `process.argv` check and the env var from `vitest.config.ts`. The chunker test reads the resolved worker config (`__vitest_worker__.config.coverage.enabled`), verified true for `--coverage`, `--coverage.enabled`, `--coverage=true` and false otherwise. `verify.sh` counts skipped/todo per tier, prints `SKIPPED` and a `skipped:` line, and fails when anything is skipped outside `--coverage`. Status: fixed: requires human verification (relies on the vitest-internal `__vitest_worker__` global; re-check on a vitest major upgrade).

### IN-02: Docs drift against measured values
**Files modified:** `docs/AS-BUILT.md`, `README.md`
**Commit:** b1afaa7 (plus counts in 23b7b67)
**Applied fix:** coverage figures 96.43% / 92.12%, "best of 9 per size", coverage-skip paragraph, README state-dir default now includes `$XDG_STATE_HOME`; per-tier counts updated to 1125.

### IN-03: Perf test sets a wider config than the doc claims
**Files modified:** `tests/system/perf.test.ts`, `docs/AS-BUILT.md`
**Commit:** 5cf7586
**Applied fix:** dropped the `maxInputChars: 400_000` override; 200k is exactly the default cap and passes.

### IN-04: Test mutates shared `KNOWN_FILTER_NAMES`
**Files modified:** `tests/integration/readmeExample.test.ts`
**Commit:** c924c61
**Applied fix:** push and restore moved into one test body with try/finally; restores only if the test added the name; `afterEach` removed.

### IN-05: README `npx ghostwriter` package-name mismatch (doc note only)
**Files modified:** `README.md`
**Commit:** aa56463
**Applied fix:** README no longer suggests `npx ghostwriter`; it says to use `npm link` or `node dist/src/cli/bin.js` and warns about the unrelated registry package.

## Not In Scope

### IN-01: Torture assertions check "typed", not "correct code"
**File:** `tests/torture/engine-torture.test.ts:123-127,149-152`
**Reason:** excluded by the request (not trivial: needs a behaviour-to-code map and seed-dependent floor changes).

---

_Fixed: 2026-11-14_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
