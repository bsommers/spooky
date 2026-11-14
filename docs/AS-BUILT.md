# As built (v1, end of Phase 6)

What exists, how it differs from the plan in `.planning/`, what was measured, and what is known not to work. Numbers were measured on the dev machine (Linux, Node 26.8.1) on 2026-11-14.

## Defects from the seed code

`.planning/PROJECT.md` lists nine defects in the code of the design chat export. Each is fixed; each row names tests (`file` :: `exact test title`) that pin it. `tests/system/asBuilt.test.ts` fails if a row loses its mapping or a named test disappears.

| # | Defect | Status | Tests |
|---|---|---|---|
| 1 | `FilterResult.modified: bool` is not a TS type (compile error) | fixed: `modified: boolean`, whole project compiles under `strict`; the pipeline validates the returned shape at runtime and computes `modified` itself | `tests/smoke/build.test.ts` :: `tsconfig.build.json compiles and emits the layout package.json main/types point at`; `tests/unit/filters/pipeline.test.ts` :: `modified in the trace reflects whether the text really changed` |
| 2 | `AntiAIFilter` declares `bannedPhrases` but reads `this.banned_phrases` (compile error) | fixed: one spelling, compile-checked; persona phrases arrive as `ctx.extraBannedPhrases` and are removed | `tests/smoke/build.test.ts` :: `tsconfig.build.json compiles and emits the layout package.json main/types point at`; `tests/unit/filters/style.test.ts` :: `extraBannedPhrases are removed as well` |
| 3 | `/g` regexes used with `.test()` then `.replace()` keep `lastIndex`, so every second call skips matches | fixed: matching uses `matchAll` on a clone, no regex state survives a call | `tests/unit/filters/confidentiality.test.ts` :: `the same instance gives identical results on repeated calls (no lastIndex state)`; `tests/unit/filters/style.test.ts` :: `same phrase 3x, called twice on one instance: identical results (no lastIndex state)` |
| 4 | `new RegExp(term)` from unescaped blocklist entries (regex injection, throws on `(`) | fixed: blocklist terms and persona phrases are literals, never compiled as patterns | `tests/unit/filters/confidentiality.test.ts` :: `matches terms with regex metacharacters literally and does not throw`; `tests/unit/filters/style.test.ts` :: `regex metacharacters in a persona phrase are literal` |
| 5 | Single-match secret shapes: no `ghp_`, `sk-`, `xox`, JWT; PEM header only (key body leaks); only the first hit redacted | fixed: built-in types for AWS, GitHub, GitLab, Slack, Stripe, Google, npm, SendGrid and Hugging Face tokens, JWTs, bearer/auth headers, URL credentials, secret-named assignments and the full PEM block, with every occurrence redacted; a 100+ sample leak corpus must come out with zero secret strings, idempotent, in both stages | `tests/unit/filters/confidentiality.test.ts` :: `two keys in one string: both redacted (CNF-02)`; `tests/unit/filters/confidentiality.test.ts` :: `full multi-line PEM block (%s): header through footer removed, body gone`; `tests/security/leak-corpus.test.ts` :: `no secret survives the pre stage or the post stage; output is idempotent; trace is clean` |
| 6 | `BaseFilter.process` is sync; the prose calls for asynchronous middleware | fixed: `Filter.process` returns `Promise<FilterResult>`; the pipeline awaits each filter in order | `tests/unit/filters/pipeline.test.ts` :: `async filter with a delay is awaited and ms reflects it` |
| 7 | Filter exceptions are unhandled; a crashing confidentiality filter must fail closed | fixed: a fail-closed filter that throws yields `FilterFailedError` and no text (CLI exit 4); `skip` filters record the error class name in the trace and pass the text on | `tests/unit/filters/pipeline.test.ts` :: `fail-closed filter that throws: FilterFailedError(filter=name), later filters not run, no text returned`; `tests/integration/orchestrator.test.ts` :: `fail-closed post filter throws -> FilterFailedError and no text`; `tests/integration/cli.test.ts` :: `exit 4: a fail-closed filter fails; no text on stdout` |
| 8 | Removing banned phrases leaves broken casing and punctuation (`"Furthermore, we ..."` -> `"we ..."`) | fixed: the style filter repairs capitalization, commas and spacing around every removal, including list items and headings | `tests/unit/filters/style.test.ts` :: `"Furthermore, we ship." -> "We ship." (re-capitalized)` |
| 9 | `TargetPersonaConfig.bannedPhrases` is defined but nothing enforces it | fixed: listed as prohibitions in the system prompt, removed by the post-stage style filter, and a surviving phrase is flagged in the trace (CLI warning on stderr) | `tests/unit/promptBuilder.test.ts` :: `system carries the author stats block, persona traits, every mandate and every banned phrase as a prohibition`; `tests/unit/filters/registry.test.ts` :: `persona banned phrases flow from ctx into the built style filter (defect 9)`; `tests/integration/orchestrator.test.ts` :: `removes the persona banned phrase on its own (no flag needed)`; `tests/integration/orchestrator.test.ts` :: `a surviving banned phrase is flagged in the trace and the text is still returned` |

End-to-end: `tests/system/e2e.test.ts` runs 3 fixture authors x 2 personas through the public `Engine` with a scripted model (persona structure markers, trace shape, no secret reaching the model or the result, determinism). `tests/torture/engine-torture.test.ts` runs 1000 seeded random `generate()` calls against a fuzzing model (empty, blank, huge, unicode, lone surrogates, secrets, banned phrases, non-string answers, thrown `Error`s, thrown strings, transport errors); every rejection must be a `GhostwriterError` and no planted secret may reach the model, the text or the trace. No source change was needed: the fuzzer found no untyped throw (seeds 1-6 and the default were also tried by hand: `TORTURE_SEED=<n>`).

## Measurements

### Test suite

`scripts/verify.sh`: typecheck plus six tiers, all green.

| Tier | Tests |
|---|---|
| smoke | 4 |
| unit | 648 |
| integration | 183 |
| system | 26 |
| security | 241 |
| torture | 5 |
| total | 1107 |

### Performance budget (`tests/system/perf.test.ts`)

Whole `generate()` path (size cap, pre filters, retrieval, prompt, scripted model, post filters), draft and model answer both of the stated size, default config, best of 9 warm runs:

| Input | Measured | Budget (3x) |
|---|---|---|
| 50 000 chars | 3.7 ms warm (10.8 ms for the first, cold call) | 11 ms |
| 200 000 chars (default `maxInputChars`) | 15 ms | 45 ms |

Scaling is linear (12.5k: 1.1 ms, 25k: 2.0 ms, 50k: 3.7 ms, 100k: 7.2 ms, 200k: 15 ms). Real latency is dominated by the model call, not the pipeline. The budget uses the best of several runs so a busy machine cannot fail the build, while a super-linear regression still does; `GHOSTWRITER_PERF_SCALE=<factor>` scales both budgets on a slower machine.

### Coverage gate (`npm run coverage`, `scripts/verify.sh --coverage`)

v8 coverage over `src/`. Gate: `src/filters/` and `src/registry/` at least 90% of lines (`vitest.config.ts`). Not lowered.

| Directory | Lines | Statements | Branches |
|---|---|---|---|
| `src/filters/` | 97.6% | 96.0% | 89.8% |
| `src/registry/` | 98.3% | 94.5% | 91.9% |

Uncovered lines (the gate is on lines; these are what remains):

- `src/filters/base.ts:18` default-argument branch of `unchanged()`; `pipeline.ts:23` (a non-`Error` value thrown by a filter, reported as `non-Error value thrown`) and `:58` (a filter whose `process` is not a function); `registry.ts:84` (no factory for a configured filter); `style.ts:389` (a defensive `continue`).
- `src/filters/confidentiality.ts:336-343, 364-365, 383-386` (custom-rule length-budget parser: the `\x`, `\u` and `\c` escape sizes, named groups, and the quantifier charge on a repeated group) and `:502` (the throw when redaction fails to reach a fixed point in 8 passes; no input is known to reach it, and the pipeline would turn it into `FilterFailedError`).
- `src/registry/profileFile.ts:144` (rethrow of an unexpected `fs` error while cleaning a temp file); `stateLock.ts:80-82` (closing the lock file handle after a failed write) and `:120` (release when the lock file is already gone).

Uncovered branches without an uncovered line (all defensive `?:`, `??` and `if` arms): `confidentiality.ts` 111, 241, 293, 300, 324, 333-335, 338-342, 350-351, 363-367, 375, 382, 406-407, 425, 465, 493, 557, 563; `pipeline.ts` 57; `protectedSpans.ts` 87, 123; `registry.ts` 38, 82-83, 93; `style.ts` 62, 70, 216, 270, 279-283, 292, 352; `profileFile.ts` 42, 108, 111, 125, 136; `sourceManager.ts` 53, 126, 147, 227, 311; `stateLock.ts` 87, 124; `targetManager.ts` 54. Over all of `src/`: 96.2% statements, 92.0% branches.

Coverage mode changes one test: the 1 MB `chunk()` timing test (`tests/unit/chunker.test.ts`) is skipped when `--coverage` is passed, because v8 instrumentation makes it about 20x slower (3 s to 60 s) and a wall-clock assertion means nothing there. It runs in every normal `npm test` and `scripts/verify.sh`, so under `--coverage` the unit tier reports one skipped test (verify.sh counts it as neither passed nor failed; that is the open `CR-06` item from Phase 1).

## What differs from the plan

- **Dependencies:** zod `^4.6.7` and vitest `^4.1.12` (the first-listed releases carried advisories). Added devDependency `@vitest/coverage-v8` (same version as vitest) for the Phase 6 coverage gate; it is the official coverage provider and the plan's `vitest --coverage` cannot run without it. Runtime dependencies are still exactly `@anthropic-ai/sdk`, `commander`, `zod`.
- **Phase 1:** entry points are `dist/src/index.js` / `.d.ts` (`rootDir: "."` emits under `dist/src`); `tsconfig.build.json` keeps tests out of the package. `Config`, `FilterSpec`, `FilterStageSpec`, `ConfigIssue` live in `types.ts`.
- **Phase 2 (filters):** `redact()` runs to a fixed point (cap 8) so redaction is idempotent on adversarial input; text is matched on its NFKC-normalized view so zero-width and full-width evasions are caught; contextual rules (secret-named assignments, URL credentials and `?token=` parameters) redact only the value and may slightly over-redact (`secretary: Johnson`); custom rules must have a bounded match length (at most 512 characters) and a bounded quantifier budget, and are refused otherwise; `buildPipeline` refuses a hand-built config with no fail-closed confidentiality at a stage.
- **Style filter:** rhythm edits work per unprotected segment and line; fenced code, inline code, URLs and blockquotes are protected; 4-space indented code is not protected (ambiguous with list continuation).
- **Phase 3:** `findBannedPhrases` lives in `registry/targetManager.ts`; persona map-key mismatches are one path-qualified `ConfigError` issue each.
- **Phase 4:** added `ProfileError` and `StoreCorruptError`; `InputTooLargeError` takes a unit; author ids, display names, query length and counts are validated; ingest and retrieval are serialized.
- **Phase 5:** config gained `llm.provider`, `baseUrl`, `apiKeyEnv`; blank input is a `ConfigError`; exit codes 1 and 7 added (and 8 for a locked state directory) to the planned 0 and 2-6; the engine takes a cross-process lock around ingest, so the "single writer" limit noted at the end of Phase 5 no longer holds for ingests (readers still do not lock).
- **Phase 6:** the plan said torture "1k random inputs"; the torture test also fuzzes author, persona, options and the model's behavior, not only the input text.
- **Contracts file:** `.planning/CONTRACTS.md` was kept in step with the code through Phase 5; the barrel `src/index.ts` is the authoritative export list.

## Known limits and open items

Not fixed, by decision; none changes a guarantee above.

- **Secret detection is pattern-based.** Format tokens (`ghp_`, `AKIA`, `npm_`, ...) require a non-alphanumeric character before them, so a token glued to letters (`Wnpm_...`) is not redacted. The torture test found this and pads planted secrets with spaces. Names, emails, customer data and prose are never detected unless listed in `blocklist` or `customRules` (README privacy note).
- **Filters need a source edit to add a name.** The config schema only accepts names from `KNOWN_FILTER_NAMES` in `config/filters.ts`; the factory is passed programmatically. Config-only registration was not built.
- **Prompt injection is reduced, not eliminated:** input and exemplars are fenced and look-alike delimiters neutralized, but a model may still follow instructions written in the draft.
- **ReDoS protection for custom rules is a heuristic** (bounded length plus a quantifier budget, tested against worst-case inputs). A regex engine with linear-time guarantees (RE2, or a worker with a timeout) is the candidate hardening.
- **Endpoints:** private, link-local and metadata addresses are not blocked for `baseUrl`; treat the config file as trusted input. The Anthropic SDK reads `ANTHROPIC_BASE_URL` from the process environment itself.
- **Persistence:** readers (`generate`, `profile`) do not lock against a concurrent ingest; a failed save rolls memory back to what a restart would load, but not byte-exactly in every case.
- **Trace:** `llm.attempts` reports 1 for real providers when the SDK retried internally (`WR-07`); `describeError` can label an `ERR_*` Node error as a file-system error, and `generate --author <x>` echoes an unknown author id in its error (`WR-10`).
- **Not verified:** Node 20 (only Node 26.8.1 was available); no live Anthropic API call has ever been made (the Anthropic path is tested against a local stub via `ANTHROPIC_BASE_URL`; the OpenAI-compatible path against a local HTTP stub and the real binary).
- **Review items left open** are listed in each `.planning/phases/*/*-REVIEW.md` (Phase 1: CR-06, CR-08, CR-09, IN-01/02; Phase 2: CR-09..12, IN-01..03; Phase 3: CR-06, IN-01/02; Phase 4: WR-06, IN-01..04; Phase 5: WR-07, WR-10, IN-*).
- **v2 (scorer, humanizer)** is not started; `ScoreBreakdown`, `DetectorAdapter` and `AiLikenessScorer` exist only as types.
