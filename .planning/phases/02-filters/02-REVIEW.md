---
phase: 02-filters
reviewed: 2026-11-13T00:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - src/filters/base.ts
  - src/filters/pipeline.ts
  - src/filters/registry.ts
  - src/filters/confidentiality.ts
  - src/filters/style.ts
  - src/filters/protectedSpans.ts
  - src/index.ts
  - tests/security/leak-corpus.test.ts
  - tests/fixtures/leaks/secrets.ts
  - tests/fixtures/leaks/samples.ts
  - tests/torture/filters-torture.test.ts
  - tests/unit/filters (read for coverage only)
findings:
  critical: 0
  high: 3
  medium: 5
  low: 4
  info: 3
  total: 15
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-11-13
**Depth:** standard
**Files Reviewed:** 7 source files and 5 test/fixture files (diff 534e935..d0709cd)
**Status:** issues_found

## Summary

The pipeline and registry are tight. Fail-closed handling is correct for thrown errors and invalid results, the trace is built from class names only, and `buildPipeline` re-checks the confidentiality invariant for hand-built configs. The fixed-point redactor behaves well: a 200k-case fuzz over placeholder, PEM, URL and assignment fragments found zero non-convergence and zero idempotence failures. Linear built-in patterns hold up (1 MB adversarial inputs finish in under 100 ms). The style filter and protected spans showed no defects in probing.

I ran the built output (`dist/`) against edge inputs, and the findings below are reproduced, not inferred. The weak points are all in the confidentiality filter:

- The ReDoS guard for custom rules is bypassable with bounded quantifiers.
- The "fail-closed" promise has two silent fail-open paths: the pipeline's stage selection and the custom-rule window.
- The contextual rules have value-boundary leaks.
- Whole-text NFKC plus invisible-character stripping silently corrupts every output, even text with no secret.

Assessment of the known deviations:

- **Fixed-point redact, cap 8, throws:** Sound. The throw is fail-closed, carries no input text, and could not be triggered by fuzz. Keep it.
- **Contextual over-redaction (`secretary: Johnson`):** Accepted as a trade-off, but it is wider than the summary states (CR-09).
- **NFKC and invisible stripping:** Right for detection, wrong as the output (CR-04).
- **512-char limit:** It is a silent leak, not just a limitation (CR-03).
- **Factories take options instead of widening the config schema:** Acceptable, but it leaves the blocklist and custom rules unvalidated by `loadConfig` and easy to forget to wire (IN-01).

## High

### CR-01: Custom-rule ReDoS guard is bypassed by chained bounded quantifiers

**File:** `src/filters/confidentiality.ts:135-253` (quantifier accounting at 165-171, 252)
**Issue:** `assertSafePattern` only counts quantifiers whose max is `Infinity`. Bounded quantifiers with a large max are not counted, and nothing limits their max or product. `a{1,500}a{1,500}a{1,500}a{1,500}b` passes construction (60 characters long, no alternation, no nested group). I measured it on 100, 200 and 400 `a` characters: about 0.2 s, 6.3 s and over 20 s. At the full 1024-character window it does not finish. A 4-deep chain is O(n^4), and the 1024-unit window only bounds n. `a{0,200}a{0,200}a{0,200}c` also hangs. The filter is synchronous, so one hostile or careless rule freezes the process on any text over about 300 characters. This contradicts the file header ("caps their worst case") and the summary's ReDoS claim. It affects every call, in the pre stage as well as post.
**Fix:** Treat a bounded quantifier as unbounded for budgeting when its max is above a small threshold, and budget all repeating quantifiers together. For example, in `quantifierAt` set `isUnbounded = max === Infinity || max > 16`, and add a total cap `repeating > 3`. For a hard guarantee, compile custom rules with RE2 (`re2` package, linear time) or run them in a worker with a timeout. Add the two patterns above to the torture test as rejected patterns.

### CR-02: A pipeline run with an unrecognised or missing `ctx.stage` silently passes text through unredacted

**File:** `src/filters/pipeline.ts:65-67`, `src/filters/registry.ts:52-89`
**Issue:** `run` selects `active = filters.filter(f => f.stages.includes(ctx.stage))`. There is no check that `ctx.stage` is `pre` or `post`, and no check that at least one filter is active. I confirmed that `run('AKIA...', {stage:'prE'})`, `run(..., {})` and `new FilterPipeline().run(...)` all return the secret verbatim with an empty trace and no error. The pipeline is built per stage by `buildPipeline`, so calling the wrong pipeline for a stage, or a JS caller or deserialised context with a bad stage, turns the redactor into pass-through. That is the same fail-open class the Phase 1 review (CR-01) closed at config level, reopened at run time.
**Fix:** In `run`, throw `ConfigError` (or `FilterFailedError`) when `!STAGES.has(ctx.stage)`. Better, let `buildPipeline` record the stage it was built for and have `run` reject a mismatching `ctx.stage`. Optionally add a `requireConfidentiality` flag that makes `run` fail when no `fail-closed` filter ran.

### CR-03: Custom-rule matches longer than the window are silently never redacted, and window edges change regex semantics

**File:** `src/filters/confidentiality.ts:42-48, 348-358`
**Issue:** Custom rules are run on 1024-unit windows stepped by 512, so a match is only found if it fits inside a window. Anything longer than 512 characters (the documented guarantee) is found only by alignment luck. A rule such as `BEGIN[\s\S]{0,2000}END` leaks the body of a 1500-character block with no error and no warning. A secret that should be redacted therefore passes the fail-closed filter. The window also changes the meaning of anchors and look-behinds:

- `^X\d+` matches at every window start. With 1024 `a` characters followed by `X5 tail`, I got `X5` redacted although it is not at a line start.
- `\b` and look-behinds see a truncated left context.

Nothing at construction time tells the rule author about either limit.
**Fix:** Either remove windowing and rely on the CR-01 fix or RE2, or make the overlap at least the longest possible match. At construction, reject any pattern whose maximum match length cannot be bounded at or below `CUSTOM_STEP`. That means rejecting unbounded `+` or `*` on a rule, or computing a max length. Document the cap in `ConfidentialityOptions`. If windowing stays, use the real text for the context of anchors, for example by passing a window with a left context prefix and discarding matches that start in the prefix.

## Medium

### CR-04: Whole-text NFKC and invisible-character stripping rewrites all output, including benign text, and breaks scripts and emoji

**File:** `src/filters/confidentiality.ts:53-63, 332`
**Issue:** The redacted text is the normalized text, so every call changes content that contains no secret. Verified results:

| Input | Output |
|---|---|
| `…` | `...` |
| `™` | `TM` |
| `½` | `1⁄2` |
| `ﬁ` | `fi` |
| NBSP | plain space |
| `❤️` | `❤` (variation selector stripped, emoji presentation lost) |
| family emoji | three separate emoji (ZWJ stripped) |
| Persian `سلام‌دنیا` | ZWNJ removed, which is orthographically wrong (length 9 to 8) |

The post stage runs on the ghostwritten result, so the user's final prose is altered in a way the style filter is not supposed to do. Also, the pre stage mutates the user's input before the LLM sees it, and `modified` is true for these changes. The summary accepts this as a cost, but it is broader than ligatures. Stripping U+200C/U+200D/U+FE0F and the tag block degrades non-Latin text and emoji for a protection that only matters inside a matched secret.
**Fix:** Use the normalized text only for detection and keep an index map back to the original (build `norm` and `map[normIndex] = origIndex` while stripping and normalizing per code point). Redact the original spans. If that is too heavy, at least do not strip ZWJ, ZWNJ and VS16 when they sit between two non-ASCII letters or emoji, and do not apply compatibility folding to text outside a matched span.

### CR-05: Contextual value rules leak partial or whole secrets at their boundaries

**File:** `src/filters/confidentiality.ts:75, 99-114`
**Issue:** Reproduced leaks:

1. A quoted value longer than 256 characters is not redacted, because `"([^"\n]{1,256})"` fails and the bare alternative cannot start with a quote. `password: "<300 chars>"` came back unchanged.
2. A quoted or bare value cannot follow a newline after the colon, so `{"password":\n"abcdefgh"}` is untouched. Pretty-printed JSON and YAML block style can do this.
3. `postgres://user:p@ss@host/db` becomes `postgres://[REDACTED:url_credential]@ss@host/db`. The rest of the password (`ss@`) is left. Passwords containing `/`, or longer than 256 characters, are also left in full (`user:pa/ss@host` is unchanged).
4. Bare values stop at `,;&`, so `password=abc,def` leaves `def`. This is acceptable for CSV, but is a leak for passwords that contain a comma.

**Fix:** For (1), drop the upper bound or raise it to the maximum line length. For (2), allow `\s{0,}` including a single newline between the separator and the value. For (3), make the userinfo password `[^\s]*?(?=@[^@\s]*(?:[/?#:\s]|$))` (greedy up to the last `@` of the authority) or consume up to the last `@` before the first `/`. Add each case to the leak corpus.

### CR-06: Common provider secrets and auth headers are not recognised

**File:** `src/filters/confidentiality.ts:78-93`
**Issue:** Only AWS, GitHub, `sk-`, Slack, JWT, bearer and PEM formats are covered by shape. These pass untouched when not preceded by a known keyword:

- Stripe `sk_live_...` and `rk_live_...` (`sk-` requires a dash).
- Google `AIza...`.
- GitLab `glpat-...`, npm `npm_...`, HuggingFace `hf_...`, SendGrid `SG....`.
- `Authorization: Basic <b64>` and `Authorization: Token <tok>`.
- Natural-language forms such as `my password is hunter2` and `pass=...` (the prefixes `pass` and `passphrase` are not in the keyword list).

The summary accepts "novel formats", but these are not novel and the leak corpus (21 kinds) does not include them, so the corpus gives an impression of coverage that does not exist.
**Fix:** Add shaped rules for `(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}`, `AIza[0-9A-Za-z_-]{35}`, `glpat-[A-Za-z0-9_-]{20,}`, `npm_[A-Za-z0-9]{36}`, `hf_[A-Za-z0-9]{30,}`, and an `Authorization:\s*(?:Basic|Token|Digest)\s+\S+` rule. Add `pass(?:phrase|wd)?` to the assignment keyword list. Add samples to `samples.ts`.

### CR-07: Nothing enforces that confidentiality runs last at the post stage

**File:** `src/filters/registry.ts:57-66`, `config/filters.ts:11-15`, `src/config/schema.ts:30-47`
**Issue:** The invariant checked is only "an enabled fail-closed confidentiality entry exists for the stage". The default pipeline orders `style` before the post-stage `confidentiality`, specifically "so the style pass or the model cannot reintroduce a secret". A user config of `[confidentiality pre, confidentiality post, style post]` passes `loadConfig` and `buildPipeline`, so the style filter (phrase replacements, persona `extraBannedPhrases` replacements, sentence merges and splits) runs on already-redacted text and its output is never re-checked. Style edits can also join text across a placeholder.
**Fix:** In `buildPipeline` (and in the schema `superRefine`), require that at the post stage no enabled non-confidentiality filter appears after the last confidentiality entry. Alternatively, make the pipeline always re-run confidentiality as a final step for the post stage.

### CR-08: Leak corpus is positive-only and checks substring absence, so it hides the precision and coverage problems above

**File:** `tests/security/leak-corpus.test.ts:30-48`, `tests/fixtures/leaks/samples.ts:104-120`
**Issue:** Every sample is built from a secret the rules were written for, and the assertion is `not.toContain(secret)` plus residue regexes written to mirror the same formats. There is no sample with a quoted value over 256 characters, a multi-line JSON value, a password containing `@` or `/`, a Stripe, Google or GitLab token, a custom rule with a 1000-character match, or any adversarial custom rule. No test covers a bounded-quantifier chain (CR-01). There is also no false-positive corpus, so over-redaction is unmeasured. The suite is green while CR-01, CR-03 and CR-05 are live.
**Fix:** Add the cases listed above to the corpus and to the torture test. Add a small "must not change" corpus (ordinary prose containing `secretary:`, `max_token: 1000`, `keyboard: us`, `…`, emoji and Persian text) with an explicit allow-list of known over-redactions, so the rules cannot get silently broader.

## Low

### CR-09: Contextual assignment rule over-redacts ordinary configuration and prose

**File:** `src/filters/confidentiality.ts:107-114`
**Issue:** The keyword has no left boundary and a trailing `[A-Za-z0-9_.-]{0,30}` suffix. Confirmed over-redactions: `secretary: Johnson`, `max_token: 1000` (the bare `token` alternative matches after `_`), `password_policy: strict`, `secrets_manager: vault`. Each is replaced by `[REDACTED:secret_assignment]`. The summary names only `secretary`. In a prose-rewriting product this removes user content that the LLM then cannot see. It fails safe, so it is Low.
**Fix:** Require a left boundary (`(?<![A-Za-z0-9])` on the keyword), and after the keyword require either end-of-word or a known suffix list (`_key`, `_secret`, `_token`, `_id`). Apply the same to bare `token`.

### CR-10: `caseInsensitive` blocklist uses simple case folding

**File:** `src/filters/confidentiality.ts:297, 307`
**Issue:** The `iu` flag does simple case folding, so `STRASSE` is not matched by a blocklisted `straße`, and the dotted capital `İ` is not matched by `i`. Dedup uses `toLowerCase()`, which differs from the regex folding. A blocklisted name can survive in upper case. Minor, because most blocklists are plain ASCII names.
**Fix:** Document that case-insensitive matching is simple-fold only, or pre-expand the terms with their `toUpperCase()`/`toLowerCase()` variants into the alternation.

### CR-11: Blocklist terms match inside larger words

**File:** `src/filters/confidentiality.ts:305-308`
**Issue:** No word boundary is applied. A blocklisted `Al` redacts `Alice` and `Algorithm`, and a 1-character term such as `a` shreds the whole text (`b[REDACTED:blocklist]n...`). Substring matching is the safer default for leaks (`Acmecorp`), but nothing rejects or warns about very short terms.
**Fix:** Reject blocklist entries shorter than 2-3 characters at construction (`ConfigError`), or offer an opt-in `wholeWord` option.

### CR-12: Custom-rule validator is both over- and under-strict, and misparses some escapes

**File:** `src/filters/confidentiality.ts:181-194, 223-236`
**Issue:** Legitimate patterns are rejected, for example `(?:a|b)+c` and `(?:\d+)+x` (the first is not catastrophic). Meanwhile an escape such as `\u{1F600}` is read as an atom `\u` followed by a counted quantifier `{...}` only when the contents are digits, so the accounting is inconsistent for `\p{...}`/`\u{...}`. The validator is a hand-written regex parser with no test that runs the accepted patterns against adversarial inputs, which is how CR-01 got through.
**Fix:** Add a property-style test that feeds every accepted pattern a set of worst-case inputs (`a` x 1024, `ab` x 512) with a time budget. Prefer RE2 over a hand-written parser.

## Info

### IN-01: Blocklist and custom rules are not reachable from config, so `loadConfig` cannot validate or load them

**File:** `src/filters/registry.ts:16-40`
**Issue:** `defaultFactories(options)` takes them programmatically, and `buildPipeline`'s default argument is `defaultFactories()` with no options. A caller that forgets to pass options gets a confidentiality filter with an empty blocklist and no error. Phase 5 must remember to wire them.
**Fix:** Make the blocklist and custom rules a required argument of the production wiring (or add `filters.confidentiality.{blocklist,customRules}` to the schema in a later phase), and add a test that `buildPipeline` with default factories is flagged in the orchestration phase.

### IN-02: `PipelineContext`/`FilterResult.modified` semantic drift

**File:** `src/filters/confidentiality.ts:419-422`, `src/filters/pipeline.ts:78`
**Issue:** `ConfidentialityFilter.process` sets `modified` from `content !== text`, so it is true for normalization-only changes (CR-04), while the pipeline recomputes the flag and ignores the filter's value. Two sources of truth for the same field.
**Fix:** Drop `modified` from the pipeline's trust boundary or document that it is advisory; after CR-04, leave it as is.

### IN-03: Dead `use`/`register` alias and unused exports

**File:** `src/filters/pipeline.ts:55-58`, `src/filters/base.ts:16-19`
**Issue:** `use` duplicates `register`, and `unchanged` is not used by any source file. Low maintenance cost, but there is no reason to ship two names for one API at v0.
**Fix:** Keep one name, and remove `unchanged` until a filter needs it.

---

_Reviewed: 2026-11-13_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
