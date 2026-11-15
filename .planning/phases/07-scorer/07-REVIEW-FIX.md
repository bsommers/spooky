---
phase: 07-scorer
fixed_at: 2026-11-14T00:00:00Z
review_path: .planning/phases/07-scorer/07-REVIEW.md
iteration: 1
findings_in_scope: 14
fixed: 13
skipped: 1
status: partial
---

# Phase 7: Code Review Fix Report

**Source review:** `.planning/phases/07-scorer/07-REVIEW.md` (scope: warnings and info)
**Verification:** `scripts/verify.sh` in the main checkout (no worktree: a hand-rolled one has no `node_modules`, so it cannot run the gates): PASS. smoke 4, unit 788, integration 201, system 52, security 442, torture 5; 0 skipped.

## Headline numbers (re-measured, generated into `docs/CALIBRATION.md`)

- AUC 0.7293 before, **0.7278** after the WR-06 splitter fix (95% interval 0.6011 to 0.8424).
- Gate: point estimate >= 0.70 met. Interval lower bound >= 0.70 **not** met (0.60); the doc says so. The test now also requires the lower bound above chance (0.5).
- Variants: `cliche` weight 0: 0.5973. `punctuation` weight 0: 0.6682. Both 0: 0.4992 (chance). Typography neutralized: 0.7202; neutralized with `cliche` 0: 0.5664. The headline rests on the two contaminated or confounded features.
- The reviewer's guess that punctuation's advantage vanishes on the RFC subset is not borne out: punctuation AUC vs RFC only is 0.8857. But AI vs RFC only is 0.5068 overall (0.5045 typography-neutralized).

## Fixed

| ID | Commit | What changed |
|---|---|---|
| IN-06 | 1168f70 | `calibrate --weights` bad/missing/non-object JSON gives a one-line `ConfigError`, exit 2. Even/odd row relabeled "not a holdout". Not done: running via `tsx` (not installed; `npm run calibrate` still writes `dist/`). |
| WR-01, WR-02, WR-03 | ce0068c | Corpus not rebuilt. Harness adds typography counts, AUC without punctuation / without cliche / both, typography-neutralized variants, per-feature AUC on RFC subset, weight and phrase-list hashes. `docs/CALIBRATION.md` rewritten: tables are a generated block (`npm run calibrate -- --update-doc`) that the test compares byte for byte; "nothing tuned / pre-registered" replaced with a truthful account; `cliche` marked test-set contaminated in doc and `config/scorer.ts`. Test also gates on CI lower bound > 0.5; the doc states the lower bound does not reach 0.70. |
| WR-06, IN-01, IN-07 (slice) | a2fc78b | Only titles always suppress a boundary; `etc/jr/st/fig/inc/ltd` only before a lowercase word or digit; `no` only before a digit; `co` dropped; "I." ends a sentence. `prepareText` throws `ConfigError` above 500k chars (500k newlines: 0.8 s). No-op `.slice()` removed. New tests. Doc regenerated. |
| WR-07, IN-07 (header) | 4394ac8 | Engine uses a `Map` for detector weights and passes only the call's members. `runEnsemble` rejects weight keys naming no member (incl. `__proto__`) and non-finite sums; `normalizeWeights` rejects an overflowing sum. Local weight 0 with no weighted member left throws new `DetectorsFailedError` (exit 9) instead of silently returning the local score. `__proto__` is not a legal detector name. Scorer header says "to within floating-point error". |
| WR-04 | 25b93d6 | `DetectorTransportError` (kind + status), `DetectorKeyMissingError`; ensemble reasons are `error:<kind>[:<status>]`. `ghostwriter score` exits 9 and adds `localOnly: true` in `--json` when every named detector was excluded (an `empty_text` exclusion does not count). Partial failure still exits 0 with a warning. |
| WR-05 | 799de85 | Detector URLs: https, or http only for loopback, with or without a key (config schema and adapter constructor). `apiKeyEnv`: upper-case, ends `_KEY`/`_API_KEY`/`_TOKEN`, not `AWS_/GITHUB_/..SECRET/PASSWORD` etc. Not done: rejecting private literal IPs over https (optional in the review). |
| IN-02, IN-03 | dfbca0c | `DetectorAdapter.score(text, signal?)`; the ensemble aborts it on timeout, the HTTP adapter honors it. Direction (1 = machine-generated) stated in types, `DetectorConfig`, CALIBRATION.md, ARCHITECTURE.md. No `invert` flag. |
| IN-04 | e074696 | `NOTICE` lists bundled third-party text and the pre-Nov-2008 RFC caveat; manifest license strings for the 13 RFCs corrected (10 flagged pre-5378); doc note. RFCs not swapped (would change the corpus). Excerpt offsets still not recorded (noted in the manifest). |

All commits carry the trailer and list explicit paths; nothing was pushed; `.planning/config.json`, `state.json` and the review file were not committed.

## Skipped

### IN-05: cliche list includes common non-AI words

**File:** `config/scorer.ts:61-65`
**Reason:** Not applied, on purpose. Pruning exactly the listed words (and nothing else) was measured: headline AUC falls from 0.7278 to **0.6863** (95% interval 0.5581 to 0.8062), under the 0.70 ship gate; vs RFC only 0.4253. The gate's own rule is "do not lower the threshold", and tuning the pruning until the gate passes would be the corpus-tuning WR-03 criticizes. Left as measured; recorded as a known issue in `config/scorer.ts` and `docs/CALIBRATION.md` (commit 4dfe6c0). **Needs a human decision:** prune and accept/replace the gate, or build the held-out corpus first.

## Other judgment calls

- IN-07 third bullet (exit code or `null` for `insufficient_text`): not changed; the flag is already in the output and changing the exit code of empty input is a behavior decision.
- Logic-level changes that pass tests but deserve a human read: WR-06 abbreviation rules (`isAbbreviationPeriod` in `src/scoring/features.ts`), WR-07 `DetectorsFailedError` semantics, WR-05 `apiKeyEnv` deny-list (heuristic; breaks any existing config using a lowercase or non-`_KEY` variable name).
- New exit code 9 added to `EXIT_CODES` and the README.

---

_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
