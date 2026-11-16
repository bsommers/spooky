---
phase: 11-ui-features
plan: 01
subsystem: web-ui
tags: [react-aria, capability-gating, xss, csp, secrets, a11y, playwright, visual-baselines]
status: complete
requires:
  - phase: 10-ui-foundation
    provides: ui/ package, theme tokens, typed API client, strict CSP, static handler
  - phase: 08-humanize
    provides: score and humanize operations, HUMANIZE_CAVEAT
provides:
  - Five feature screens (Generate, Authors/Ingest, Personas, Settings, Score/Humanize), each a lazy chunk
  - CapabilitiesProvider + AuthGate (token prompt on 401, Score/Humanize gated on the capability list)
  - Shared ErrorBanner (typed codes), PlainText, Bars, Trace/Indicators, Announcer live region
  - ui/src/api/operations.ts generated from OpenAPI; UI parity test; scripts/scan-bundle.mjs
  - Real-server e2e rig (MockLlmClient, canary key) and 26 new committed visual baselines (10 shell baselines regenerated for the new nav)
affects: []
tech-stack:
  added: []
  patterns:
    - "untrusted text only ever reaches the DOM as a text node (PlainText / React escaping); a syntax-tree test bans every HTML-from-string route"
    - "busy buttons use aria-disabled, not React Aria isPending (its hidden announcer element fails axe role-img-alt)"
    - "one shared fixture module drives vitest, Playwright route mocks and the deterministic screenshots"
key-files:
  created:
    - ui/src/screens/{generate,authors,personas,settings,score}/
    - ui/src/components/ (ErrorBanner, AuthGate, TokenForm, PlainText, Bars, Trace, TextInput, Picker, CopyButton, Announcer, Section, useLoad, errors)
    - ui/src/api/capabilities.tsx, ui/src/api/operations.ts, ui/src/styles/screens.css
    - scripts/scan-bundle.mjs
    - ui/tests/e2e/server/start.mjs, ui/tests/e2e/{screens-visual,screens-a11y,keyboard,flow}.spec.ts, mockApi.ts
    - tests/security/ui-{secrets,csp,score-caveat}.test.ts, tests/integration/ui-parity.test.ts
  modified:
    - ui/src/app/{App,route,Shell}.tsx, ui/src/app/pages/Overview.tsx (now reads the shared capability state)
    - ui/scripts/gen-api.mjs, scripts/verify.sh, package.json (ui:verify), docs/UI.md, docs/SURFACES.md
key-decisions:
  - "Screens are lazy chunks; first-load JS is about 115 KB gzip (budget 250 KB)"
  - "eslint rules replaced by a TypeScript-syntax-tree ban test (no eslint dependency could be installed)"
  - "Existing UI_CSP kept (stricter than the plan's table); no src/api/csp.ts split"
  - "Visual baselines generated on the host; the pinned container reproduces them pixel for pixel"
metrics:
  duration: "about 3 h"
  completed: 2026-11-15
  tasks: 7
commits: 9
plan_head_before: ca58452db25a5f72e80843128e18316e91e12076
plan_head_after: 69de00efb144302c78d3bba0e5cadf2ad2277323
actuals:
  tasks: 7
  commits: 9
---

# Phase 11 Plan 01: UI feature screens Summary

Every operation is now usable from the web UI: Generate, Authors/Ingest (with profile), Personas, Settings (read-only) and Score/Humanize (gated on the capability list, weak-scorer caveat always on screen), in both themes, with model output rendered strictly as text.

## What was built

- **Gating and auth**: one capability fetch per page load; a 401 puts the token form in front of any feature screen; Score and Humanize turn off with an explanation when the server does not list them (nav entry stays).
- **Generate**: author and persona selects from the API, draft box with live count against `limits.maxInputChars` (empty or over-cap cannot submit), humanize switch only when offered, plain-text output with copy, trace table with a filter box, banned-phrase and confidentiality counts (sums every entry of a filter that runs twice), typed error banner that keeps the draft.
- **Authors/Ingest**: list (arrow keys select), profile via `GET /api/profile` as numbers beside SVG bars, ingest form (id pattern, name, pasted text or a file read in the browser; 4 MB and binary refusal; busy state; typed errors).
- **Personas, Settings**: read-only; Settings shows the key variable NAME with set/not-set in words, theme radios, an in-memory token field.
- **Score/Humanize**: per-feature contribution and delta bars, iteration history with meaning-guard reverts, server caveat per result plus the registry text always on screen (a root test pins it to `HUMANIZE_CAVEAT`).
- **Safety**: `source-bans.test.ts` (syntax-tree), `scripts/scan-bundle.mjs` (filter secret rules, entropy, planted canary), root CSP/secret/parity tests, perf budget test.

## Verification (`scripts/verify.sh`, one run, PASS)

| Tier | Result |
|---|---|
| typecheck, ui typecheck, css lint, gen-api drift, license audit | ok |
| ui vitest (unit, component, a11y, build) | 406/406 (was 167) |
| ui e2e (Playwright) | 98/98 (was 34); 26 new committed PNG baselines (10 existing ones regenerated) |
| smoke / unit / integration / system / security / torture | 4 / 957 / 295 / 67 / 493 / 5 passed |
| skipped | 0 |

Host-rendered baselines also pass unchanged in the pinned Playwright container (`ui/scripts/e2e-container.sh`).

## Deviations from Plan

**1. [Rule 3 - Blocking] No eslint rules.** Installing eslint, typescript-eslint and eslint-plugin-react was denied by the permission system, so `ui/eslint.config.js` was not created. The same bans (and more: `outerHTML`, `srcdoc`, `new Function`, string timers, `DOMParser`, Markdown/sanitizer imports, data-driven `href`/`src`) are enforced by `ui/tests/unit/source-bans.test.ts` on the TypeScript syntax tree, which is tested against bad snippets. A real eslint config can be added later if the dependency is approved.

**2. [Rule 4 avoided] State directory is not shown.** The plan lists "state dir shown read-only"; `GET /api/config` does not return it (adding it is a registry/OpenAPI/CLI change). Settings says it is set by `--state-dir` / `GHOSTWRITER_STATE_DIR` on the server and that the API does not report the path.

**3. CSP module not split.** The Phase 10 `UI_CSP` in `src/api/static.ts` is stricter than the plan's table (`default-src 'none'`, no `data:` images, `form-action 'none'`); `tests/security/ui-csp.test.ts` pins it (including on every lazy chunk) instead of introducing `src/api/csp.ts`.

**4. [Rule 1 - Bug] React Aria `isPending` fails axe.** It injects a `role="img"` announcer without a name (`role-img-alt`, serious). Found by the real-browser axe run; buttons now use `aria-disabled` with a guarded submit. Commit bed1580.

**5. [Rule 1 - Bug] Trace counts.** Confidentiality runs before and after the model; the indicator first read only the first entry. It now sums all entries of a filter. Commit bed1580.

**6. e2e server.** The real binary has no mock-model hook, so e2e uses `ui/tests/e2e/server/start.mjs` (real API server and static handler, `MockLlmClient`, canary key in the environment). Visual and axe specs answer `/api` from fixtures for deterministic numbers.

**7. Gated tests are not skipped.** Phase 8 is built, so the absent-capability case is tested with a mocked capability list, never `skip` (verify.sh counts 0 skipped).

## Open issues

- Eslint config absent (see 1); the syntax-tree test is the enforcement.
- The `state dir` display is not available without an API change (see 2).
- A rejected-token 429 lockout is shown through the token form; Settings' token field has no 429 messaging of its own.
- Baselines depend on Chromium 159 / Playwright 1.65.1; regenerate with `ui/scripts/e2e-container.sh --update-snapshots all` after a pin change.
- scan-bundle takes about 8 s on the 400 KB entry chunk (the filter reads minified code line by line).

## Known Stubs

None.

## Threat Flags

None beyond the plan's model; no new endpoint. The static handler and API are unchanged.

## Self-Check: PASSED

Files present: ui/src/screens/{generate,authors,personas,settings,score}, scripts/scan-bundle.mjs, ui/tests/e2e/server/start.mjs, the PNGs under ui/tests/e2e/__screenshots__. Commits 244ac1f, 7b44c92, 15d1e0e, 462c358, 78c6f5b, 6393b8e, bed1580, 73db29b, 69de00e are ancestors of HEAD.
