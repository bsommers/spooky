---
phase: 08-humanizer
fixed_at: 2026-11-15T00:00:00Z
review_path: .planning/phases/08-humanizer/08-REVIEW.md
iteration: 1
findings_in_scope: 9
fixed: 9
skipped: 0
status: all_fixed
---

# Phase 8: Code Review Fix Report

**Fixed at:** 2026-11-15
**Source review:** .planning/phases/08-humanizer/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 9 (HR-01, HR-02, MD-01, MD-02, MD-03, LW-01..LW-04; Info not in scope)
- Fixed: 9
- Skipped: 0

**Verification:** `scripts/verify.sh` PASS, run in an isolated git worktree (node_modules symlinked from the main checkout) and fast-forwarded into `gsd/phase-01-foundation`. Final counts: smoke 4, unit 922, integration 285, system 65, security 472, torture 5, 0 skipped. Typecheck clean. The calibration doc test (`tests/system/humanize-calibration.test.ts`) passes with the recorded numbers unchanged, because the deterministic edits over the corpus are not affected by the new guard checks or the trimmed replacement table.

## Fixed Issues

### HR-01: Guard accepts content additions (URL, email, link, fence, injected sentence)

**Files modified:** `src/humanize/guard.ts`, `config/humanize.ts`, `tests/unit/humanize/guard.test.ts`
**Commit:** 90faf16
**Applied fix:** Link tokens (URL, email, bare host, markdown link target) are compared as multisets (`link_added` / `link_dropped`, so swapped emails fail); a new code fence is `fence_added`; sentences of 4+ words with under half their words in the original's vocabulary are counted as new, and more than one per ten original sentences (none under ten) is `sentences_added`. Thresholds live in `config/humanize.ts`. An existing test that expected only `number_added` now expects it among the violations (the added sentence is also new prose).

### HR-02: Model chatter and wrappers accepted as document content

**Files modified:** `src/humanize/rewriteLlm.ts`, `src/humanize/guard.ts`, `config/humanize.ts`, `tests/unit/humanize/rewriteLlm.test.ts`
**Commit:** 47deedd
**Applied fix:** `unwrap` also strips one outer code fence when the original has none. An answer whose first line is absent from the input and ends in `:` or is a stock opener (Sure, Certainly, Here is...) throws `LlmError` (recorded as `llm_error`, prior text kept). The guard gains `content_dropped` (under 60% of the original's distinct words kept, judged for 12+ word vocabularies), which also bounds silent deletion (IN-03).

### MD-01: Number and name checks are set-based

**Files modified:** `src/humanize/guard.ts`, `tests/unit/humanize/guard.test.ts`
**Commit:** ed7c9b8
**Applied fix:** Number tokens carry sign, currency symbol and `%` or a short unit, are compared as counts (dropped/added) and as an ordered sequence (`number_reordered`). Named entities are compared by count against the other side's capitalized occurrences, plus an ordered check on names present on both sides (`entity_reordered`). Status: fixed, requires human verification (logic change in a heuristic guard; the limits that remain are documented, see below).

### MD-02: Deterministic cliche replacements corrupt text

**Files modified:** `src/humanize/rewrite.ts`, `config/humanize.ts`, `tests/unit/humanize/rewrite.test.ts`
**Commit:** 638272c
**Applied fix:** `underscore(s)`, `aligning` and `exhibited` removed from the table; a/an agreement corrected after replacement; a match is skipped when adjoined by `.`, `-`, `/`, `@` or an identifier character (dotted names, paths, emails, snake_case), while a sentence-final word is still replaced; quoted spans are not edited, so one quoted cliche word no longer discards the whole deterministic candidate. Status: fixed, requires human verification (the vowel-sound rule is a small heuristic).

### MD-03: `generate --humanize` bypasses persona banned phrases

**Files modified:** `src/engine.ts`, `src/humanize/loop.ts`, `tests/integration/humanize.test.ts`
**Commit:** 3777414
**Applied fix:** The loop takes an optional `banned(text)` dependency; a candidate adding a banned phrase the input lacked is rejected as `banned_phrase_added`. `Engine.generate` wires the persona's list in, and after the loop recomputes the `persona-banned` trace entry for the returned text (replacing the stale one), so the CLI warning is accurate. The style filter itself is not re-run (stated in the docs).

### LW-01: `neutralize` permanently alters user text

**Files modified:** `src/humanize/rewriteLlm.ts`, `tests/unit/humanize/rewriteLlm.test.ts`
**Commit:** be755b8
**Applied fix:** When the original contained a delimiter look-alike, `&lt;` before `input` / `exemplar(s)` in the answer is restored to `<`. A text that never needed escaping is left alone. Limitation: a non-ASCII look-alike (fullwidth `＜`) is restored as ASCII `<`.

### LW-02: `llmCalls` counts attempts that made no call

**Files modified:** `src/humanize/loop.ts`, `src/models/types.ts`, `tests/unit/humanize/loop.test.ts`, `tests/integration/humanize.test.ts`
**Commit:** 2684b77
**Applied fix:** `llmCalls` increments after `deps.llm()` succeeds (no key: 0). Docs (`docs/HUMANIZING.md`, `docs/API.md`) and the type comment say "one logical call, plus transport retries".

### LW-03: `HUMANIZE_CAVEAT` implies measured detector results

**Files modified:** `config/humanize.ts`, `src/service/operations.ts`, `tests/unit/service/operations.test.ts`, `tests/system/humanize-calibration.test.ts`
**Commit:** 39e1983
**Applied fix:** Caveat now ends "No external detector has been tested (docs/HUMANIZING.md)." The AUC comes from `HEURISTIC_HELD_OUT_AUC` (caveat and operation description), and the calibration test asserts it equals the measured `testAucBefore`. README, `docs/API.md`, `docs/MCP.md` and `docs/SURFACES.md` still contain the literal 0.694 in prose; the code figure is checked, the prose is not.

### LW-04: Surface parity gap on `target`

**Files modified:** `src/service/schemas.ts`, `src/engine.ts`, `src/cli/main.ts`, `tests/integration/surfaces.test.ts`, `tests/integration/humanize.test.ts`, `tests/integration/humanize-cli.test.ts`
**Commit:** 8ad6e36
**Applied fix:** `generateInput` refines `target` to require `humanize: true` (CLI, HTTP, MCP all report `USAGE`; the CLI's separate check was removed so the code is uniform); the library throws `ConfigError`. A cross-surface failure case was added. The other LW-04 gaps (`maxIterations`/`llm` on `generate`, `maxTokens`/`temperature` on `humanize`, `maxIterations: 0` as a redact-only no-op) are documented in `docs/HUMANIZING.md` as deliberate surface limits, not changed.

## Docs and tests added outside a single finding

- `docs/HUMANIZING.md` (commit d50a2a1): guard description rewritten to what it now checks; a "Known limits" list (sentence-initial names, caseless scripts get no name protection, number words untracked, negation/reorder, single quotes and long quotes, vocabulary-overlap heuristics, style filter not re-run); surface limits; "Not measured" now says the new checks have not been run against real model output.
- End-to-end probes through `Engine.humanize` for the link, chatter and fence bypasses (commit b693a29).

## Not in scope

IN-01 (duplicated defaults in `HumanizeFilter`), IN-02, IN-04 were not changed. IN-03 is covered by the `content_dropped` check but the 0.5x to 2x length bounds are unchanged.

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
