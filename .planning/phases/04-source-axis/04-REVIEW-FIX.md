---
phase: 04-source-axis
fixed_at: 2026-11-13T00:00:00Z
review_path: .planning/phases/04-source-axis/04-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 04: Code Review Fix Report

**Fixed at:** 2026-11-13
**Source review:** .planning/phases/04-source-axis/04-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5 (CR-01..04 and WR-05, as requested)
- Fixed: 5
- Skipped: 0
- Out of scope, untouched: WR-06, WR-07 (Phase 5 scope), IN-01..IN-04

**Verification:** `scripts/verify.sh` ran after every fix and ended PASS each time. Final run: smoke 4, unit 582, integration 6, security 241, torture 4. It ran in the main checkout (`gsd/phase-01-foundation`), not an isolated worktree: the caller required the gate after each fix and a worktree has no `node_modules`; the caller was waiting synchronously, so there was no foreground session to race. Nothing was pushed.

## Fixed Issues

### CR-01: A failed ingest destroys the author's existing data

**Files modified:** `src/store/inMemoryVectorStore.ts`, `src/models/types.ts`, `src/registry/sourceManager.ts`, `tests/unit/sourceManager.test.ts`, `tests/unit/store.test.ts`
**Commit:** 76541fd
**Applied fix:** New optional `VectorStore.replaceCollection(name, items)`, implemented atomically in `InMemoryVectorStore`: the batch is validated and the new collection built first, capacity is checked net of the collection being replaced, and only then is it swapped in. `SourceManager` uses it, so a capacity, dimension or store I/O rejection leaves the old chunks and profile untouched. Stores without the method fall back to delete-then-upsert (documented; a failure there still drops the author). Tests: oversize re-ingest keeps profile and retrieval results, a store I/O failure keeps them, the fallback path is pinned, and `replaceCollection` has unit tests (exact replace, net capacity, validation failure, empty items). The old test that asserted the destructive behavior was rewritten for the fallback store. Status: fixed, requires human verification (store contract extended).

### CR-02: Cosine score NaN or wrong at extreme magnitudes

**Files modified:** `src/store/inMemoryVectorStore.ts`, `tests/unit/store.test.ts`
**Commit:** 5e2dff3
**Applied fix:** Entries keep `max` (largest absolute component) and `snorm` (norm of `v/max`); the cosine sums `(a_i/amax)*(b_i/bmax)` and divides by `asnorm*bsnorm`, so nothing is squared at its raw magnitude. Scores are forced finite and clamped to [-1, 1], and the comparator is a plain strict order over finite scores (no `||` fall-through). Non-finite vectors were already rejected in `upsert` and `query`, and now `load` is tested with an `Infinity` literal. Tests: scales 1e200, 1e308, 1e-200, 5e-324 and 1e-320 score 1 against any rescaling, opposite and orthogonal directions, insertion-order independence with mixed magnitudes, a huge query, non-finite rejection. Status: fixed, requires human verification (scoring arithmetic).

### CR-03: Secret-shaped `authorId` reached the store, the file and error messages

**Files modified:** `src/registry/sourceManager.ts`, `src/models/errors.ts`, `tests/security/source-secrets.test.ts`
**Commit:** fd5aa17
**Applied fix:** `ingest` runs the id through the confidentiality pipeline and rejects with `ConfigError` (value withheld) if redaction would change it, before any embedding or storage. `UnknownAuthorError` no longer echoes the id: the message carries the id's length and a sha256 prefix, and the `authorId` property is non-enumerable (still readable, absent from JSON). Tests: aws, ghp, sk and slack shaped ids are rejected and reach no store, embedder, saved file or error JSON; a blocklisted id is rejected; an ordinary id works; retrieve, remove and getProfile errors do not echo a ghp-shaped id. Status: fixed, requires human verification.

### CR-04: `upsert` did not validate the chunk shape `load` requires

**Files modified:** `src/store/inMemoryVectorStore.ts`, `tests/unit/store.test.ts`
**Commit:** e966b06
**Applied fix:** A single `chunkProblem(chunk, id)` helper now backs both `upsert`/`replaceCollection` (TypeError) and `load` (StoreCorruptError), so the two cannot drift. Existing load error messages are unchanged. Tests: eleven malformed chunk shapes are rejected by both write paths with nothing stored, and a save/load round trip shows an invalid item can no longer poison the persisted file.

### WR-05: `save` did not enforce the caps `load` enforces

**Files modified:** `src/store/inMemoryVectorStore.ts`, `tests/unit/store.test.ts`
**Commit:** e9e4366
**Applied fix:** Before touching the filesystem, `save` rejects with `InputTooLargeError` when collections exceed `maxCollections`, vectors exceed `maxItems`, the serialized size exceeds `maxFileBytes`, or `JSON.stringify` hits the engine string limit. A rejected save creates no directory or temp file and leaves an existing target intact. Tests: oversize save with an existing file preserved, a file at exactly `maxFileBytes` loads back, too many collections. Not done: a cap on total `items x dim` components (the review's optional first suggestion) is left open.

## Skipped Issues

None. WR-06, WR-07 and IN-01..IN-04 were excluded from scope by request and not attempted.

---

_Fixed: 2026-11-13_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
