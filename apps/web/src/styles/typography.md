# Typography spec — v2

The single source of truth for the app's typographic system. v2 keeps the
Schibsted Grotesk + JetBrains Mono pairing but moves the pipeline off Google
Fonts and onto self-hosted files, matches Schibsted Grotesk's variable
weight range, and pins the five-step ramp against the v2 mockup.

## Stack

| Role  | Family             | Loaded weights     | Fallback chain                                                        |
|-------|--------------------|--------------------|-----------------------------------------------------------------------|
| sans  | Schibsted Grotesk  | 400–900 (variable) | Schibsted Grotesk Fallback (Arial-metrics) → system-ui → sans-serif   |
| mono  | JetBrains Mono     | 400–700            | JetBrains Mono Fallback (Menlo-metrics) → ui-monospace → monospace    |

Newsreader is not loaded. `italic` for Schibsted Grotesk is available but
carries a separate subset — we ship only `normal` in v2 because no live
surface uses italics; add the italic files if that changes.

## Self-hosted pipeline

Fonts live in `apps/web/public/fonts/` and are declared in
`apps/web/src/app.css`. `apps/web/index.html` preloads the two `latin`
subsets so the first paint doesn't wait on the CSS parse. No page or
component may import a font any other way — no `<link>` to `fonts.googleapis
.com`, no imported `.css` from `@fontsource/*`.

Files in the pipeline:

| File | Family | Subset | Size |
|------|--------|--------|------|
| `schibsted-grotesk-latin.woff2`      | Schibsted Grotesk | latin      | ~46 KB |
| `schibsted-grotesk-latin-ext.woff2`  | Schibsted Grotesk | latin-ext  | ~21 KB |
| `jetbrains-mono-latin.woff2`         | JetBrains Mono    | latin      | ~31 KB |
| `jetbrains-mono-latin-ext.woff2`     | JetBrains Mono    | latin-ext  | ~12 KB |

Total cold-cache payload: ~110 KB — inside the 120 KB budget. Bytes come
straight from the `Maskin App v2 Standalone.html` bundle (which ships the
same Google Fonts subsets); no re-subsetting was needed.

## Five-step weight ramp

Tailwind class shown alongside the absolute values so call sites can pin to
the named token.

| Step       | Tailwind                     | Size  | Line-height | Weight | Letter-spacing | Notes                              |
|------------|------------------------------|-------|-------------|--------|----------------|------------------------------------|
| page title | `text-2xl` / `font-semibold` | 24px  | 1.2         | 600    | -0.022em       | One per page                       |
| section    | `text-lg`  / `font-medium`   | 18px  | 1.3         | 500    | -0.013em       | Major section headers              |
| body       | `text-sm`  / `font-normal`   | 14px  | 1.55        | 400    | -0.006em       | Default body, prose                |
| label      | `text-xs`  / `font-medium`   | 12px  | 1.4         | 500    | -0.003em       | Form labels, metadata, chip counts |
| caption    | `text-xs`  / `font-normal`   | 12px  | 1.4         | 400    | -0.003em       | Helper text, timestamps            |

The v2 mockup adds a **micro-eyebrow** for section labels inside menus (the
mockup's "VIEW / SHOW / SORT" markers): 8px JetBrains Mono at 700 with
0.11em tracking, uppercase. It ships as an `.eyebrow` utility in `app.css`,
not a new ramp step — use it verbatim, don't nest more sizes.

Tracking-by-size curves from -0.022em at 24px down to -0.003em at 12px.
Call sites between named steps pick the closest step.

## Dark-mode body weight

Body weight stays 400 in dark mode — heavier weights measurably reduce
reading fluency on dark fields.

## Numeric column treatment

JetBrains Mono carries `font-variant-numeric: tabular-nums` by default
(applied to `.font-mono`, `code`, `kbd`, `samp`, `pre` in `app.css`). Sans
numerals on table columns also need tabular-nums — apply Tailwind's
`tabular-nums` utility on those cells.

## Long-form measure cap

Long-form prose (object descriptions, hypothesis bodies, retros) caps at
`max-w-[75ch]` on viewports ≥1280px (Tailwind `xl:max-w-[75ch]`). Below
that breakpoint, content fills available width.

## Tokens

CSS variables defined in `apps/web/src/app.css`:

- `--font-sans` — full sans fallback chain
- `--font-mono` — full mono fallback chain
- `.eyebrow` — the v2 uppercase micro-label utility

Tailwind classes `font-sans` and `font-mono` resolve to these. The `<body>`
element uses `font-sans` by default.

## CLS budget

Cold-cache font swap must produce <0.05 CLS. The `@font-face` fallback
families (`Schibsted Grotesk Fallback`, `JetBrains Mono Fallback`) in
`app.css` carry `size-adjust` / `ascent-override` / `descent-override`
overrides tuned so the fallback render box approximates the webfont box.
These values were carried over from the pre-v2 pipeline and are known to be
inside budget — re-pin them if the font files change.
