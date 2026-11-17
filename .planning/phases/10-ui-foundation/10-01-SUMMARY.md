---
phase: 10-ui-foundation
plan: 01
subsystem: web-ui
tags: [react-aria, vite, theming, csp, offline, a11y, playwright, self-hosted-fonts]
status: complete
requires:
  - phase: 09-service-surfaces
    provides: node:http server with the staticHandler mount hook, OpenAPI document from the operations registry
provides:
  - ui/ package (Vite, React 19, React Aria Components, TS strict) served by `ghostwriter serve` at / with a strict CSP
  - Theme contract (one css file + one manifest line), engine, no-flash bootstrap, Black Cat and Tron Neon themes, AA contrast asserted over every declared pair
  - Original SVG logo, 10-icon set, favicon set; self-hosted OFL fonts; THIRD_PARTY.md license audit
  - Typed API client generated from the registry's OpenAPI document (token in memory only)
  - src/api/static.ts (traversal-safe static handler), serve --ui-dir / --no-ui
  - UI tiers wired into scripts/verify.sh (typecheck, css lint, license audit, vitest, Playwright)
affects: [11-ui-features]
tech-stack:
  added:
    - "ui/ (separate package): react 19, react-aria-components (Apache-2.0), zod, @fontsource-variable/{orbitron,inter,jetbrains-mono,fraunces} (OFL-1.1)"
    - "ui/ dev: vite 8, vitest 5, @playwright/test 1.65.1 (pinned), jsdom, axe-core (MPL-2.0, test only), stylelint, openapi-typescript"
  patterns:
    - "components read only --gw-* tokens; stylelint forbids raw colors outside theme files"
    - "theme = one css rule + one manifest line; contract, files and contrast are checked at build time"
    - "CSP without unsafe-inline: bootstrap is a file; React Aria's two runtime <style> injections handled by a linked stylesheet under its id and an exact hash"
key-files:
  created:
    - ui/ (package, src/theme, src/app, src/api, src/icons, src/styles, public, build, scripts, tests incl. committed baselines)
    - src/api/static.ts
    - docs/UI.md
  modified:
    - src/cli/serve.ts (--ui-dir, --no-ui, mount)
    - scripts/verify.sh, package.json (ui:* scripts, files += ui/dist), vitest.config.ts (global setup builds ui/dist if missing)
    - docs/UI-THEMES.md, docs/SURFACES.md, docs/API.md, README.md, .gitignore
key-decisions:
  - "Six background tokens added to the plan's token list (bg-grid, grid-cell, grid-transform, bg-mark, anim-grid, anim-glow) so Tron's tilted grid and Black Cat's watermark need no theme names in component CSS"
  - "Hash routing; no router dependency, no server rewrite needed"
  - "Black Cat display font: Fraunces (OFL); body and mono shared with Tron"
  - "Static assets are public (before the token check); the UI asks for the token itself and keeps it in memory"
  - "Visual baselines generated in the pinned Playwright container; the host Chromium of the same version renders identical pixels, so verify.sh runs the suite on the host by default (GW_E2E_CONTAINER=1 for the container)"
metrics:
  duration: "about 80 min"
  completed: 2026-11-15
  tasks: 7
  files: 91 ui files + 17 root files
commits: 7
plan_head_before: dc929e6a2b10c15a6747de6fc7a1259d8e312f0b
plan_head_after: 1d3fbcce81de526929b034c661f3f4509b3bc160
---

# Phase 10 Plan 01: UI foundation and theming Summary

A themed, accessible, offline React app shell served by the Phase 9 server: React Aria Components over a `--gw-*` token system, two themes (Black Cat, Tron Neon), a typed API client and a kitchen-sink page, with the whole matrix from the plan under test.

## What was built

- **Server**: `src/api/static.ts` mounts `ui/dist` through the existing `staticHandler` hook. GET/HEAD only; `..`, NUL, backslash, encoded slash, dotfile segments and symlink escapes are 404; SPA fallback for extension-less paths but never for `/api`, `/openapi.json`, `/mcp`. CSP: `default-src 'none'; script-src 'self'; style-src 'self' <hash>; img/font/connect/manifest 'self'; base-uri/form-action 'none'; frame-ancestors 'none'`. `serve --ui-dir DIR | --no-ui`; `mcp --http` never serves it.
- **Theming**: `contract.ts` (zod; every token, no extras, hex colors, no remote url), `manifest.ts`, `engine.ts` (data-theme, best-effort localStorage, system preference, reduced motion), `ThemeProvider`, `public/theme-init.js` (no flash; a test runs it against the engine). `build/theme-check.ts` runs in the Vite build: contract, manifest-file agreement, asset existence, and AA for every declared pair on bg, surface and bg-raised in both themes. Both palettes passed first try.
- **Design**: Black Cat (amber eyes, vertical slit active markers, dim moon + haze, paw bullets, cat watermark, logo blink) and Tron Neon (lumagrid palette, Orbitron/Inter/JetBrains Mono, perspective neon grid, glow pulse). All SVG art original and hand-authored.
- **Shell**: skip link, banner, labelled Primary nav (`aria-current`), main takes focus after navigation, footer; ThemeSwitcher (React Aria Select, live region); Overview (calls `/api/capabilities`; 401 shows a token form, token in memory only; 429 shows the wait); Kitchen sink (Button, Select, Switch, Dialog, Tooltip, Tabs, status, icons, token swatches).
- **API client**: `ui/src/api/schema.d.ts` generated from the registry's OpenAPI document; root test fails when the committed `openapi.json` snapshot drifts from the registry, a UI test fails when `schema.d.ts` drifts from the snapshot.
- **Licenses**: `ui/THIRD_PARTY.md` generated from the lockfile; GPL/AGPL/LGPL/unknown or a font without its license file fails; font licenses and bundled-package licenses ship in `dist/licenses/`.

## Verification (`scripts/verify.sh`, run twice; second run clean)

| Tier | Result |
|---|---|
| ui (vitest: unit, component, a11y, build) | 157/157 |
| ui e2e (Playwright: visual: 12 baseline PNGs, both themes, desktop and phone, a11y with contrast, offline, CSP, theme, motion) | 34/34 |
| smoke / unit / integration / system / security / torture (root) | 4 / 950 / 291 / 66 / 472 / 5, all passed |
| skipped | 0 |

New root tests: static handler 27 (20 traversal variants), UI next to the API 6, OpenAPI snapshot 1, spawned binary `--ui-dir/--no-ui` 1. UI-01..06 covered: UI-01 (Vite/React/TS strict SPA, own tsconfig/tests, imports only generated API types, proxy in dev), UI-02 (React Aria Components only), UI-03 (data-theme, switch, persistence with try/catch, prefers-color-scheme default, reduced motion), UI-04 (two themes, numeric AA), UI-05 (original SVG logo, 10 icons, favicon set), UI-06 (offline scan of built output, Playwright with network blocked, THIRD_PARTY.md).

## Deviations from Plan

**1. [Rule 2 - Missing critical functionality] CSP vs React Aria's runtime `<style>` injections**
- Found during: first real-browser run (CSP violation `style-src-elem`).
- Issue: `usePress` and the iOS scroll lock insert inline `<style>` elements, blocked by `style-src 'self'`.
- Fix: index.html links `/react-aria-pressable.css` under the id React Aria checks (it then skips injecting); the scroll-lock rule is allowed by its exact sha256 in `UI_CSP`. Both are re-derived from the installed library by a test, so an upgrade that changes them fails a test.
- Commits: cfbbff8, b7c00f5.

**2. [Rule 2] Contract extended by six background tokens** (see key-decisions); documented in docs/UI-THEMES.md.

**3. [Rule 3] Tooling choices**: `@types/node` ^22 in ui/ (vitest 5 peer); `license-checker` dropped in favor of reading the lockfile and each package.json (deterministic, production-only); stylelint `.stylelintignore` for the generated fonts.css; icons rendered to PNG by a Playwright script (`scripts/make-icons.mjs`).

**4. [Rule 1] Test assumptions corrected while writing** (not product bugs): the license texts in dist/licenses quote upstream URLs as prose, so the offline scan covers html/css/js/svg/json only, with `https://react.dev/errors/` (React's production error-message text, never fetched) allowlisted next to the w3.org namespaces; the real-browser run blocks every non-localhost request and asserts zero attempts.

**5. Select chevron drawn as SVG** instead of a text glyph, so no system font enters the screenshots.

## Notes and open items

- The PROJECT.md "no dependencies beyond ..." list governs the root package; `ui/` is a separate package with its own dependency set per the plan. Root `dependencies` are unchanged.
- One root test (`chunker` 1 MB wall-clock, pre-existing) failed once under load in the first full verify run and passed alone and on the next full run; it is not touched by this plan.
- `ui/` `npm audit --omit=dev`: 0 vulnerabilities. The full audit reports moderate advisories in dev tooling only (not shipped).
- Visual baselines are Chromium 159 (Playwright 1.65.1) renders; regenerate with `ui/scripts/e2e-container.sh --update-snapshots all` and review the PNG diff.
- The dialog overlay is an opaque background (no alpha color allowed by the raw-color rule outside theme files); a translucent scrim would need a token.
- Phase 11 feature screens, a light theme, and a user override for reduced motion are not in scope.

## Known Stubs

None. (The Overview and kitchen sink are real; feature screens are Phase 11 by plan.)

## Threat Flags

None beyond the plan's model: the static handler is a new unauthenticated GET surface (public assets only, traversal/symlink/dotfile tested, CSP, nosniff, no framing); host/origin checks still run before it.

## Self-Check: PASSED

Files present: src/api/static.ts, ui/package.json, ui/THIRD_PARTY.md, docs/UI.md, ui/tests/e2e/__screenshots__ (12 PNG). Commits a352ea4, b03ade2, e791daa, 1cfa9d2, cfbbff8, b7c00f5, 1d3fbcc are ancestors of HEAD.
