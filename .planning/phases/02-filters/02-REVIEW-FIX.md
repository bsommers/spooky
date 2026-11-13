---
phase: 02-filters
fixed_at: 2026-11-13T00:00:00Z
review_path: .planning/phases/02-filters/02-REVIEW.md
iteration: 1
findings_in_scope: 8
fixed: 8
skipped: 0
status: all_fixed
---

# Phase 02: Code Review Fix Report

**Fixed at:** 2026-11-13
**Source review:** .planning/phases/02-filters/02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 8 (CR-01..CR-08, high and medium only, per request)
- Fixed: 8
- Skipped: 0
- Out of scope, untouched: CR-09..CR-12 (low), IN-01..IN-03 (info)

**Verification:** `scripts/verify.sh` ran after every fix in an isolated git worktree (node_modules symlinked from the main checkout) and ended PASS each time. It was run once more in the main checkout after the fast-forward: PASS (smoke 4, unit 311, security 221, torture 3). The worktree is removed and `gsd/phase-01-foundation` fast-forwarded to 373fd8e. Nothing was pushed.

## Fixed Issues

### CR-01: Custom-rule ReDoS guard bypassed by chained bounded quantifiers

**Files modified:** `src/filters/confidentiality.ts`, `tests/unit/filters/confidentiality.test.ts`
**Commit:** d1a983b
**Applied fix:** A variable quantifier with max above 16 (or none) is "large"; a rule may have at most one. The product of every variable quantifier's choice count is capped at 256 (a large one counts 64). Both reviewer patterns, `a+a+b` and `a+a{1,8}a{1,8}b` are now rejected; measurement showed the old "2 unbounded allowed" rule still cost about 0.2 s per 1 KiB window. Tests cover the rejected patterns, still-accepted legitimate patterns (UUID, IPv4, `internal-\d{1,32}`), and a timing check on 100k-character worst-case inputs. Status: fixed, requires human verification (the budget is a heuristic; the RE2 / worker option from the review was not taken).

### CR-02: Unrecognised or missing `ctx.stage` silently passed text through

**Files modified:** `src/filters/pipeline.ts`, `src/filters/registry.ts`, `tests/unit/filters/pipeline.test.ts`, `tests/unit/filters/registry.test.ts`
**Commit:** f041992
**Applied fix:** `FilterPipeline.run` throws `ConfigError` for a missing or unknown `ctx.stage`. `FilterPipeline` takes optional `{stage, requireConfidentiality}`; `buildPipeline` sets both, so a pipeline built for `pre` rejects a `post` context and refuses to run with no active fail-closed confidentiality filter. A plain `new FilterPipeline()` still runs with zero filters (existing contract) but rejects a bad stage.

### CR-03: Custom-rule matches longer than the window silently never redacted; window edges change regex semantics

**Files modified:** `src/filters/confidentiality.ts`, `tests/unit/filters/confidentiality.test.ts`
**Commit:** efe57ed
**Applied fix:** Construction now computes the pattern's maximum match length and rejects unbounded quantifiers (`+ * {n,}`) and any pattern that can match more than 512 characters, so every accepted match fits the scan. Windows carry 64 characters of real context on both sides and only keep matches that start in their own 512-character range, so `^`, `$`, `\b`, look-behind and look-ahead keep their meaning. Behaviour change (intended): `internal-\d+` must now be written `internal-\d{1,32}`; existing tests updated. Escapes `\p{..}`, `\u{..}`, `\uXXXX`, `\xHH` are parsed as single atoms (also removes the CR-12 misparse for those). Status: fixed, requires human verification.

### CR-04: Whole-text NFKC and invisible stripping rewrote all output

**Files modified:** `src/filters/confidentiality.ts`, `tests/unit/filters/confidentiality.test.ts`
**Commit:** 5a198e5
**Applied fix:** Detection still runs on normalized text, but normalization is done segment by segment with an index map; a redacted span replaces the original characters (including invisible ones hidden inside the secret) and everything else is returned byte for byte. `modified` is now true only for real redactions. A 3000-case fuzz asserts segment-wise normalization equals whole-string NFKC for detection. The previous "normalized output (documented)" test was replaced. Status: fixed, requires human verification.

### CR-05: Contextual value rules leaked at their boundaries

**Files modified:** `src/filters/confidentiality.ts`, `tests/unit/filters/confidentiality.test.ts`
**Commit:** 510b1e2
**Applied fix:** Quoted values up to 65,536 characters, closing quote optional (an unterminated quote redacts to end of line); up to 40 whitespace characters including newlines allowed after the separator; URL userinfo passwords run to the last `@` of the authority and may contain `@` or `/` (up to 1024 characters); bare values may contain `,` and `;` (still stop at whitespace, quotes and `&`). Includes linear-time adversarial tests. Accepted side effects, recorded in the false-positive allow-list: `Password:\nName: Bob` and `http://localhost:3000/@user` now over-redact. Status: fixed, requires human verification.

### CR-06: Common provider secrets and auth headers not recognised

**Files modified:** `src/filters/confidentiality.ts`, `tests/unit/filters/confidentiality.test.ts`, `tests/fixtures/leaks/secrets.ts`, `tests/security/leak-corpus.test.ts`
**Commit:** 413121e
**Applied fix:** New shaped rules: Stripe `sk|rk|pk_(live|test)_`, Google `AIza`, GitLab `glpat-`, npm, HuggingFace, SendGrid. New `auth_header` rule for `Authorization: Basic|Token|Negotiate|ApiKey|Digest`. Added `passphrase`, `passcode`, bare `pass` to the assignment keywords and a `password|passwd|passphrase|passcode|pwd is <value>` form. The leak corpus gained a fake-secret generator for each format (assembled from fragments, no secret-shaped literals) and residue detectors.

### CR-07: Nothing enforced that confidentiality runs last at post

**Files modified:** `config/filters.ts`, `src/config/schema.ts`, `src/filters/registry.ts`, `tests/unit/config.test.ts`, `tests/unit/filters/registry.test.ts`
**Commit:** 9a027b2
**Applied fix:** Shared helper `firstFilterAfterFinalConfidentiality` is used by the schema `superRefine` (issue path `filters.pipeline[i]`) and by `buildPipeline` at the post stage; any enabled filter ordered after the last fail-closed confidentiality entry is a `ConfigError`. Disabled trailing entries are fine. One existing registry test used the now-invalid order and was reordered.

### CR-08: Leak corpus was positive-only

**Files modified:** `tests/fixtures/leaks/benign.ts` (new), `tests/fixtures/leaks/samples.ts`, `tests/security/leak-corpus.test.ts`, `tests/torture/filters-torture.test.ts`
**Commit:** 373fd8e
**Applied fix:** Corpus grew from 130 to 221 security-tier tests: long and multi-line quoted values, passwords containing `@ / , ;`, auth headers, natural-language forms, all new provider kinds in every context. New false-positive corpus (`MUST_NOT_CHANGE` byte-for-byte, plus `KNOWN_OVER_REDACTIONS` asserted with exact output so rules cannot silently broaden). Security tests also cover over-long and hostile custom rules and a window-alignment sweep with provider secrets. Torture adds a benign-unicode no-change test and a hostile-custom-rule test. Confirmed the new tests fail against the pre-fix confidentiality.ts.

## Skipped Issues

None. CR-09..CR-12 (low) and IN-01..IN-03 (info) were out of the requested scope.

---

_Fixed: 2026-11-13_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
