---
phase: 04-source-axis
verified: 2026-11-13T12:00:00Z
status: passed
score: 3/3 must-haves verified
covered_files:
  - ".planning/phases/04-source-axis/04-01-PLAN.md"
  - ".planning/phases/04-source-axis/04-01-SUMMARY.md"
  - "src/embedding/hashEmbedder.ts"
  - "src/filters/confidentiality.ts"
  - "src/index.ts"
  - "src/ingestion/chunker.ts"
  - "src/ingestion/stylometry.ts"
  - "src/models/errors.ts"
  - "src/models/types.ts"
  - "src/registry/sourceManager.ts"
  - "src/store/inMemoryVectorStore.ts"
  - "tests/fixtures/authors/bulleted-executive.txt"
  - "tests/fixtures/authors/terse-technical.txt"
  - "tests/fixtures/authors/verbose-hedging.txt"
  - "tests/integration/source.test.ts"
  - "tests/security/source-secrets.test.ts"
  - "tests/torture/source-torture.test.ts"
  - "tests/unit/chunker.test.ts"
  - "tests/unit/errors.test.ts"
  - "tests/unit/sourceManager.test.ts"
  - "tests/unit/store.test.ts"
  - "tests/unit/stylometry.test.ts"
covered_digest: "v3:sha256:e266c16fd38bc9a31a46eec278db4829a0d9a4e36ee46d39d37bede06e90dd24"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 4: Source axis Verification Report

**Phase Goal:** Turn an author's corpus into a `StylometricProfile` plus retrievable exemplar chunks (ROADMAP: "Chunker, stylometry, embedder, vector store, source manager"). Success criterion 4: "A 3-author fixture corpus yields distinct, stable profiles; retrieval top-k deterministic."
**Verified:** 2026-11-13
**Status:** passed
**Re-verification:** No, initial verification. It covers the code after review fixes CR-01..04 and WR-05 (commits 76541fd..e9e4366), HEAD 30dce49.

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | 3-author fixture corpus gives distinct, stable profiles (ROADMAP SC4, plan truth 1) | VERIFIED | Probe against built `dist/`: terse/verbose/bulleted ingested through the real confidentiality pipeline. Pairwise they differ on 5, 6 and 6 numeric metrics (plan asks >= 2). Two independent managers gave byte-identical `listAuthors()`. Re-ingesting the same text gave an identical profile. `tests/integration/source.test.ts` asserts the same. |
| 2 | Retrieval deterministic, top-k (ROADMAP SC4, plan truth 2) | VERIFIED | Same probe: `retrieve(id, query, 5)` for all three authors returned identical ids and scores across two managers. The full probe output hash was identical across two separate node processes (`01a33553...`). Ties break by chunk id ascending (CR-02 made the comparator a strict order over finite scores). No cross-author hit in any result. |
| 3 | Secrets never reach the store (plan truth 3, SRC-04) | VERIFIED | Probe corpus planted an `AKIA...` key, an RSA PEM block, a `ghp_` token and a zero-width-split `AKIA` key. After `store.save()`, the file (mode 0600, 8632 bytes) contained none of them. The profile JSON and `retrieve()` results were clean. A `ghp_`-shaped `authorId` was refused with `ConfigError` and the id was absent from the message. Redaction runs on the whole corpus before chunking, so boundary-straddling secrets are one match. `tests/security/source-secrets.test.ts` (part of the 241 security tests) covers the same. |
| 4 | A failed re-ingest keeps the prior author (CR-01 guarantee, not a plan truth) | VERIFIED | Probe: store capped at 30 items, author `a` ingested, then an oversize re-ingest. It threw `InputTooLargeError`; the profile and the retrieval results were byte-identical to before. `SourceManager` uses the atomic `replaceCollection`. |

**Score:** 3/3 plan truths verified (the fourth row is an extra probe). None are behavior-unverified.

Plan test matrix, spot-checked against the suites (all present and passing in the gate): chunker (30 tests, incl. hard-cut, CRLF, surrogates, `overlap>=size`), stylometry (finite metrics, `ProfileError` on empty), embedder determinism and zero-vector handling, store (top-k, replace, save/load round trip, corrupt file), integration (6), security, `remove`/re-ingest replace, torture 5 MB.

## Required Artifacts

| Artifact | Status | Details |
|---|---|---|
| `src/ingestion/chunker.ts` (108 lines) | VERIFIED | Real implementation. Exported as `chunk` from `src/index.ts`. |
| `src/ingestion/stylometry.ts` (154 lines) | VERIFIED | `extractProfile`, `vectorCollectionName`. Exported. |
| `src/embedding/hashEmbedder.ts` (53 lines) | VERIFIED | `HashEmbedder` (256-d default). Exported. |
| `src/store/inMemoryVectorStore.ts` (306 lines) | VERIFIED | Cosine, `save`/`load`, `replaceCollection`, shared `chunkProblem`. Exported. |
| `src/registry/sourceManager.ts` (202 lines) | VERIFIED | `ingest`, `getProfile`, `listAuthors`, `retrieve`, `remove`. Exported. |
| `tests/fixtures/authors/*.txt` (3 authors) | VERIFIED | Present and consumed by `tests/integration/source.test.ts`. |
| Tests: unit (chunker, stylometry, store, sourceManager), integration, security, torture | VERIFIED | Present and passing. |

Level 3/4: `SourceManager` is wired to the real `FilterPipeline`/`ConfidentialityFilter`, `HashEmbedder` and `InMemoryVectorStore` in the probe, and real corpus text reaches profiles, chunks and the saved file. The constructor refuses a pipeline with no `confidentiality` filter, and `#redact` fails closed if the filter did not run without error.

## Behavioral Spot-Checks and Gate

| Behavior | Command | Result | Status |
|---|---|---|---|
| Build | `npm run build` | exit 0 | PASS |
| Gate | `scripts/verify.sh` | `verify: PASS`. smoke 4/4, unit 582/582, integration 6/6, system 0 tests, security 241/241, torture 4/4 (837 vitest tests in 19 files) | PASS |
| Distinct, stable profiles; deterministic retrieval | node probe over `dist/src/index.js`, run twice in separate processes | identical output hash; see truths 1 and 2 | PASS |
| Planted secrets absent from saved store | same probe | see truth 3 | PASS |
| Failed re-ingest keeps prior author | same probe | see truth 4 | PASS |
| 5 MB torture | `vitest run tests/torture/source-torture.test.ts` | pass; documented measurement 389-397 ms against a 2000 ms budget (the plan asked for < 5 s) | PASS |

Probe execution: no `scripts/*/tests/probe-*.sh` declared or present.

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| SRC-01 | 04-01 | Chunker splits on paragraph/sentence boundaries with size cap and overlap | SATISFIED | `chunker.ts` plus 30 unit tests. |
| SRC-02 | 04-01 | Stylometry extractor produces a `StylometricProfile` | SATISFIED | Truth 1. |
| SRC-03 | 04-01 | `SourceManager` CRUD for profiles and chunks into `VectorStore`; top-k retrieval | SATISFIED | Truths 1, 2 and 4. `remove` and ingest-twice-replaces are unit-tested. |
| SRC-04 | 04-01 | Corpus passes the confidentiality filter before storage | SATISFIED | Truth 3. |

All four IDs are declared in the PLAN and mapped to Phase 4 in REQUIREMENTS.md. No orphaned requirements. Note that the REQUIREMENTS.md checkboxes for SRC-01..04 are still unticked (`[ ]`); that is bookkeeping, not code.

## Anti-Patterns Found

None. No TBD/FIXME/XXX/TODO/HACK markers in the Phase 4 source files. No stubs or empty implementations.

## Warnings and Info (not gaps)

- **Open review items, deliberately out of fix scope:** WR-06 (`load` does not check file mode or ownership, so a world-writable or foreign file is accepted and its text is not re-redacted). WR-07 (`store.load()` is not coordinated with the manager queue, and profiles are memory-only: after a restart plus `load`, `retrieve` throws `UnknownAuthorError`, and there is no restore API). IN-01..IN-04 (exported shared `/g` regex, the constructor checks the filter by name only, a hung embedder blocks the queue, `authorId` filtering happens after the top-k cut). WR-06 and WR-07 are real but concern cross-process persistence, which no Phase 4 criterion requires. They should be resolved in Phase 5 before the CLI persists anything.
- **Store contract extended (CR-01):** `replaceCollection` is optional on `VectorStore`. A store without it falls back to delete-then-upsert, where a failure drops the author. This is documented and tested.
- **Not done in WR-05:** a cap on total `items x dim` components.
- **Accepted risk (from the plan):** hashed bag-of-words retrieval is weak semantically. The `Embedder` interface is the seam for v2. The store file is plaintext at 0600.
- **Untested:** Node 20 behavior (only a newer Node is available locally).
- **Working tree:** only untracked `.planning/config.json` and `.planning/state.json`. The branch is `gsd/phase-01-foundation` and is not merged to `main`. The src and tests diff against HEAD is empty, so the fingerprint above matches the committed code.

## Gaps Summary

No gaps. The phase goal is achieved: `npm run build && scripts/verify.sh` is green at HEAD 30dce49, and all three must-have truths and ROADMAP criterion 4 are backed by passing tests plus direct probes against the built output.

---

_Verified: 2026-11-13_
_Verifier: Claude (gsd-verifier)_
