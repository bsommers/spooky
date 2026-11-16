# Web UI (Phases 10 and 11: foundation, theming and feature screens)

`ghostwriter serve` serves a React app at `/` next to the API (`/api/*`, `/openapi.json`): one process, one origin, no CORS. Phase 10 built the shell (navigation, theme switcher, connection check, a "kitchen sink" of every control); Phase 11 added the feature screens below, so every operation is usable from the UI. The UI talks to the server over HTTP only, like any other client; it has no key, no direct engine access and no write path for config.

```
ui/
  index.html            shell page; links /theme-init.js (same-origin, runs before first paint)
  vite.config.ts        plugins in build/: theme validation, theme list for index.html, font license copy
  src/
    main.tsx            entry
    app/                Shell, ThemeSwitcher, Backdrop, hash routes, pages (Overview, KitchenSink), App (lazy screens)
    screens/            generate/ authors/ personas/ settings/ score/  (one lazy chunk each)
    components/         ErrorBanner, AuthGate, PlainText, Bars, Trace, TextInput, Picker, CopyButton, Announcer, useLoad
    api/                typed client (client.ts), capability gating (capabilities.tsx), generated schema.d.ts, openapi.json and operations.ts
    theme/              contract.ts, manifest.ts, engine.ts, ThemeProvider.tsx, contrast.ts, themes/<id>.css
    icons/              hand-authored SVG icon set + logo mark (currentColor)
    styles/             base, backdrop, shell, components (read --gw-* tokens only)
    assets/fonts.css    @font-face for the bundled variable fonts
  public/               theme-init.js, favicons, manifest, art/ (cat silhouette, paw)
  tests/                unit, component, a11y (jsdom axe), build (offline, CSP, licenses), e2e (Playwright)
  THIRD_PARTY.md        generated license inventory
```

## Run it

```bash
npm run ui:install         # once: installs ui/ (separate package.json and lockfile)
npm run build              # compile the CLI (repo root)
npm run ui:build           # builds ui/dist
ghostwriter serve          # open http://127.0.0.1:8787/
```

`serve` mounts `ui/dist` automatically when it exists (`--ui-dir <path>` picks another build, `--no-ui` turns it off; `mcp --http` never serves it). Developing the UI: `cd ui && npm run dev` starts Vite on its own port and proxies `/api` and `/openapi.json` to a `ghostwriter serve` on 8787 (add `--allow-origin http://localhost:5173` there only if you call the API cross-origin without the proxy).

## Screens (Phase 11)

| Screen (hash) | Operations | What it shows |
|---|---|---|
| Overview (`#/`) | `capabilities` | the server's operation list; the token prompt |
| Generate (`#/generate`) | `generate`, `authors`, `personas`, `config_get` | author and persona selects, a mode switch ("Rewrite my draft" / "Write about a topic"), draft box (rewrite) or topic box ("Topic we're researching"), notes box ("Notes and facts to use (optional)") and a length select (topic), each with a live count against `limits.maxInputChars` (empty or over-cap cannot submit; each mode keeps its own text), the topic-mode help (the model writes new text from the topic and notes; nothing is looked up online), the fixed topic caveat above every topic result (the server's `caveat`; a test keeps the bundled copy equal to `TOPIC_CAVEAT`), optional humanize switch (only when the server lists `humanize`), plain-text output with copy, filter trace table with a filter box, banned-phrase and confidentiality COUNTS, typed error banner |
| Authors (`#/authors`) | `authors`, `profile`, `ingest` | author list, stylometric profile as numbers beside SVG bars, ingest form (id pattern, name, pasted text or a file read in the browser into the text box, 4 MB cap) |
| Personas (`#/personas`) | `personas` | list and detail, read-only |
| Score / Humanize (`#/score`) | `score`, `humanize` | tabs; before/after scores, per-feature contribution and delta bars, iteration history with the meaning guard's reverts; the weak-scorer caveat is on screen at all times |
| Settings (`#/settings`) | `config_get`, `filters` | provider, model, endpoint host, key variable NAME with set/not-set status, limits, filters, scoring, theme radios, optional API token held in memory. Read-only: the config is changed in the server's config file |

**Gating.** The capability list is fetched once per page load (`CapabilitiesProvider`). A 401 shows the token form instead of any feature screen (`AuthGate`). Score and Humanize panels turn off with an explanation when the server does not list `score` / `humanize`; the nav entry stays. Phase 8 is built, so both are normally on; both states are tested with a mocked capability list (no skipped tests).

**Untrusted text.** Model output, corpus text, persona text, author names, trace metadata and server error messages are rendered as text nodes only (`PlainText`, React's escaping): no HTML, no Markdown, no link detection. `ui/tests/unit/source-bans.test.ts` walks the TypeScript syntax tree of `ui/src` and fails on `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`srcdoc`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function`, string timers, `DOMParser`, a Markdown or sanitizer import, and (in screens and components) any `href`/`src` taken from data. It is the equivalent of the eslint rules `react/no-danger` and `no-restricted-syntax` with no extra dependency, and it is tested against bad snippets first.

**Secrets.** The browser never holds a provider key: `GET /api/config` returns the variable NAME and a boolean. The optional bearer token lives in the API client's closure; the only storage the UI touches is the theme id (`gw-theme`). `scripts/scan-bundle.mjs` scans `ui/dist` with the confidentiality filter's secret rules, an entropy check and any planted canary (`--planted VALUE`); the Playwright flow plants a fake key in the server environment and asserts it is in no API response, storage, cookie or the bundle.

**Weak-scorer caveat.** `ui/src/screens/score/caveat.ts` holds the registry's `HUMANIZE_CAVEAT` text; `tests/security/ui-score-caveat.test.ts` fails if the two differ. Every humanize result also shows the caveat the server returned.

**Live region.** `Announcer` is one polite status region in the footer: generation finished or failed, ingest done, file loaded, copied. Buttons stay focusable while busy (`aria-disabled`, not React Aria's `isPending`, whose hidden announcer element fails axe's `role-img-alt`).

**Budget.** First-load JavaScript is about 115 KB gzipped (budget 250 KB, `ui/tests/build/perf.test.ts`); every screen is a separate chunk loaded on first visit.

## Decisions

- **Component library: React Aria Components** (Adobe, Apache-2.0, the same license as Spooky). Headless, so every pixel comes from our CSS custom properties and two very different themes need no overrides fighting a built-in look; keyboard, focus, ARIA and screen-reader behavior are the library's job. Checked and not chosen: Radix UI (MIT, lower level, fewer composed widgets), MUI (opinionated look, heavy theming), Chakra and Mantine (own theming runtime that competes with the token system).
- **Server**: `node:http` and one static handler (`src/api/static.ts`); no framework. Config stays read-only; there is no `config set`.
- **Token**: the optional bearer token covers `/api/*`, `/openapi.json` and `/mcp`, not the static assets (they are public code, no secret). With a token set, the Overview asks for it; it is kept in page memory only (never `localStorage`, a cookie or a URL) and a reload forgets it. Wrong tokens are throttled by the server. Running tokenless on loopback means any local process can use the server (see [API.md](API.md#threat-model-and-the-tokenless-default)).
- **Fonts**: self-hosted variable woff2 from `@fontsource-variable/{orbitron,inter,jetbrains-mono,fraunces}` (SIL OFL 1.1), latin and latin-ext subsets, bundled by Vite. No CDN, no runtime font request to another origin. Each font's license file ships in `dist/licenses/`, and the license of every bundled package in `dist/licenses/THIRD_PARTY_LICENSES.md`. Black Cat's display font is Fraunces (OFL serif); body and mono are shared with Tron.
- **Typed API client**: `ui/src/api/schema.d.ts` is generated by `openapi-typescript` from the operations registry's own OpenAPI document (`npm run gen:api`, after `npm run build`). The client's path, query, body and response types come from it, so a renamed route or field breaks `tsc`. `ui/src/api/openapi.json` is the committed snapshot; a root test fails if it differs from what the registry produces, a UI test fails if `schema.d.ts` differs from the snapshot.
- **Hash routing** (`#/kitchen-sink`): no router dependency, deep links need no server rewrite. The server still answers an extension-less path with `index.html`, but never under `/api`, `/openapi.json` or `/mcp`.
- **No `dangerouslySetInnerHTML`**: a test scans the source for it, `innerHTML`, `insertAdjacentHTML` and `document.write`. React escapes everything it renders.

## Content-Security-Policy

Served with every UI file (`UI_CSP` in `src/api/static.ts`):

```
default-src 'none'; script-src 'self'; style-src 'self' 'sha256-...'; img-src 'self'; font-src 'self';
connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'
```

No `unsafe-inline`, no `unsafe-eval`, no remote source. How the app fits: the theme bootstrap is a file (`/theme-init.js`), not an inline script; the bundle is built with no `data:` URIs; React and the theme engine only touch styles through the CSSOM (`element.style`), which CSP allows. React Aria injects two small `<style>` elements at runtime; both are handled without loosening the policy: the pressable rule ships as a linked stylesheet under the id React Aria checks (`/react-aria-pressable.css`, so it skips its own injection), and the iOS scroll-lock rule is allowed by its exact hash. A test recomputes both from the installed library, so an upgrade that changes them fails the build, not a phone. A real-browser test uses the app (navigate, switch theme, dialog, list, tooltip) and fails on any CSP violation, and proves an injected inline script, a remote script and an inline `<style>` are blocked.

The API answers with its own stricter `default-src 'none'` policy; the UI policy applies only to what the static handler serves.

## Static serving rules

`GET`/`HEAD` only; a path with `..`, a NUL, a backslash, an encoded slash or a leading dot in any segment is a 404, as is anything whose resolved real path leaves the UI directory (symlinks included). Hashed files under `/assets/` are `immutable`; everything else is `no-store`. See `tests/unit/api/static.test.ts` (20 traversal variants) and `tests/integration/ui-serve.test.ts`.

## Accessibility

React Aria supplies roles, keyboard and focus management. The shell has a skip link, a banner, a labelled `Primary` navigation (`aria-current="page"`), a main landmark that takes focus after navigation, and a footer. The theme switcher is a labelled select with a polite live region ("Theme changed to Tron Neon"). Focus rings come from `--gw-focus-ring`; the active nav item and tab carry a vertical slit marker. Tests: axe in jsdom for structure (both themes, overlays open, error states) and axe in real Chromium with `color-contrast` on, zero violations, both themes.

## Reduced motion

The only animations are the Tron floor grid, its glow pulse and the logo blink. The theme engine sets `--gw-motion-scale: 0` inline and `data-motion="reduced"` on `<html>` when `prefers-reduced-motion` is set (before first paint, and live if the preference changes); the stylesheet turns the marker and the media query into `animation: none`. Tests assert the computed animation of each layer in real Chromium in both modes.

## Tests (`npm run ui:test`, `npm --prefix ui run test:e2e`, both part of `scripts/verify.sh`)

| Tier | What |
|---|---|
| unit | theme contract (every token, no extras, hex colors, no remote url, manifest and files agree, a third theme is one file and a line), contrast (every declared pair, both themes, a failing pair fails the build), theme switch, persistence, storage that throws, invalid stored id, system preference, reduced motion, `theme-init.js` agrees with the engine, generated API types |
| component | ThemeSwitcher, shell landmarks and navigation, API client, Overview token flow, kitchen sink widgets; each feature screen with a mocked API (`tests/helpers/fixtures.ts`): loading, empty, success, every typed error code, retry, hostile text, keyboard, axe |
| security (ui) | source bans on the syntax tree, perf budget, CSP-compatible build |
| security (root) | `tests/security/ui-secrets.test.ts` (scanner, bundle, storage use), `ui-csp.test.ts`, `ui-score-caveat.test.ts`; `tests/integration/ui-parity.test.ts` (the UI calls only registry routes and every route has a screen) |
| a11y | axe, jsdom (structure) and Chromium (contrast), both themes, overlays |
| build | offline scan of the built bundle (no other origin; the scanner is shown to catch CDN fonts, `@import`, protocol-relative urls), CSP-compatible output (no inline script or style, no `eval`), license audit and font license files |
| e2e | Playwright against the real API server and built UI with the model scripted by `MockLlmClient` (`ui/tests/e2e/server/start.mjs`): visual baselines (shell, kitchen sink, overlays, every feature screen and the Generate error, result and topic-mode states; both themes; desktop 1280x800 and phone 390x844), axe with contrast per screen, theme and state, keyboard (tab order, focus indicator on every stop, skip link, select, live region), the ingest-generate flow (output equals the API result), offline, CSP over all screens, secrets (planted canary) |
| root | static handler traversal and headers, UI next to the API (`tests/unit/api/static.test.ts`, `tests/integration/ui-serve.test.ts`), OpenAPI snapshot drift |

**Visual baselines** (diff threshold: `maxDiffPixelRatio` 0.002, i.e. 0.2% of pixels, in `ui/playwright.config.ts`; the feature screens use the fixture API in `tests/e2e/mockApi.ts`, so numbers and timings are fixed) are committed PNGs in `ui/tests/e2e/__screenshots__/`, generated in the pinned official Playwright image (`mcr.microsoft.com/playwright:v<version>-noble`, version taken from the pinned `@playwright/test`) with `ui/scripts/e2e-container.sh --update-snapshots all` (docker or podman). Every font on the page is bundled, so a host Chromium of the same version renders the same pixels (verified: the host run matched the container baselines); `GW_E2E_CONTAINER=1 scripts/verify.sh` runs the suite in the container. Phase 11 re-checked this: the 26 feature-screen and 12 shell baselines made on the host pass unchanged in the container. `npm run ui:verify` is the CI-local run of the UI tiers. Review the PNG diff before committing a regeneration.

## Licenses

`ui/THIRD_PARTY.md` is generated from `ui/package-lock.json` and each package's own `package.json` (`npm run licenses` in `ui/`). Allowed: Apache-2.0, MIT, BSD-2/3-Clause, ISC, 0BSD, OFL-1.1 (fonts), CC0-1.0, BlueOak-1.0.0. GPL, AGPL, LGPL, unknown or missing licenses fail the audit, and so does a font without its license file. Development-only tools (Vite, Vitest, Playwright, axe-core (MPL-2.0), stylelint, ...) are not part of the bundle.
