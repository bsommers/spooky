---
phase: 01-foundation
reviewed: 2026-11-12T00:00:00Z
depth: standard
files_reviewed: 17
files_reviewed_list:
  - package.json
  - tsconfig.json
  - tsconfig.build.json
  - vitest.config.ts
  - scripts/verify.sh
  - config/filters.ts
  - config/settings.ts
  - config/targetPersonas.ts
  - src/index.ts
  - src/config/load.ts
  - src/config/schema.ts
  - src/models/errors.ts
  - src/models/types.ts
  - tests/smoke/build.test.ts
  - tests/unit/config.test.ts
  - tests/unit/errors.test.ts
  - .planning/CONTRACTS.md (reference only)
findings:
  critical: 0
  high: 1
  medium: 3
  low: 5
  info: 2
  total: 11
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-11-12
**Depth:** standard
**Files Reviewed:** 16 source/test files (diff 97b526f..a9ad1af)
**Status:** issues_found

## Summary

The foundation is small and mostly sound. `npm run build` and `scripts/verify.sh` both pass (57 tests), and types match CONTRACTS.md. I probed `loadConfig` against edge inputs by running it on the built output. The main gap is that the config schema lets a user switch off the fail-closed confidentiality guarantee (D6) with no error. The rest are validation gaps, a brittle error-message dependency, and verification-gate weaknesses. No critical issues.

## High

### CR-01: Config can disable, remove, or make confidentiality fail-open without any error

**File:** `src/config/schema.ts:10-17,58-62` (defaults in `config/filters.ts:11-15`)
**Issue:** `filters.pipeline` accepts `[]`, `{name:'confidentiality', enabled:false}`, or `{name:'confidentiality', onError:'skip'}`. I confirmed that `loadConfig` returns OK for all three. D6 and FLT-03 require that confidentiality runs both pre and post and fails closed. The plan's threat model says "fail at startup". A one-line config edit or typo silently turns a secret-redaction pipeline into pass-through, which is a data-leak path to the LLM provider and into the output.
**Fix:** Add a `superRefine` on `pipeline` that enforces the invariant at load time (or require an explicit `allowUnsafeConfidentiality: true` escape hatch):
```ts
.superRefine((pipeline, ctx) => {
  for (const stage of ['pre', 'post'] as const) {
    const ok = pipeline.some(f => f.name === 'confidentiality' && f.enabled &&
      f.onError === 'fail-closed' && (f.stage === stage || f.stage === 'both'));
    if (!ok) ctx.addIssue({ code: 'custom', path: [], message: `confidentiality must be enabled and fail-closed at stage "${stage}"` });
  }
  pipeline.forEach((f, i) => {
    if (f.name === 'confidentiality' && f.onError !== 'fail-closed')
      ctx.addIssue({ code: 'custom', path: [i, 'onError'], message: 'confidentiality must be fail-closed' });
  });
})
```

## Medium

### CR-02: Whitespace-only strings pass validation (`llm.model`, banned phrases, persona text)

**File:** `src/config/schema.ts:20-25,53`
**Issue:** `z.string().min(1)` accepts `" "`. I confirmed `llm.model: " "` and `bannedPhrases: [" "]` load fine. The inline comment on line 25 says an empty phrase "would match everywhere", and a single space does exactly that to any text. An invalid model name also surfaces only at the first LLM request, which contradicts "never at first request".
**Fix:** Use `z.string().trim().min(1)` for `llm.model`, `name`, `cognitiveLoad`, `informationDensity`, and each `structuralMandates` and `bannedPhrases` entry. Add unit tests for the whitespace cases.

### CR-03: "is required" detection depends on zod's English message text

**File:** `src/config/load.ts:23`
**Issue:** `issue.message.endsWith('received undefined')` classifies a missing-key error by string-matching a library-generated message. A zod patch release, a `z.config({ localeError })` change, or a custom `error` on a field flips the output from `llm.model: is required` to `llm.model: Invalid input: ...`. The `ConfigError.message` and `issues` are what the CLI will print for exit code 2, and tests assert the exact text. The CONTRACTS note "never match on message" is violated internally.
**Fix:** Decide on structure rather than text, for example by walking the raw input along `issue.path`:
```ts
function isMissing(raw: unknown, path: readonly PropertyKey[]): boolean {
  let cur: any = raw;
  for (const seg of path) { if (cur == null || typeof cur !== 'object') return true; cur = cur[seg]; }
  return cur === undefined;
}
// ...issue.code === 'invalid_type' && isMissing(raw, issue.path)
```
Pass `raw` into `toIssues`.

### CR-04: `npm run build` / `tsconfig.build.json` / package entry points are not exercised by any test

**File:** `tests/smoke/build.test.ts:10-25`, `package.json:10-13`, `tsconfig.build.json`
**Issue:** FND-01 and the plan's truth #1 are "`npm run build` exits 0". The smoke test only runs `tsc --noEmit -p tsconfig.json`, and `scripts/verify.sh` does the same typecheck, so the test duplicates the gate. `tsconfig.build.json` (a different `include`/`exclude`) is never compiled by any gate. A break there, or in the emitted layout that `main` and `types` (`dist/src/index.js`) depend on via `rootDir: "."`, would pass `verify`. The second smoke test also imports `../../src/index.js` from source, not the built artifact.
**Fix:** Have the smoke test (or verify.sh) run `tsc -p tsconfig.build.json --outDir <tmp>` and assert that `<tmp>/src/index.js` and `index.d.ts` exist (and optionally import the emitted `index.js`). Drop the duplicate `--noEmit` run from the test, or from verify.sh.

## Low

### CR-05: `llm.temperature` allowed up to 2, but the default provider (Anthropic) caps at 1

**File:** `src/config/schema.ts:55`, `config/settings.ts:6`
**Issue:** A value such as `1.5` passes startup validation and is rejected by the API at the first request. This breaks the "fail at startup, not first request" goal for the project's default provider. The test asserts `[0,2]`, which locks in the looser bound.
**Fix:** Cap at 1 (the intersection of the supported providers), or validate against the provider once `ProviderConfig` is wired in.

### CR-06: `verify.sh` counts skipped and todo tests as neither passed nor failed, so a skipped test cannot fail the gate

**File:** `scripts/verify.sh:81-85,95`
**Issue:** The status handling only counts `passed` and `failed`. `it.skip`, `it.todo`, and `describe.skip` are included in `total` but not in `passed`, so the output reads `3/4 passed` with no failure. The gate still exits 0, and `bad` is set only when `failed` is nonzero. Tests can be quietly disabled to turn the gate green, which `layered-verification-gates` warns against. The inline `node -` script also relies on stdin being parsed as CommonJS (`require`) in a `"type":"module"` package. That works on Node 26 but is an implicit dependency.
**Fix:** Count `skipped` and `pending` explicitly, print them (`3/4 passed, 1 SKIPPED`), and fail on them (or require an opt-in env var). Use `node --input-type=commonjs -`, or a `.cjs` helper file.

### CR-07: `engines.node` is looser than the toolchain requires

**File:** `package.json:7-9`
**Issue:** `engines` says `>=20`, but the installed vite 8.3.8 requires `^20.19.0 || >=22.12.0`. Node 20.0 to 20.18 and 22.0 to 22.11 satisfy `engines` but cannot run `npm test`. That undermines FND-01 ("works from a clean clone").
**Fix:** Set `"node": "^20.19.0 || >=22.12.0"` and document it.

### CR-08: Persona keys are case-sensitive and may collide with Object.prototype names

**File:** `src/config/schema.ts:20,33-37`
**Issue:** `Engineer` and `engineer` are distinct keys, which makes `--persona` ambiguous and error-prone. Keys such as `constructor`, `toString`, and `hasOwnProperty` match the regex. If a later phase looks personas up in a plain-object map, those keys will hit prototype members. `__proto__` is blocked, but only incidentally by the leading `_` rule.
**Fix:** Normalize or reject case-insensitive duplicates (compare `p.key.toLowerCase()`), and have later phases use `Map`. Optionally reject reserved names.

### CR-09: Error `cause` and message interpolation can carry sensitive or untrusted text

**File:** `src/models/errors.ts:28,38,48,68`
**Issue:** `FilterFailedError` and `LlmError` chain the raw `cause`. For a confidentiality filter failure, the cause could embed the offending text or the matched secret (for example a regex error containing the input). That contradicts "trace metadata must never contain matched values" the moment someone logs `err.cause` or prints a stack. `UnknownPersonaError` and `UnknownAuthorError` interpolate raw user-supplied strings (control characters, ANSI escapes) into messages that the CLI will print.
**Fix:** Document and enforce that causes passed to `FilterFailedError` are sanitized (or store only `cause.name`/`code`). Escape with `JSON.stringify(key)` when interpolating user strings.

## Info

### IN-01: `Config` type and zod schema are only checked in one direction

**File:** `src/config/load.ts:46`
**Issue:** `const config: Config = parsed.data` proves the schema output is assignable to `Config`. It does not prove the reverse. A field added to the schema but not to `Config` still compiles, because assignability tolerates extra properties on non-literals, and it is returned untyped. The header comments in `schema.ts` and `load.ts` claim the contract is "proven".
**Fix:** Add a bidirectional type-equality assertion (for example `Expect<Equal<z.output<typeof configSchema>, Config>>`) in a type-only test or in `schema.ts`.

### IN-02: Dependencies and contracts not yet used or wired

**File:** `package.json:18-22`, `src/models/types.ts:112-114`
**Issue:** `@anthropic-ai/sdk` and `commander` are installed but unused in Phase 1. This is an acceptable early declaration, but it adds to the audit surface. `ProviderConfig` (provider, `baseUrl`, `apiKeyEnv`) exists in types, but `Config.llm` has only `model`, so provider selection and key-env validation are unreachable through `loadConfig`, and `llm.model` is declared separately from `ProviderConfig.model`. A later phase must reconcile the two or the single-declaration rule (FND-02) is strained.
**Fix:** Either note the intent in the roadmap or defer the dependency adds to the phases that use them. Plan the `Config.llm` to `ProviderConfig` merge before the LLM phase.

---

_Reviewed: 2026-11-12_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
