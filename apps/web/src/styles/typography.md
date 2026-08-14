# Typography spec

The single source of truth for the app's typographic system. T3 wires the
loader and tokens. T4–T6 apply the ramp to surfaces. T7 sweeps tabular-nums
onto numeric columns. T8 verifies in Playwright.

## Stack

| Role  | Family             | Loaded weights | Fallback chain                                                              |
|-------|--------------------|----------------|-----------------------------------------------------------------------------|
| sans  | Schibsted Grotesk  | 400, 500, 600  | Schibsted Grotesk Fallback (Arial-metrics) → system-ui → sans-serif         |
| mono  | JetBrains Mono     | 400, 500       | JetBrains Mono Fallback (Menlo-metrics) → ui-monospace → monospace          |

Newsreader is intentionally not loaded (dropped by Sebk on 2026-06-22).

The Google Fonts URL in `apps/web/index.html` requests exactly the weights
above — no over-request, no variable-range syntax. Both rules are asserted by
AC-T2. Adding `600` to Schibsted Grotesk was approved on 2026-06-23 by the
Strategist: at 24px/500 the page title sat flat against the section ramp,
and `font-bold` on the title element fell back unpredictably because 700
was never loaded. Total payload across both families is five statics,
~110KB cold-cache, inside the 120KB budget.

## 5-step weight ramp

Tailwind class shown alongside the absolute values so call sites can pin to
the named token.

| Step       | Tailwind            | Size  | Line-height | Weight | Letter-spacing | Notes                              |
|------------|---------------------|-------|-------------|--------|----------------|------------------------------------|
| page title | `text-2xl`/`font-semibold` | 24px  | 1.2         | 600    | -0.022em       | Used once per page                 |
| section    | `text-lg`/`font-medium`    | 18px  | 1.3         | 500    | -0.013em       | Major section headers              |
| label      | `text-xs`/`font-medium`    | 12px  | 1.4         | 500    | -0.003em       | Form labels, metadata, badges      |
| body       | `text-sm`/`font-normal`    | 14px  | 1.55        | 400    | -0.006em       | Default body, prose                |
| caption    | `text-xs`/`font-normal`    | 12px  | 1.4         | 400    | -0.003em       | Helper text, timestamps            |

Tracking-by-size curves from -0.022em at 24px down to -0.003em at 12px.
The Designer's spec interpolates linearly between size breakpoints; call
sites between named steps pick the closest.

## Dark-mode body weight

Per the Roboto Flex grade study linked on the bet, heavier weights in dark
mode measurably reduce reading fluency. **Dark mode uses the same weight as
light mode** for body (400). Do not go heavier in DM to compensate for
halation — the failure mode to watch is "we made it heavier and it got
worse," not "too thin."

## Numeric column treatment

JetBrains Mono carries `font-variant-numeric: tabular-nums` by default (set
on `.font-mono`, `code`, `kbd`, `samp`, `pre` in `app.css`). Sans numerals on
table columns also need tabular-nums — apply Tailwind's `tabular-nums` class
on those cells. T7 sweeps remaining sans numeric columns; AC-U4 verifies
this on every numeric column.

## Long-form measure cap

Long-form prose (object descriptions, hypothesis bodies, retros) caps at
`max-w-[75ch]` on viewports ≥1280px (Tailwind `xl:max-w-[75ch]`). Below
that breakpoint, content fills available width. Applied by T4 on the object
detail page; T5/T6 apply where relevant.

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

## OpenType features

Schibsted Grotesk's `font-feature-settings` story isn't well documented and
the family has no optical-size axis (`opsz`), so the tracking curve above
substitutes for what variable-axis fonts handle via the axis. T8 may add
`cv01` / `ss03` / slashed-zero after measurement if any feel-gap remains.
