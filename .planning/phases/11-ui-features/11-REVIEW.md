---
phase: 11-ui-features
reviewed: 2026-11-15T00:00:00Z
depth: standard
files_reviewed: 48
files_reviewed_list:
  - scripts/scan-bundle.mjs
  - scripts/verify.sh
  - package.json
  - tests/integration/ui-parity.test.ts
  - tests/security/ui-csp.test.ts
  - tests/security/ui-score-caveat.test.ts
  - tests/security/ui-secrets.test.ts
  - tests/helpers/uiBuild.ts
  - ui/playwright.config.ts
  - ui/scripts/gen-api.mjs
  - ui/src/api/capabilities.tsx
  - ui/src/api/client.ts
  - ui/src/api/operations.ts
  - ui/src/app/App.tsx
  - ui/src/app/Shell.tsx
  - ui/src/app/pages/Overview.tsx
  - ui/src/app/route.ts
  - ui/src/components/Announcer.tsx
  - ui/src/components/AuthGate.tsx
  - ui/src/components/Bars.tsx
  - ui/src/components/CopyButton.tsx
  - ui/src/components/ErrorBanner.tsx
  - ui/src/components/Picker.tsx
  - ui/src/components/PlainText.tsx
  - ui/src/components/Section.tsx
  - ui/src/components/TextInput.tsx
  - ui/src/components/TokenForm.tsx
  - ui/src/components/Trace.tsx
  - ui/src/components/errors.ts
  - ui/src/components/useLoad.ts
  - ui/src/screens/authors/AuthorsScreen.tsx
  - ui/src/screens/generate/GenerateScreen.tsx
  - ui/src/screens/personas/PersonasScreen.tsx
  - ui/src/screens/score/ScoreScreen.tsx
  - ui/src/screens/score/caveat.ts
  - ui/src/screens/settings/SettingsScreen.tsx
  - ui/tests/unit/source-bans.test.ts
  - ui/tests/build/perf.test.ts
  - ui/tests/component/shared.test.tsx
  - ui/tests/component/generate.test.tsx
  - ui/tests/component/score.test.tsx
  - ui/tests/component/settings.test.tsx
  - ui/tests/e2e/flow.spec.ts
  - ui/tests/e2e/helpers.ts
  - ui/tests/e2e/csp.spec.ts
  - ui/tests/e2e/server/start.mjs
  - ui/tests/helpers/screens.tsx
  - src/api/static.ts
findings:
  critical: 0
  warning: 20
  info: 4
  total: 24
status: issues_found
---

# Phase 11: Code Review Report

**Reviewed:** 2026-11-15
**Depth:** standard (cross-checked against `src/service/schemas.ts`, `src/service/operations.ts`, `src/api/limits.ts`, `src/api/static.ts`)
**Severity labels:** HR = high, MD = medium, LW = low, IN = info. Frontmatter maps HR to `critical`, MD and LW to `warning`, IN to `info`.
**Counts:** HR 0, MD 10, LW 10, IN 4.

## Summary

The security-critical paths hold up. Model output, corpus text, persona text and API error messages all reach the DOM only as React text nodes. There is no `dangerouslySetInnerHTML`, no markdown, no link detection, and no `href` or `src` taken from data. No API key is read or stored by the UI. The token lives in a closure variable and is sent only as the `Authorization` header. The CSP is strict (`default-src 'none'`, no `unsafe-inline`), and the lazy chunks are served through the same static handler, so they carry the same header. Score and Humanize are gated on the capability list, the caveat is always rendered on that screen, and Settings is read-only for configuration. I found no exploitable XSS or secret-exposure path.

The defects are correctness and robustness gaps, plus several places where a test or gate is weaker than it looks. The main ones:
- Generate with humanize shows no caveat.
- The UI overrides the server's configured humanize defaults.
- An emptied number field sends `null`.
- There is no client-side cancellation or timeout.
- `scan-bundle` has a proven blind spot.
- `verify.sh` runs the bundle-scan test before the build it depends on.

## HR: High

None.

## MD: Medium

### MD-01: Generate with "Humanize the result" shows no weak-scorer caveat

**File:** `ui/src/screens/generate/GenerateScreen.tsx:114-129,141-157`
**Issue:** The humanize switch is offered on Generate and sends `humanize: true, target`. The server's `generateOutput` carries no caveat (`src/service/schemas.ts` `generateOutput`; the generate handler returns only `text`, `trace` and `promptTokensEstimate`), and the Generate screen never imports `HUMANIZE_CAVEAT`. Humanized text is therefore presented on a screen that says nothing about the heuristic being a weak, confounded proxy. This breaks the requirement that the caveat is always visible when humanize output is shown. `ui-score-caveat.test.ts` only checks the Score screen.
**Fix:** Render the caveat on Generate whenever `canHumanize` is true, or at least whenever the humanize switch is on or the result came from a humanize request. Extract `Caveat` from `ScoreScreen.tsx` into `components/` and reuse it. Add a component test and a source assertion for Generate.

### MD-02: Hard-coded humanize `target` (0.3) and `maxIterations` (3) override the server's configured defaults

**File:** `ui/src/screens/score/ScoreScreen.tsx:199-200,214-220`; `ui/src/screens/generate/GenerateScreen.tsx:34,59`
**Issue:** The UI always sends `target` and `maxIterations`, seeded from literals that mirror `DEFAULT_HUMANIZE`. The server accepts both as optional and falls back to `config.humanize.*`, which `SettingsScreen` displays as "Humanize target score" and "Humanize max iterations". An operator who sets `humanize.targetScore: 0.2` sees 0.2 on Settings while every UI run uses 0.3. The UI already loads `/api/config` on these screens.
**Fix:** Initialise `target` and `iterations` from `config.humanize` once the config loads. Alternatively, leave the fields unset until the user edits them and omit them from the body.

### MD-03: Clearing a NumberField sends `NaN`, serialised as `null`, and fails with a server 400

**File:** `ui/src/screens/score/ScoreScreen.tsx:247-254`; `ui/src/screens/generate/GenerateScreen.tsx:123`
**Issue:** `NumberField.onChange` reports `NaN` when the input is emptied (React Aria's documented behaviour). `setTarget(NaN)` or `setIterations(NaN)` is stored and `JSON.stringify` turns it into `null`. The server rejects `target: null` (`z.number().min(0).max(1).optional()`) with USAGE. `ready` does not account for this, so the user gets a generic banner for a field they just cleared, and the mid-edit `NaN` is also fed back into the controlled `value`. No test covers it.
**Fix:** Keep the field value as `number | undefined` (or guard on `Number.isFinite`). Disable submit, or omit the field, when it is not finite, and show a hint. Add a test that clears the field.

### MD-04: No cancellation or client timeout on any request; busy state can hang indefinitely

**File:** `ui/src/api/client.ts:54-66`; all `submit` handlers (Generate, Score, Humanize, Ingest)
**Issue:** `fetch` is called without an `AbortSignal`, and `ApiClient` has no way to cancel. A humanize call can run up to 10 model iterations. If the server or model stalls, the button stays on "Humanizing..." with no cancel and no timeout (the server's 408 covers only body upload). Leaving the screen does not abort the request. The model call and its cost continue, and the late answer is silently discarded by the unmounted component. `useLoad` drops stale answers but also never aborts.
**Fix:** Accept `{ signal }` in `get` and `post`. Create an `AbortController` per submit, abort it on unmount and on a Cancel button, and add a generous client timeout via `AbortSignal.timeout`. Map `AbortError` to a distinct, non-alarming message.

### MD-05: "Try again" on Generate does not reload the config, so a failed config load is permanent

**File:** `ui/src/screens/generate/GenerateScreen.tsx:28,73-86`
**Issue:** `loadError` can come from the config load, but `onRetry` calls only `reloadAuthors()` and `reloadPersonas()`. `const [config] = useLoad(...)` discards its reload function. If `/api/config` fails once, the banner and its Retry button stay forever until the page is revisited. The recovers-on-retry test covers authors and personas, not config.
**Fix:** `const [config, reloadConfig] = useLoad(...)` and call all three in `onRetry`, or retry only the failed one.

### MD-06: `scan-bundle` misclassifies base64 secrets containing `/` as paths, so they pass the entropy check

**File:** `scripts/scan-bundle.mjs:51-57` (`benign`), `:73-76` (token regex)
**Issue:** The candidate token regex includes `/`, and `benign()` exempts anything matching `^[./-]*(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9._-]+$`, meaning "a path". A 40-character base64 secret with a `/` and no `+` or `=` matches the path rule and is skipped. I confirmed this with a probe: `wJalrXUtnFEMI+K7MDENGbPxRfiCYzq8e3Vh2Tq9` is flagged as `high-entropy-token`, while the identical string with `+` replaced by `/` is not (exit 0). AWS-style secret access keys, a common shape, are exposed to this roughly a quarter of the time. The scanner self-test in `ui-secrets.test.ts` uses a `RANDOM` value with no `/`, so the gap is invisible. The test's "flags a long high-entropy token" case does not catch this.
**Fix:** Apply the path exemption only when the token also looks path-like, for example it contains `.` or begins with `./` or `/`, or has a known extension. Otherwise require entropy below the threshold. Add a self-test case with a slash-bearing random token.

### MD-07: `verify.sh` runs the bundle-scan security test before the root `dist/` it needs exists or is fresh

**File:** `scripts/verify.sh:114-130,183-195`; `tests/security/ui-secrets.test.ts:46-66`; `scripts/scan-bundle.mjs:60-68`
**Issue:** `scanDir()` loads `ConfidentialityFilter` from the repo's `dist/src/index.js` (gitignored). `verify.sh` runs `tsc --noEmit` (no emit), then the UI suite, then the root tiers, which include `ui-secrets.test.ts` and `ui-csp.test.ts`. The only step that emits `dist/` is `tsc -p tsconfig.build.json` inside the e2e block, after the tests, and it is skipped under `--no-e2e`. The smoke build test emits to a temp dir. On a clean checkout the security tier therefore fails on first run ("dist/ is missing"). Once `dist/` exists, it silently scans with a possibly stale filter. The new `ui:verify` script does build first, but `verify.sh` is the gate and does not call it or `scan-bundle.mjs`.
**Fix:** Build `dist/` (`tsc -p tsconfig.build.json`) before the root tests in `verify.sh`. Alternatively, have `loadFilter` import the TypeScript source or fail with a clear skip-is-failure message. Document the dependency in `ui-secrets.test.ts`.

### MD-08: A 401 after the first load points to the wrong page, and a rejected token is not forgotten

**File:** `ui/src/components/errors.ts:15`; `ui/src/screens/settings/SettingsScreen.tsx:60-67`; `ui/src/app/pages/Overview.tsx`
**Issue:** The capability request handles 401 by clearing the token and showing the form. Every other call surfaces `UNAUTHORIZED` through `ErrorBanner` with the hint "Enter the token on the Overview page." There are two problems.
- Once capabilities are `ok`, Overview renders no token form. The only place to enter a token is Settings. The hint sends users to a page that cannot help.
- A wrong token entered in Settings (or one that expires or changes after a server restart) stays in the client. Every later request resends it. Per the comment in `capabilities.tsx:38`, the server counts each as a wrong guess, so the user drifts into 429 and lockout.
**Fix:** Change the hint to "Enter the token under Settings". In `toApiError` or the client, call `setToken(undefined)` on any 401, and have the gate or provider move back to the `auth` state. Add a screen-level test for a 401 on a POST.

### MD-09: Ingest silently replaces an existing author with no confirmation

**File:** `ui/src/screens/authors/AuthorsScreen.tsx:49-101,139`
**Issue:** Submitting an id that already exists overwrites that author's corpus and profile. The only safeguard is a hint paragraph. The authors list is already loaded in the same screen, so a collision is detectable before the request. A fat-fingered id (`terse` instead of `terse2`) irreversibly destroys the previous corpus.
**Fix:** Pass the known ids into `IngestForm`. When `authorId` matches one, show an inline warning and require an explicit confirm (checkbox or confirm button) before enabling Ingest.

### MD-10: Focus is dropped to `<body>` after a token is accepted on a gated screen

**File:** `ui/src/components/AuthGate.tsx:12-31`
**Issue:** `Overview` handles this case: its heading is focused when the token form is replaced by the result. `AuthGate` has no equivalent. After a correct token the gate swaps `TokenForm` for the screen, the focused Connect button unmounts, and focus falls to `<body>`. Nothing is announced either, since `Shell`'s focus move runs only on route change. Keyboard and screen-reader users must start from the top of the page.
**Fix:** After a successful reload that follows a submit, focus the screen's `h1` (or `main`) and `announce("Connected")`. A shared `useFocusAfterAuth` hook could serve both `Overview` and `AuthGate`.

## LW: Low

### LW-01: Score and Humanize disable the submit button with no explanation, and a failed config load is silent there

**File:** `ui/src/screens/score/ScoreScreen.tsx:50-54,64,97,205,263`
**Issue:** `useCap()` swallows a config error: `cap` stays `undefined` and `ready` is false forever. The button is `isDisabled` (removed from the tab order) and, unlike Generate and Ingest, there is no hint saying why. A user whose `/api/config` call failed sees a dead form with no banner and no retry.
**Fix:** Surface the `useLoad` error with `ErrorBanner` and Retry. Render a "Waiting for the server limits" or "Write some text" hint beside the button, as Generate does.

### LW-02: Switching Score and Humanize tabs discards the panel's text and result

**File:** `ui/src/screens/score/ScoreScreen.tsx:388-403`
**Issue:** React Aria renders only the selected `TabPanel`. All state (draft text, result, error) lives inside the panel components and is lost on every tab switch. A long pasted text must be re-entered.
**Fix:** Lift `text` (and optionally results) into `ScoreScreen`, or use `shouldForceMount` on the panels.

### LW-03: Stale output stays on screen next to a new error or after a changed selection

**File:** `ui/src/screens/generate/GenerateScreen.tsx:30-37,140-157`
**Issue:** On a failed re-run, `error` is set but `result` from the previous run remains rendered under "Output", so the page shows a banner and an output that belongs to a different request. The author and persona pickers are not disabled while `busy`, so the user can change them mid-flight and the arriving result is shown against a selection it was not generated for. Score and Humanize have the same stale-result-plus-error pattern.
**Fix:** Clear `result` when a new request starts (or mark it stale), and disable the pickers while busy. Alternatively, record the author and persona alongside the result and display them.

### LW-04: Non-2xx and capability edge cases in the provider and client are loosely handled

**File:** `ui/src/api/capabilities.tsx:30-49`; `ui/src/api/client.ts:64-66`
**Issue:** Three small problems.
- `reload` has no sequence guard (unlike `useLoad`), so overlapping reloads, such as StrictMode's double effect plus Overview's `reload`, can let an older response overwrite a newer one.
- Any 429, including one not related to token guessing, is rendered as "Too many wrong tokens" and leaves the held token in place.
- A token containing a non-Latin-1 character makes `fetch` throw a `TypeError` for the header. That is reported as `NETWORK` ("could not reach the server"), which misleads the user.
**Fix:** Add a request counter to `reload`. Distinguish a 429 on an authenticated token from a generic one. Validate the token for ISO-8859-1 before `setToken` and report "the token contains unsupported characters".

### LW-05: Ingest input checks are narrower than the server's rules

**File:** `ui/src/screens/authors/AuthorsScreen.tsx:60-61,66-82`
**Issue:** The id regex is correct. But the server's `displayNameSchema` also rejects control characters, and `textSchema` rejects NUL. The UI checks NUL only for files, not for pasted text, and does not check names. There is no pre-check against the engine's corpus cap, which the config view does not expose. The result is a late USAGE or INPUT_TOO_LARGE banner after a multi-MB request. The 4 MB file limit is also unrelated to any configured server limit.
**Fix:** Apply the NUL and control-character checks on the text box and name field with inline messages. Consider exposing `maxCorpusChars` in the config view so the UI can show a count against it.

### LW-06: Source-ban checker has easy gaps

**File:** `ui/tests/unit/source-bans.test.ts:21-23,33-36,47-51`
**Issue:** The tests prove the rules work on the listed snippets, but the rules do not cover several URL and markup sinks:
- `location.href = x`, `location.assign(x)` and `window.open(x)`
- `el.setAttribute('href', x)`
- JSX spread props (`<a {...p}>`)
- `import('react-markdown')` (dynamic import)
- Markdown packages outside the regex list, such as `micromark`, `mdx` and `html-react-parser`

The `#${...}` template exemption allows any data after the `#`, so `href={`#${model.x}`}` passes. A model-supplied string there would only reach hash routing, but the check does not enforce a route constant.
**Fix:** Add the sinks above to the checker and its bad-input table. Restrict the `#` exemption to identifiers named `path` or `r.path`, or to a value drawn from `ROUTES`.

### LW-07: `ui-secrets` comment stripper can hide a storage use

**File:** `tests/security/ui-secrets.test.ts:36`
**Issue:** `code()` removes `(^|[^:])//.*$`. A string containing `//` not preceded by `:` (for example `'a//b'` or a regex) truncates the rest of the line, so `localStorage.setItem(...)` after it on the same line escapes the "storage in one place" check. The check also covers only `.ts` and `.tsx` source, not the built bundle.
**Fix:** Strip comments with the TypeScript scanner (as `source-bans.test.ts` already uses `ts`), or run the storage check over `ui/dist` as well.

### LW-08: The e2e secrets test cannot show the bearer token stays out of responses

**File:** `ui/tests/e2e/flow.spec.ts` ("secrets: a key planted..."), `ui/tests/e2e/server/start.mjs`
**Issue:** The e2e server runs without a token requirement, so the 401, 429 and wrong-token flows are never exercised in a real browser. The "memory-only-token" assertions pass trivially on a server that never looks at the header. Token handling on a real auth-enabled server (including that the token never ends up in the URL, storage or an error message) is covered only by jsdom component tests.
**Fix:** Add an e2e variant that starts the server with `--token-env`. Cover the gate, a wrong token, a correct token, and a scan of storage, URL and responses for the token.

### LW-09: Root `uiBuild` global setup keeps a stale `ui/dist`

**File:** `tests/helpers/uiBuild.ts:8-12`
**Issue:** It builds the UI only if `ui/dist/index.html` is missing, but the comment says "`scripts/verify.sh` always rebuilds it first". Under `--no-ui`, or any bare `npm test`, `ui-csp`, `ui-secrets` and `ui-serve` run against whatever old `dist` is on disk. They can pass after the source has regressed.
**Fix:** Rebuild when any `ui/src` file is newer than `ui/dist/index.html`, or always rebuild. Correct the comment.

### LW-10: Error is announced twice, and the live region mixes with `role="status"` placeholders

**File:** `ui/src/screens/generate/GenerateScreen.tsx:64-67`, `ui/src/components/ErrorBanner.tsx:11`, `ui/src/components/Section.tsx:30`
**Issue:** A failed submit both calls `announce("... failed: CODE")` (polite) and renders an `ErrorBanner` with `role="alert"` (assertive). Screen readers read the error twice, and the second message is just the bare code. Loading placeholders are separate `role="status"` regions that appear alongside the global one.
**Fix:** Rely on the alert alone for errors and use `announce` only for success. Keep a single polite region for progress.

## IN: Info

### IN-01: Stale test reference in the generated manifest header

**File:** `ui/scripts/gen-api.mjs:35` (emitted into `ui/src/api/operations.ts:2`)
**Issue:** The header says "tests/unit/parity.test.ts requires the UI to call only these". That file does not exist; the check is `tests/integration/ui-parity.test.ts`.
**Fix:** Correct the path in the generator and regenerate.

### IN-02: Parity test greps raw source text, so a commented-out call counts as coverage

**File:** `tests/integration/ui-parity.test.ts:19-22,36-40`
**Issue:** `uiCalls()` matches `api.get('/api/x')` in any text, including comments and string literals. A screen that commented out its only call to an operation would still satisfy "every operation is used". It also does not detect a UI call made through a helper.
**Fix:** Parse with the TypeScript AST (as `source-bans.test.ts` does) and count only call expressions.

### IN-03: Small code-quality items in the new screens

**File:** `ui/src/screens/authors/AuthorsScreen.tsx:129,185`; `ui/src/components/PlainText.tsx:5`
**Issue:**
- `files as unknown as FileList` is a double cast to satisfy `readFile`'s signature. Change `readFile` to take `Iterable<File> | null` instead.
- `selectionBehavior="replace"` at line 185 is mis-indented.
- `data-testid="plain-text"` ships in the production DOM.

**Fix:** Clean up as noted.

### IN-04: `fmt` has inconsistent precision

**File:** `ui/src/components/Bars.tsx:40-43`
**Issue:** Values of 10 or more get one decimal ("10.0") while smaller values are trimmed ("0.5", "5"), so a score table can show `10.0` next to `5`.
**Fix:** Trim trailing zeros in all branches, or document the intent.

---

_Reviewed: 2026-11-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
