---
phase: 08-humanizer
plan: 01
subsystem: humanizer
tags: [humanizer, meaning-guard, confidentiality, uniform-surfaces, measured-results]
status: complete
requires:
  - phase: 07-scorer
    provides: HeuristicScorer, feature breakdown, calibration corpus
  - phase: 09-service-surfaces
    provides: operations registry, CLI/HTTP/MCP/OpenAPI adapters, PENDING_CAPABILITIES
provides:
  - Engine.humanize(text, options) and generate(..., { humanize, target })
  - humanize registry operation: `ghostwriter humanize`, POST /api/humanize, MCP tool, OpenAPI path; generate gains --humanize/--target on every surface
  - src/humanize/{guard,rewrite,rewriteLlm,loop}.ts, src/scoring/targets.ts, src/filters/humanize.ts (HumanizeFilter), config/humanize.ts
  - config section humanize { targetScore (0.3), maxIterations (3, max 10) }
  - docs/HUMANIZING.md with measured results; PENDING_CAPABILITIES is now empty
affects: [10-ui-foundation, 11-ui-features]
tech-stack:
  added: []
  patterns:
    - "candidate = copy; the best text is replaced only by a candidate that passed confidentiality, the meaning guard and scored strictly lower"
    - "confidentiality runs on every candidate BEFORE it is scored, and once more on the final text"
    - "doc numbers are asserted by a test (humanize-calibration marker), like CALIBRATION.md"
key-files:
  created:
    - config/humanize.ts
    - src/humanize/guard.ts
    - src/humanize/rewrite.ts
    - src/humanize/rewriteLlm.ts
    - src/humanize/loop.ts
    - src/scoring/targets.ts
    - src/filters/humanize.ts
    - docs/HUMANIZING.md
    - tests/unit/humanize/{guard,rewrite,loop}.test.ts
    - tests/integration/{humanize,humanize-cli}.test.ts
    - tests/security/humanize-confidentiality.test.ts
    - tests/system/humanize-calibration.test.ts
  modified:
    - src/engine.ts
    - src/service/{operations,schemas}.ts
    - src/cli/main.ts
    - src/config/{schema,view}.ts
    - src/models/types.ts
    - src/pipeline/promptBuilder.ts
    - src/index.ts
    - docs/{API,MCP,SURFACES,AS-BUILT}.md
    - README.md
    - .planning/{CONTRACTS,REQUIREMENTS}.md
key-decisions:
  - "Gains are measured against a weak, confounded scorer (held-out AUC 0.694); the caveat is in the operation description, in every result (`caveat`), in the text rendering and in HUMANIZING.md"
  - "Confidentiality runs before the guard and the rescore (not after the guard as in the plan diagram), so nothing unredacted is ever scored or compared"
  - "HumanizeFilter is a library filter, not selectable in filters.pipeline: the engine runs the loop itself so confidentiality is always last and the model/scorer are reachable"
  - "The guard compares every candidate with the ORIGINAL input (no drift across iterations)"
requirements-completed: [HUM-01, HUM-02, HUM-03, HUM-04]
plan_head_before: 97373a2bbba0acf432ab55c95bb43627fd534880
plan_head_after: 10be2e3d9195c648d70aa9b850d4c783444d09eb
commits: 3
actuals:
  tasks: 6
  commits: 3
---

# Phase 8 Plan 1: Humanizer loop Summary

Bounded, score-driven rewriting on the local heuristic with a mechanical meaning guard and confidentiality on every candidate, exposed on the library, CLI, HTTP API, OpenAPI and MCP from the one registry entry.

## What was built

- **Guard (HUM-02):** numbers (none dropped/added/altered), proper nouns and acronyms (none dropped; no capitalized word the original lacked), quoted spans, protected spans (code, URLs, blockquotes), code identifiers byte-identical, word count within 0.5x-2x. Violations are fixed codes, never text.
- **Rewrite steps:** deterministic (stock-word replacement/deletion, split at a clause conjunction or `;`, semicolon joins; only unprotected prose) then one model pass per iteration (prompt from author profile + feature instructions; text fenced and delimiter look-alikes neutralized). Target features are the two largest score contributions (`selectTargets`).
- **Loop (HUM-01, HUM-03, HUM-04):** stop at target or `maxIterations`; best-scoring version returned, not the last; a model failure keeps the prior text (traced by error class); per-step trace with scores, per-feature deltas, redaction flag and outcome; final text re-redacted. A failed redaction aborts (fail closed) and is not swallowed as a model failure.
- **Surfaces:** `humanize` registry operation (CLI `ghostwriter humanize [file] [--author --target --max-iterations --no-llm]`, `POST /api/humanize`, MCP `humanize`, OpenAPI), `generate` gains `humanize`/`target`; removed from `PENDING_CAPABILITIES` (now empty); parity test, CONTRACTS table and docs updated.

## Measured result (deterministic edits only, 140 AI / 141 human corpus texts)

Mean AI score 0.593 -> 0.543 (drop 0.050, below the 0.1 bar: documented, fixtures not tuned); 4% reach the 0.3 target; 55% improve at all; guard rejected 0/183 edits on AI texts and 7/118 on human texts; human texts also fall (0.475 -> 0.456); held-out AUC (AI after vs human as written) 0.694 -> 0.595; length unchanged. Not measured: a real model pass; any external detector. HUMANIZING.md says so.

## Deviations from Plan

1. **[Rule 3 - Blocking] `ghostwriter score` already existed:** only `--humanize` (on `generate`) and the new `humanize` command were added.
2. **[Design] Order guard/confidentiality:** confidentiality first, then guard, then rescore (plan diagram: guard first). Reason: the rescore must never see a secret the model invented, and the guard then judges exactly what would be returned.
3. **[Design] `HumanizeFilter` not selectable in `filters.pipeline`:** adding `humanize` to `KNOWN_FILTER_NAMES` would need the model and scorer inside a config-built filter and would let a config reorder it relative to the final confidentiality filter. The engine runs the loop after the post pipeline; the filter class is exported for custom pipelines.
4. **[Rule 1 - Bug, found while testing] split/merge undid each other and split inside lists:** a sentence created by a split was re-joined by the merge in the same call, and `, and <list item>` was split into a fragment. Fixed: sentences created in a call are not edited again; conjunction splits require a following subject word.
5. **Outcome `unchanged` dropped:** a deterministic pass with nothing to edit is not a step (no trace noise).
6. **Task 5 config key:** `humanize: { targetScore, maxIterations }` added to the schema, the redacted config view and the OpenAPI output of `config_get`.

## Auth gates

None.

## Known Stubs

None. The model pass has only been exercised with a scripted model (no live model in this repository); that is stated in HUMANIZING.md, not hidden.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: new-model-call-path | src/humanize/rewriteLlm.ts | Sends the redacted text to the configured model (open-world). Input redacted first; answer redacted, guarded and rescored before use; output size capped; operation annotated `openWorldHint`. |
| threat_flag: new-network-route | src/service/operations.ts | `POST /api/humanize` / MCP `humanize` (costs up to `maxIterations` model calls); same auth, body and concurrency limits as `generate`. |

## Verification

`scripts/verify.sh`: PASS (typecheck; smoke 4, unit 895, integration 281, system 65, security 472, torture 5; 0 skipped).

## Self-Check: PASSED

- Files exist: config/humanize.ts, src/humanize/{guard,rewrite,rewriteLlm,loop}.ts, src/scoring/targets.ts, src/filters/humanize.ts, docs/HUMANIZING.md
- Commits in history: af6385e, f9fe473, 10be2e3
