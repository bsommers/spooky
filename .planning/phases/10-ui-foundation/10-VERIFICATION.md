---
phase: 10-ui-foundation
verified: 2026-11-15T15:30:00Z
status: human_needed
score: 8/8 must-haves verified
covered_files:
  - .planning/phases/10-ui-foundation/10-01-PLAN.md
  - .planning/phases/10-ui-foundation/10-01-SUMMARY.md
  - scripts/verify.sh
  - src/api/static.ts
  - src/cli/serve.ts
  - ui/THIRD_PARTY.md
  - ui/index.html
  - ui/src/api/client.ts
  - ui/src/theme/contract.ts
  - ui/src/theme/contrast.ts
  - ui/src/theme/engine.ts
  - ui/src/theme/themes/black-cat.css
  - ui/src/theme/themes/tron-neon.css
covered_digest: "v3:sha256:933cc992a55c0da252b9ec69542683539363d3b7260e1759902c8818ed11037e"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Open the served app (ghostwriter serve) and look at shell + kitchen-sink in both themes"
    expected: "Black Cat reads as restrained charcoal/amber with slit-pupil focus markers, moon/haze, faint watermark; Tron Neon reads as the lumagrid look (perspective neon grid, cyan glow, Orbitron)"
    why_human: "Visual design quality and the claim that Tron matches the live lumagrid site (extracted 2026-11-14) cannot be judged by tests; screenshot baselines only detect change, not quality"
  - test: "Decide whether the --gw-border exemption is acceptable"
    expected: "--gw-border is only 1.20-1.39:1 against bg/surface/raised in BOTH themes (computed from the token files); ui/src/theme/contrast.ts declares it a decorative separator exempt from WCAG 1.4.11 and only enforces a 1.1:1 floor. Every control is text-labelled, and --gw-accent (3:1+) is the boundary token. Accept, or require >=3:1 borders."
    why_human: "This is a judgment on WCAG 1.4.11 interpretation that weakens the plan's literal 'UI >= 3' test row and the REQUIREMENTS UI-04 wording ('3:1 UI'). Not an override-file entry; needs an explicit maintainer decision"
  - test: "Navigate the shell with a real screen reader and keyboard only"
    expected: "Skip link, landmarks, nav aria-current, theme switcher live-region announcement and Dialog/Tooltip behave sensibly"
    why_human: "axe + component tests prove no rule violations, not an actual assistive-tech experience"
---

# Phase 10: UI foundation and theming Verification Report

**Phase Goal:** an accessible, offline, themeable app shell served by the Phase 9 server; no feature screens yet beyond a themed kitchen-sink and shell nav.
**Verified:** 2026-11-15
**Status:** human_needed
**Re-verification:** No, initial verification

## Gate run

`scripts/verify.sh` exit 0, `verify: PASS`. Root: smoke 4, unit 957, integration 291, system 67, security 472, torture 5 (1796 tests, 70 files, 0 skipped). UI: typecheck ok, css lint (no raw colors in components) ok, `ui 167/167`, Playwright `ui e2e 34/34` (visual, a11y with contrast, offline, CSP, themes).

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | UI-01: Vite+React+TS SPA in `ui/`, built to static files served at `/` by the API server | VERIFIED | `ui/dist/index.html` + hashed assets exist; `src/api/static.ts` mounts it via `staticHandler`; `src/cli/serve.ts --ui-dir/--no-ui`; `tests/system/surfaces.test.ts` "serve --ui-dir serves the built web UI at /" and `tests/integration/ui-serve.test.ts` (6) pass; separate `ui/package.json`/tsconfig |
| 2 | UI-02: React Aria Components only UI kit | VERIFIED | THIRD_PARTY.md lists react-aria-components (Apache-2.0); no second kit in prod deps; shell uses Select/Switch/Dialog/Tooltip/Tabs |
| 3 | UI-03: themes switch via `data-theme` on `<html>`, persisted best-effort, system default, reduced motion | VERIFIED | `engine.ts:72` `root.setAttribute('data-theme', id)`; localStorage access wrapped in try/catch (`engine.ts:16-19`); `theme-init.js` same-origin no-flash script in `index.html`; `ui/tests/unit/engine.test.ts`, `component/theme.test.tsx`, `e2e/theme.spec.ts` pass; reduced motion sets `data-motion=reduced` |
| 4 | UI-03: theme contract = one token file + one manifest line, schema-validated; third theme needs nothing else | VERIFIED | `contract.ts` (zod), `manifest.ts` (2 lines), `themes/*.css`; `tests/unit/contract.test.ts` + `helpers/tmpTheme.ts` exercise adding a theme; build-time `theme-check` |
| 5 | UI-04: Black Cat and Tron Neon shipped with the full `--gw-*` token set | VERIFIED | Both CSS files define all tokens (amber #ffb000 accent / Fraunces; Tron Orbitron/Inter/JetBrains Mono, grid tokens); contract test requires every token, no extras |
| 6 | UI-04: every declared text/UI pair meets WCAG AA, asserted by unit test over token files | VERIFIED with caveat | `contrast.ts` CONTRAST_PAIRS: text/muted/accent/accent-2/danger/warning/success at 4.5, focus-ring and accent boundary at 3 on bg/surface/raised; `contrast.test.ts` passes. Caveat: `--gw-border` only held to a 1.1 floor (actual 1.20-1.39:1); see Human Verification #2 |
| 7 | UI-05: original SVG logo, icon set, favicon set | VERIFIED | `dist/favicon.svg`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192/512.png`, `dist/art/*`, `ui/src/icons/index.tsx`; hand-authored per SUMMARY and no third-party art deps |
| 8 | UI-06: offline, fonts self-hosted, licenses recorded, built output references no external origin, CSP, typed client | VERIFIED | `dist/assets/*.woff2` (Fraunces, Inter, JetBrains Mono, Orbitron); scan of dist html/css/js: only w3.org xmlns and a `react.dev/errors` string literal inside React's error text (never fetched); `offline.test.ts`/`offline.spec.ts` pass (network blocked run); `UI_CSP` in `static.ts` has `default-src 'none'`, no unsafe-inline, `index.html` has no inline script; `csp-compat.test.ts` + `csp.spec.ts` pass; `licenses.test.ts` + THIRD_PARTY.md; `ui/src/api/client.ts` types from generated `schema.d.ts`, token in memory only (no web storage use for it) |

**Score:** 8/8 verified (0 behavior-unverified; behavior-dependent truths 3 and 8 are backed by passing named unit/e2e tests)

## Required Artifacts

All present, substantive, wired: `src/api/static.ts`, `src/cli/serve.ts` mount, `ui/src/theme/{contract,contrast,engine,manifest,ThemeProvider}`, `ui/src/theme/themes/{black-cat,tron-neon}.css`, `ui/src/api/{client,schema.d.ts,openapi.json}`, `ui/THIRD_PARTY.md`, `docs/UI.md`, `docs/UI-THEMES.md`, e2e baselines in `ui/tests/e2e/__screenshots__`.

## Anti-patterns

No TBD/FIXME/XXX in phase files. `ui/dist` and `ui/test-results` are gitignored build output (dist is rebuilt by vitest global setup and `prepack`).

## Deviations from plan text (non-blocking, noted)

- Plan "UI >= 3" contrast row is met for focus ring and accent boundary but not for `--gw-border` (documented exemption, Human #2).
- Six extra background/animation tokens added beyond the plan's list (documented in SUMMARY; contract test covers them).
- Hash routing, Playwright run on host Chromium by default rather than the container (baselines were generated in the pinned container; same Chromium version).
- Not independently verified: the "extracted from live lumagrid" palette fidelity (no network use).

## Gaps Summary

No gaps. Automated goal achievement is complete and green; status is `human_needed` solely for the three judgment items above.

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
