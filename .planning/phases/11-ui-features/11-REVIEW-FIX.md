---
phase: 11-ui-features
fixed_at: 2026-11-15T00:00:00Z
review_path: .planning/phases/11-ui-features/11-REVIEW.md
iteration: 1
findings_in_scope: 24
fixed: 18
skipped: 6
status: partial
---

# Phase 11: Code Review Fix Report

**Fixed at:** 2026-11-15
**Source review:** .planning/phases/11-ui-features/11-REVIEW.md
**Iteration:** 1

**Scope:** MD-01..MD-10 (required) and LW-01..LW-04, LW-06, LW-08, LW-09, LW-10 (asked for). LW-05, LW-07 and IN-01..IN-04 were left out on purpose (see Skipped).

**Summary:**
- Findings in the review: 24 (MD 10, LW 10, IN 4)
- Fixed: 18 (MD-01..MD-10, LW-01, LW-02, LW-03, LW-04, LW-06, LW-08, LW-09, LW-10), in 18 fix commits plus one follow-up test commit
- Skipped: 6 (LW-05, LW-07 and IN-01..IN-04, all by instruction)

**Where verification ran:** the main checkout (no worktree; `workflow.use_worktrees` was not used because the caller asked to work in place). `scripts/verify.sh` was run at the end from that checkout: PASS, 0 skipped.

**Final gate (scripts/verify.sh):**
- typecheck, ui typecheck, css lint, gen-api drift, license audit: ok
- ui: 441/441 (was 406)
- root: smoke 4, unit 957, integration 295, system 67, security 501, torture 5, all passed, skipped 0
- ui e2e (Playwright): 102/102 (was 98; +4 in the new `token.spec.ts`)
- Visual baselines were NOT regenerated: no screenshot changed beyond the diff threshold. The UI did change intentionally in places not covered by a baseline (Cancel button while busy, caveat when Humanize is on, replace-confirmation on a colliding author id, "why disabled" hint on Score/Humanize, token-form error text).

## Fixed Issues

### MD-01: Generate with humanize shows no weak-scorer caveat
**Files modified:** `ui/src/components/Caveat.tsx` (new, extracted from ScoreScreen), `ui/src/screens/score/ScoreScreen.tsx`, `ui/src/screens/generate/GenerateScreen.tsx`, `ui/tests/component/generate.test.tsx`, `tests/security/ui-score-caveat.test.ts`
**Commit:** 286f285
**Applied fix:** the shared `Caveat` renders on Generate while the humanize switch is on and while a humanized result is on screen (even after the switch is turned off). The root caveat test now asserts both screens use the shared component, which renders the registry constant.

### MD-02: Hard-coded humanize target and maxIterations
**Files modified:** `GenerateScreen.tsx`, `ScoreScreen.tsx`, `ui/tests/component/generate.test.tsx`, `ui/tests/component/score.test.tsx`
**Commit:** f98f05e
**Applied fix:** the fields show `config.humanize.*` once loaded; `target` and `maxIterations` are omitted from the request until the user edits them, so the server's configured defaults apply. The existing Humanize request test now expects the omission.

### MD-03: Clearing a NumberField sends NaN (null)
**Files modified:** `ui/src/components/NumberInput.tsx` (new), `GenerateScreen.tsx`, `ScoreScreen.tsx`, tests
**Commit:** dfd9296
**Applied fix:** `NumberInput` marks an emptied field invalid with a message; Generate and Humanize are not ready (and say so) until it holds a number. Nothing with NaN or null is sent. Note: React Aria commits the cleared value on blur, which the tests reflect.

### MD-04: No cancellation or client timeout
**Files modified:** `ui/src/api/client.ts`, `ui/src/components/useAbortable.ts` (new), `ErrorBanner.tsx`, `errors.ts`, `GenerateScreen.tsx`, `ScoreScreen.tsx`, `AuthorsScreen.tsx`, `ui/tests/component/api.test.tsx`, `ui/tests/component/generate.test.tsx`
**Commit:** 0726f6c
**Applied fix:** `get`/`post` accept `{ signal, timeoutMs }`; default timeout 5 minutes (`CLIENT_TIMEOUT`); cancel ends with `ABORTED` even when a fetch ignores its signal. Generate, Score and Humanize get a Cancel button while busy (focus returns to the submit button); every submit aborts on unmount. A cancel shows as a calm `role=status` notice, not an alert. Ingest aborts on unmount and times out but has no Cancel button (the server may still complete the write). Plain GET loads (`useLoad`) are not aborted on unmount; they are cheap and already drop stale answers.

### MD-05: Generate "Try again" does not reload the config
**Files modified:** `GenerateScreen.tsx`, `generate.test.tsx`
**Commit:** e5afb8e
**Applied fix:** `onRetry` also calls `reloadConfig`. The retry test now runs for authors, personas and config (the config case fails without the fix).

### MD-06: scan-bundle skips slash-bearing base64 secrets
**Files modified:** `scripts/scan-bundle.mjs`, `tests/security/ui-secrets.test.ts`
**Commit:** d36793e
**Applied fix:** the path exemption now needs a file extension or a lowercase-only relative/absolute path; otherwise the token reaches the entropy check. Self-test cases added for a slash-bearing key, one with a leading slash, and an unquoted assignment.

### MD-07: verify.sh runs the bundle scan before dist/ exists
**Files modified:** `scripts/verify.sh`, `tests/helpers/rootBuild.ts` (new), `tests/helpers/staleness.ts` (new), `vitest.config.ts`, `tests/security/ui-secrets.test.ts`
**Commit:** a23677f
**Applied fix:** verify.sh builds `dist/` before the root tests (and the e2e block reuses it). Independently, a vitest global setup rebuilds `dist/` when it is missing or older than `src/` or `config/`, so a bare `npm test` works from a clean checkout (tried with `dist/` deleted). Tests cover the staleness check and that the loaded `dist/` is current.

### MD-08: 401 hint points to the wrong page; rejected token not forgotten
**Files modified:** `ui/src/api/client.ts`, `ui/src/api/capabilities.tsx`, `ui/src/components/errors.ts`, `ui/tests/helpers/screens.tsx`, `api.test.tsx`, `generate.test.tsx`
**Commit:** 7135306
**Applied fix:** any 401 makes the client drop the token (unless a newer one was set meanwhile) and notify `onUnauthorized`; the provider then returns to the token form. Hint reworded. **Behaviour change in tests:** `UNAUTHORIZED` was removed from the shared `TYPED_CODES` banner tables because a 401 no longer leaves a screen showing a banner; dedicated tests cover the 401 on a POST, the forgotten token and recovery with a new one.

### MD-09: Ingest silently replaces an existing author
**Files modified:** `AuthorsScreen.tsx`, `authors.test.tsx`
**Commit:** 0699d77
**Applied fix:** an id that matches a known author shows a warning and Ingest stays disabled until a "Replace the existing author" switch is on; changing the id withdraws the confirmation.

### MD-10: Focus dropped to body after a token is accepted on a gated screen
**Files modified:** `ui/src/components/AuthGate.tsx`, `generate.test.tsx`
**Commit:** 8ccc220
**Applied fix:** after a submitted token opens the gate, focus moves to `main` (always mounted, so no race with the lazy screen chunk) and "Connected" is announced.

### LW-01: Score/Humanize disabled with no reason; config failure silent
**Files modified:** `ScoreScreen.tsx`, `score.test.tsx`
**Commit:** 80823ee
**Applied fix:** config errors show an `ErrorBanner` with Try again; a hint beside the button names why it is off (waiting for limits, empty, over the limit, cleared number).

### LW-02: Tab switch discards the panel's text and result
**Files modified:** `ScoreScreen.tsx`, `ui/src/styles/components.css`, `score.test.tsx`
**Commit:** f36d274
**Applied fix:** both `TabPanel`s use `shouldForceMount`; the idle one is inert and `display: none`. This also keeps a running request alive across a tab switch (relevant after MD-04). The unit tests scope test-id queries to the live panel.

### LW-03: Stale output beside a new error / changed selection
**Files modified:** `GenerateScreen.tsx`, `ScoreScreen.tsx`, `generate.test.tsx`
**Commit:** df6a9d8
**Applied fix:** the result is cleared when a new request starts; the author/persona/author-profile pickers are disabled while busy.

### LW-04: Provider and client edge cases
**Files modified:** `client.ts`, `capabilities.tsx`, `TokenForm.tsx`, `errors.ts`, `api.test.tsx`, `shared.test.tsx`
**Commit:** db86e4d
**Applied fix:** (a) a sequence counter on `reload` drops older answers; (b) only a 429 with code `RATE_LIMITED` is treated as the token lockout (and forgets the held token); other 429s are ordinary errors; (c) a token that fetch cannot send (above U+00FF or a control character) is reported as `BAD_TOKEN` instead of "could not reach the server", in the form and in the client. The form now trims a pasted newline or space (otherwise (c) would have newly rejected tokens that fetch used to accept).

### LW-06: Source-ban checker gaps
**Files modified:** `ui/tests/unit/source-bans.test.ts`
**Commit:** fb484b4
**Applied fix:** added `location.href`/`location =`/`assign`/`replace`, `window.open`, `setAttribute` (URL attributes, handlers, computed names), JSX spreads onto link/image/form-like tags, `import()`/`require` of markup packages and a longer package list; the `#` exemption now accepts only `#${path}` / `#${x.path}`. Each is in the bad-input table.

### LW-08: e2e cannot show the token flow
**Files modified:** `ui/playwright.config.ts` (second webServer), `ui/tests/e2e/server/start.mjs` (`--token-env`, `--lockout-failures`), `ui/tests/e2e/server/constants.mjs`, `ui/tests/e2e/token.spec.ts` (new), `.gitignore`
**Commit:** 27b92a7
**Applied fix:** a second real server requires a token; four serial specs cover the gate and wrong token, the right token (focus, announcement, full flow), a mid-session 401, and the lockout (even the right token is refused). Each checks that the token appears only in the `Authorization` header of `/api/` requests and not in the URL, storage, cookies, DOM, response bodies or console.

### LW-09: Stale ui/dist used by the root tests
**Files modified:** `tests/helpers/uiBuild.ts`, `scripts/scan-bundle.mjs`, `tests/security/ui-secrets.test.ts`
**Commit:** 5abeb8d
**Applied fix:** rebuild when anything under `ui/` source is newer than `ui/dist/index.html`; comment corrected. **Two things found on the way:** the child build must not inherit vitest's `NODE_ENV=test` (it bundled React's development build), so the setup now passes `NODE_ENV=production`; and that dev bundle exposed an exponential-backtracking regex in `scan-bundle`'s `benign()` (the scan ran for over two minutes). It is replaced by a linear check, with a regression test; the old regex hangs on the new test.

### LW-10: Error announced twice
**Files modified:** `ScoreScreen.tsx`, `AuthorsScreen.tsx`, `GenerateScreen.tsx`, `generate.test.tsx`, `score.test.tsx`
**Commit:** 20a1434
**Applied fix:** a failed submit clears the live region instead of announcing the code again; the `role=alert` banner says it once. The separate `role=status` loading placeholders were left as they are.

### Follow-up: e2e specs
**Files modified:** `ui/tests/e2e/keyboard.spec.ts`, `ui/tests/e2e/screens-a11y.spec.ts`
**Commit:** 7875f9b
**Applied fix:** adjusted to LW-10 (assert the alert, empty live region) and LW-02 (two `unavailable` notes now exist; the idle one is hidden).

## Skipped Issues

### LW-05: Ingest input checks narrower than the server's rules
**File:** `ui/src/screens/authors/AuthorsScreen.tsx:60-82`
**Reason:** skipped by instruction. It needs `maxCorpusChars` exposed in the config view (a server and OpenAPI change) to be more than a partial fix.
**Original issue:** NUL/control-character checks missing on pasted text and the name; no pre-check against the corpus cap.

### LW-07: ui-secrets comment stripper can hide a storage use
**File:** `tests/security/ui-secrets.test.ts:36`
**Reason:** skipped by instruction. Not attempted.
**Original issue:** `//` inside a string truncates the rest of the line before the storage check.

### IN-01..IN-04
**Reason:** info-level, outside the requested scope (fix scope was critical+warning). Not attempted: stale manifest header path (IN-01), parity test greps raw text (IN-02), small code-quality items (IN-03), `fmt` precision (IN-04).

## Notes for a later look

- Plain `useLoad` GET requests are still not aborted on unmount.
- Ingest has no Cancel button by design (see MD-04).
- The password field in the token form keeps a rejected token's text so the user can correct a typo; the token is not held anywhere else. The e2e check excludes input values for that reason.

---

_Fixed: 2026-11-15_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
