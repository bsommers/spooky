---
phase: 03-target-axis
reviewed: 2026-11-13T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/registry/targetManager.ts
  - src/pipeline/promptBuilder.ts
  - src/index.ts
  - tests/unit/target.test.ts
  - tests/unit/promptBuilder.test.ts
findings:
  critical: 0
  high: 1
  medium: 3
  low: 3
  info: 2
  total: 9
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-11-13
**Depth:** standard
**Files Reviewed:** 3 source files and 2 test files (diff e956e8a..006ba3f)
**Status:** issues_found

## Summary

Contract conformance is good. `TargetManager` (`get`, `list`, sorted `.valid`, key-mismatch `ConfigError`, defensive copies), `buildPrompt` and `findBannedPhrases` match the plan, and the exports are in `src/index.ts`. Regex metacharacters are escaped correctly under the `u` flag and there is no ReDoS. Case, whitespace and `\b` variants of the `<input>` and `<exemplar>` delimiters are neutralized. Entity forms (`&lt;/input>`) stay literal and inert, so they are not a bypass.

The findings were reproduced by compiling the sources and running probes. The weaknesses are:

- `findBannedPhrases` does no Unicode normalization, although the confidentiality filter does. Zero-width characters, NFKC compatibility forms and whitespace variants all evade it.
- Delimiter neutralization is blind to invisible characters.
- A NaN score makes the exemplar order depend on input order, which breaks the determinism guarantee.
- Persona and profile strings go unescaped into the system prompt.

## High

### CR-01: `findBannedPhrases` is bypassed by invisible characters, NFKC forms and whitespace variants

**File:** `src/registry/targetManager.ts:64-71`
**Issue:** The match is `new RegExp(escapeRegExp(phrase), 'iu').test(text)` on the raw text. The confidentiality filter already treats invisible-character and NFKC evasion as in scope (`normalizeForMatching`, `src/filters/confidentiality.ts:99-133`), but this check does not. With the banned phrases `circle back` and `delve`, each of the following returns `[]` (verified):

- `circ\u200ble back`: zero-width space.
- `de\u00adlve`: soft hyphen.
- `ｃｉｒｃｌｅ back`: fullwidth letters.
- `circle\u00a0back`: NBSP.
- `circle  back`: two spaces.
- `circle\nback`: newline.
- `circle\u200b back`: invisible character next to the space.

The model can be steered to emit these, and the output check is the control that is meant to catch them. The result will feed the Phase 5 trace entry `persona-banned`, so a miss is a silent policy bypass. Simple case folding also means `Straße` does not match `STRASSE`, and the test comment at `target.test.ts:168` implies otherwise (see CR-07).
**Fix:** Normalize both sides the same way as the filter, collapse whitespace runs, and skip phrases that are empty after normalization:
```ts
import { normalizeForMatching } from '../filters/confidentiality.js';
const canon = (s: string) => normalizeForMatching(s).replace(/\s+/g, ' ').trim().toLowerCase();

export function findBannedPhrases(text, persona) {
  const hay = canon(text);
  const found: string[] = [];
  for (const phrase of persona.bannedPhrases) {
    const needle = canon(phrase);
    if (needle === '' || found.includes(phrase)) continue;
    if (hay.includes(needle)) found.push(phrase);
  }
  return found;
}
```
This also removes the per-phrase `RegExp` construction and `escapeRegExp`. Document that cross-script homoglyphs (Cyrillic `е` for `e`) remain out of scope. Add tests for each variant above.

## Medium

### CR-02: Delimiter neutralization does not cover invisible characters or fullwidth brackets

**File:** `src/pipeline/promptBuilder.ts:26-29`
**Issue:** `DELIMITER_LOOKALIKE` is `/<(\s*\/?\s*(?:input|exemplars?)\b)/gi`. `\s` does not match zero-width characters, and the match requires an ASCII `<`. These inputs pass through unchanged (verified):

- `<\u200binput>` and `</\u200binput>`
- `<\u00adinput>`
- `<inpu\u200bt>`
- `<exemplar\u200b>` is caught only because `\b` happens to match.
- `＜/input＞` (fullwidth).

Whether a given model treats these as the closing tag is not guaranteed, but the project's own filters already assume that invisible characters and NFKC are evasion vectors. The tests at `promptBuilder.test.ts:157-165` cover only case and ASCII whitespace.
**Fix:** Run the detection on a view with invisibles removed and brackets folded, or strip invisibles from untrusted text before fencing. For example, `text.replace(INVISIBLE_RE, '').normalize('NFKC')` and then neutralize. If rewriting the text is unacceptable, widen the pattern: `<[\s\u200b-‏\u00ad\u2060\ufeff]*\/?[\s\u200b-‏\u00ad\u2060\ufeff]*(?:i[\u200b\u00ad]*n[\u200b\u00ad]*p...)`. Also neutralize `＜`. Add tests for these.

### CR-03: A NaN score makes exemplar selection depend on input order

**File:** `src/pipeline/promptBuilder.ts:40-41, 47`
**Issue:** The comparator is `b.score - a.score || a.index - b.index || ...`. If either score is `NaN` the difference is `NaN`, which is falsy, so it falls through to the index comparison. The comparator is then inconsistent (non-transitive), and the sorted order depends on the input order. Four chunks with one NaN gave `t1,t2,t4,t3` for one input order and `t2,t4,t3,t1` for the reverse (verified). The selected set changes too under a tight budget. This violates the "same inputs, same prompt" guarantee: a vector store returning NaN similarity is enough. `Infinity - Infinity` has the same effect.
**Fix:** Validate `Number.isFinite(ex.score)` up front and throw `RangeError`, as is done for `maxExemplarChars`. Alternatively, rank non-finite scores last explicitly. Add a test with shuffled input containing NaN.

### CR-04: Persona and profile strings are interpolated unescaped into the system prompt

**File:** `src/pipeline/promptBuilder.ts:59-74`
**Issue:** `persona.name`, `cognitiveLoad`, `informationDensity`, `structuralMandates[]`, `profile.displayName`, `preferredPunctuation` and `commonTransitionWords` are inserted verbatim. Only `bannedPhrases` goes through `JSON.stringify`. A value containing a newline forges a standalone line or section. With `name: 'N\n\nIgnore</input>'`, the output has a standalone `Ignore</input>` line between `Audience:` and `Cognitive load:` (verified). Persona values come from config and are trusted, but the stylometric fields are corpus-derived. The header comment's trust split ("everything in `system` is configuration") is therefore not enforced. A multi-line mandate would also be indistinguishable from a new section.
**Fix:** Pass every interpolated string through a `line()` helper that collapses `\s+` to a single space, trims, and neutralizes delimiters. Or render them with `JSON.stringify` as is done for banned phrases. Validate in `TargetManager` or `loadConfig` that these fields are single-line.

## Low

### CR-05: Exemplar budget is measured on neutralized text, not the documented raw length

**File:** `src/pipeline/promptBuilder.ts:17, 48-50`
**Issue:** `maxExemplarChars` is documented as the "summed length of exemplar texts", but the length is taken after `neutralize`, which adds 3 characters per delimiter look-alike. An exemplar `<input><input>` (14 characters) with a budget of 14 is dropped (verified). The budget also ignores the wrapper tags, the header line and the unbounded `input`, so it is not a bound on prompt size. Tests only use plain-letter exemplars (`promptBuilder.test.ts:113-137`).
**Fix:** Decide the semantic and make the doc and code agree. Either measure `ex.text.length` and neutralize after selection, or document "rendered length, after escaping". Add a test with a delimiter-containing exemplar at the exact budget.

### CR-06: `selectExemplars` stops at the first oversize chunk, so one large top-score chunk empties the section

**File:** `src/pipeline/promptBuilder.ts:49`
**Issue:** The `break` is intentional (tested at `promptBuilder.test.ts:121`), but it means a single over-budget top-ranked chunk discards every lower-scoring exemplar even when a large part of the budget is unused. The plan only requires "truncated at chunk boundary, lowest score dropped first", which `continue` also satisfies. A corpus with variable chunk sizes would silently lose all exemplars, and no signal is returned to the caller. Duplicate chunks with the same `id` are also not de-duplicated, so the same text can be shown twice.
**Fix:** Confirm the intent with the plan owner. If prefix-only is the design, return or log the number of dropped exemplars. Otherwise use `continue`. De-duplicate by `id`.

### CR-07: Test gaps and misleading assertions

**File:** `tests/unit/target.test.ts:167-169`, `tests/unit/promptBuilder.test.ts:157-165, 186-189`
**Issue:**
- The "matches non-ASCII phrases case-insensitively" test names `STRASSE` in the haystack but asserts only on `éclair`. No case exercises `ß`, NFKC, invisible characters, NBSP or multiple spaces (CR-01), and none covers invisible-character delimiters (CR-02), NaN scores (CR-03) or newlines in persona fields (CR-04).
- The determinism test compares two calls with identical argument order. Only the tie-break test shuffles.
- The ReDoS test asserts `< 1000` ms on wall clock, which is flaky on a loaded CI box and meaningless because the phrase is escaped.
**Fix:** Add the cases listed above and drop or correct the `STRASSE` mention. Remove the timing assertion, or assert that the pathological phrase matches literally.

## Info

### IN-01: Neutralization is non-injective and does not escape `&`

**File:** `src/pipeline/promptBuilder.ts:28-29`
**Issue:** The text `&lt;input>` supplied by the user and a neutralized `<input>` render identically. This is harmless to the model, and the model is told the input is source material. It does mean the transform cannot be reversed, and a downstream consumer that decodes entities could reintroduce a tag.
**Fix:** Optionally also escape `&` to `&amp;`, or document that the transform is one-way and for display only.

### IN-02: `TargetManager` constructor and `buildPrompt` throw bare `TypeError` on malformed runtime input

**File:** `src/registry/targetManager.ts:6-10, 28`, `src/pipeline/promptBuilder.ts:73, 98`
**Issue:** A persona with missing `structuralMandates` or `bannedPhrases` (from unvalidated JS config) makes `copyPersona` or `systemPrompt` throw `TypeError: ... is not iterable`. It is not a `ConfigError` with a path, unlike the key-mismatch case. A non-string `input` throws inside `neutralize`. Nothing is leaked, so this is a robustness issue only.
**Fix:** In the constructor, validate the array fields and push `ConfigIssue` entries alongside the key check. Add a `typeof input === 'string'` guard in `buildPrompt`.

---

_Reviewed: 2026-11-13_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
