---
phase: 04-source-axis
plan: 01
subsystem: source-axis
tags: [typescript, chunking, stylometry, hash-embedding, vector-store, confidentiality, vitest]

requires:
  - phase: 01-foundation
    provides: shared types (StylometricProfile, Chunk, ScoredChunk, Embedder, VectorStore), error hierarchy, verify.sh
  - phase: 02-filters
    provides: ConfidentialityFilter (NFKC detection), FilterPipeline, leak-corpus fixtures
provides:
  - chunk(): paragraph > sentence > word > hard-cut chunker with overlap, surrogate safety and a chunk cap
  - extractProfile(): pure deterministic StylometricProfile; ProfileError for word-less corpora
  - HashEmbedder: FNV-1a feature hashing, L2-normalized, zero vector for token-less text
  - InMemoryVectorStore: exact cosine, id-ascending ties, validated JSON save/load, 0600 atomic writes
  - SourceManager: ingest / getProfile / listAuthors / retrieve / remove with redaction before chunking
affects: [05-orchestration, 06-hardening]

status: complete
actuals:
  tasks: 5
  commits: 5
plan_head_before: 5a346d943813f7c7440045bde7b1c06c0a610806
plan_head_after: e27b1ef75d0771427caf1816c113f1928bc10766

tech-stack:
  added: []
  patterns:
    - "Ingest order is a security property: size guard -> pre-stage confidentiality (fail-closed, verified via trace) -> profile -> chunk -> embed -> store"
    - "Redact the whole corpus before chunking so a secret straddling a chunk boundary is still one match"
    - "Untrusted-size inputs are capped (chars, chunks, authors, query length, store file bytes/items) with typed errors"
    - "Persisted files are untrusted on load: size check first, field-by-field validation, swap state only after full validation"
    - "Mutating ops and retrieval run through a promise-chain mutex; embedding is batched with event-loop yields"

key-files:
  created:
    - src/ingestion/chunker.ts
    - src/ingestion/stylometry.ts
    - src/embedding/hashEmbedder.ts
    - src/store/inMemoryVectorStore.ts
    - src/registry/sourceManager.ts
    - tests/unit/chunker.test.ts
    - tests/unit/stylometry.test.ts
    - tests/unit/store.test.ts
    - tests/unit/sourceManager.test.ts
    - tests/security/source-secrets.test.ts
    - tests/integration/source.test.ts
    - tests/torture/source-torture.test.ts
    - tests/fixtures/authors/terse-technical.txt
    - tests/fixtures/authors/verbose-hedging.txt
    - tests/fixtures/authors/bulleted-executive.txt
  modified:
    - src/models/errors.ts
    - src/filters/confidentiality.ts
    - src/index.ts
    - tests/unit/errors.test.ts

key-decisions:
  - "SourceManager takes a pre-stage FilterPipeline (not a bare filter) and checks the trace for a non-errored 'confidentiality' entry after every run; a pipeline that skipped it (e.g. post-only) fails closed with FilterFailedError"
  - "activePassiveRatio = share of sentences WITHOUT a passive construction, in [0,1] (a true active:passive ratio is infinite when nothing is passive)"
  - "sentenceLengthStdDev is the population standard deviation; lexicalDensityRatio is the raw type-token ratio"
  - "Chunk ids are `<authorId>#<8-digit index>` so id order is document order; collection name is `author/<authorId>`"
  - "authorId must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ (it becomes a collection name and, later, a CLI argument)"
  - "listAuthors returns profiles sorted by id; remove() of an unknown author throws UnknownAuthorError"
  - "Torture budget 2000 ms, set from a measured ~390 ms for 5 MB (about 5x), env-overridable via GW_SOURCE_BUDGET_MS"

requirements-completed: [SRC-01, SRC-02, SRC-03, SRC-04]
duration: ~9min
completed: 2026-11-13
---

# Phase 4 Plan 1: Source axis Summary

Author corpus to profile plus retrievable chunks: a boundary-aware chunker, a pure stylometry extractor, an offline hashed bag-of-words embedder, an exact-cosine store with validated 0600 persistence, and a SourceManager that redacts secrets from the whole corpus before anything is chunked, embedded or stored.

## Commits
- b2b2598: chunker (+ `unit` on InputTooLargeError)
- a5918f0: stylometry extractor + ProfileError
- e66bd2b: HashEmbedder + InMemoryVectorStore + StoreCorruptError
- 70a98b9: SourceManager + security tests (SRC-04)
- e27b1ef: three author fixtures, integration suite, 5 MB torture test

## Tests
New tests this plan: chunker 30, stylometry 34, store/embedder 58, sourceManager 41, security 14, integration 6, torture 1 (184), plus 7 new cases in errors.test.ts. `scripts/verify.sh`: typecheck ok; smoke 4, unit 552, integration 6, security 235, torture 4, 801/801 passed; `verify: PASS`.

## Torture measurement (plan: "record the number")
5,242,973-character seeded corpus with ~20 planted secrets, real ConfidentialityFilter, default chunking (800/100), 256-d embedder: ingest 389-397 ms over 5 runs (idle 32-core Linux, Node 22); save + load of the 24.4 MB store file 230 ms. Budget set to 2000 ms (about 5x) rather than the plan's 5 s ceiling, so a quadratic regression fails the test.

## Deviations from Plan

### Auto-fixed / additive

**1. [Rule 3 - Blocking] `ProfileError` and `StoreCorruptError` did not exist**
- The task brief and plan name a typed `ProfileError`; neither it nor a store-corruption error was in `errors.ts`.
- Added `ProfileError` (`PROFILE_INVALID`) and `StoreCorruptError` (`STORE_CORRUPT`) to `src/models/errors.ts` with unique-code tests. CONTRACTS.md "Errors" list is now behind the code (see Follow-ups).

**2. [Rule 2 - Missing critical] size/count guards need a unit in the error**
- `InputTooLargeError` hard-coded "characters". Added an optional third `unit` argument (default "characters", backward compatible) so chunk-, author-, vector- and byte-limit violations report accurately.

**3. [Rule 2 - Missing critical] author id, display name and query validation, concurrency, atomicity**
- Not in the plan, required for untrusted input: authorId pattern, displayName length (and display name is itself redacted), k range 1..100, query length cap, serialized ingest/retrieve/remove, "embed everything before touching old data", and cleanup of a half-replaced author if the store rejects the upsert.

**4. [Rule 1 - Bug, found by own test] sentence/segment heuristics**
- First transition-word list included "first"/"next" (matches "the first stage"); removed. Sentence-break regex got a look-behind so a 1 MB run of "." cannot be rescanned from every position (quadratic); covered by a pathological-input test.

**5. Task ordering**: fixtures (plan task 5) shipped with the integration suite in the last commit instead of before SourceManager; SourceManager's own tests use inline text, so no task depended on them.

**6. `PLACEHOLDER_RE` is now exported from `src/filters/confidentiality.ts`** (was module-private) so the stylometry extractor can drop `[REDACTED:*]` tokens instead of duplicating the pattern. Behaviour of the filter is unchanged.

None of STATE.md, ROADMAP.md or REQUIREMENTS.md was touched, per the brief.

## Threat model coverage
- Corpus secrets redacted pre-store: verified for AWS, GitHub, sk-, JWT, Slack, Google, three PEM kinds, boundary-straddling secrets at 40 alignments, zero-width and full-width evasion, blocklist terms, and a secret in the display name. The security tests were checked to fail (13/14) when redaction is bypassed.
- Store file: plaintext by design (documented in the module header), path chosen by caller, written 0600 via temp file + rename (umask-proof, tightens pre-existing 0644 files, replaces rather than follows a symlink at the target).
- Load: file-size cap before read, item/collection/dimension caps, field-level validation, no file content in error messages, state swapped only after full validation.

## Known Stubs
None.

## Follow-ups (not done, outside this plan's contract)
- Profiles are held in `SourceManager` memory only; the store persists chunks, not profiles. The CLI `ingest` then `generate` flow (Phase 5/6) needs a profile persistence step, or `SourceManager` needs an export/import of profiles.
- `.planning/CONTRACTS.md` Errors list should gain `ProfileError(PROFILE_INVALID)` and `StoreCorruptError(STORE_CORRUPT)`, and the CLI exit-code table needs a mapping for them (suggest 2 for ProfileError, 2 for StoreCorruptError).
- `retrieve` embeds the query as given; it relies on the orchestrator having already put user input through the pre-stage confidentiality filter, which matters once a remote embedder replaces `HashEmbedder`.
- `tests/unit/chunker.test.ts` has a deliberately worst-case 1M-chunk test (~2.4 s); lower it if suite time becomes a concern.

## Self-Check: PASSED
All created files exist; commits b2b2598, a5918f0, e66bd2b, 70a98b9, e27b1ef are ancestors of HEAD; `scripts/verify.sh` PASS.
