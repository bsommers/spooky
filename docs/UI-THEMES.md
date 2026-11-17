# UI themes

Contract (`ui/src/theme/contract.ts`): a theme is ONE CSS file `ui/src/theme/themes/<id>.css` holding exactly one rule, `:root[data-theme="<id>"] { --gw-*: value; }`, plus one line in `ui/src/theme/manifest.ts` (`{ id, label, colorScheme }`). Adding a third theme is that file and that line, nothing else (a test does exactly this). Every token below must be defined, none may be added, color tokens are opaque `#rrggbb`, no value may name another origin, and a file or manifest line without its partner fails the build. Components read only `--gw-*` (stylelint forbids raw colors outside theme files). Contrast (WCAG 2.x AA) is asserted by test and by the build over every declared pair; the values below are the shipped palettes after that check.

| Group | Tokens |
|---|---|
| surfaces | `--gw-bg --gw-bg-raised --gw-surface --gw-border` |
| text | `--gw-text --gw-text-muted` |
| accents | `--gw-accent --gw-accent-text --gw-accent-2` |
| status | `--gw-danger --gw-warning --gw-success` |
| focus and shape | `--gw-focus-ring --gw-glow --gw-radius` |
| fonts, motion | `--gw-font-display --gw-font-body --gw-font-mono --gw-motion-scale` |
| background art | `--gw-bg-art --gw-bg-grid --gw-bg-grid-cell --gw-bg-grid-transform --gw-bg-mark --gw-anim-grid --gw-anim-glow` |

The plan listed one `--gw-bg-art` token; Tron's perspective floor needs the grid plane, its cell size, its transform and the two animations to be separate (the plane is tilted, the glow is not), and Black Cat's watermark is an image, so six background tokens were added to the contract rather than putting theme names in component CSS. Required contrast pairs: text, muted, accent, accent-2, danger, warning, success at 4.5:1 on bg, surface and bg-raised; accent-text on accent at 4.5:1; focus ring and accent (as a UI boundary) at 3:1. `--gw-motion-scale` is overridden to 0 inline when the user prefers reduced motion.

Shipped values (the files are the source of truth; the tests read them):

| Token | Black Cat | Tron Neon |
|---|---|---|
| bg / bg-raised / surface / border | `#0a0a0c` / `#1b1b20` / `#131316` / `#2a2a31` | `#05070a` / `#121a24` / `#0b0f14` / `#1f2a37` |
| text / muted | `#ece7dc` / `#a8a398` | `#e6edf3` / `#9aa4b2` |
| accent / accent-text / accent-2 | `#ffb000` / `#1a1100` / `#8fa3c7` | `#00e5ff` / `#031014` / `#ff2bd6` |
| danger / warning / success | `#ff6b6b` / `#ffb000` / `#7bd88f` | `#ff5c7a` / `#ffc233` / `#3ddc97` |
| focus ring | `#ffd24a` | `#7df9ff` |
| radius | 8px | 4px |
| display / body / mono | Fraunces Variable / Inter Variable / JetBrains Mono Variable | Orbitron Variable / Inter Variable / JetBrains Mono Variable |

The remainder of this page records where the design came from.

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
