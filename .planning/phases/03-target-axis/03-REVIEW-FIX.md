---
phase: 03-target-axis
fixed_at: 2026-11-13T00:00:00Z
review_path: .planning/phases/03-target-axis/03-REVIEW.md
iteration: 1
findings_in_scope: 6
fixed: 6
skipped: 0
status: all_fixed
---

# Phase 03: Code Review Fix Report

**Fixed at:** 2026-11-13
**Source review:** .planning/phases/03-target-axis/03-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 6 (CR-01..05 and CR-07, as requested)
- Fixed: 6
- Skipped: 0
- Out of scope, untouched: CR-06 (design question, needs plan-owner decision), IN-01, IN-02

**Verification:** `scripts/verify.sh` ran after every fix and ended PASS each time. Final run: smoke 4, unit 382, security 221, torture 3. It ran in the main checkout (`gsd/phase-01-foundation`), not an isolated worktree: the caller was waiting synchronously, so there was no foreground session to race. Nothing was pushed.

## Fixed Issues

### CR-01: `findBannedPhrases` bypassed by invisible characters, NFKC forms and whitespace variants

**Files modified:** `src/registry/targetManager.ts`, `tests/unit/target.test.ts`
**Commit:** e05ccc0
**Applied fix:** Both the text and each phrase go through the existing `normalizeForMatching` (NFKC, invisibles stripped), then whitespace runs collapse to one space and the result is lower-cased. Matching is `includes`, so `escapeRegExp` and the per-phrase `RegExp` are gone. Phrases that are empty after normalization are ignored. Homoglyphs and full Unicode case folding (`ß` vs `SS`) are documented as out of scope. Tests cover zero-width space, soft hyphen, ZWJ, fullwidth letters, NBSP, double space, newline, an invisible next to a space, mixed case, a normalized configured phrase, and invisible-only phrases. Status: fixed, requires human verification (matching semantics changed).

### CR-02: Delimiter neutralization did not cover invisible characters or fullwidth brackets

**Files modified:** `src/pipeline/promptBuilder.ts`, `src/filters/confidentiality.ts`, `tests/unit/promptBuilder.test.ts`
**Commit:** b4be2df
**Applied fix:** Detection now runs on the NFKC, invisible-stripped view of the text. It uses `normalizeWithMap` from the confidentiality filter, which now has an `export` keyword and no other change. The offending `<` code point in the original text is replaced by `&lt;`, so everything else, including ligatures and invisibles, is returned byte for byte. Plain ASCII output is identical to before. Tests cover `<​input>`, `</​input>`, soft hyphen, a split tag name, `<exemplar​>`, spaced invisibles, fullwidth `＜/input＞`, fullwidth letters, small `﹤`, and invisible-character delimiters inside exemplars. Status: fixed, requires human verification.

### CR-03: A NaN score made exemplar selection depend on input order

**Files modified:** `src/pipeline/promptBuilder.ts`, `tests/unit/promptBuilder.test.ts`
**Commit:** 4ca4431
**Applied fix:** `buildPrompt` throws `RangeError` naming the offending chunk id when any exemplar score is non-finite (NaN, +/-Infinity), before any ranking. This is the review's first option. Tests cover each non-finite value, three input orders with a NaN (the same error each time), and an all-finite shuffle that gives an identical prompt under a tight budget. Behavior change: a vector store returning NaN now fails loudly instead of producing an order-dependent prompt.

### CR-04: Persona and profile strings interpolated unescaped into the system prompt

**Files modified:** `src/pipeline/promptBuilder.ts`, `tests/unit/promptBuilder.test.ts`
**Commit:** 0e029ce
**Applied fix:** A `line()` helper collapses all whitespace, including line breaks, U+2028/2029 and U+0085, to single spaces, trims, and neutralizes delimiters. It is applied to `persona.name`, `cognitiveLoad`, `informationDensity`, `structuralMandates[]` and `bannedPhrases[]`, and to `profile.displayName`, `preferredPunctuation[]` and `commonTransitionWords[]`. Banned phrases still go through `JSON.stringify` afterwards. Tests assert that no standalone forged line or section appears, that no `</input>` reaches the system prompt, and that the template's line count is unchanged by hostile values. The existing snapshot was unaffected.

### CR-05: Exemplar budget measured on neutralized text

**Files modified:** `src/pipeline/promptBuilder.ts`, `tests/unit/promptBuilder.test.ts`
**Commit:** b6f8723
**Applied fix:** The budget is now measured on `ex.text.length` (raw), and neutralization is applied only to the selected chunks. The `BuildPromptArgs` doc states the semantic and that it is not a bound on prompt size. Tests: `<input><input>` (14 chars) is kept at a budget of 14 and dropped at 13, and a second chunk fits beside it at exactly 20.

### CR-07: Test gaps and misleading assertions

**Files modified:** `tests/unit/target.test.ts`, `tests/unit/promptBuilder.test.ts`
**Commit:** 1f96690 (remaining items), plus the test halves of e05ccc0, b4be2df, 4ca4431 and 0e029ce
**Applied fix:** The review's coverage gaps were closed alongside their fixes: NFKC, invisible, NBSP, whitespace and newline phrases (CR-01), invisible and fullwidth delimiters (CR-02), NaN with shuffled input (CR-03), newlines in persona fields (CR-04). The misleading `STRASSE` assertion was corrected in e05ccc0 (the test now uses `Fresh Éclair`). 1f96690 adds a shuffled-argument determinism test (duplicate scores, tight budget) and a test documenting that `STRASSE` does not match `straße` (no full case folding). The wall-clock ReDoS test was replaced in e05ccc0 by structural assertions: the pathological phrase `(a+)+$` matches only as a literal, and `a.c`, `a|b`, `^a` and `[abc]` do not act as patterns.

## Skipped Issues

None. CR-06, IN-01 and IN-02 were excluded from scope by request and not attempted.

---

_Fixed: 2026-11-13_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
