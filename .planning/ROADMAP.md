# Roadmap: Ghostwriter Engine

| # | Phase | Goal | Requirements | Depends |
|---|---|---|---|---|
| 1 | Foundation & contracts | Buildable TS skeleton, all shared types/interfaces, config schema, verify script | FND-01..03 | - |
| 2 | Filter pipeline + filters | Async pipeline, confidentiality filter, style filter, fully tested | FLT-*, CNF-*, STY-* | 1 |
| 3 | Target axis | Personas, prompt builder, banned-phrase enforcement | TGT-* | 1 |
| 4 | Source axis | Chunker, stylometry, embedder, vector store, source manager | SRC-* | 1, 2 (CNF for SRC-04) |
| 5 | Orchestration, LLM, CLI | End-to-end generate, Anthropic + OpenAI-compatible adapters, retries, CLI | LLM-*, ORC-* | 2, 3, 4 |
| 6 | Hardening & docs | Torture/security suites, e2e, README, as-built doc | all | 5 |

## Milestone v2: scoring and humanizing (after v1 ships)
| # | Phase | Goal | Requirements | Depends |
|---|---|---|---|---|
| 7 | AI-likeness scorer | Deterministic [0,1] scorer, breakdown, detector adapter interface, calibration harness | SCR-* | 6 |
| 8 | Humanizer loop | Score-driven bounded rewrite with meaning guard, wired as post filter, CLI `ghostwriter score` and `--humanize` | HUM-* | 7 |

Phase 7 success: calibration report on fixture corpus (AUC measured and recorded); scorer is deterministic. Phase 8 success: on the fixture AI texts the mean score drops by the measured amount recorded in docs, numbers/entities preserved on 100% of fixtures, no secrets reintroduced.

Waves: P1 -> (P2 || P3) -> P4 -> P5 -> P6. P2 and P3 touch disjoint dirs (`src/filters`, `src/registry/targetManager` + `src/pipeline`) and can run in parallel.

## Phase success criteria
1. `npm run build && scripts/verify.sh` green on empty-feature skeleton; types compile under `strict`.
2. Pipeline runs filters in order, fail-closed works, a leaked-secret corpus yields zero secret strings in output, redaction idempotent, style filter leaves code/URLs untouched.
3. Prompt snapshot stable; unknown persona error lists keys.
4. A 3-author fixture corpus yields distinct, stable profiles; retrieval top-k deterministic.
5. `ghostwriter generate` with `MockLlmClient` returns expected text + trace; LLM 429 x3 -> `LlmError`, no output.
6. All tiers green; docs match behavior.
