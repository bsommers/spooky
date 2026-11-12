# Requirements

## v1
### Foundation
- [ ] **FND-01**: `npm run build`, `npm test`, `scripts/verify.sh` work from a clean clone.
- [ ] **FND-02**: All shared types live in `src/models/types.ts` only (single declaration site).
- [ ] **FND-03**: Config validated with zod at load; invalid config fails fast with a path-qualified error.

### Filter pipeline
- [ ] **FLT-01**: `Filter` interface is async: `process(text, ctx): Promise<FilterResult>`; has `name`, `stage: 'pre'|'post'|'both'`.
- [ ] **FLT-02**: `FilterPipeline.register/use` chainable; executes in registration order; returns `{text, trace[]}` (per-filter `modified`, duration, metadata, no raw secrets in trace).
- [ ] **FLT-03**: Per-filter `onError: 'fail-closed' | 'skip'` policy. Confidentiality defaults to fail-closed (throws `FilterFailedError`, no text returned).
- [ ] **FLT-04**: Filters can be enabled/disabled and ordered from config without code changes.

### Confidentiality
- [ ] **CNF-01**: Redact AWS access keys, GitHub tokens (`ghp_`, `github_pat_`), `sk-` API keys, Slack tokens, JWTs, bearer tokens, and full PEM private-key blocks (header through footer).
- [ ] **CNF-02**: Redact **all** occurrences, not just the first.
- [ ] **CNF-03**: Configurable blocklist of literal terms (case-insensitive option); entries escaped, never interpreted as regex; custom regex rules supplied separately and validated at construction.
- [ ] **CNF-04**: Placeholder typed and deterministic; metadata reports counts per rule, never matched values.
- [ ] **CNF-05**: Redaction is idempotent (`f(f(x)) == f(x)`).

### Style (anti-AI-cliche) filter
- [ ] **STY-01**: Remove/replace configured cliche phrases with correct casing and punctuation repair.
- [ ] **STY-02**: Phrase list is data (config), with replacement or deletion per entry; persona `bannedPhrases` merged in via ctx.
- [ ] **STY-03**: Sentence-rhythm check: flag/split runs of N+ sentences within ±15% of the same length, using the author profile's target variance. Deterministic (no randomness).
- [ ] **STY-04**: Never alters content inside code fences, inline code, URLs, or quoted blocks.

### Source axis (author voice)
- [ ] **SRC-01**: Chunker splits documents on paragraph/sentence boundaries with size cap and overlap.
- [ ] **SRC-02**: Stylometry extractor produces a `StylometricProfile` from corpus text.
- [ ] **SRC-03**: `SourceManager` CRUD for author profiles + corpus chunks into `VectorStore`; retrieval returns top-k exemplar passages for a query.
- [ ] **SRC-04**: Corpus is run through the confidentiality filter before being stored.

### Target axis (audience)
- [ ] **TGT-01**: `TargetManager` loads/validates personas; unknown key -> `UnknownPersonaError` listing valid keys.
- [ ] **TGT-02**: `PromptBuilder` assembles system+user prompt from profile + exemplars + persona + input; snapshot-tested.
- [ ] **TGT-03**: Persona `bannedPhrases` enforced post-generation (reported in trace if still present).

### Orchestration + surfaces
- [ ] **ORC-01**: `generate(input, authorId, personaKey)` runs pre-filters -> prompt -> LLM -> post-filters; returns `{text, trace}`.
- [ ] **ORC-02**: LLM failure -> typed `LlmError`; no partial text returned; retries bounded (max 2, exponential, injectable sleep).
- [ ] **ORC-03**: CLI `ghostwriter generate|ingest|profile|personas|filters` with `--json`; exit codes documented.
- [ ] **ORC-04**: Library exports the same operations as the CLI (uniform surfaces).
- [ ] **LLM-01**: `OpenAICompatClient` posts to `{baseUrl}/chat/completions`, maps `LlmRequest` to messages, parses `choices[0].message.content`; key from env var named in config; works with a local server and no key when `apiKeyEnv` is unset.
- [ ] **LLM-02**: Provider selected by config/CLI `--provider anthropic|openai-compat`; unknown provider -> `ConfigError`. Both adapters share the retry policy and return identical typed errors.
- [ ] **ORC-05**: Input size cap (default 200k chars) enforced before any filter or LLM work.

## v2: Detector scoring and humanizing (later milestone)
- [ ] **SCR-01**: `AiLikenessScorer.score(text): number` returns a value in [0,1] (0 = reads human, 1 = reads machine-generated), deterministic, offline. Built from interpretable features: sentence-length burstiness, lexical diversity, cliche/transition density, punctuation variety, repetition of n-grams, paragraph-shape uniformity. Weights in config.
- [ ] **SCR-02**: Scorer returns a per-feature breakdown so every score is explainable.
- [ ] **SCR-03**: Pluggable `DetectorAdapter` interface (`score(text): Promise<number>` normalized to [0,1]) so external detector APIs or local classifiers can be added; ensemble = configurable weighted mean.
- [ ] **SCR-04**: Calibration harness: labeled human/AI fixture corpus, reports AUC and score distributions; ships numbers in docs. No claim beyond measured results.
- [ ] **HUM-01**: `HumanizeFilter` runs a bounded loop: score -> targeted rewrite of the worst-scoring features (rhythm variation, cliche removal, voice-profile-consistent phrasing via LLM pass) -> rescore; stops at `targetScore` (default 0.3) or `maxIterations` (default 3).
- [ ] **HUM-02**: Meaning preservation guard: entities, numbers, and quoted spans must be unchanged (diff check); on violation revert that iteration.
- [ ] **HUM-03**: Confidentiality filter runs again after humanizing; protected spans (code/URLs) untouched.
- [ ] **HUM-04**: Report before/after score and per-feature deltas in the trace. Goal is to lower the score on the local scorer and any plugged-in detectors; no guarantee against any specific third-party detector, and docs state the measured results per detector.

## v3 (deferred)
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
