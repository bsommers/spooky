---
phase: 01-foundation
plan: 01
subsystem: infra
tags: [typescript, vitest, zod, esm, config]

requires: []
provides:
  - Strict ESM TypeScript build (`npm run build`) and `scripts/verify.sh` per-tier gate
  - Every CONTRACTS.md type declared once in src/models/types.ts
  - GhostwriterError hierarchy with stable codes
  - loadConfig(raw?) zod-validated config with path-qualified ConfigError
affects: [02-filters, 03-target-axis, 04-source-axis, 05-orchestration]

actuals:
  tokens: 9001
  tasks: 3
  commits: 3
plan_head_before: 97b526f9ad85bcc37786e551a90ad565df926172
plan_head_after: 96005f79e9c4ff256b6ed354c9a0da713b191263

tech-stack:
  added: [typescript ^5.5, vitest ^4.1.12, zod ^4.6.7, commander ^12.1, "@anthropic-ai/sdk ^0.40", "@types/node ^20"]
  patterns:
    - "Types declared once in src/models/types.ts; schema output proven assignable to Config at compile time"
    - "Config defaults are data in config/*.ts; loadConfig returns a structuredClone (no shared mutable state)"
    - "Strict zod objects: typo keys fail at startup"
    - "tsconfig.json for typecheck (includes tests); tsconfig.build.json for emit (src+config only)"

key-files:
  created:
    - package.json
    - package-lock.json
    - tsconfig.json
    - tsconfig.build.json
    - vitest.config.ts
    - scripts/verify.sh
    - src/index.ts
    - src/models/types.ts
    - src/models/errors.ts
    - src/config/schema.ts
    - src/config/load.ts
    - config/settings.ts
    - config/targetPersonas.ts
    - config/filters.ts
    - tests/smoke/build.test.ts
    - tests/unit/errors.test.ts
    - tests/unit/config.test.ts
  modified: []

key-decisions:
  - "zod ^4.6.7 and vitest ^4.1.12 instead of the draft's zod 3 / vitest 2: both drafts pulled npm-audit advisories (zod high, tinypool critical); the 4.x lines audit clean. vitest 5 was rejected because it needs vite as a peer dependency, which PROJECT.md does not allow."
  - "Build emits dist/src/index.js; package.json main/types point there. tsconfig.build.json excludes tests so test files are not shipped."
  - "Config types (Config, FilterSpec, FilterStageSpec, ConfigIssue) added to types.ts as a clearly marked additive section; CONTRACTS.md types are verbatim."
  - "Personas are an array in config (not a map) so duplicate keys are detectable; filters.pipeline stage accepts pre|post|both."
  - "Default pipeline = confidentiality:pre, style:post, confidentiality:post, matching the CONTRACTS pipeline semantics (style, then confidentiality again)."
  - "llm.maxRetries bounded to 0..2 per ORC-02; llm.model has no default."

patterns-established:
  - "scripts/verify.sh [--only <pattern>]: tsc --noEmit, one vitest run, per-tier counts from the JSON report; missing tiers show 0 tests; --only matching nothing fails"

requirements-completed: [FND-01, FND-02, FND-03]

duration: 7min
completed: 2026-11-12
status: complete
---

# Phase 1 Plan 01: Foundation & contracts Summary

**Strict ESM TypeScript skeleton with verify.sh per-tier gate, single-site CONTRACTS types and typed errors, and a zod config loader that fails at startup with path-qualified errors**

## Performance

- **Duration:** about 7 min
- **Completed:** 2026-11-12T03:09Z
- **Tasks:** 3
- **Files:** 17 created

## Accomplishments
- `npm run build` exits 0 under `strict` + `noUncheckedIndexedAccess`; emitted entry points match `package.json`.
- `scripts/verify.sh` prints per-tier counts (smoke 2/2, unit 55/55, other tiers 0 tests) and exits nonzero on typecheck/test failure or an unmatched `--only`.
- Every interface in `.planning/CONTRACTS.md` is declared once in `src/models/types.ts`; six error classes carry stable codes.
- `loadConfig` rejects missing `llm.model`, non-positive `chunk.size`, unknown filter names, empty personas and duplicate persona keys with messages like `filters.pipeline[1].name: unknown filter "foo"`.

## Task Commits

1. **Task 1: Scaffold** - `f42ac95` (chore)
2. **Task 2: Types + errors** - `7a01698` (feat)
3. **Task 3: Config schema + loader** - `96005f7` (feat)

**Plan metadata:** committed separately (docs: complete plan)

## Files Created/Modified
- `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` - toolchain
- `scripts/verify.sh` - typecheck + tiered test gate
- `src/models/types.ts` - single declaration site for shared types
- `src/models/errors.ts` - GhostwriterError and subclasses
- `src/config/schema.ts`, `src/config/load.ts` - zod schema and `loadConfig`
- `config/settings.ts`, `config/targetPersonas.ts`, `config/filters.ts` - default config as data
- `src/index.ts` - barrel (types, errors, `loadConfig`)
- `tests/smoke/build.test.ts`, `tests/unit/errors.test.ts`, `tests/unit/config.test.ts`

## Decisions Made
See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Draft package.json/tsconfig corrected**
- **Found during:** Task 1
- **Issue:** untracked drafts declared `main: dist/index.js` while `rootDir: "."` emits `dist/src/index.js`, and the build would have shipped tests.
- **Fix:** entry points now `dist/src/index.js`/`.d.ts`; added `tsconfig.build.json` (src+config only), `files: ["dist"]`; removed the redundant `exactOptionalPropertyTypes: false`.
- **Files modified:** package.json, tsconfig.json, tsconfig.build.json
- **Committed in:** f42ac95

**2. [Rule 2 - Missing critical] Dependency versions moved off advisory-affected releases**
- **Found during:** Task 1 (`npm install` reported 7 vulnerabilities incl. 2 critical, 2 high)
- **Fix:** zod ^4.6.7, vitest ^4.1.12; `npm audit` now reports 0 vulnerabilities. Package names are unchanged (PROJECT.md list).
- **Committed in:** f42ac95

**3. [Rule 3 - Blocking] src/index.ts created**
- **Found during:** Task 1. The plan's smoke test imports it but it is not in `files_modified`; also needed so `tsc` has an input. Starts as `export {}`, grows into the barrel.
- **Committed in:** f42ac95, 7a01698, 96005f7

### Plan variances (not auto-fixes)
- Smoke tier has 2 tests (typecheck, import), not 1: the test matrix lists both cases, so the Task 1 "smoke 1/1" check reads 2/2.
- Added `Config`, `FilterSpec`, `FilterStageSpec`, `ConfigIssue` to `types.ts` (FND-02 forbids declaring them elsewhere). CONTRACTS.md does not list them; update it if you want it to remain the full inventory.
- Committed on branch `gsd/phase-01-foundation`, not `main` (see Issues Encountered).

**Total deviations:** 3 auto-fixed (1 missing critical, 2 blocking). **Impact:** none on scope; all necessary for a correct, secure, buildable skeleton.

## Issues Encountered
- The commit guard refuses to commit on `main` (protected branch, `git.allow_default_branch_commits` unset). The dispatch asked for local commits on `main`; I did not change the config. Work was re-homed onto `gsd/phase-01-foundation` (branched from `main` at 97b526f). Fast-forward `main` to it or set the config flag as you prefer; nothing was pushed.
- Not verified: behavior on Node 20 (only Node v26.8.1 available locally).

## Known Stubs
None. `config/targetPersonas.ts` and the `style` filter default are real data; the `confidentiality` and `style` filters themselves are Phase 2 work (names are only validated here).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Phases 2 and 3 can import all shared types and errors from `src/models/types.ts` / `errors.ts`, and read `Config.filters.pipeline` and `Config.personas`.
- `@anthropic-ai/sdk` (0.40.x) and `commander` (12.x) are installed but unused; Phase 5 should re-check versions.

## Self-Check: PASSED
