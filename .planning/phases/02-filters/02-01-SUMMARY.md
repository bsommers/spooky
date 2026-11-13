---
phase: 02-filters
plan: 01
subsystem: filters
tags: [typescript, redaction, pipeline, regex-safety, markdown, vitest]

requires:
  - phase: 01-foundation
    provides: shared types (Filter, FilterResult, PipelineContext, TraceEntry, FilterSpec, Config), typed errors, loadConfig with the confidentiality-at-pre-and-post invariant
provides:
  - FilterPipeline (async, ordered, per-filter fail-closed/skip policy, count-only trace)
  - buildPipeline(cfg, stage, factories) / defaultFactories(options) config-driven wiring
  - ConfidentialityFilter (typed idempotent redaction, blocklist, validated custom rules)
  - StyleFilter (phrase edit + repair, protected spans, profile-driven rhythm check)
  - splitProtected/join protected-span utility
  - config/phrases.ts default phrase list and rhythm settings
affects: [05-orchestration, 06-hardening, 08-humanizer]

actuals:
  tokens: 30900
  tasks: 5
  commits: 8
plan_head_before: 534e935f519d12a321e6a0c526a890b3e2fe979c
plan_head_after: a1207262a954a38ea3bfa4593969ff511b302d33

tech-stack:
  added: []
  patterns:
    - "Redaction = collect spans from all rules, union overlaps, replace each group once, iterate to a fixed point"
    - "Contextual rules redact the value capture group only (regex `d` flag indices), so name= and user: stay readable"
    - "Edits applied right to left so each edit sees an already-final right-hand side; spacing repaired at edit sites only"
    - "Secrets in fixtures are assembled from fragments at runtime so no secret-shaped literal enters the repo"
    - "Trace error text is the thrown error's class name only (messages may carry input text)"

key-files:
  created:
    - src/filters/base.ts
    - src/filters/pipeline.ts
    - src/filters/registry.ts
    - src/filters/confidentiality.ts
    - src/filters/style.ts
    - src/filters/protectedSpans.ts
    - config/phrases.ts
    - tests/unit/filters/pipeline.test.ts
    - tests/unit/filters/registry.test.ts
    - tests/unit/filters/protectedSpans.test.ts
    - tests/unit/filters/confidentiality.test.ts
    - tests/unit/filters/style.test.ts
    - tests/security/leak-corpus.test.ts
    - tests/torture/filters-torture.test.ts
    - tests/fixtures/leaks/secrets.ts
    - tests/fixtures/leaks/samples.ts
    - tests/helpers/prng.ts
  modified:
    - src/index.ts

key-decisions:
  - "Redaction is applied to NORMALIZED text (strip invisibles, NFKC), not mapped back onto the original: output has compatibility characters folded and invisible characters removed. Evasion by ZWSP or full-width letters fails; the cost is that benign text such as U+FB01 becomes `fi`."
  - "redact() iterates to a fixed point (cap 8, then throws -> fail-closed) because replacing a secret with a placeholder can move a contextual rule's value boundary; idempotence holds by construction, not by hoping a single pass is stable."
  - "Overlapping rule matches are unioned, never partially redacted; a group made only of existing placeholders is left alone; the group label is the most specific (lowest-priority-number) rule."
  - "Filter-local option types (ConfidentialityOptions, PhraseEntry, RhythmSettings) live next to their filters; src/models/types.ts is unchanged."
  - "Blocklist, custom rules and phrase list are passed programmatically via defaultFactories(options); the Phase 1 config schema only carries {name,stage,onError,enabled} and was not widened."
  - "Style rhythm: runs of >=4 sentences within +-15% of their mean; long runs (mean > profile avg) are split at `, and/but/so/yet` or `;` on every second sentence, short runs are merged in pairs with `;` when the second sentence starts with a safe-to-lowercase word; authors with sd/avg <= 15% are reported `natural` and left alone; no usable profile -> `rhythm: skipped`."

patterns-established:
  - "Filters are pure given (text, ctx); per-call state only (persona extra phrases compile per call, nothing retained)"
  - "A hand-built config is re-checked in buildPipeline for an enabled fail-closed confidentiality filter at the stage (defence in depth beside loadConfig)"

requirements-completed: [FLT-01, FLT-02, FLT-03, FLT-04, CNF-01, CNF-02, CNF-03, CNF-04, CNF-05, STY-01, STY-02, STY-03, STY-04]

duration: ~70min
completed: 2026-11-12
status: complete
---

# Phase 2 Plan 01: Filter pipeline + filters Summary

**Async fail-closed filter pipeline with a typed, idempotent confidentiality redactor (PEM blocks, cloud/VCS/API tokens, JWT, bearer, blocklist, validated custom rules) and a deterministic style editor that repairs casing, commas and spacing and never touches code, URLs or quotes**

## Performance

- **Duration:** about 70 min
- **Completed:** 2026-11-12
- **Tasks:** 5 (matrix-first: tests written and seen failing before each implementation)
- **Files:** 17 created, 1 modified (`src/index.ts`, additive exports)

## Accomplishments
- All nine PROJECT.md defects are covered by tests: async interface, stateless regexes (same instance, repeated calls), escaped blocklist, full PEM block / `ghp_` / `sk-` / `xox` / JWT / multi-hit redaction, fail-closed errors, casing and punctuation repair, persona `bannedPhrases` enforced through `ctx.extraBannedPhrases`.
- Leak corpus: 130 generated samples (21 secret kinds x up to 8 contexts: prose, code fence, JSON, YAML, env file, URL query, inline code, log line; plus multi-secret, evasion and blocklist samples). Zero planted secrets survive the pre or post stage, output is idempotent, traces contain no secret.
- ReDoS: nested/ambiguous repetition, backreferences, empty-match and over-long custom patterns are rejected at construction (`ConfigError`); accepted custom rules run on 1024-char windows (50k chars of a quadratic-prone pattern in ~25 ms). Adversarial 1MB repetitions (`eyJ`, `sk-`, `AKIA`, `Bearer `, PEM header, `password=`, `?token=`, `a-`, `://`, `ghp_`) each finish in tens of ms; 1MB ordinary text with 100+ secrets in about 10 ms.
- `scripts/verify.sh`: smoke 4/4, unit 239/239 (171 new), security 130/130, torture 1/1; `npm run build && scripts/verify.sh` exits 0.

## Task Commits

1. **Task 1: Filter interface + pipeline** - `04e0be9` (feat)
2. **Task 2: Protected spans** - `dca056f` (feat)
3. **Task 3: Confidentiality filter + leak corpus** - `be8f56b` (feat)
4. **Task 4: Style filter** - `6c79336` (feat)
5. **Task 5: Registry, exports, torture** - `2f920f4` (feat), preceded by `f1c8218` (fix: fixed-point redaction, found by the torture test)
6. Comment-only follow-ups: `e550861`, `a120726` (docs)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Redaction was not idempotent on adversarial input**
- **Found during:** Task 5 (torture test, first run)
- **Issue:** `token: <PEM>...` redacted on pass 1 left `token: [REDACTED:private_key]<junk>`; on pass 2 the secret-assignment rule saw the placeholder plus junk as one value and relabelled it, so `f(f(x)) != f(x)` (CNF-05).
- **Fix:** iterate `redact()` to a fixed point (cap 8, then throw, which the pipeline turns into `FilterFailedError`); groups consisting only of existing placeholders are preserved; label = most specific rule in the group. Regression tests added.
- **Files modified:** src/filters/confidentiality.ts, tests/unit/filters/confidentiality.test.ts
- **Commit:** f1c8218

**2. [Rule 2 - Missing critical] Defence-in-depth guards not in the plan**
- `buildPipeline` rejects a hand-built config lacking an enabled fail-closed confidentiality filter at the stage; `defaultFactories().confidentiality` refuses `onError: 'skip'`; `ConfidentialityFilter.onError` is a constant. (Phase 1 review made this a config invariant; these keep it from being bypassed outside `loadConfig`.)
- Trace `error` is the error class name, not its message (messages can embed filtered text; threat-model row "trace logs leak secrets").

**3. [Rule 2 - Missing critical] Contextual redaction rules added beyond the CNF-01 list**
- URL credential query/fragment params (`?token=`, `#access_token=`, ...), `user:pass@` in URLs, and secret-named assignments (`PASSWORD=`, `"api_key":`, `client_secret:`) redact the value only. The plan's corpus requires secrets in "URLs `?token=`, JSON, env files", which format-only patterns cannot cover. Trade-off: some over-redaction (`secretary: Johnson`).

### Plan variances (not auto-fixes)
- **Task 1 / Task 5 split:** `src/filters/registry.ts` imports both filters, so it cannot compile in Task 1. Its tests were parked and the registry shipped in Task 5 with the wiring.
- **matchAll instead of `String.replace`:** Task 3 says "`String.replace` only"; spans need offsets for union-merge and value-group redaction. `matchAll` works on a clone, so stored regexes keep `lastIndex === 0` (same guarantee, tested by repeated calls on one instance).
- **Normalization decision (the plan asked to decide and document):** redact on the normalized text, see key-decisions.
- **Custom rules** are only guaranteed to match when <= 512 chars long (windowing); built-in rules are not windowed.
- **Rhythm is per unprotected segment and per line**, so an inline code span or URL in a paragraph splits it into separate segments for the run detector. Headings, list items, table rows and blockquotes are never rhythm-edited.
- **Blockquote lines are protected** (STY-04 "quoted blocks"); the plan's Task 2 listed only fences, inline code and URLs. Indented (4-space) code blocks are NOT protected (ambiguous with list continuation).
- **Unit count** came out at 239 total (171 new) against the plan's ">= 45".

**Total deviations:** 1 bug fix, 2 missing-critical additions, 6 variances. **Impact:** scope unchanged; all requirement IDs covered.

## Contract notes
- `src/models/types.ts`: **no change** (the additive-only allowance was not used). `src/index.ts` gained exports for the pipeline, registry, both filters and the protected-span helpers.
- The pipeline's trace `modified` is computed (`content !== input`), not copied from the filter's own flag. `FilterResult.modified` is still validated as a boolean.
- `FilterPipeline.register` and `use` are aliases. Duplicate names throw `ConfigError` at registration.

## Issues Encountered
- `performance.now()` can read ~1 ms short of a `setTimeout` delay, so the async-delay test asserts `ms >= delay - 1`, not strictly `>= delay`.
- Not verified: behaviour on Node 20 (only Node v26.8.1 locally); `d`-flag regex indices and lookbehind need Node >= 16, within the engines range.

## Known Stubs
None. No hardcoded empty data, placeholders or TODOs in shipped source.

## Threat Flags
None. No new network, auth, file-access or schema surface; the filters are pure string transforms.

## Accepted risks (from the plan, unchanged)
Novel secret formats and non-pattern PII (names, addresses) are not detected (v2 NER filter). Also: homoglyphs outside NFKC (e.g. Cyrillic `а` for `a`) are not folded, because folding them would corrupt legitimate non-Latin text.

## Self-Check: PASSED
All created files exist; commits 04e0be9, dca056f, be8f56b, 6c79336, f1c8218, 2f920f4, e550861, a120726 are ancestors of HEAD; `npm run build && scripts/verify.sh` exits 0.
