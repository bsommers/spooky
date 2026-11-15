---
phase: 10-ui-foundation
reviewed: 2026-11-15T00:00:00Z
depth: standard
files_reviewed: 24
files_reviewed_list:
  - src/api/static.ts
  - src/api/server.ts
  - src/cli/serve.ts
  - package.json
  - scripts/verify.sh
  - tests/helpers/uiBuild.ts
  - tests/helpers/uiFixture.ts
  - tests/unit/api/static.test.ts
  - tests/integration/ui-serve.test.ts
  - ui/index.html
  - ui/public/theme-init.js
  - ui/public/react-aria-pressable.css
  - ui/build/plugins.ts
  - ui/build/theme-check.ts
  - ui/build/licenses.mjs
  - ui/src/api/client.ts
  - ui/src/api/context.tsx
  - ui/src/app/Shell.tsx
  - ui/src/app/route.ts
  - ui/src/app/pages/Overview.tsx
  - ui/src/theme/contract.ts
  - ui/src/theme/contrast.ts
  - ui/src/theme/engine.ts
  - ui/src/theme/themes/black-cat.css
findings:
  high: 0
  medium: 2
  low: 10
  info: 4
  total: 16
status: issues_found
---

# Phase 10: Code Review Report

**Reviewed:** 2026-11-15
**Depth:** standard (UI tests, CSS and the remaining ui/ files read selectively; the CSP hash was recomputed against the installed react-aria source)
**Severity scheme:** HR (high), MD (medium), LW (low), IN (info)

## Summary

The static mount is carefully built. Traversal, encoded slash, backslash, NUL, dotfile and double-encoding cases all end in 404. The `startsWith(root + sep)` check correctly rejects the `dist-sibling` prefix trick. Method handling, protected-namespace exclusion and Host/Origin ordering are right: the Host check runs before the static handler. The CSP has no `unsafe-inline` or `unsafe-eval`. The one inline allowance is a hash, and I confirmed it equals sha256 of the real `usePreventScroll` text (`gYiS/BvZ...farlg=`). The token is held in a closure variable only. It is never written to a URL, storage or log. No `dangerouslySetInnerHTML`, `eval` or `innerHTML` exists. Production licenses are all Apache-2.0-compatible (MIT, Apache-2.0, 0BSD, OFL fonts). `axe-core` (MPL-2.0) is dev-only.

There is no high-severity finding. Two medium issues need fixing: a confirmed symlink escape that contradicts the documented guarantee, and a stale wrong token that gets resent and can lock out the user.

## Medium

### MD-01: symlinked `index.html` escapes the root (directory index and root index)

**File:** `src/api/static.ts:112-116` (and `src/api/static.ts:80-86`, `99-100`)
**Issue:** The header comment promises "the resolved real path must stay inside the real root, so a symlink cannot lead out of it". `locate()` re-checks `realpath` only for the requested path. When that path is a directory, it joins `index.html` and calls `stat`, which follows symlinks. The result is never `realpath`-checked, and `createReadStream(found.file)` then reads the target.

I reproduced this with a throwaway root containing `sub/index.html -> /outside/secret.html`. `GET /sub/` and `GET /sub` returned 200 with the outside file's content. The same applies to a symlinked root-level `index.html`, which `/` and the SPA fallback serve, and which `hasBuiltUi` accepts.

`GET /sub/index.html` is correctly 404. Only the implicit-index path leaks. The test fixture covers a file symlink (`link.txt`) but not an `index.html` symlink, so the suite does not catch it.

Exploitation needs write access to the served directory, which is why this is medium. `--ui-dir` is user-chosen, so the stated invariant should still hold.
**Fix:** Re-resolve the final file and re-check containment.
```ts
if (st.isDirectory()) {
  file = await realpath(join(real, 'index.html'));
  if (!file.startsWith(rootPrefix)) return undefined;
  st = await stat(file);
}
```
Do the same in `hasBuiltUi` / `createStaticHandler` for the root index. Add fixture cases `sub2/index.html -> secret` and root `index.html -> secret`.

### MD-02: a rejected token stays in the client and is resent on every later request, which can trigger the server's lockout

**File:** `ui/src/app/pages/Overview.tsx:54-56`, `ui/src/api/client.ts:60,86-88`
**Issue:** `api.setToken(value)` runs before the attempt. On a 401 or 429, nothing clears the token. The `Overview` component remounts on every navigation: Kitchen sink, back to Overview, hash change. On remount, `load()` runs in the `useEffect` and sends the same wrong token. The server (`server.ts:212-216`) counts every request carrying an `Authorization` header that fails as a guess (`throttle.failed`), adds a delay, and eventually locks the peer.

So one typo plus ordinary navigation, or React StrictMode's double effect in dev, burns throttle budget without the user submitting anything. A subsequent correct token then meets "Too many wrong tokens". The 429 branch also reports `wrong: true` even when the lockout came from the stale resend.
**Fix:** On `ApiError.unauthorized`, call `api.setToken(undefined)` before switching to the `auth` state, so the next request is credential-less, which the server does not count. Add a component test: wrong token, navigate away and back, assert the second request has no `Authorization` header.

## Low

### LW-01: `immutable` cache heuristic is name-pattern based and checks the resolved path

**File:** `src/api/static.ts:136`
**Issue:** `/-[A-Za-z0-9_-]{6,}\.[a-z0-9]+$/` is tested against `found.file` (the real, post-symlink path). Any file under `assets/` with a hyphenated tail of six or more characters, for example `font-regular.woff2` or `my-notes.txt`, is served `max-age=31536000, immutable`. A symlink in `assets/` can also borrow a hashed target name. Vite's output is safe today, but `--ui-dir` accepts arbitrary trees, and a wrong long-lived cache is hard to undo for a user.
**Fix:** Test the requested path (`segments`) rather than the real path. Tighten the pattern to Vite's actual hash shape (`-[A-Za-z0-9_-]{8}\.`), or read an emitted manifest.

### LW-02: open/read failure after the stat destroys the connection instead of answering

**File:** `src/api/static.ts:144-155`
**Issue:** Headers are only `setHeader`'d, not flushed. If `createReadStream` errors (EACCES, or the file removed after `stat`), `res.destroy()` resets the socket. The client sees a network error, not a 404 or 500, and the `log` line records a misleading `200`. `Content-Length` was also taken from `stat`, so a file that changes mid-flight yields a truncated or over-long body.
**Fix:** Open with `fs.promises.open`, `fstat` the handle, and stream from it. This also closes the stat-then-open race. On open failure, return `false` (404) before any header is set.

### LW-03: `.md` and other unknown extensions fall to `application/octet-stream`; shipped license texts are not discoverable

**File:** `src/api/static.ts:42-53`; `ui/src/app/Shell.tsx:53-55`
**Issue:** `dist/licenses/THIRD_PARTY_LICENSES.md` is served as octet-stream. With `nosniff`, browsers download it instead of showing it. The `-OFL.txt` files render, but nothing in the UI links to either. The OFL attribution travels with the files but is not reachable by a user following the in-app trail.
**Fix:** Add `.md` -> `text/plain; charset=utf-8` (not `text/markdown`, to stay inert). Link `/licenses/THIRD_PARTY_LICENSES.md` from the footer.

### LW-04: `serve` swallows a UI setup failure for the default directory and ignores conflicting flags silently

**File:** `src/cli/serve.ts:116-127`
**Issue:**
- When `defaultUiDir()` finds a directory but `createStaticHandler` throws (for example a dangling-symlink root), the empty `catch` produces no stderr note. `/` is 404 with no explanation.
- `--no-ui` combined with `--ui-dir` silently ignores `--ui-dir`.
- `--ui-dir` is accepted by `serve` only. `mcp --http` runs with `mode.api=false`, so it never serves the UI, which is correct, but nothing says so.
**Fix:** In the catch, emit `note: the web UI at <dir> could not be served (<reason class>)`. Throw `ConfigError` when both `--no-ui` and `--ui-dir` are given.

### LW-05: the release package lists `ui/dist` but nothing builds it

**File:** `package.json` (`files`, `scripts`)
**Issue:** `ui/dist` is gitignored. `files` adds it to the tarball, but there is no `prepack` or `prepublishOnly` that runs `ui:build`. A publish from a tree without a fresh build ships no UI. The server then prints only a stderr "not built" note, and the feature is gone with no failure. A stale build ships just as quietly.
**Fix:** Add `"prepack": "npm run build && npm run ui:build"` and fail the pack if `ui/dist/index.html` is missing. Alternatively add a release-time check in `verify.sh`.

### LW-06: focus is dropped after submitting the token form, and live regions are nested

**File:** `ui/src/app/pages/Overview.tsx:20-22,45,52-57`
**Issue:**
- `load()` sets `{kind:'loading'}`, which unmounts the form that holds focus. Focus falls to `<body>`. This is a WCAG 2.4.3/3.2 focus-order problem for keyboard and screen-reader users, who must tab back from the top of the page.
- The card is `aria-live="polite"` and its children also carry `role="status"` and `role="alert"`. Many screen readers announce twice or inconsistently.
- Axe tests pass because they check static states, not this transition.
**Fix:** Keep the form mounted while retrying (disable the button, show a status). Alternatively, after the result renders, move focus to the new heading or error. Drop `aria-live` on the container and keep only the specific roles.

### LW-07: hash routing treats malformed hashes as Overview, not Not-found

**File:** `ui/src/app/route.ts:21-26`
**Issue:** `parseHash` matches `^#(\/[a-z0-9/-]*)?$` and returns `'/'` on any non-match. `#/Kitchen-Sink`, `#/foo.bar` and `#main` all render Overview with the Overview nav highlighted. Meanwhile `#/zzz` renders NotFound. This inconsistency also interacts with the skip link: if its JS `preventDefault` is bypassed (middle-click, JS error), `href="#main"` navigates to Overview.
**Fix:** Return the raw path (or `null` for non-matching) and let `App` render NotFound for anything unknown. Give the skip link a non-routing target, or handle `#main` explicitly.

### LW-08: `zod` is a production dependency but is used only at build and test time

**File:** `ui/package.json:21`; `ui/src/theme/contract.ts:5`
**Issue:** `contract.ts` imports zod, but runtime code imports it only as types (`import type`). The bundle contains no zod (grep for `ZodError` is 0). Still, listing it under `dependencies` puts it in the production license audit and in `THIRD_PARTY.md` as "bundled". This overstates what ships, and a later runtime import would be pulled into the bundle without notice.
**Fix:** Move `zod` to `devDependencies` and regenerate `THIRD_PARTY.md`.

### LW-09: the license classifier mis-handles parenthesised SPDX expressions

**File:** `ui/build/licenses.mjs:26-36`
**Issue:** `classifyLicense` strips parentheses, then splits on `OR` before `AND`. `(MIT OR GPL-3.0) AND LGPL-3.0` becomes `["MIT", "GPL-3.0 AND LGPL-3.0"]`. The first alternative is allowed, so the whole expression passes even though the required `AND LGPL-3.0` is disallowed. It fails open on exactly the case the audit exists for. No current package triggers it.
**Fix:** Parse with a real SPDX expression parser (`spdx-expression-parse`, or `spdx-satisfies`), or reject any expression containing parentheses that is not a plain `A OR B` / `A AND B`.

### LW-10: contrast contract omits non-text boundaries and the offline scanner has blind spots

**File:** `ui/src/theme/contrast.ts:25-37`; `ui/tests/build/offline.test.ts:21-29`
**Issue:**
- `CONTRAST_PAIRS` covers text, accent, status and focus, but not `--gw-border` against its surfaces (WCAG 1.4.11). The measured black-cat border (#2a2a31 on #0a0a0c) is roughly 1.4:1. Today's controls with only that border are buttons, which have text. A future theme or a border-only control gets no protection, and a contrast failure in the border token will not fail the build.
- The remote-URL scan only catches protocol-relative URLs inside `url()`, `src=` and `href=`. A JS string `fetch("//cdn.example/x")`, `import("//...")`, or a runtime-built `data:` or `blob:` URL passes. The scan is a strong guard, not proof of offline behavior.
**Fix:** Add the pairs `--gw-border`/surfaces with `min: 3` only for controls that rely on it, or document the exemption. Extend the scanner with `/["'`]\/\/[a-z0-9.-]+\.[a-z]{2,}/` on `.js` files.

## Info

### IN-01: `transformIndexHtml` silently no-ops if the `<html>` tag changes

**File:** `ui/build/plugins.ts:30-33`
**Issue:** `html.replace('<html lang="en">', ...)` does nothing if the tag gains an attribute. `theme-init.js` then finds no `data-themes`, returns early, and the first paint has no `data-theme`. This is a graceful degradation, but a silent one, and caught only by a late test.
**Fix:** Fail the build when the replacement did not occur.

### IN-02: no `<noscript>` fallback; `color-scheme` meta is hard-coded to dark

**File:** `ui/index.html:7,15-20`
**Issue:** With JavaScript disabled the page is blank, with no explanation. `<meta name="color-scheme" content="dark">` is correct for the two current dark themes, but it is not derived from the manifest, so a future light theme flashes dark UA chrome before `theme-init.js` runs.
**Fix:** Add a short `<noscript>` message inside `#root`'s sibling. Emit the meta value from `THEMES` in `themePlugin`.

### IN-03: platform edge cases and unexercised CSP path

**File:** `src/api/static.ts:58-72`; `ui/tests/build/csp-compat.test.ts`
**Issue:**
- On Windows, a segment such as `index.html::$DATA` or `C:` is not rejected by the `[\\/\0]` check. `resolve` plus the containment check stops drive escapes, but alternate-data-stream names are not considered.
- The iOS scroll-lock `<style>` (the only thing the CSP hash exists for) runs only under an iOS user agent. The Chromium e2e run never exercises it, so correctness rests on the source-text hash test alone. That test is sound but fragile: it depends on the `react-aria/dist/private` path and the template-literal shape, and it fails loudly on upgrade, which is the intended behavior.
**Fix:** Reject `:` in segments on `win32`. Optionally add a WebKit/iOS-emulation e2e that opens a modal.

### IN-04: defence-in-depth headers and wording

**File:** `src/api/server.ts:84-90`; `ui/src/app/pages/Overview.tsx:29-31`
**Issue:** `SECURITY_HEADERS` has no `Permissions-Policy` and no `Cross-Origin-Opener-Policy`. Both are cheap for a local app that needs no camera, geolocation or cross-window access. Separately, the Overview shows "Too many wrong tokens" for any 429, including a lockout caused by another tab (see MD-02).
**Fix:** Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` and `Cross-Origin-Opener-Policy: same-origin`. Make the 429 message neutral ("Too many attempts; try again in N seconds").

---

_Reviewed: 2026-11-15_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
