---
phase: 07-scorer
plan: 01
subsystem: scoring
tags: [scorer, detector-adapter, ensemble, calibration, cli]

requires:
  - phase: 02-filters
    provides: protected-span splitter, confidentiality pipeline (run first on every score request)
  - phase: 05-orchestration
    provides: Engine facade, CLI, endpoint/key-egress policy, HTTP helpers
provides:
  - HeuristicScorer (six interpretable features, exact per-feature breakdown, configurable weights)
  - DetectorAdapter plug point, HttpDetectorAdapter, runEnsemble (weighted mean, failures excluded and recorded)
  - labeled fixture corpus (39 human, 34 AI) with per-file provenance, scripts/calibrate.ts, docs/CALIBRATION.md
  - engine.score and `ghostwriter score [--json] [--detector name]`
affects: [08-humanizer]

tech-stack:
  added: []
  patterns:
    - "features are pure [0,1] functions that report availability; the scorer renormalizes over available features"
    - "ensemble records exclusion reasons as class names / fixed words, never messages"
    - "docs numbers are machine-checked: tests/system/calibration.test.ts recomputes AUC and compares with CALIBRATION.md"

key-files:
  created:
    - config/scorer.ts
    - src/scoring/features.ts
    - src/scoring/scorer.ts
    - src/scoring/detectorAdapter.ts
    - src/scoring/ensemble.ts
    - src/scoring/calibration.ts
    - scripts/calibrate.ts
    - docs/CALIBRATION.md
    - tests/fixtures/corpus/ (73 texts + manifest.json)
    - tests/unit/scoring/{features,scorer,ensemble,detectorAdapter,calibration}.test.ts
    - tests/system/calibration.test.ts
    - tests/integration/score.test.ts
    - tests/security/score-redaction.test.ts
  modified:
    - src/models/types.ts
    - src/config/schema.ts
    - src/engine.ts
    - src/cli/main.ts
    - src/index.ts
    - package.json
    - tsconfig.json
    - tsconfig.build.json
    - README.md
    - docs/ARCHITECTURE.md
    - .planning/CONTRACTS.md
    - tests/integration/parity.test.ts

key-decisions:
  - "Feature curves, default weights and the phrase list were fixed before the corpus was scored; shipped defaults were NOT tuned to the corpus"
  - "Two features (lexicalDiversity, repetition) are anti-predictive on this corpus; defaults left as pre-registered, in-sample what-if recorded as exploratory only"
  - "Unavailable features are left out and weights renormalized (breakdown always sums to the score); nothing computable -> 0.5 + insufficient_text"
  - "scorer config is an optional section like confidentiality; detectors are declared in config but run only when named per request"
  - "calibrate runs from tsc output (npm run calibrate); dist/scripts excluded from the published package via files: [\"dist\", \"!dist/scripts\"]"

status: complete
actuals:
  tokens: 57400   # chars/4 over lines added by the five commits below (about 90k chars of that is the fixture corpus)
  tasks: 5
  commits: 6      # measured rev-list b835e23..HEAD; one of the six (c25d2e5) is the concurrent filters agent's, the five of this plan are listed below
plan_head_before: b835e236ea0e24d58dd7fa6579763641b34da600
plan_head_after: 13bcf566eaa8d1d08a53c1d2771e5cf4a7419ef2

duration: ~35 min
completed: 2026-11-14
---

# Phase 7 Plan 1: AI-likeness scorer Summary

A deterministic, explainable [0,1] AI-likeness score (six features, exact per-feature breakdown, config weights), an opt-in detector plug point with a failure-tolerant weighted-mean ensemble, `engine.score` / `ghostwriter score`, and a calibration harness whose measured result is **AUC 0.7293** (95% bootstrap interval 0.6026 to 0.8424) on 39 human and 34 AI samples. The 0.70 ship gate is met, narrowly, and the measurement says less than the headline suggests.

## Calibration (measured; full report in docs/CALIBRATION.md)

- AUC 0.7293, interval 0.6026 to 0.8424. Accuracy at a fixed 0.5 cut 0.5890 (majority-class rate 0.5342). Scores cluster 0.2 to 0.6; no absolute threshold is meaningful.
- Per-feature AUC: punctuation 0.8956, cliche 0.7440, paragraphUniformity 0.7017, burstiness 0.6961, **repetition 0.1538, lexicalDiversity 0.1282** (the last two point the wrong way on this corpus: the AI samples have higher vocabulary diversity and fewer repeated trigrams than the human samples).
- Confounds: against the 13 modern technical human samples (RFCs) alone AUC is 0.5090 (chance); against the 26 19th-century literary samples 0.8394. Word count alone gives 0.658 (inverted). So the headline mostly separates modern assistant prose from 19th-century prose.
- Exploratory, in-sample, NOT adopted: weight 0 on lexicalDiversity and repetition gives AUC 0.8575 (interval 0.7466 to 0.9502). Found after looking at the per-feature results, so it is a fit to these 73 samples.
- Corpus: human = 26 Project Gutenberg public-domain excerpts (1787-1907) + 13 IETF RFC excerpts (1995-2020); AI = 34 texts written by Claude (Sonnet 5.5) in this session from stored prompts, before any feature was written. The `cliche` phrase list was written by the same model after the AI texts, so that feature's AUC is optimistic. No modern casual human writing and no other generator model are in the corpus.

## Commits (this plan)

| Task | Commit | Files |
|---|---|---|
| 1 Features | 3be6602 | config/scorer.ts, src/scoring/features.ts, tests/unit/scoring/features.test.ts |
| 2 Scorer + breakdown + weights config | 41b8f55 | src/scoring/scorer.ts, src/models/types.ts, src/config/schema.ts, tests/unit/scoring/scorer.test.ts |
| 3 DetectorAdapter + ensemble | d2668b0 | src/scoring/detectorAdapter.ts, src/scoring/ensemble.ts, src/models/types.ts, tests/unit/scoring/{ensemble,detectorAdapter}.test.ts |
| 4 Corpus + calibration | 102a111 | tests/fixtures/corpus/**, scripts/calibrate.ts, src/scoring/calibration.ts, docs/CALIBRATION.md, package.json, tsconfig*.json, tests/system/calibration.test.ts, tests/unit/scoring/calibration.test.ts |
| 5 Engine + CLI + docs | 13bcf56 | src/engine.ts, src/cli/main.ts, src/index.ts, README.md, docs/ARCHITECTURE.md, .planning/CONTRACTS.md, tests/integration/{parity,score}.test.ts, tests/security/score-redaction.test.ts |

`c25d2e5` (filters, in the same range) belongs to the concurrent confidentiality agent; src/filters/confidentiality.ts and its tests were not touched.

## Verification

`scripts/verify.sh`: PASS. smoke 4, unit 780, integration 198, system 48, security 442, torture 5 (1477 tests), 0 skipped. `npm run build` clean; `ghostwriter score` run against the built binary.

Test-matrix mapping: features in isolation (uniform vs varied, repeated trigrams, cliche density, empty -> 0.5 + `insufficient_text`, < 50 words -> `low_confidence`), 1000 seeded random strings in [0,1] and finite, determinism and contribution sum within 1e-9, weights from config / normalized / negative rejected, ensemble (mean, throw excluded and recorded, all fail -> local only, 1.2 and NaN rejected), protected spans excluded, calibration gate (AUC >= 0.70, doc matches), security (whole 100+ sample leak corpus never reaches a detector; filter failure -> nothing sent).

## Deviations from Plan

**1. [Rule 2 - Missing critical] Added a timeout, a response-size cap, no-redirect and the endpoint/key-egress policy to `HttpDetectorAdapter`, and reject `apiKeyEnv` over cleartext http in the config schema.** The plan names external detectors but no transport; sending redacted text with a bearer token off-box needs the same protections as the LLM clients. Commits d2668b0, 41b8f55.

**2. [Rule 3 - Blocking] `scripts/calibrate.ts` cannot run directly (Node's type stripping does not map the repo's `.js` import specifiers to `.ts`, and adding `tsx` would be a new dependency).** It is compiled by `tsconfig.build.json` and run as `npm run calibrate` (`tsc -p tsconfig.build.json && node dist/scripts/calibrate.js`); `dist/scripts` is excluded from the package via `files`. Commit 102a111.

**3. [Additions] Surface parity.** The plan's `ghostwriter score` / `engine.score` made the CONTRACTS parity table gain a sixth row and `tests/integration/parity.test.ts` its hard-coded capability list. Commit 13bcf56.

**4. [Additions] Extra module `src/scoring/calibration.ts`** (AUC, bootstrap, histogram) so the statistics are unit-tested and reusable; and optional additive fields on `ScoreBreakdown` (`flags`, `stats`) plus `ScoreResult`/`ScoreOptions` types.

**5. [Process] Plan said Task 5 CLI is `ghostwriter score`; ROADMAP's Phase 8 row also lists it.** It is delivered here; Phase 8 should add only `--humanize`.

## Decisions needing the owner

- The shipped default weights give 0.7293 while a re-weighting found in-sample gives 0.8575. I did not adopt it because it was chosen after seeing the data. A larger, genre-matched corpus (modern casual human text, several generator models) and a held-out split should decide the weights before the humanizer (Phase 8) targets this score.
- The gate was met by a margin smaller than the bootstrap interval. If "AUC >= 0.70" should be read against the lower bound, it is not met.

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: network-egress | src/scoring/detectorAdapter.ts | `HttpDetectorAdapter` POSTs redacted text to a config-declared URL. Opt-in per request, redacted text only, endpoint/key-egress policy applied, no redirects, size cap, timeout. Covered by tests/security/score-redaction.test.ts and tests/unit/scoring/detectorAdapter.test.ts. |

## Self-Check: PASSED

- Files exist: config/scorer.ts, src/scoring/{features,scorer,detectorAdapter,ensemble,calibration}.ts, scripts/calibrate.ts, docs/CALIBRATION.md, tests/fixtures/corpus/manifest.json, the six test files above.
- Commits 3be6602, 41b8f55, d2668b0, 102a111, 13bcf56 are on `gsd/phase-01-foundation`.
- `.planning/config.json` and `.planning/state.json` were not committed; `src/filters/confidentiality.ts` and its tests were not touched.
