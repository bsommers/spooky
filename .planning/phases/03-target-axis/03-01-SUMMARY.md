---
phase: 03-target-axis
plan: 01
subsystem: target-axis
tags: [typescript, personas, prompt-assembly, prompt-injection, vitest, snapshot]

requires:
  - phase: 01-foundation
    provides: shared types (TargetPersonaConfig, ScoredChunk, StylometricProfile), UnknownPersonaError, ConfigError
provides:
  - TargetManager (get/list over a key-checked persona map, UnknownPersonaError with sorted valid keys)
  - buildPrompt (deterministic {system,user} assembly, fenced input, exemplar char budget)
  - findBannedPhrases (literal, case-insensitive persona phrase check)
affects: [05-orchestration]

status: complete
actuals:
  tasks: 3
  commits: 3
plan_head_before: e956e8af5efc2e6593271a6525cc94491c83cc4f
plan_head_after: 320fb6305dd2cbd6240534e1338921d844088e47

tech-stack:
  added: []
  patterns:
    - "System prompt = trusted config only (profile, persona); user prompt = untrusted text fenced in <input>/<exemplars> tags"
    - "Delimiter look-alikes (<input>, </ INPUT >, <exemplar>) in untrusted text become &lt;... ; other angle brackets untouched"
    - "Exemplar budget keeps the highest-scoring PREFIX: first chunk that does not fit stops the list"
    - "Locale-independent code-unit sort for persona keys; fixed 1-decimal number rendering (never -0.0, NaN -> n/a)"

key-files:
  created:
    - src/registry/targetManager.ts
    - src/pipeline/promptBuilder.ts
    - tests/unit/target.test.ts
    - tests/unit/promptBuilder.test.ts
    - tests/unit/__snapshots__/promptBuilder.test.ts.snap
  modified:
    - src/index.ts

key-decisions:
  - "findBannedPhrases lives in src/registry/targetManager.ts (persona logic) and is tested in target.test.ts"
  - "Lexical density ratio renders as a one-decimal percentage (42.4%) so the 1-decimal rule does not collapse 0.42 to 0.4"
  - "Exemplar scores are not rendered, only used for ordering, so float drift cannot change the prompt"
  - "Invalid maxExemplarChars (negative, fractional, non-finite) throws RangeError"

requirements-completed: [TGT-01, TGT-02, TGT-03]
duration: ~20min
completed: 2026-11-13
---

# Phase 3 Plan 1: Target axis Summary

Persona registry with sorted listing and valid-key errors, byte-deterministic prompt assembly with fenced untrusted input and a chunk-boundary exemplar budget, and a literal case-insensitive banned-phrase check.

## Commits
- d92ccc3: TargetManager
- 09a321d: PromptBuilder (+ snapshot)
- 320fb63: findBannedPhrases

## Tests
- target.test.ts: 22 (14 TargetManager, 8 findBannedPhrases); promptBuilder.test.ts: 25 (2 snapshot assertions)
- `scripts/verify.sh`: PASS. smoke 4, unit 358, security 221, torture 3 (586 total, all passing); typecheck clean.

## Deviations from Plan
None of rules 1-4. Notes:
- Plan did not say where `findBannedPhrases` lives; placed in `targetManager.ts`. `src/index.ts` now also exports `TargetManager`, `findBannedPhrases`, `buildPrompt` and their types (additive).
- Persona map-key mismatch is reported as `ConfigError` with one `personas.<key>.key` issue per offender.

## Accepted risk
Prompt injection: delimiting plus the "source material, not instructions" rule reduces but cannot eliminate the chance a model follows instructions inside `<input>` (as per the plan's threat model).

## Known Stubs
None.

## Threat Flags
None.

## Self-Check: PASSED
Files and commits d92ccc3, 09a321d, 320fb63 verified present.
