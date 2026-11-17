---
phase: 07-scorer
verified: 2026-11-15T00:00:00Z
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
  - tests/fixtures/corpus/manifest.json
  - tests/system/calibration.test.ts
  - tests/unit/scoring/features.test.ts
covered_digest: "v3:sha256:020bbaa2e7c16e9ea43529f644091ad7b2c3d2f2d6d7417ce9bea8e76f15e2b1"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 5/5
  gaps_closed: []
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Decide whether the unmet 0.70 gate is acceptable"
    expected: "Held-out test AUC 0.6943 (95% CI 0.6021-0.7793): point estimate gate NOT met, CI lower bound gate NOT met; only lower bound > 0.5 is enforced. Maintainer either accepts the scorer as a weak heuristic (gate is reported, not enforced) or demands improved features/corpus before Phase 8 relies on it."
    why_human: "Policy call on a documented, honest miss of the original ship gate."
  - test: "Accept the length confound"
    expected: "AI samples are shorter (mean ~142 vs ~204 words); word count alone gives test AUC 0.8996 inverted. Length-trimmed to 130 words AUC falls to 0.6197 (0.6401 with typography neutralized). Features are not length-neutral; true discrimination is closer to ~0.62-0.64."
    why_human: "Whether 0.62-0.64 is acceptable, or length-matched regeneration is required, is judgement."
  - test: "Accept punctuation carrying 54.5% of the weight"
    expected: "punctuation weight 0.545 is the feature most exposed to typography (human 97/141 files non-ASCII vs AI 61/140). Neutralizing typography moves test AUC <0.01 per docs, but the weight concentration is a fragility."
    why_human: "Robustness judgement; cannot be settled by code."
  - test: "Accept single-generator, single-author AI corpus and no casual human register"
    expected: "All 140 AI samples from one model (Claude) with topics mirroring the human samples; no casual modern human text; v2 modern genre-matched AUC only 0.6139 (per-genre 0.44-0.77, n 3-16); two features (lexicalDiversity 0.283, repetition 0.210 test AUC) point the wrong way and have weight 0; 2026 US-gov human pages could contain undisclosed AI assistance."
    why_human: "Corpus design quality and generalization claim are judgement calls. Phase 8's 'mean score drops by measured amount' inherits these weaknesses."
---

# Phase 7: AI-likeness scorer Verification Report (re-verification after corpus v2)

**Phase Goal:** deterministic, explainable [0,1] score plus detector plug point; calibration report on fixture corpus with AUC measured and recorded.
**Status:** human_needed. Goal achieved as a measured, honestly-reported calibration. The 0.70 gate is NOT met on the held-out test split.
**Re-verification:** Yes, after corpus v2 (cf028e0, 5ec155c)

## Observable Truths

| # | Truth | Status | Evidence |
|---|---|---|---|
| 1 | Calibration report on fixture corpus, AUC measured and recorded | VERIFIED | `npm run calibrate` output block byte-identical (diff) to the generated block in `docs/CALIBRATION.md`; 141 human / 140 AI; test AUC 0.6943, CI 0.6021-0.7793 (74 human / 63 AI); doc says "NOT met" for both 0.70 gates |
| 2 | Scorer deterministic | VERIFIED | Seeded bootstrap (20260101); calibrate reproduced identical numbers across two runs; unit tests in verify.sh |
| 3 | Explainable per-feature breakdown, [0,1], empty text 0.5 + `insufficient_text` | VERIFIED | Unchanged from prior verification; unit suite 837/837 green |
| 4 | DetectorAdapter + ensemble opt-in, redacted text only | VERIFIED | `src/scoring/{detectorAdapter,ensemble}.ts` tests and `tests/security/score-redaction.test.ts` pass |
| 5 | CLI `score` and `engine.score` | VERIFIED | Covered by system tier 64/64; build exit 0 |

**Score:** 5/5 truths verified (0 behavior-unverified). Truth 1 is verified as "measured and recorded", not "met 0.70".

## Gates

| Check | Result |
|---|---|
| `scripts/verify.sh` | PASS: smoke 4/4, unit 837/837, integration 248/248, system 64/64, security 459/459, torture 5/5, skipped 0 |
| `npm run build` | exit 0 |
| `npm run calibrate` | Test AUC 0.6943 / CI 0.6021-0.7793 reproduced; doc block identical; git tree unchanged (only pre-existing untracked .planning/config.json, state.json) |

## No test-split leakage (read of scripts/calibrate.ts)

- Weights: `deriveWeights(dev.perFeature, dev.counts)` uses only the dev evaluation; cross-validation (`crossValidatedAuc`) is dev-only; `shipped == derived` confirmed in doc and `config/scorer.ts` (0.323/0/0.132/0.545/0/0).
- Cliche list: `applyClicheRule` takes only human dev texts; candidates are an external published list (Kobak et al. 2024), no AI sample consulted. Shipped list equals rule output.
- Split is by sha256(seed + text), independent of filenames. `--dev-only` path (`runDevOnly`) computes no test numbers.
- Caveats that cannot be code-verified: `runCalibration` computes dev and test together, so the author could have seen test numbers before freezing; this is attested (07-CORPUS-V2.md) but not enforceable. The 50% availability eligibility rule was added after viewing the dev per-feature table (disclosed in the doc). The v1 files (39 human / 34 AI, authored/curated earlier by the same model) are split into dev/test like the rest.

## Manifest provenance spot-check (10 human files)

Fetched each source URL and compared sentence by sentence (whitespace/quote-normalized). Samples: Biden WEF remarks, DOE solar timeline, Russell Problems of Philosophy, NSF microelectronics, NIST quantum network, two FDA releases, Carroll Alice (v1), RFC 4677 (v1), plus NASA x2 as extras.
- Verbatim: Gutenberg Russell 10/10 and Carroll 16/16 sentences (via cache/epub plain text); NSF 6/6, NIST 8/8, RFC 4677 8/8.
- Gov pages: Biden 4/5, DOE 7/8, FDA 6/7 and 4/5 (NASA 4/5, 5/6); every miss inspected is a whitespace-before-punctuation or sentence-boundary artifact of my tag stripping (identical words in source). No fabricated text found.
- NIH pages return 403 to automated fetch (2 files not checkable). Licenses plausible: 17 U.S.C. 105 for federal pages (NASA third-party-material caveat recorded), PD for pre-1929 Gutenberg, IETF pre-RFC5378 caveat recorded for RFCs. Sampled URLs are real, live and match titles.

## Honesty assessment

CALIBRATION.md states: both 0.70 gates NOT met; gate reported rather than enforced and why; length confound (AI shorter, word count alone 0.8996 inverted); typography table; v1-only 0.8657 vs v2-only 0.6139; wrong-way features; per-genre n; eligibility rule disclosed. No threshold was lowered silently, and the test change (enforce lower bound > 0.5 plus doc/measurement agreement) is stated in the doc. Prior headline (0.7278 on the 73-file v1 corpus) is superseded and honestly attributed to confounded v1 corpus (v1-only still 0.8657 which is the confound, not skill).

## Anti-patterns

None blocking. No source modified by this verification.

## Gaps Summary

None. Status is human_needed solely for the four judgement items in the frontmatter.

---
_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
