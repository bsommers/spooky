---
phase: 11-ui-features
verified: 2026-11-15T20:00:00Z
status: human_needed
score: 8/8 must-haves verified (2 with documented deviations awaiting a human decision)
covered_files:
  - ".gitignore"
  - ".planning/phases/11-ui-features/11-01-PLAN.md"
  - ".planning/phases/11-ui-features/11-01-SUMMARY.md"
  - "docs/SURFACES.md"
  - "docs/UI.md"
  - "package.json"
  - "scripts/scan-bundle.mjs"
  - "scripts/verify.sh"
  - "tests/helpers/rootBuild.ts"
  - "tests/helpers/staleness.ts"
  - "tests/helpers/uiBuild.ts"
  - "tests/integration/ui-parity.test.ts"
  - "tests/security/ui-csp.test.ts"
  - "tests/security/ui-score-caveat.test.ts"
  - "tests/security/ui-secrets.test.ts"
  - "ui/playwright.config.ts"
  - "ui/scripts/gen-api.mjs"
  - "ui/src/api/capabilities.tsx"
  - "ui/src/api/client.ts"
  - "ui/src/api/operations.ts"
  - "ui/src/app/App.tsx"
  - "ui/src/app/Shell.tsx"
  - "ui/src/app/pages/Overview.tsx"
  - "ui/src/app/route.ts"
  - "ui/src/components/Announcer.tsx"
  - "ui/src/components/AuthGate.tsx"
  - "ui/src/components/Bars.tsx"
  - "ui/src/components/Caveat.tsx"
  - "ui/src/components/CopyButton.tsx"
  - "ui/src/components/ErrorBanner.tsx"
  - "ui/src/components/NumberInput.tsx"
  - "ui/src/components/Picker.tsx"
  - "ui/src/components/PlainText.tsx"
  - "ui/src/components/Section.tsx"
  - "ui/src/components/TextInput.tsx"
  - "ui/src/components/TokenForm.tsx"
  - "ui/src/components/Trace.tsx"
  - "ui/src/components/errors.ts"
  - "ui/src/components/useAbortable.ts"
  - "ui/src/components/useLoad.ts"
  - "ui/src/screens/authors/AuthorsScreen.tsx"
  - "ui/src/screens/generate/GenerateScreen.tsx"
  - "ui/src/screens/personas/PersonasScreen.tsx"
  - "ui/src/screens/score/ScoreScreen.tsx"
  - "ui/src/screens/score/caveat.ts"
  - "ui/src/screens/settings/SettingsScreen.tsx"
  - "ui/src/styles/components.css"
  - "ui/src/styles/index.css"
  - "ui/src/styles/screens.css"
  - "ui/src/styles/shell.css"
  - "ui/tests/build/perf.test.ts"
  - "ui/tests/component/api.test.tsx"
  - "ui/tests/component/authors.test.tsx"
  - "ui/tests/component/generate.test.tsx"
  - "ui/tests/component/personas.test.tsx"
  - "ui/tests/component/score.test.tsx"
  - "ui/tests/component/settings.test.tsx"
  - "ui/tests/component/shared.test.tsx"
  - "ui/tests/component/shell.test.tsx"
  - "ui/tests/e2e/flow.spec.ts"
  - "ui/tests/e2e/helpers.ts"
  - "ui/tests/e2e/keyboard.spec.ts"
  - "ui/tests/e2e/mockApi.ts"
  - "ui/tests/e2e/screens-a11y.spec.ts"
  - "ui/tests/e2e/screens-visual.spec.ts"
  - "ui/tests/e2e/server/constants.mjs"
  - "ui/tests/e2e/server/start.mjs"
  - "ui/tests/e2e/token.spec.ts"
  - "ui/tests/helpers/app.tsx"
  - "ui/tests/helpers/fixtures.ts"
  - "ui/tests/helpers/screens.tsx"
  - "ui/tests/setup/dom.ts"
  - "ui/tests/unit/api-types.test.ts"
  - "ui/tests/unit/source-bans.test.ts"
  - "vitest.config.ts"
covered_digest: "v3:sha256:0ed2929d5a2c9b9fe19a70c94acf861078372d3a1169a4b581c21bdf49c0e0c9"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Open every screen (Generate incl. result/error, Authors, Personas, Settings, Score, Humanize) in both themes at desktop and phone width and look at them."
    expected: "Layout, hierarchy, spacing and wording are acceptable; nothing clipped or confusing. Committed PNG baselines only prove stability, not quality."
    why_human: "Visual quality is a judgment; 38 baselines are compared to themselves."
  - test: "Drive Generate, Ingest and the Score/Humanize tabs with a real screen reader (NVDA/VoiceOver/Orca)."
    expected: "Labels, the live-region completion/error announcements, the alert on failure (said once) and the 'Connected' announcement are audible and sensible."
    why_human: "axe and DOM-level live-region assertions cannot prove real assistive-tech output."
  - test: "Run the real binary against a real provider (not MockLlmClient): ingest an author, generate, and (if Phase 8 scorer is live) humanize."
    expected: "Output matches the API result; caveat visible; no key in any response, storage or bundle."
    why_human: "All e2e uses MockLlmClient with a canary key; no real LLM run exists in this phase."
  - test: "Decide on two documented deviations: (a) Settings does not display the state directory (UI-10 / plan Screens table say 'state dir shown read-only'); GET /api/config does not return it, so it needs an API/registry change. (b) UI-12 says 'lint rule enforces' no dangerouslySetInnerHTML; eslint could not be installed and a TypeScript-syntax-tree test (ui/tests/unit/source-bans.test.ts, run in verify.sh) enforces the bans instead."
    expected: "Accept both as-is (add an overrides: entry) or schedule follow-up work (expose stateDir read-only via config; add eslint config)."
    why_human: "Requirement text is not met literally; accepting the equivalent is a product decision."
---

# Phase 11: UI features Verification Report

**Phase Goal:** every user-facing operation usable from the UI, accessibly and safely, in both themes (ROADMAP: every screen axe-clean in both themes, keyboard-complete, screenshots stable, no API key or model-output HTML injection path).
**Verified:** 2026-11-15
**Status:** human_needed
**Re-verification:** No, initial verification

## Gate run

`scripts/verify.sh` (full, with UI and Playwright) run by the verifier in its own process: **exit 0, "verify: PASS"**. Typecheck, ui typecheck, css lint, gen-api drift, license audit ok. Root tiers: smoke 4, unit 957, integration 295, system 67, security 501, torture 5 (all passed, skipped 0). ui e2e (Playwright) 102/102. This matches the SUMMARY/REVIEW-FIX numbers (UI vitest 441 per REVIEW-FIX; the log tail printed here covers the root tiers and e2e).

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Generate, Authors/Ingest(+profile), Personas, Settings, Score/Humanize screens exist and call the real API | VERIFIED | `ui/src/screens/{generate,authors,personas,settings,score}` present; `ui/src/api/operations.ts` generated from OpenAPI; `tests/integration/ui-parity.test.ts` green; `ui/tests/e2e/flow.spec.ts` runs ingest -> generate against a real API server with MockLlmClient |
| 2 | Every screen axe-clean in both themes, incl. error/busy/result states | VERIFIED | `ui/tests/e2e/screens-a11y.spec.ts` loops `THEME_IDS` x all `SCREENS` (idle) plus generate over-cap/result/error/busy, real Chromium so color-contrast included; 102/102 pass |
| 3 | Keyboard-complete | VERIFIED (automated) | `keyboard.spec.ts`: skip link first stop, per-screen Tab order with visible focus and no trap, select Enter/arrows/Esc, Space on Generate, Enter submits ingest, tab arrows. Real AT not exercised (human item 2) |
| 4 | Screenshots stable | VERIFIED | 38 committed PNG baselines (every screen x 2 themes, desktop+phone, Generate error/result, humanize result); pass in verify run; SUMMARY says container reproduces them pixel-for-pixel (not re-run here) |
| 5 | No model-output HTML injection path | VERIFIED | `grep` of `ui/src` finds no `dangerouslySetInnerHTML/innerHTML/outerHTML/eval`; `PlainText` renders text nodes; `source-bans.test.ts` bans HTML-from-string, markup/sanitizer packages, data-driven `href/src`, setAttribute, dynamic import. Enforcement is a syntax-tree test, not eslint (see deviation b) |
| 6 | No API key path to the browser | VERIFIED | Settings shows key variable NAME and set/not-set only; token held in a closure variable in `ui/src/api/client.ts` (memory only); only `localStorage` use is theme id (`ui/src/theme/engine.ts`); `tests/security/ui-secrets.test.ts` + `scripts/scan-bundle.mjs` (entropy, filter regexes, planted canary) + Playwright storage inspection in `flow.spec.ts` pass |
| 7 | Capability gating (Phase 8 absent/present) | VERIFIED | `ui/src/api/capabilities.tsx` single fetch; Score/Humanize panels disabled with explanation when absent, nav kept; tested with mocked capability list (not skipped, 0 skipped) |
| 8 | HUMANIZE_CAVEAT shown | VERIFIED | `ui/src/components/Caveat.tsx` renders `ui/src/screens/score/caveat.ts`; `tests/security/ui-score-caveat.test.ts` asserts text equals registry `HUMANIZE_CAVEAT` and that Score and Generate both use the shared component |
| 9 | CSP strict and zero violations; perf budget | VERIFIED | `tests/security/ui-csp.test.ts` pins `UI_CSP` (stricter than plan table) incl. lazy chunks; `csp.spec.ts` e2e; `perf.test.ts` budget (SUMMARY: ~115 KB gzip vs 250 KB); screens lazy |
| 10 | UI-14 parity: UI uses only registry operations | VERIFIED | `ui-parity.test.ts` green (grep-based; review IN-02 notes a commented call could pass, minor) |

**Score:** 8/8 requirements (UI-07..UI-14) verified for the roadmap contract; two requirement-text deviations flagged below.

## Requirements Coverage

| Req | Status | Note |
|-----|--------|------|
| UI-07 Generate | SATISFIED | counts-only indicators; trace; typed error banner |
| UI-08 Ingest/Authors/profile | SATISFIED | |
| UI-09 Personas | SATISFIED | |
| UI-10 Settings | PARTIAL | Provider/theme/key-name/memory token done; **state dir not displayed** (API does not return it); screen states where it is set |
| UI-11 Score/Humanize gated | SATISFIED | |
| UI-12 Security | SATISFIED w/ deviation | text-only, CSP, bundle scan done; "lint rule" replaced by syntax-tree test (eslint install denied) |
| UI-13 Tests | SATISFIED | |
| UI-14 Parity | SATISFIED | |

No orphaned requirements.

## Anti-Patterns / Residual items

- No TBD/FIXME/XXX gate hits investigated beyond the verify run; no blockers found.
- Review items deliberately left open: LW-05 (ingest pre-checks narrower than server rules; server returns typed error late), LW-07 (comment stripper in `ui-secrets` can hide a storage use on odd lines; localStorage is only in theme engine today), IN-01..IN-04 (stale header comment, grep-based parity, `data-testid` in prod DOM, `fmt` precision). Warnings, none block the goal.
- Settings token field has no 429 lockout message of its own (SUMMARY open issue).
- Baselines depend on Chromium 159 / Playwright 1.65.1.

## Human Verification Required

See `human_verification` in frontmatter: visual review, real screen reader, a real (non-mock) LLM run, and the decision on the two requirement-text deviations (state dir display, eslint rule). If both deviations are accepted, add:

```yaml
overrides:
  - must_have: "Settings: state dir (read-only display)"
    reason: "GET /api/config does not expose it; UI states where it is set; API change deferred"
    accepted_by: "<name>"
    accepted_at: "<ISO>"
  - must_have: "lint rule enforces no dangerouslySetInnerHTML"
    reason: "eslint install denied; syntax-tree test in verify.sh enforces a superset of bans"
    accepted_by: "<name>"
    accepted_at: "<ISO>"
```

---

_Verified: 2026-11-15_
_Verifier: Claude (gsd-verifier)_
