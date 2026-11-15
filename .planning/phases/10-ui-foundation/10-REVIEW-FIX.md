---
phase: 10-ui-foundation
fixed_at: 2026-11-15T00:00:00Z
review_path: .planning/phases/10-ui-foundation/10-REVIEW.md
iteration: 1
findings_in_scope: 12
fixed: 10
skipped: 2
status: partial
---

# Phase 10: Code Review Fix Report

**Source review:** `.planning/phases/10-ui-foundation/10-REVIEW.md`
**Scope:** MD-01, MD-02, LW-01, LW-02, LW-04, LW-05, LW-06, LW-07, LW-09, LW-10 (requested). LW-03, LW-08 and IN-01..04 were deferred by request.
**Verification ran in:** the main checkout (no worktree). `scripts/verify.sh` passes: typecheck ok; ui typecheck, css lint and license audit ok; root tiers smoke 4/4, unit 957/957, integration 291/291, system 67/67, security 472/472, torture 5/5, skipped 0; ui 167/167; ui e2e 34/34.

## Fixed Issues

### MD-01: symlinked `index.html` escapes the root
**Files:** `src/api/static.ts`, `tests/helpers/uiFixture.ts`, `tests/unit/api/static.test.ts`
**Commit:** 94e4a6b
**Fix:** `locate()` now `realpath`s the implicit directory index and re-checks the root prefix; `hasBuiltUi()` resolves the real root and requires the real `index.html` inside it (so `createStaticHandler` refuses a symlinked root index). Tests: fixture `sub2/index.html -> secret` (GET `/sub2/` and `/sub2` no longer leak; they fall back to the SPA shell, `/sub2/index.html` is 404) and a scratch root whose `index.html` is a symlink out (`hasBuiltUi` false, handler refused). Both new cases were confirmed failing before the fix.

### MD-02: rejected token resent on every request
**Files:** `ui/src/app/pages/Overview.tsx`, `ui/tests/component/api.test.tsx`
**Commit:** b70d28f
**Fix:** `api.setToken(undefined)` on 401 before showing the form. Test: wrong token, navigate to Kitchen sink and back, assert no later request carries `Authorization`. Confirmed failing before the fix. The 429 branch is unchanged (the review only asked for 401).

### LW-01: immutable cache heuristic
**Files:** `src/api/static.ts`, `tests/helpers/uiFixture.ts`, `tests/unit/api/static.test.ts`
**Commit:** 0f2dc8c
**Fix:** The pattern is tested against the requested last segment (not the real path) and tightened to Vite's 8-character hash. Test covers `font-regular.woff2`, `my-notes.txt` and a symlink `plain.js -> app-AbCdEf12.js`, all `no-store`.

### LW-02: open/read failure destroyed the connection
**Files:** `src/api/static.ts`, `tests/helpers/uiFixture.ts`, `tests/unit/api/static.test.ts`
**Commit:** 1783caa
**Fix:** `fs.promises.open` plus `fh.stat()` before any header; open failure or a non-file returns "not handled" (404); `Content-Length` comes from the handle and the stream is bounded to that size. Test uses a `chmod 000` asset. When the test user bypasses file modes (root) the file is readable and the test expects 200, so it never skips.

### LW-04: `serve` UI setup
**Files:** `src/cli/serve.ts`, `tests/system/surfaces.test.ts`
**Commit:** ff9c096
**Fix:** `--no-ui` with `--ui-dir` is a `ConfigError`; an unservable default UI directory now prints a stderr note with the error code. The existing `--no-ui` system test no longer passes `--ui-dir`. Test: new system test for the conflicting flags (confirmed failing before). The default-directory note is not unit-tested (it needs a corrupted `ui/dist`); `mcp --http` wording was not changed (the review called its behavior correct).

### LW-05: release package ships no UI build
**Files:** `package.json`, `scripts/check-ui-dist.mjs` (new), `tests/unit/prepack.test.ts` (new)
**Commit:** 0e459da
**Fix:** `prepack` runs `npm run build && npm run ui:build && node scripts/check-ui-dist.mjs`; the check exits 1 without `ui/dist/index.html`. Tests assert the script chain and the check's pass/fail behavior. `npm pack` itself was not run.

### LW-06: focus and nested live regions in the token form
**Files:** `ui/src/app/pages/Overview.tsx`, `ui/tests/component/api.test.tsx`
**Commit:** 7dd2f28
**Fix:** The form stays mounted while a token is checked (button `isPending`, "Checking..."); resubmits are ignored while busy; focus moves to the "Server" heading when the result replaces the form; `aria-live` removed from the card (the specific `role=status` / `role=alert` elements remain). Test covers all three.

### LW-07: malformed hashes rendered Overview
**Files:** `ui/src/app/route.ts`, `ui/tests/component/shell.test.tsx`
**Commit:** 3d64605
**Fix:** Only `''`, `#`, `#/...` and the skip target `#main` map to a page; anything else maps to a route that matches nothing, so the not-found page renders with no nav item current. A `hashchange` to `#main` keeps the current page. The test now expects `#/<script>` and `#//evil.example` to be not-found (they were Overview).

### LW-09: SPDX classifier failed open on parentheses
**Files:** `ui/build/licenses.mjs`, `ui/tests/build/licenses.test.ts`
**Commit:** 84960e9
**Fix:** A small recursive-descent parser (AND binds tighter than OR, parentheses group, `WITH` judged by the license id, malformed input rejected). `(MIT OR GPL-3.0) AND LGPL-3.0` now fails on the LGPL. No new dependency.

### LW-10: border contrast and offline scanner blind spot
**Files:** `ui/src/theme/contrast.ts`, `ui/tests/unit/contrast.test.ts`, `ui/tests/build/offline.test.ts`
**Commits:** 9e2eb9d (border), 7bb6bdf (scanner)
**Fix (judgment call, needs a human look):** The review's own fix offers "pairs at 3:1 only for controls that rely on it, or document the exemption". Shipped borders measure 1.20 to 1.39 against the surfaces, and every border is decorative or on a text-labelled control, so a 3:1 pair would fail both themes and force a palette and snapshot change. Instead, `--gw-border` gets a 1.1 floor pair (it cannot become invisible) and the exemption is documented in `contrast.ts`, with controls that rely on a border alone directed to `--gw-accent` (3:1). The `ContrastPair.min` type gained `1.1`. Scanner: protocol-relative URLs in JS strings (`fetch("//host.tld/x")`, `import(...)`, `new Worker(...)`) are flagged in `.js` files, with the run-time-built `data:`/`blob:` blind spot noted in a comment.

## Skipped Issues

### LW-03: `.md` content type and license discoverability
**File:** `src/api/static.ts:42-53`; `ui/src/app/Shell.tsx:53-55`
**Reason:** Deferred by request (out of the requested set).

### LW-08: `zod` listed under production dependencies
**File:** `ui/package.json:21`; `ui/src/theme/contract.ts:5`
**Reason:** Deferred by request (out of the requested set).

### IN-01..IN-04
**Reason:** Deferred by request (info findings, not trivial enough to bundle in): `transformIndexHtml` silent no-op, `<noscript>` and `color-scheme` meta, Windows ADS segments and iOS e2e, `Permissions-Policy` / `Cross-Origin-Opener-Policy` headers and neutral 429 wording.

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
