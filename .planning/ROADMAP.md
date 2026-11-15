# Roadmap: Ghostwriter Engine

| # | Phase | Goal | Requirements | Depends |
|---|---|---|---|---|
| 1 | Foundation & contracts ✓ (2026-11-12) | Buildable TS skeleton, all shared types/interfaces, config schema, verify script | FND-01..03 | - |
| 2 | Filter pipeline + filters ✓ (2026-11-13) | Async pipeline, confidentiality filter, style filter, fully tested | FLT-*, CNF-*, STY-* | 1 |
| 3 | Target axis ✓ (2026-11-13) | Personas, prompt builder, banned-phrase enforcement | TGT-* | 1 |
| 4 | Source axis ✓ (2026-11-13) | Chunker, stylometry, embedder, vector store, source manager | SRC-* | 1, 2 (CNF for SRC-04) |
| 5 | Orchestration, LLM, CLI ✓ (2026-11-13) | End-to-end generate, Anthropic + OpenAI-compatible adapters, retries, CLI | LLM-*, ORC-* | 2, 3, 4 |
| 6 | Hardening & docs ✓ (2026-11-14) | Torture/security suites, e2e, README, as-built doc | all | 5 |

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

## Milestone v3: surfaces and UI (after v1 ships; Phase 8 features surface when they land)
| # | Phase | Goal | Requirements | Depends |
|---|---|---|---|---|
| 9 | Service surfaces | One shared service layer (`src/service/`) declaring every operation once; CLI, local HTTP API (OpenAPI 3.1 from zod) and MCP server (stdio + streamable HTTP) all call it; parity test over all surfaces | API-*, MCP-* | 6 (score/humanize ops light up with 7/8) |
| 10 | UI foundation & theming | React + TS (Vite) SPA in `ui/` served by the API; React Aria Components; runtime-switchable theme system with "Black Cat" and "Tron Neon"; AA contrast tested; offline | UI-01..UI-06 | 9 |
| 11 | UI features | Generate, Ingest/Authors, Personas, Settings, Score/Humanize screens; component + axe + keyboard + Playwright visual tests; XSS-safe, CSP, no secrets in bundle | UI-07..UI-14 | 10 (Score/Humanize panels gated on 8) |

Phase 9 success: parity test green over Engine/CLI/HTTP/MCP; OpenAPI spec validates and is generated, not hand-written; HTTP errors map 1:1 to CLI exit codes. Phase 10 success: both themes pass WCAG AA in tests, third theme = one token file, bundle makes zero external requests. Phase 11 success: every screen axe-clean in both themes, keyboard-complete, screenshots stable, no API key or model-output HTML injection path. Design: `docs/SURFACES.md`, `docs/UI-THEMES.md`.

Waves: P9 -> P10 -> P11. Phase 9 files: `src/service`, `src/api`, `src/mcp`, `src/cli` (additive). Phase 10/11: `ui/` only plus static-serve hook in `src/api`.
