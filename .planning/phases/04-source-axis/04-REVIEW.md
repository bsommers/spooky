---
phase: 04-source-axis
reviewed: 2026-11-13T00:00:00Z
depth: standard
files_reviewed: 8
files_reviewed_list:
  - src/ingestion/chunker.ts
  - src/ingestion/stylometry.ts
  - src/embedding/hashEmbedder.ts
  - src/store/inMemoryVectorStore.ts
  - src/registry/sourceManager.ts
  - src/models/errors.ts
  - src/filters/confidentiality.ts
  - src/index.ts
findings:
  critical: 0
  high: 1
  medium: 3
  low: 3
  info: 4
  total: 11
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-11-13
**Depth:** standard
**Files Reviewed:** 8 source files (diff 5a346d9..4d3ecfd); tests read for coverage gaps only
**Status:** issues_found

## Summary

Confidentiality ordering is sound: redaction runs on the whole corpus and on `displayName` before profile, chunk, embed and store. The trace check fails closed. Contract conformance with `src/models/types.ts` is good (profile fields, `Chunk`, `ScoredChunk`, `VectorStore`, `Embedder`). Probed by running the sources:

- **Chunker:** 3000 random inputs (surrogates, NBSP, CJK, newlines, random size and overlap) produced no lone surrogate, no chunk longer than `size+1`, no infinite loop and no lost head or tail.
- **Stylometry:** no NaN or Infinity for any non-empty corpus. 2-3M-character adversarial inputs (dot runs, `.)` runs, "really " runs, whitespace runs, newline-space runs) all ran in under 110 ms, so no quadratic regex.
- **Save path:** temp file opened `wx` 0600, then rename, so a symlink at the target is replaced and not followed.
- **Load path:** the file is validated before the swap and its messages carry no content.

The defects are in failure atomicity, in score arithmetic at extreme magnitudes, and in places where untrusted identifiers or chunk fields bypass the redaction and validation guarantees.

## High

### CR-01: A failed ingest destroys the author's existing data, contradicting the documented guarantee

**File:** `src/registry/sourceManager.ts:362-371` (doc at 328-331)
**Issue:** The doc comment promises "a rejected ingest leaves the author as it was". `deleteCollection` runs first, and `upsert` can then reject for predictable reasons: `maxItems` in the store, a dimension mismatch, or a store I/O error. The catch block then deletes the collection and the profile, so the old data is lost. Verified: an author with 10 chunks was re-ingested with a corpus that produces 25 chunks against `maxItems: 20`. The call threw `InputTooLargeError`, and the old author was gone (`getProfile` threw `UnknownAuthorError`). A caller who re-ingests an updated corpus loses the working corpus on a capacity error.
**Fix:** Do not delete first. Upsert the new chunks, then remove stale ids. Either add an optional store method (for example `replaceCollection(name, items)`, atomic: build a new `Collection`, check capacity net of the old collection's size, then swap), or in the manager upsert under a staging name and swap. Add a test that re-ingests an oversize corpus over an existing author and asserts the old chunks are still retrievable. If atomic replace is deferred, correct the doc comment.

## Medium

### CR-02: Cosine score is NaN or wrong for large or small magnitudes, and NaN corrupts the ordering

**File:** `src/store/inMemoryVectorStore.ts:41-45, 115-122`
**Issue:** `norm` squares the components, which overflows to `Infinity` at about 1e154 and underflows to 0 at about 1e-162. `toVector` only checks `Number.isFinite`. Verified results:

- Stored `[1e200,1e200]`, query `[1e200,1e200]`: score `NaN` (`Infinity/Infinity`).
- Stored `[1e200,1e200]`, query `[1,1]` (the same direction): score `0`.
- Underflowed vectors are treated as zero vectors.

The sort comparator `b.score - a.score || compareIds` falls through to the id comparison when either score is `NaN`. That makes the comparator non-transitive, so the order depends on insertion order. This is the same defect as Phase 3 CR-03, and `NaN` scores are returned to the caller. The hostile source is a loaded store file or a custom `Embedder`. `HashEmbedder` output is normalized and safe.
**Fix:** Compute the norm with scaling (divide by the max absolute component first), or reject components with `Math.abs(x) > 1e150` in `toVector` and in `#validate`. Clamp the score to `[-1,1]` and force `Number.isFinite(score) ? score : 0`. Add tests with `1e200` and `1e-200`.

### CR-03: A secret-shaped `authorId` is never redacted and reaches the store, the file, and error messages

**File:** `src/registry/sourceManager.ts:284, 337, 352, 401, 414`; `src/ingestion/stylometry.ts:131-133`; `src/models/errors.ts:48`
**Issue:** `AUTHOR_ID` allows 64 characters of `[A-Za-z0-9._-]`. That admits `AKIAIOSFODNN7EXAMPLE` and `ghp_` plus 36 characters. The id is not passed through the confidentiality filter, unlike `displayName`. Verified: `ingest('AKIAIOSFODNN7EXAMPLE', …)` is accepted. The value then appears in the following places:

- `profile.authorId`
- `profile.vectorCollectionName` (`author/AKIA…`)
- every chunk id and `chunk.authorId`
- the plaintext store file
- `UnknownAuthorError.message` (`unknown author "ghp_aaaa…"`), which `retrieve` and `remove` throw for any caller-supplied string

This breaks the SRC-04 property "zero matches in store dump" for ids, and puts the secret in logs.
**Fix:** In `#checkAuthorId`, reject ids that the confidentiality filter would modify (run `#redact` on the id and compare). Alternatively restrict the id to a conservative pattern and a shorter length. In `UnknownAuthorError`, truncate the id or reduce it to its length plus a hash prefix. Add a security test with a planted key as the id.

### CR-04: `upsert` does not validate chunk fields, so a store that was accepted can be saved but never loaded

**File:** `src/store/inMemoryVectorStore.ts:73-84` versus `227-231`
**Issue:** `upsert` checks only `chunk.id === id` and the vector. `#validate` on load demands that `authorId` and `text` are strings and that `index` is a non-negative integer. Verified: an upsert with `chunk = {id:'x',authorId:'a'}` (no `text`) succeeds. `save` then writes the file (the `text` key is dropped by `JSON.stringify`), and `load` throws `StoreCorruptError` on it. A single bad item makes the whole persisted store, every author, unrecoverable. `query` also returns `text: undefined`, which violates `Chunk`.
**Fix:** Run the same chunk validation in `upsert`, sharing one `validateChunk(chunk, id)` helper with `#validate`. Add a save/load round-trip test with an invalid chunk.

## Low

### WR-05: Save and load limits are not symmetric, and total vector memory is not capped

**File:** `src/store/inMemoryVectorStore.ts:66-69, 94, 141, 170`
**Issue:** `load` rejects files larger than 256 MiB, but `save` has no cap. With `maxItems=200,000` and normalized float vectors (about 19 characters per component in JSON), a store of about 50,000 chunks at dim 256 reaches the 256 MiB limit. Anything larger is writable and not loadable. `JSON.stringify` also throws `RangeError: Invalid string length` beyond about 512 MiB. `maxItems` bounds the item count but not `items × dim`: `HashEmbedder` allows dim 65,536, giving about 105 GB of `Float64Array` at the default item cap. Loading expands the data about 8-10 times in memory (text, parsed arrays, `Float64Array`).
**Fix:** Cap `items × dim` on `upsert` and `load` (for example `maxTotalComponents`). Make `save` reject, with `InputTooLargeError`, any serialized size above `maxFileBytes`, before it writes. Alternatively stream the output.

### WR-06: `load` does not check the file mode or ownership, and `save` leaves existing directory permissions as they are

**File:** `src/store/inMemoryVectorStore.ts:143, 167-171`
**Issue:** The plan's threat model says the file is plaintext with `0600` permissions. `save` enforces 0600, but `load` accepts a world-writable or foreign-owned file. Poisoned chunks then flow into the prompts as exemplars. `mkdir({mode:0o700})` applies only to directories it creates. The temp file is fsynced, but the parent directory is not, so the rename is not crash-durable. Loaded text is also not re-redacted, so a store file produced by another tool can carry secrets into retrieval results.
**Fix:** In `load`, `stat` the file and reject (or warn) when `st.mode & 0o022` is set, or when `st.uid !== process.getuid()` on POSIX. Optionally fsync the directory after `rename`. Document that load trusts only the file's structure, not its content.

### WR-07: `save` and `load` bypass the manager's serialization and orphan its profiles

**File:** `src/registry/sourceManager.ts:304-309, 426-430`; `src/store/inMemoryVectorStore.ts:131-180`
**Issue:** `store.load()` replaces all collections at once, with no coordination with the manager queue. A `load` that overlaps an in-flight `ingest` silently discards that ingest's upserts. The manager's `#profiles` map is memory-only. After a restart plus `load`, `retrieve` throws `UnknownAuthorError` for every author whose chunks are in the store, and there is no API to rebuild a profile from stored chunks. The file header says profile persistence is the caller's job, but the public API gives callers no way to do it (no `registerProfile` or `restoreProfile`).
**Fix:** Expose `SourceManager.persist(path)` and `SourceManager.restore(path)` that run through `#serial`, and persist profiles alongside the chunks. Alternatively export a profile import method and document the required order.

## Info

### IN-01: `PLACEHOLDER_RE` is now an exported shared `/g` regex

**File:** `src/filters/confidentiality.ts:44`
**Issue:** `String.replace` and `matchAll` are safe with a global regex, but any consumer that calls `.test()` or `.exec()` on this shared instance inherits stale `lastIndex` state.
**Fix:** Export a factory (`placeholderRe()`) or a non-global source string.

### IN-02: `SourceManager` constructor only checks the filter name, not that the filter is fail-closed or active at the `pre` stage

**File:** `src/registry/sourceManager.ts:307`
**Issue:** The runtime trace check in `#redact` (lines 379-381) does fail closed on every ingest, so this is not exploitable. A misconfigured pipeline still passes construction and then fails on every ingest. A filter that is named `confidentiality` but does nothing is also accepted.
**Fix:** Require `pipeline` to have been built with `requireConfidentiality: true` and `stage: 'pre'`, or probe it in the constructor.

### IN-03: A hung embedder or store blocks the whole serialization queue

**File:** `src/registry/sourceManager.ts:426-430`
**Issue:** A single promise that never settles stalls every later `ingest`, `retrieve` and `remove`. A synchronous ingest of up to 10 M characters (redaction, profile, chunking) blocks the event loop in the same way.
**Fix:** Add an optional per-operation timeout or `AbortSignal` for the embed and store awaits. Document the 10 M default as a blocking cost.

### IN-04: `retrieve` filters by `authorId` after taking the top `k`, so a mislabelled chunk can shrink the result

**File:** `src/registry/sourceManager.ts:406-407`
**Issue:** Isolation is correct. Per-author collections plus the `authorId` filter mean another author's chunk is never returned. For a loaded (untrusted) file whose collection holds chunks that carry a different `authorId`, the filter runs after `k` was applied, so the result can silently be shorter than `k`. The chunker's `maxChunks` guard is applied only on the manager path. The public `chunk()` export has `O(n*size/stride)` cost when `overlap` is close to `size`, and no cap if `maxChunks` is omitted.
**Fix:** Query `k` plus a margin, or have the store filter on `chunk.authorId`. Document that `maxChunks` should always be passed for untrusted text.

---

_Reviewed: 2026-11-13_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
