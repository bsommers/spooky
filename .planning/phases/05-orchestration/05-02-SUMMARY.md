---
phase: 05-orchestration
plan: 01
part: B (tasks 3-5 plus Phase 2/4 carry-overs)
subsystem: orchestration
tags: [typescript, orchestrator, engine, cli, commander, persistence, config]

requires:
  - phase: 05-orchestration part A (05-01-SUMMARY.md)
    provides: withRetry, MockLlmClient, AnthropicClient, OpenAICompatClient, createLlmClient
provides:
  - Orchestrator.generate (pre -> retrieve -> prompt -> LLM retry -> post -> banned-phrase trace), fail-closed everywhere
  - Engine facade (ingest, getProfile, listPersonas, listFilters, generate) with lazy LLM client and state-dir persistence
  - SourceManager persistence: load()/save()/restoreProfiles(), profiles.json (0600, atomic, validated)
  - Config.confidentiality (blocklist, custom rules) wired through loadConfig -> buildPipeline (Phase 2 IN-01)
  - Config.llm provider/baseUrl/apiKeyEnv
  - ghostwriter CLI (ingest, generate, personas, filters, profile), --json, exit codes 0-7
  - Surface parity test that enumerates the CONTRACTS table

status: complete
scope: "Tasks 3-5 of 05-01-PLAN.md plus the three carry-overs. Tasks 1-2 are in 05-01-SUMMARY.md."
actuals:
  tasks: 3
  commits: 5
plan_head_before: 02288ed65c8ed0f71601dbf682fe881d6ae23dc8
plan_head_after: 392ac6ed9bf4b15765639601448bc7227dae7b27

key-files:
  created:
    - src/orchestration/orchestrator.ts
    - src/engine.ts
    - src/registry/profileFile.ts
    - src/cli/main.ts
    - src/cli/bin.ts
    - tests/helpers/rig.ts
    - tests/helpers/cli.ts
    - tests/unit/configWiring.test.ts
    - tests/integration/orchestrator.test.ts
    - tests/integration/persistence.test.ts
    - tests/integration/engine.test.ts
    - tests/integration/cli.test.ts
    - tests/integration/parity.test.ts
    - tests/system/cli.test.ts
  modified:
    - src/models/types.ts
    - src/models/errors.ts
    - src/config/schema.ts
    - src/config/load.ts
    - src/filters/registry.ts
    - src/registry/sourceManager.ts
    - src/index.ts
    - package.json
    - .planning/CONTRACTS.md

key-decisions:
  - "Orchestrator validates order: input type/size/blank, persona, author, then client construction (missing API key), then filters. Unknown persona/author and oversize input cost nothing and run no filter"
  - "Empty, whitespace, non-string or >4 MiB model answers are LlmError(attempts so far), never a successful empty result (MockLlmClient returns them as-is)"
  - "persona-banned trace entry is added only when a banned phrase survives the post stage; metadata is {found:true,count}, never the phrase. The real style filter already strips banned phrases, so the flag fires when style is disabled/failed"
  - "Both pipelines must show a successful confidentiality trace entry or the orchestrator throws FilterFailedError (defence in depth on top of FilterPipeline.requireConfidentiality)"
  - "Retrieval query = first 20,000 chars of the redacted input (placeholders can lengthen text past SourceManager's query cap)"
  - "Config.confidentiality is optional with no default so loadConfig output stays unchanged for existing configs; custom rules are compiled at loadConfig and reported as confidentiality.customRules"
  - "buildPipeline's default factories derive from cfg.confidentiality; explicit factories still win"
  - "Persistence lives in SourceManager (not Engine) so store.save/load, profile writes, ingest, remove and retrieve share one queue. Store file is written before the profiles file"
  - "load(): neither file = empty state; exactly one = StoreCorruptError; each profile must have chunks in the store (zero-vector probe also catches embedder dimension mismatch)"
  - "Profile file corruption is StoreCorruptError; a bad record through restoreProfiles is ProfileError; both name the field and never the value; vectorCollectionName must equal the one derived from authorId"
  - "Engine re-validates its config with loadConfig (hand-built configs cannot relax confidentiality) and clones it"
  - "LLM client is created lazily on first generate, so ingest/profile/personas/filters need no API key"
  - "CLI: exit 1 = unexpected or file-system error (class name / errno only), new exit 7 = STORE_CORRUPT, ProfileError = 2; --json errors are a stdout document, text-mode errors go to stderr"
  - "Only generate requires llm.model; other commands get a placeholder so `personas` works with no config"

metrics:
  tests_added: 126
  verify: "typecheck ok; 1029 tests pass (smoke 4, unit 621, integration 151, system 8, security 241, torture 4); verify.sh PASS"
---

# Phase 5 Plan 01 Part B: Orchestrator, Engine, CLI Summary

The generate pipeline is assembled and reachable from both the library and the `ghostwriter` CLI, ingests survive across processes, and the confidentiality blocklist and custom rules now come from the config.

## Commits

| # | Commit | Content |
|---|---|---|
| carry-over 2 | a0c9081 | `Config.confidentiality`, `Config.llm.provider/baseUrl/apiKeyEnv`, `buildPipeline` defaults from config |
| 3 | d362824 | `Orchestrator` + `tests/helpers/rig.ts` (30 integration tests) |
| carry-over 1 | f94d602 | profile persistence/restore on `SourceManager`, `profileFile.ts` (18 integration tests) |
| 4 | 7d73c8e | `Engine` facade, `index.ts` exports (17 integration tests) |
| 5 | 392ac6e | commander CLI, `bin.ts`, parity test, system tier, CONTRACTS entries (32 + 9 + 8 tests) |

## Test matrix coverage (plan -> where)

| Plan row | Test |
|---|---|
| happy path trace order | orchestrator: `pre -> llm -> post` = `confidentiality, llm, style, confidentiality` |
| secret not in prompt / retrieval query; LLM echo cleaned | orchestrator (captured request + spied `retrieve`) |
| unknown persona/author, LLM never called | orchestrator, cli (exit 3) |
| input > cap, no filter ran (spy) | orchestrator (spy call count), cli/system (exit 6) |
| fail-closed throws pre/post | orchestrator (no LLM call / no text), cli (exit 4) |
| empty LLM output -> LlmError | orchestrator (6 junk shapes), cli (exit 5) |
| banned phrase survives | orchestrator (trace flag, text returned), cli (stderr warning) |
| system CLI | tests/system/cli.test.ts against the tsc-built binary + local stub: ingest then generate --json in separate processes, exit codes 2/3/5/6/7, `--help` lists 5 commands, stdin / `--file` / positional, no key -> exit 2 |
| parity | tests/integration/parity.test.ts parses the CONTRACTS table; also asserts neither surface has extras |
| determinism | orchestrator and cli: identical text/prompt/request, byte-identical stdout (trace `ms` differs by nature and is excluded) |

## Carry-overs

1. **Persistence**: `<stateDir>/store.json` + `profiles.json`, 0600 in a 0700 dir, atomic, deterministic, redacted before writing. Store save/load, profile writes, ingest, remove, retrieve and `restoreProfiles` all run on the manager's queue (mutation-checked: removing `#serial` from `load()` fails the overlap test). Typed errors: `StoreCorruptError`, `ProfileError`, `InputTooLargeError`. State dir: `--state-dir`, `$GHOSTWRITER_STATE_DIR`, `$XDG_STATE_HOME/ghostwriter`, `~/.local/state/ghostwriter`.
2. **Config wiring**: `confidentiality: {blocklist, caseInsensitive, customRules}` validated and eagerly compiled in `loadConfig`; verified end to end through ingest, orchestrator and CLI.
3. **CONTRACTS.md**: added Config, FilterSpec, FilterStageSpec, ConfigIssue (+ CustomRuleConfig, ConfidentialityConfig), ProfileError, StoreCorruptError, exit codes 1 and 7 and the `--json` shape, persistence and orchestrator flow sections.

## Deviations from Plan

**1. [Process] Orchestrator written before its tests.** Tests were added immediately after and run green on the first pass (one assertion corrected: the real style filter strips banned phrases, so the "survives" test disables it). Persistence tests include a mutation check on the queue. Not strict red-green for Task 3.

**2. [Rule 2 - missing functionality] Additions needed by the required behavior.** `Config.llm.provider/baseUrl/apiKeyEnv` (the CLI must pick a provider and the plan had nowhere to put it); blank-input rejection (`ConfigError`, exit 2); exemplar/option validation; `src/cli/bin.ts` + `package.json` `bin`; `validateProfile` bounds on every persisted field since profile text reaches the system prompt.

**3. [Spec choice] Exit codes.** CONTRACTS listed 0, 2-6. Added 7 (STORE_CORRUPT) and 1 (unexpected / errno-only file-system errors); ProfileError maps to 2.

**4. [Scope] Exit code 4 is covered in the integration tier only** (needs an injected failing filter; the real binary has no hook for that, deliberately).

None of the above changes an existing public contract; existing tests were not modified (one new optional config section, no new defaults).

## Known limitations

- Single writer: two processes writing one state directory race last-writer-wins (documented in CONTRACTS and `SourceManager`).
- If the post-ingest save fails the call rejects but memory is ahead of disk; a rejected `load()` after the store file validated leaves the loaded chunks next to the old profiles (documented; the CLI exits).
- The Anthropic SDK reads `ANTHROPIC_BASE_URL` from `process.env` itself, independent of the `env` passed to `createLlmClient`; the system test relies on that to avoid the network.
- README "provider receives redacted-but-real business text" note from the plan's threat model is still outstanding (docs task).

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|---|---|---|
| threat_flag: filesystem-write | src/registry/profileFile.ts, src/registry/sourceManager.ts | New state-dir writes (0600/0700, atomic, symlink-safe); mitigated and tested |
| threat_flag: file-read-untrusted | src/cli/main.ts | CLI reads user-named files and stdin with byte caps; errors report errno only |

## Self-Check: PASSED

All files above exist; commits a0c9081, d362824, f94d602, 7d73c8e, 392ac6e are ancestors of HEAD; `scripts/verify.sh` PASS.
