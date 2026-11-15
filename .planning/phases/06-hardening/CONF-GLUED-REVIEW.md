---
phase: 06-hardening
reviewed: 2026-11-14T23:20:00Z
depth: deep
files_reviewed: 5
files_reviewed_list:
  - src/filters/confidentiality.ts
  - tests/unit/filters/confidentiality.test.ts
  - tests/torture/engine-torture.test.ts
  - README.md
  - docs/AS-BUILT.md
findings:
  critical: 0
  warning: 3
  info: 4
  total: 7
status: issues_found
---

# Commit f0733bc: glued-token redaction review

Method: compiled src to the scratchpad, probed with 1 MB adversarial inputs, 60k-case structural fuzz, FP scans over the repo, random hex/base64/base64url/UUID, and hand-built slugs. The 199 unit tests pass.

Verified OK (no finding):
- **ReDoS/quadratic:** none. About 35 inputs of 1 MB each (repeated `xsk-`, `risk-`, `npm_`, `hf_`, `SG.`, `eyJ`, `sk_live_`, `bearer`+spaces, long single runs after each prefix, Unicode/ZWSP/ligature variants) all finish in under 230 ms. Bounded lookaheads and dot-delimited SG./JWT segments hold.
- **Idempotence:** 60k fuzz inputs built from token fragments, placeholders, ZWSP, ligatures, combining marks, bidi and emoji gave 0 non-idempotent results and 0 fixed-point throws.
- **NFKC index map:** correct for the new unanchored matches. ZWSP-split, ligature-prefixed and full-width glued tokens redact the right original range, and NBSP/ZWSP outside the span are preserved.
- **Protected spans:** no regression. Existing `[REDACTED:...]` placeholders and context rules are unaffected. A custom-rule name that looks like a Stripe key is contained by the placeholder pseudo-rule.
- **Hashes, UUIDs, base64:** 0/20000 false positives on sha256 hex, sha512 base64, UUID and SRI strings.

## Warnings

### WR-01: `sk-` glued alternative redacts ordinary kebab-case slugs/URLs/filenames that contain a digit

**File:** `src/filters/confidentiality.ts:170-173`
**Issue:** `sk-(?=[A-Za-z0-9_-]{32})(?=[A-Za-z_-]{0,80}[0-9])[A-Za-z0-9_-]{32,}` fires on any word ending in `sk` (risk, task, disk, desk, ask, mask, whisk) followed by `-` and a 32+ char hyphenated run with one digit. It then consumes the whole rest of the run. Confirmed (the output shows the first letters kept and the rest replaced):
- `/blog/task-prioritization-matrix-for-2024-planning` becomes `/blog/ta[REDACTED:api_key]`
- `disk-usage-report-2024-q1-final-version.csv` becomes `di[REDACTED:api_key].csv`
- `risk-management-best-practices-v2-guide`, `feature/ask-the-team-about-release-2-0-candidate`, `.mask-image-gradient-2x-retina-display-fallback` and `fix/task-123-handle-null-pointer-in-parser-module` are all redacted.

Years, versions and issue numbers in slugs and branch names are common. The FP guard test uses only digit-free slugs, so it never exercises this path. This destroys exemplar/draft text sent to the model. It fails safe, but it contradicts the stated goal of keeping `risk-assessment-framework`-style text untouched.
**Fix:** Require token-like entropy rather than "one digit anywhere in the first 80 chars". Options, strongest first:
1. Require the body to have no `-` runs of word-like lowercase segments, for example `sk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{32,}` and demand at least two digits plus an uppercase letter.
2. Reject bodies containing 3 or more `-` separators (real keys have at most 3).
3. Add a post-match check in `collect` (a rule `accept(m)` hook) that counts distinct character classes.

Add tests for `task-…-2024-…` slugs.

### WR-02: Docs claim lookalikes are left alone, but digit-bearing lookalikes are redacted; floor description is inexact

**File:** `docs/AS-BUILT.md:91`, `README.md:110`, `.planning/phases/06-hardening/CONF-GLUED-FIX.md`
**Issue:** The docs say glued lookalikes below the floors "are left alone", citing `risk-assessment-framework`. That holds only when there is no digit (see WR-01). The text says "`sk-` 32+ chars with a digit" but omits that the digit must appear within the first 80 chars after only letters, `_` or `-`. It also says "SendGrid 22.43 segments" (typo for 22/43). Glued `Bearer` (20+ chars and a digit) is not mentioned in the AS-BUILT list, and the README's short-prefix list omits bearer. The residual leak list omits the following, all verified:
- `npm_`+36 followed by more alnum leaks the tail, because there is no trailing bound (`npm_`+36 chars+`bbbb` leaves `bbbb`).
- A glued `sk-` key of 32+ letters with no digit leaks.
- A JWT payload under 10 chars glued to a word leaks.

**Fix:** State the digit-in-80 rule and that digit-bearing slugs can be false-positive redacted. Fix `22.43` to `22/43`. Add bearer to both lists, or fix WR-01 and keep the claim.

### WR-03: SendGrid unanchored alternative false-positives on dotted identifiers

**File:** `src/filters/confidentiality.ts:187`
**Issue:** `SG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{43,}` has no left boundary, so `MSG.NotificationPreferencesManagerImpl.getDefaultConfigurationForTenantWithExtrasAndMore` becomes `M[REDACTED:sendgrid_key]` (confirmed). Any `…SG.<22+ char ident>.<43+ char ident>` matches. Dotted Java/TS/config paths ending in an `SG` or `MSG` acronym qualify. This is rarer than WR-01.
**Fix:** Require real SendGrid shape in the glued form: exactly `SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])`. Real keys are 22 and 43 chars, so using `{22,}` and `{43,}` only adds false positives.

## Info

### IN-01: Redundant boundary alternatives (dead code)

**File:** `src/filters/confidentiality.ts:185`
**Issue:** `${B}npm_[A-Za-z0-9]{36}|npm_[A-Za-z0-9]{36}` is equivalent to `npm_[A-Za-z0-9]{36}`; the first alternative can never add a match. The same holds for Stripe, where the boundary alternative (floor 16) is the only reason a non-glued 16 to 23 char body matches, so that one is not redundant. The JWT boundary alternative is also not redundant.
**Fix:** Drop the duplicate npm alternative, and fix the "two ways" comment at lines 166-169, which overstates what npm does.

### IN-02: Glued bearer alternative redacts prose such as `pallbearer 12345678901234567890123`

**File:** `src/filters/confidentiality.ts:189-192`
**Issue:** `The pallbearer 12345678901234567890123 carried` becomes `The pall[REDACTED:bearer_token] carried` (confirmed). It needs 20+ token chars with a digit after a glued `bearer`, so the case is contrived. Leaving the `\b`-less alternative in place buys little: real headers are `Authorization: Bearer …` and are already covered by the anchored rule.
**Fix:** Optional. Drop the glued bearer alternative, or require the preceding char to be non-letter or `Authorization` context.

### IN-03: Base64url blobs get partially redacted at about 2.7% of 4 KB blobs

**File:** `src/filters/confidentiality.ts:170-173, 186`
**Issue:** Random 4 KB base64url blobs (55/2000) hit `sk-` or `hf_` mid-blob, and the match then consumes the rest of the run. This looks like it errs in the safe direction, but it is unpredictable for embedded data. The 1/2000 base64 hit is probably `hf_`/`sk-` as well. Hex, standard base64, UUID and SRI strings are unaffected.
**Fix:** Same entropy/shape check as WR-01. Alternatively, accept and document.

### IN-04: Test gaps

**File:** `tests/unit/filters/confidentiality.test.ts:632-652`
**Issue:**
- The FP guard has no digit-bearing slug, no dotted-identifier SG case and no glued `bearer` + 20 chars + digit prose case.
- The ReDoS test omits `bearer` and the sk-with-lookahead worst case (`risk-` x N, which I measured at about 90 ms).
- The torture test (`tests/torture/engine-torture.test.ts:108`) now glues every planted secret and has no padded variant, so leaks that only affect the anchored path would not be caught.

**Fix:** Add the cases above and keep a mix of padded and glued plants.

---

_Reviewed: 2026-11-14T23:20:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
