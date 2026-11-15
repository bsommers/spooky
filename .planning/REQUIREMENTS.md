# Requirements

## v1

### Foundation

- [x] **FND-01**: `npm run build`, `npm test`, `scripts/verify.sh` work from a clean clone.
- [x] **FND-02**: All shared types live in `src/models/types.ts` only (single declaration site).
- [x] **FND-03**: Config validated with zod at load; invalid config fails fast with a path-qualified error.

### Filter pipeline

- [x] **FLT-01**: `Filter` interface is async: `process(text, ctx): Promise<FilterResult>`; has `name`, `stage: 'pre'|'post'|'both'`.
- [x] **FLT-02**: `FilterPipeline.register/use` chainable; executes in registration order; returns `{text, trace[]}` (per-filter `modified`, duration, metadata, no raw secrets in trace).
- [x] **FLT-03**: Per-filter `onError: 'fail-closed' | 'skip'` policy. Confidentiality defaults to fail-closed (throws `FilterFailedError`, no text returned).
- [x] **FLT-04**: Filters can be enabled/disabled and ordered from config without code changes.

### Confidentiality

- [x] **CNF-01**: Redact AWS access keys, GitHub tokens (`ghp_`, `github_pat_`), `sk-` API keys, Slack tokens, JWTs, bearer tokens, and full PEM private-key blocks (header through footer).
- [x] **CNF-02**: Redact **all** occurrences, not just the first.
- [x] **CNF-03**: Configurable blocklist of literal terms (case-insensitive option); entries escaped, never interpreted as regex; custom regex rules supplied separately and validated at construction.
- [x] **CNF-04**: Placeholder typed and deterministic; metadata reports counts per rule, never matched values.
- [x] **CNF-05**: Redaction is idempotent (`f(f(x)) == f(x)`).

### Style (anti-AI-cliche) filter

- [x] **STY-01**: Remove/replace configured cliche phrases with correct casing and punctuation repair.
- [x] **STY-02**: Phrase list is data (config), with replacement or deletion per entry; persona `bannedPhrases` merged in via ctx.
- [x] **STY-03**: Sentence-rhythm check: flag/split runs of N+ sentences within ±15% of the same length, using the author profile's target variance. Deterministic (no randomness).
- [x] **STY-04**: Never alters content inside code fences, inline code, URLs, or quoted blocks.

### Source axis (author voice)

- [x] **SRC-01**: Chunker splits documents on paragraph/sentence boundaries with size cap and overlap.
- [x] **SRC-02**: Stylometry extractor produces a `StylometricProfile` from corpus text.
- [x] **SRC-03**: `SourceManager` CRUD for author profiles + corpus chunks into `VectorStore`; retrieval returns top-k exemplar passages for a query.
- [x] **SRC-04**: Corpus is run through the confidentiality filter before being stored.

### Target axis (audience)

- [x] **TGT-01**: `TargetManager` loads/validates personas; unknown key -> `UnknownPersonaError` listing valid keys.
- [x] **TGT-02**: `PromptBuilder` assembles system+user prompt from profile + exemplars + persona + input; snapshot-tested.
- [x] **TGT-03**: Persona `bannedPhrases` enforced post-generation (reported in trace if still present).

### Orchestration + surfaces

- [x] **ORC-01**: `generate(input, authorId, personaKey)` runs pre-filters -> prompt -> LLM -> post-filters; returns `{text, trace}`.
- [x] **ORC-02**: LLM failure -> typed `LlmError`; no partial text returned; retries bounded (max 2, exponential, injectable sleep).
- [x] **ORC-03**: CLI `ghostwriter generate|ingest|profile|personas|filters` with `--json`; exit codes documented.
- [x] **ORC-04**: Library exports the same operations as the CLI (uniform surfaces).
- [x] **LLM-01**: `OpenAICompatClient` posts to `{baseUrl}/chat/completions`, maps `LlmRequest` to messages, parses `choices[0].message.content`; key from env var named in config; works with a local server and no key when `apiKeyEnv` is unset.
- [x] **LLM-02**: Provider selected by config/CLI `--provider anthropic|openai-compat`; unknown provider -> `ConfigError`. Both adapters share the retry policy and return identical typed errors.
- [x] **ORC-05**: Input size cap (default 200k chars) enforced before any filter or LLM work.

## v2: Detector scoring and humanizing (later milestone)

- [x] **SCR-01**: `AiLikenessScorer.score(text): number` returns a value in [0,1] (0 = reads human, 1 = reads machine-generated), deterministic, offline. Built from interpretable features: sentence-length burstiness, lexical diversity, cliche/transition density, punctuation variety, repetition of n-grams, paragraph-shape uniformity. Weights in config.
- [x] **SCR-02**: Scorer returns a per-feature breakdown so every score is explainable.
- [x] **SCR-03**: Pluggable `DetectorAdapter` interface (`score(text): Promise<number>` normalized to [0,1]) so external detector APIs or local classifiers can be added; ensemble = configurable weighted mean.
- [x] **SCR-04**: Calibration harness: labeled human/AI fixture corpus, reports AUC and score distributions; ships numbers in docs. No claim beyond measured results.
- [x] **HUM-01**: `HumanizeFilter` runs a bounded loop: score -> targeted rewrite of the worst-scoring features (rhythm variation, cliche removal, voice-profile-consistent phrasing via LLM pass) -> rescore; stops at `targetScore` (default 0.3) or `maxIterations` (default 3).
- [x] **HUM-02**: Meaning preservation guard: entities, numbers, and quoted spans must be unchanged (diff check); on violation revert that iteration.
- [x] **HUM-03**: Confidentiality filter runs again after humanizing; protected spans (code/URLs) untouched.
- [x] **HUM-04**: Report before/after score and per-feature deltas in the trace. Goal is to lower the score on the local scorer and any plugged-in detectors; no guarantee against any specific third-party detector, and docs state the measured results per detector.

## v3: Surfaces and UI (milestone v3)

Uniform-surface rule: every capability exists on every surface (library, CLI, HTTP API, MCP, UI where it is user-facing). Operations: generate, ingest, profile, list authors, list personas, list filters, score, humanize, config get.

### Service layer, HTTP API, MCP

- [x] **API-01**: `src/service/operations.ts` declares each operation once (name, zod input/output schema, error mapping, handler over `Engine`); CLI, HTTP and MCP are generated/derived from it, none re-declares schemas.
- [x] **API-02**: Local HTTP server (`ghostwriter serve`): binds 127.0.0.1 by default; non-loopback bind requires explicit `--host` plus a bearer token; optional bearer token (constant-time compare, token from env var, never logged); no `Access-Control-Allow-Origin: *` (same-origin only, optional explicit origin allowlist); Host/Origin header checks against DNS rebinding.
- [x] **API-03**: Request limits: body size cap (default 1 MiB, ingest 10 MiB, configurable), JSON only, content-type enforced, request timeout, bounded concurrency; over-limit -> 413 before parsing.
- [x] **API-04**: Typed error -> HTTP status mapping mirrors CLI exit codes (usage/config/profile 400/422, unknown persona/author 404, filter failed 422, LLM failed 502, input too large 413, store corrupt 500, state locked 423/503) in one table shared with `EXIT_CODES`; body `{ok:false,error:{code,message}}`; unexpected errors by class name only.
- [x] **API-05**: `GET /openapi.json` serves an OpenAPI 3.1 document generated from the zod schemas; test validates it and fails on drift from the registered operations. `config get` never returns secrets (env var names only).
- [x] **API-06**: Parity test: enumerates the operations registry and fails when any operation lacks a library method, CLI command, HTTP route or MCP tool (and when a surface has a capability the registry lacks). Adds missing CLI commands (`authors`, `config get`; `score`/`humanize` arrive with Phases 7-8).
- [x] **MCP-01**: MCP server using the official `@modelcontextprotocol/sdk`; transports stdio and streamable HTTP (the latter under the API-02 auth/bind rules); one tool per operation with zod-derived input schema.
- [x] **MCP-02**: Tool inputs are untrusted: validated with the operation schema, size-capped, no path/shell interpolation, no file-system paths accepted (text only); tool output is data, errors map to MCP error results with the same codes.
- [x] **MCP-03**: Tool annotations (readOnlyHint/destructiveHint) set correctly; ingest is the only state-mutating tool; secrets never in tool results or logs; stdio server writes nothing but protocol to stdout.

### UI

- [ ] **UI-01**: `ui/` is a Vite + React + TypeScript (strict) SPA built to static files served by the API server at `/`; dev proxy to the API; `ui/` has its own tsconfig and tests and does not import from `src/` except generated API types.
- [ ] **UI-02**: Component library: React Aria Components (Apache-2.0); all interactive widgets from it; no second UI kit.
- [ ] **UI-03**: Theme system: CSS custom properties on `[data-theme]`, runtime switch, choice persisted (localStorage, try/catch), default follows `prefers-color-scheme`, `prefers-reduced-motion` disables animation; theme contract = one token file per theme validated by a schema test.
- [ ] **UI-04**: Themes "Black Cat" and "Tron Neon" shipped; every text/background token pair used meets WCAG AA (4.5:1 text, 3:1 UI) asserted by a unit test over the token files.
- [ ] **UI-05**: Original SVG logo and icon set (no third-party art); favicon set.
- [ ] **UI-06**: Offline: no runtime request to any external origin (fonts self-hosted, OFL/compatible licenses recorded in `ui/THIRD_PARTY.md`); test asserts built HTML/CSS/JS reference only same-origin URLs.
- [ ] **UI-07**: Generate screen: persona + author pickers, input, output, trace view, banned-phrase and confidentiality indicators (counts only).
- [ ] **UI-08**: Ingest/Authors screen: ingest text/file, list authors, stylometric profile view.
- [ ] **UI-09**: Personas viewer.
- [ ] **UI-10**: Settings: provider, theme, state dir (read-only display); the API key is never displayed, stored in the browser, or present in the client bundle; token for the API held in memory only.
- [ ] **UI-11**: Score and Humanize panels with before/after score and per-feature deltas; feature-flagged off until Phases 7/8 are present (capability discovered via `GET /api/capabilities`).
- [ ] **UI-12**: Security: model output rendered as text only (no `dangerouslySetInnerHTML`, lint rule enforces), strict CSP (`default-src 'self'`, no inline script, no `unsafe-eval`) set by the API server and asserted in tests; secret-scan of the built bundle in CI.
- [ ] **UI-13**: Tests: Vitest + Testing Library component tests, axe checks per screen in both themes, full keyboard navigation tests, Playwright screenshots in both themes (baselines committed, deterministic).
- [ ] **UI-14**: Every UI action goes through the same HTTP operations (no UI-only capability), verified by the parity test.

## v4 (deferred)

Real vector DB adapter, real embedder, streaming, PII classifier filter (NER).

## Traceability

| Req | Phase |
|---|---|
| FND-* | 1 |
| FLT-*, CNF-*, STY-* | 2 |
| TGT-* | 3 |
| SRC-* | 4 |
| LLM-*, ORC-* | 5 |
| SCR-*, HUM-* | 7-8 (milestone v2) |
| API-*, MCP-* | 9 (milestone v3) |
| UI-01..UI-06 | 10 |
| UI-07..UI-14 | 11 |
