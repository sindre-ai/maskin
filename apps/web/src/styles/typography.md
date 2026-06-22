# Typography spec

The single source of truth for the app's typographic system. T3 wires the
loader and tokens. T4–T6 apply the ramp to surfaces. T7 sweeps tabular-nums
onto numeric columns. T8 verifies in Playwright.

## Stack

| Role  | Family             | Loaded weights | Fallback chain                                                              |
|-------|--------------------|----------------|-----------------------------------------------------------------------------|
| sans  | Schibsted Grotesk  | 400, 500       | Schibsted Grotesk Fallback (Arial-metrics) → system-ui → sans-serif         |
| mono  | JetBrains Mono     | 400, 500       | JetBrains Mono Fallback (Menlo-metrics) → ui-monospace → monospace          |

Newsreader is intentionally not loaded (dropped by Sebk on 2026-06-22).

The Google Fonts URL in `apps/web/index.html` requests exactly the weights
above — no over-request, no variable-range syntax. Both rules are asserted by
AC-T2.

## 5-step weight ramp (placeholder — T2 owns the final values)

The bet body names 400 (body) and 500 (label) explicitly. The values below
are a conservative first pass against the loaded weight set (400 + 500 only);
T2 may refine sizes, line-heights, and tracking — and may add a third weight
if a tighter title needs it.

| Step       | Size  | Line-height | Weight | Letter-spacing | Notes                              |
|------------|-------|-------------|--------|----------------|------------------------------------|
| page title | 32px  | 1.15        | 500    | -0.02em        | Used once per page                 |
| section    | 20px  | 1.3         | 500    | -0.015em       | Major section headers              |
| label      | 13px  | 1.4         | 500    | -0.005em       | Form labels, metadata, badges      |
| body       | 14px  | 1.55        | 400    | 0              | Default body, prose                |
| caption    | 12px  | 1.4         | 400    | 0              | Helper text, timestamps            |

Tracking-by-size is approximated by the negative letter-spacing column. T2
may swap this for a tracking curve pinned to size breakpoints.

## Dark-mode body weight

Per the Roboto Flex grade study linked on the bet, heavier weights in dark
mode measurably reduce reading fluency. Default: **dark mode uses the same
weight as light mode** for body (400). Do not go heavier in DM to compensate
for halation. T2 may revisit; this is the safe default.

## Numeric column treatment

JetBrains Mono carries `font-variant-numeric: tabular-nums` by default (set
on `.font-mono`, `code`, `kbd`, `samp`, `pre` in `app.css`). Sans numerals on
table columns also need tabular-nums — apply Tailwind's `tabular-nums` class
on those cells. AC-U4 verifies this on every numeric column.

## Long-form measure cap

Long-form prose (object descriptions, hypothesis bodies, retros) caps at
`max-w-[75ch]` on viewports ≥1280px. Below that, content fills available
width. Applied by T4 on object detail; T5/T6 apply where relevant.

## Tokens

CSS variables defined in `apps/web/src/app.css`:

- `--font-sans` — full sans fallback chain
- `--font-mono` — full mono fallback chain

Tailwind classes `font-sans` and `font-mono` resolve to these. Body element
uses `font-sans` by default.

## CLS budget

Cold-cache font swap must produce <0.05 CLS (AC-T3). The `@font-face`
fallback families (`Schibsted Grotesk Fallback`, `JetBrains Mono Fallback`)
in `app.css` carry `size-adjust` / `ascent-override` / `descent-override`
overrides tuned so the fallback render box approximates the webfont box.
First-pass values are conservative; T8 will pin them against measured CLS.
