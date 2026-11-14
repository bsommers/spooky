---
phase: 06-hardening
reviewed: 2026-11-14T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - tests/system/e2e.test.ts
  - tests/system/perf.test.ts
  - tests/system/asBuilt.test.ts
  - tests/torture/engine-torture.test.ts
  - tests/integration/readmeExample.test.ts
  - scripts/verify.sh
  - package.json
  - README.md
  - docs/ARCHITECTURE.md
  - docs/AS-BUILT.md
findings:
  critical: 0
  warning: 6
  info: 5
  total: 11
status: issues_found
---

# Phase 6: Code Review Report

**Reviewed:** 2026-11-14
**Depth:** standard
**Files Reviewed:** 10 (plus vitest.config.ts and tests/unit/chunker.test.ts for context)
**Status:** issues_found

## Summary

Verified by running: `scripts/verify.sh` passes and its per-tier counts (4/648/183/26/241/5 = 1107) match AS-BUILT. `--coverage` passes (unit 647/648 plus 1 skipped). Torture also passes on seeds 7, 99, 777, 4242 and 12345. The CLI flags, exit codes, JSON error shape, personas list and state-dir default in README match `src/cli/main.ts` (one small gap: the XDG fallback is undocumented, see IN-02). The defect map is truthful: every named test exists and passes. No BLOCKERs. The warnings are about test honesty and flakiness.

## Warnings

### WR-01: Perf budget fails under CPU contention (reproduced)

**File:** `tests/system/perf.test.ts:16-17,28-37`
**Issue:** The budgets are 11 ms and 45 ms of absolute wall clock. "Best of N" does not protect against sustained contention. With 40 busy-loop processes on a 32-core box, 3 of 3 runs failed (`58.0 < 45`, `12.8 < 11`, `14.3 < 11`). `verify.sh` runs the file in parallel with the 3 s torture files, and a 2-vCPU CI runner is a realistic place for this to flake. The calibration was done on Node 26 only; `engines` allows Node 20. An invalid `GHOSTWRITER_PERF_SCALE` (`abc`, giving NaN) turns the assertion into an always-fail with a confusing message, and `0` always fails.
**Fix:** Assert a ratio instead of absolute time. For example, time 50k and 200k in the same process and require `t200/t50 < ~8` (linear is about 4), which catches quadratic growth without a machine-dependent constant. Alternatively keep the absolute budget but run it serially (`describe.sequential` plus a separate project or `--poolOptions`), validate `SCALE` with `Number.isFinite(SCALE) && SCALE > 0`, and skip when `CI` is set.

### WR-02: Torture test pads secrets to avoid a real leak class, and AS-BUILT misstates it

**File:** `tests/torture/engine-torture.test.ts:108`; `docs/AS-BUILT.md:89`
**Issue:** The fuzzer found that a secret glued to a preceding letter is not redacted. Reproduced against `dist`:
- `Wnpm_aaaa...` is not redacted.
- `Whf_...` is not redacted.
- `Wsk-...` is not redacted.
- `W` + a JWT is not redacted.
The test then inserts spaces so the invariant "no planted secret reaches the model" holds. That is the invariant weakened to fit the code. AS-BUILT cites `ghp_` and `AKIA` among the affected formats, and those are in fact redacted when glued (`xAKIA...`, `tokenghp_...` both give `[REDACTED:...]`). The real affected set is npm, hf, `sk-` and JWT, and README's privacy section does not mention the gap.
**Fix:** Correct AS-BUILT to list the formats that actually leak. Add a deterministic security-tier test that pins the current behaviour (`Wnpm_...` unredacted), so that a fix or regression is visible. Better, fix the boundary rule, since leaking a token glued to a word is the wrong side to fail on.

### WR-03: asBuilt guard only proves the title string appears somewhere in the file

**File:** `tests/system/asBuilt.test.ts:31`
**Issue:** `readFileSync(path).toContain(title)` is satisfied by a comment, a `describe` name, an `it.skip`/`it.todo`, or a longer title that contains the string. Deleting or skipping the real test, or leaving its title in a comment, keeps the guard green while the defect map claims it is pinned. The only requirement is `refs.length >= 1`, so any one valid reference satisfies a row. A defect row can therefore carry unrelated tests. Defects 1 and 2 share the same compile-smoke test, which asserts nothing about `modified: boolean` or `bannedPhrases`.
**Fix:** Match `(it|test)(\.each\(.*\))?\(\s*['"\`]` followed by the escaped title, and reject `.skip` and `.todo`. Better, run vitest with the JSON reporter and assert the named tests are `passed` (the title is `fullName`). Give defects 1 and 2 a behaviour test of their own, for example a type-level `expectTypeOf<FilterResult['modified']>().toEqualTypeOf<boolean>()`.

### WR-04: README snippet and its test can drift; the "verbatim" claim is unenforced

**File:** `tests/integration/readmeExample.test.ts:1-2,9,22`; `README.md:86-97`
**Issue:** The `// ---- README snippet start/end ----` markers exist, but no code compares the two. Editing README does not fail a test. The "docs match reality" guarantee is therefore social. The README step 2 text ("`[...default entries..., noEmoji]`, before the last confidentiality") is ambiguous. Appending after the defaults is exactly what the pipeline refuses (README line 100), and the test builds its own explicit list rather than the one README describes.
**Fix:** In the test, read README.md, extract the fenced `ts` block, and compare it to the text between the markers (ignoring whitespace). Rewrite step 2 as "insert `{ name: 'noEmoji', stage: 'post' }` between `style` and the final `confidentiality`".

### WR-05: e2e "persona structure" assertions largely test the mock script

**File:** `tests/system/e2e.test.ts:30-35,48-58`
**Issue:** `scripted()` returns `BLUF:` iff the system prompt contains the mandate, and the test then asserts `text.startsWith('BLUF:')`. This proves prompt routing only (the prompt content is separately checked in test 2), not any engine property. AS-BUILT describes it as "persona structure markers", which overstates it. The `persona-banned` trace path, retry, and error paths are never exercised end to end, and `attempts: 1` is the only retry assertion.
**Fix:** Reword AS-BUILT ("persona mandates reach the prompt"). Add one e2e case where the scripted model emits a banned phrase that survives, and assert the `persona-banned` trace entry plus the CLI-visible outcome.

### WR-06: Coverage-mode skip is invisible to the gate, and its trigger is fragile

**File:** `vitest.config.ts:4`; `scripts/verify.sh` (tier counter); `tests/unit/chunker.test.ts:192`
**Issue:** `process.argv.includes('--coverage')` misses `--coverage.enabled`, `--coverage=true`, or a CI wrapper that enables coverage via config. In those cases the 20x slowdown reappears and the timing test fails or times out. In coverage mode the chunker test is skipped, and `verify.sh` counts it as neither passed nor failed (open Phase 1 CR-06), so the gate cannot tell a deliberate skip from an accidental one. AS-BUILT does disclose this.
**Fix:** Derive the flag from the resolved config (`configureVitest` or `test.coverage.enabled`) or from `--coverage*` prefix matching. Make `verify.sh` fail if skipped is greater than 0 outside coverage mode.

## Info

### IN-01: Torture assertions check "typed", not "correct code"

**File:** `tests/torture/engine-torture.test.ts:123-127,149-152`
**Issue:** The test only requires `instanceof GhostwriterError` and 4 or more distinct codes. A non-string model answer producing `CONFIG_INVALID` instead of `LLM_FAILED` would pass. Planting a secret in `authorId` (line 111) is never checked in the error message, although WR-10 already knows the id is echoed. The `rejected.size >= 4` and `resolved > 20%` floors are seed-dependent and will fail for some `TORTURE_SEED` values, which makes the documented hunting workflow noisy.
**Fix:** Map `behavior` to an expected code set. Assert `err.message` contains no planted secret, or mark that as a known failure.

### IN-02: Docs drift against measured values

**File:** `docs/AS-BUILT.md:45,52,69`; `README.md:52`; `tests/system/perf.test.ts:26`
**Issue:**
- AS-BUILT says "best of 9 warm runs, default config", but the 200k case uses 5 runs and the test raises `maxInputChars` to 400000.
- Over-`src/` coverage is quoted as 96.2% statements and 92.0% branches, while the run measured 96.43% and 92.12%.
- README's state-dir default omits the `$XDG_STATE_HOME` fallback (`src/engine.ts:63`).
**Fix:** Update the figures, or word them as approximate.

### IN-03: Perf test sets a wider config than the doc claims

**File:** `tests/system/perf.test.ts:26`
**Issue:** The 200k case runs with `maxInputChars: 400_000`, but the doc and test title call 200k "the default `maxInputChars`". The model answer is also processed at 200k, so the measurement covers both directions, which is fine but unstated in the title.
**Fix:** Drop the override for the 200k case, or reword the title.

### IN-04: Test mutates the shared `KNOWN_FILTER_NAMES` array through casts

**File:** `tests/integration/readmeExample.test.ts:26-33`
**Issue:** `added` is computed at describe time, and the `afterEach` splice removes the name even if it was originally present. It is correct under per-file module isolation but breaks with `--no-isolate` or with a second test added to the describe block.
**Fix:** Use `vi.spyOn`/a try-finally inside the test, restoring only what the test itself added.

### IN-05: README `npx ghostwriter` and package-name mismatch

**File:** `README.md:40`
**Issue:** The package is named `spooky` but the bin is `ghostwriter`. `npx ghostwriter` worked locally here, but outside a linked checkout it resolves the registry package named `ghostwriter`, an unrelated package. This is a supply-chain footgun.
**Fix:** Document only `npm link` or `node dist/src/cli/bin.js`, or add a `spooky` bin alias.

---

_Reviewed: 2026-11-14_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
