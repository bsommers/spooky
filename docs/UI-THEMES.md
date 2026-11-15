# UI themes

Contract: a theme is one CSS file defining `--gw-*` tokens under `:root[data-theme="<id>"]` plus a manifest entry. See `.planning/phases/10-ui-foundation/10-01-PLAN.md` for the token list. Contrast (WCAG AA) is asserted by test; values below are the starting palette and must be adjusted until the test passes.

## Tron Neon (extracted from https://bsommers.github.io/lumagrid, 2026-11-14)
The page is a JS SPA, so WebFetch returned only the title; the compiled stylesheet `assets/index-*.css` was fetched directly and read. These are the site's actual values.

| Token | lumagrid value | Use |
|---|---|---|
| bg | `#05070A` (`--lg-bg`), pure `#000000` alt | page |
| card/surface | `#0B0F14` | panels |
| border | `#1F2A37` | borders |
| text / body / muted | `#E6EDF3` / `#C9D1D9` / `#9AA4B2` | text |
| accent cyan | `#00E5FF`, light `#7DF9FF` | accent, focus, glow |
| accent-2 magenta | `#FF2BD6` | secondary accent |
| fonts | Orbitron Variable (display), Inter Variable (body), JetBrains Mono Variable (mono), all woff2, bundled same-origin | |

Grid/glow: fixed `.grid-bg` layer behind content; `:before` is a perspective floor grid: two `linear-gradient`s of `rgb(0 229 255 / .22)` 1px lines, `background-size: var(--cell)` (32px mobile, 48px desktop), `transform: perspective(500px) rotateX(62deg)`, `transform-origin: 50% 100%`, height 200%, scrolls via `@keyframes grid-scroll` (8s linear infinite, translateY one cell); `:after` is `radial-gradient(60% 40% at 50% 100%, rgb(0 229 255 / .18), transparent 70%)` pulsing opacity .55 to 1 over 6s (`glow`, alternate). Both animations are disabled under reduced motion (`animation:none`). Theme-color `#05070A`.
Fonts are SIL OFL (Orbitron, Inter, JetBrains Mono); self-host via fontsource.
Contrast notes: `#00E5FF` on `#05070A` is about 12:1 (fine for text); `#FF2BD6` on `#05070A` about 6:1; muted `#9AA4B2` about 7:1. Verify by test, not these estimates.

## Black Cat (original design; palette is a documented proposal)
| Token | Proposed | Use |
|---|---|---|
| bg | `#0A0A0C` | page (deep black) |
| surface / raised | `#131316` / `#1B1B20` | panels |
| border | `#2A2A31` | borders |
| text / muted | `#ECE7DC` / `#A8A398` | warm off-white |
| accent amber (eyes) | `#FFB000`, bright `#FFD24A` | accent, focus, slit-pupil indicator |
| accent-2 moon | `#8FA3C7` | secondary, night haze tint |
| danger / warning / success | `#FF6B6B` / `#FFB000` / `#7BD88F` | status |
Motifs: vertical slit-pupil in focus rings and active-tab markers; faint whisker lines (SVG strokes at 6-8% opacity) near headers; paw-print list bullets; cat silhouette watermark bottom-right at 4-6% opacity; moon disc with a soft radial night haze behind the header; no animation except a slow blink on the logo eyes (off under reduced motion). All art is original SVG authored in the repo (no third-party or copyrighted art). Display font: OFL serif chosen at execution (see SURFACES open decision 4).
