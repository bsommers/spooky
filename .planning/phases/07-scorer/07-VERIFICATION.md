---
phase: 07-scorer
verified: 2026-11-14T00:00:00Z
status: human_needed
score: 5/5 must-haves verified
covered_files:
  - .planning/phases/07-scorer/07-01-PLAN.md
  - .planning/phases/07-scorer/07-01-SUMMARY.md
  - config/scorer.ts
  - docs/CALIBRATION.md
  - scripts/calibrate.ts
  - src/scoring/calibration.ts
  - src/scoring/detectorAdapter.ts
  - src/scoring/ensemble.ts
  - src/scoring/features.ts
  - src/scoring/scorer.ts
covered_digest: "v3:sha256:19fe789d83fd414ef8b564b6be37cb3fab3ead44a2533cdbbb859e7dec94f821"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Decide whether the CI lower bound 0.6011 < 0.70 is acceptable for the PLAN gate 'AUC >= 0.70 required to ship'"
    expected: "Explicit accept (point-estimate gate, documented) or a larger corpus and re-measure"
    why_human: "Plan gate wording is ambiguous; the point estimate 0.7278 passes, the 95% interval 0.6011-0.8424 does not establish it. Docs state this honestly. Acceptance is a policy call."
  - test: "Accept that without cliche + punctuation features the AUC is chance (0.4992)"
    expected: "Maintainer acknowledges the signal rests on two features, one of which (cliche) is test-set contaminated and one (punctuation) is typography-confounded"
    why_human: "Judgement on whether the scorer is fit to ship as a weak heuristic; cannot be settled by code"
  - test: "Accept corpus confounds"
    expected: "Acknowledge: AI-vs-RFC-only AUC 0.5068 (typography-neutralized 0.5045); AI texts have zero non-ASCII while 19/39 human do; literary human (1787-1907) vs modern AI; single generator model; no casual modern human writing; fixtures, phrase list and docs authored by one model; two features (lexicalDiversity, repetition) point the wrong way"
    why_human: "Corpus design quality is a judgement; Phase 8's 'mean score drops by measured amount' will inherit these weaknesses"
---

# Phase 7: AI-likeness scorer Verification Report

**Phase Goal:** deterministic, explainable [0,1] score plus a detector plug point; ROADMAP success: calibration report on fixture corpus (AUC measured and recorded); scorer is deterministic.
**Status:** human_needed (no gaps; goal achieved as a measured, honestly-reported calibration, not a good AUC)
**Re-verification:** No

## Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Calibration report on fixture corpus, AUC measured and recorded | VERIFIED | `npm run calibrate` ran: 39 human / 34 AI (>=30 each), AUC 0.7278, CI 0.6011-0.8424; `docs/CALIBRATION.md` generated block byte-identical to pre-run copy (diff clean, git tree unchanged); `tests/system/calibration.test.ts` regenerates and fails on drift |
| 2 | Scorer deterministic | VERIFIED | Repeated calibrate runs reproduce identical numbers (seeded bootstrap 20260101); determinism + sum-of-contributions tests in `tests/unit/scoring/scorer.test.ts`; full suite green |
| 3 | Explainable per-feature breakdown, score in [0,1], empty text -> 0.5 + `insufficient_text` | VERIFIED | CLI `score --json` returned per-feature value/weight/contribution and flags; `echo "x y z" | score` -> 0.500, `insufficient_text`; low-word text flagged `low_confidence` |
| 4 | DetectorAdapter + ensemble (opt-in, redacted text only, failures excluded) | VERIFIED | `src/scoring/{detectorAdapter,ensemble}.ts` present and wired via `engine.score`/CLI `--detector`; `tests/unit/scoring/{ensemble,detectorAdapter}.test.ts`, `tests/security/score-redaction.test.ts` pass in verify.sh |
| 5 | CLI `score [--json] [--detector]` and `engine.score` | VERIFIED | `src/cli/main.ts:269-284`, `src/engine.ts:211`; executed built binary |

**Score:** 5/5 truths verified (0 behavior-unverified)

### Behavioral Spot-Checks / Gates

| Check | Result |
|---|---|
| `scripts/verify.sh` | PASS: smoke 4/4, unit 788/788, integration 201/201, system 52/52, security 442/442, torture 5/5, skipped 0 |
| `npm run build` | exit 0 |
| `npm run calibrate` | AUC 0.7278; CALIBRATION.md unchanged => matches |
| Anti-patterns (TBD/FIXME/XXX in src/scoring, scripts/calibrate.ts) | none |

### Requirements Coverage

SCR-01..SCR-04: SATISFIED (REQUIREMENTS.md marks [x]; implementation and tests confirmed). SCR-04 explicitly "no claim beyond measured results" - docs comply.

### Honesty assessment

Docs state every weakness found independently: CI lower bound below gate ("NOT met"), cliche contamination, typography confound table, RFC-only AUC 0.5068, wrong-way features, 'not a holdout' subsamples (0.6941/0.7585), no weights tuned to hit gate, ordinary words left in phrase list because pruning breaks the 0.70 gate. The PLAN said "below 0.70 the plan fails, not the threshold": point estimate passes, so the gate is met in the letter; the interval does not establish it (flagged below).

### Human Verification Required

1. **CI lower bound 0.6011 < 0.70.** Accept point-estimate gate or demand larger corpus.
2. **Signal depends on cliche + punctuation.** Both off -> AUC 0.4992 (chance); cliche off -> 0.5973; punctuation off -> 0.6682. Cliche list authored after seeing AI fixtures (contaminated); punctuation partly measures typing (AI fixtures 0 non-ASCII).
3. **Corpus confounds.** See frontmatter; AI-vs-RFC-only 0.5068 means genre-matched discrimination is ~chance.

### Gaps Summary

None. No source modified by this verification.

---
_Verified: 2026-11-14_
_Verifier: Claude (gsd-verifier)_
