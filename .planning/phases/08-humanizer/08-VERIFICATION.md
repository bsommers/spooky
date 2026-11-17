---
phase: 08-humanizer
verified: 2026-11-15T16:00:00Z
status: passed
score: 8/8 must-haves verified
covered_files:
  - .planning/phases/08-humanizer/08-01-PLAN.md
  - .planning/phases/08-humanizer/08-01-SUMMARY.md
  - config/humanize.ts
  - docs/HUMANIZING.md
  - src/cli/main.ts
  - src/engine.ts
  - src/filters/humanize.ts
  - src/humanize/guard.ts
  - src/humanize/loop.ts
  - src/humanize/rewrite.ts
  - src/humanize/rewriteLlm.ts
  - src/scoring/targets.ts
  - src/service/operations.ts
covered_digest: "v3:sha256:cec9340bd99f3c957cb5cd89f440a1d509356dc029529598a95f71ba8e375adc"
behavior_unverified: 0
overrides_applied: 0
re_verification: false
---

# Phase 8: Humanizer loop Verification Report

**Phase Goal:** Score-driven bounded rewrite with meaning guard, wired as post filter, CLI `score` and `--humanize`; lowers the AI-likeness score while preserving meaning (HUM-01..04).
**Verified:** 2026-11-15
**Status:** passed
**Re-verification:** No (initial). Verified after the code-review fixes (08-REVIEW-FIX.md, HR-01..LW-04) were applied.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Bounded loop (HUM-01): stops at target or maxIterations; best-scoring version returned, not last | VERIFIED | `src/humanize/loop.ts` runs `for iteration <= maxIterations && score > target`; candidate replaces best only when strictly lower. Probe: `maxIterations:1,target:0` -> iterations 1, llmCalls 1; `maxIterations:0` -> 0 iterations, 0 steps; `target:1` -> 0 iterations, text unchanged. maxIterations capped at 10 (`config/humanize.ts`, validated in `Engine.#humanizeSettings`). |
| 2 | Meaning guard (HUM-02): numbers/entities/quotes/code/URLs preserved; violation reverts the iteration | VERIFIED | Probe: scripted model changing 12 -> 13 rejected with `number_added|number_dropped|length_out_of_bounds|content_dropped` on all 3 iterations, `13` absent from result. Rejections counted in `guardRejections` and trace. Over all 140 AI fixtures (deterministic path) numbers and mid-sentence capitalized names identical before/after in 140/140 (0 mismatches). |
| 3 | Confidentiality re-run (HUM-03): secret introduced by the rewrite model is removed before rescore; final text redacted again | VERIFIED | `tryCandidate` calls `deps.redact` before `checkMeaning` and `score`; final `deps.redact(best)` after loop. Probe: model answer injecting an `sk-ant-...` key -> step `redacted=true`, secret absent from `text` and from the whole serialized result/trace. `tests/security/humanize-confidentiality.test.ts` (library, HTTP, MCP, generate --humanize) passes. |
| 4 | Trace (HUM-04): per-iteration score before/after and per-feature deltas | VERIFIED | CLI `--json` output shows `initialScore`, `finalScore`, `featureDeltas`, `featuresBefore/After`, per-step `scoreBefore/After`, `delta_*` trace metadata. |
| 5 | Humanize reachable on every surface and in OpenAPI | VERIFIED | CLI `ghostwriter humanize` and `generate --humanize/--target` run (built `dist`); library `Engine.humanize`; HTTP `POST /api/humanize` -> 200 with score; MCP `callTool humanize` ok and listed in `toolDefinitions`; `buildOpenApi` contains `/api/humanize`. `target` without `humanize` -> 400 `USAGE` over HTTP. |
| 6 | Parity test passes; `PENDING_CAPABILITIES` empty | VERIFIED | `PENDING_CAPABILITIES.length === 0` (src/service/operations.ts:67, asserted in `tests/integration/surfaces-parity.test.ts:268`); operations list includes `humanize`; parity suite passes in `scripts/verify.sh`. |
| 7 | Determinism and LLM-failure policy | VERIFIED | Two runs with a scripted model are identical (probe, ignoring `ms`). LLM errors recorded as `llm_error` and the prior text kept (loop.ts catch; unit tests). |
| 8 | Roadmap success: mean score drop on fixture AI texts is the measured amount recorded in docs; numbers/entities preserved; no secrets reintroduced; docs honest about the weak scorer | VERIFIED (see note) | Re-measured: 140 AI fixtures, mean drop 0.050 (docs: 0.593 -> 0.543, drop 0.050), asserted by `tests/system/humanize-calibration.test.ts` marker. `docs/HUMANIZING.md` opens with the weak-scorer warning (held-out AUC 0.694, confounded, no external detector tested), states the 0.050 drop is below the plan's 0.1 bar and that fixtures were not tuned, and lists the guard's known limits and what is not measured. |

**Score:** 8/8. Note on truth 8: the plan's calibration bar (mean drop >= 0.1) is NOT met (0.050; 4% reach target, 55% improved). The plan said to document honestly rather than tune, and the roadmap criterion reads "drops by the measured amount recorded in docs", which is satisfied. This is a weak result, not a defect.

## Required Artifacts / Key Links

| Artifact | Status |
|----------|--------|
| `src/humanize/{guard,rewrite,rewriteLlm,loop}.ts`, `src/filters/humanize.ts`, `src/scoring/targets.ts`, `config/humanize.ts` | exist, substantive (864 lines), wired via `Engine.humanize`/`generate` |
| `src/service/operations.ts` humanize op -> CLI / HTTP / MCP / OpenAPI adapters | WIRED (exercised end to end above) |
| `docs/HUMANIZING.md` numbers <-> code | WIRED (test fails on drift) |

## Behavioral Spot-Checks

| Check | Result |
|-------|--------|
| `scripts/verify.sh` | PASS: typecheck clean; smoke 4, unit 922, integration 285, system 65, security 472, torture 5; 0 skipped |
| CLI `humanize --no-llm --json` on AI sample | 0.618 -> 0.449, `12`, date, `Acme Corp` and quoted span intact, llmCalls 0 |
| Probes (scratchpad, built dist): library, MCP, HTTP, OpenAPI, bounds, guard, secret, determinism, 140-fixture preservation | all as above |

## Requirements Coverage

HUM-01, HUM-02, HUM-03, HUM-04: SATISFIED. API-06 parity extended to humanize: SATISFIED. UI-11 belongs to Phase 11, not in scope. No orphaned requirements. No TBD/FIXME/XXX markers in phase files.

## Anti-Patterns / Residual Limits (non-blocking, documented)

- Guard is heuristic: sentence-initial names, caseless scripts, number words, negation flips and single-quoted spans are not protected (listed in HUMANIZING.md "Known limits").
- No live-model run exists; model-pass behavior is tested only with a scripted model. No external detector was tested.
- Gain is against a weak scorer (AUC 0.694) and part of it is moving along the heuristic (human texts also drop, 0.475 -> 0.456).

## Human Verification Required

None required for the goal; the above limits are documented and accepted.

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
