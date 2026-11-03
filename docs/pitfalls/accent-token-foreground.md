# `accent` Token Used Without Its Foreground Pair (Invisible in Light Mode)

`--accent` is a near-white background token in light mode. Using it as a standalone visible color (text, dot, or rail) produces near-invisible output on white surfaces.

**Variant A — `text-accent` as a text color**
- **What**: Text rendered with `text-accent` is nearly invisible in light mode.
- **When to check**: Any time you add a styled text button or inline action element.
- **Fix pattern**: Use `text-muted-foreground hover:text-foreground` for inline action buttons.
- **History**: Introduced on Restart/Retry buttons in PR #503, fixed on `bet/session-restart`.

**Variant B — `bg-accent` on a text-free indicator (dot, rail, badge background)**
- **What**: `bg-accent` on a small shape (unread dot, gutter rail, status indicator) with no accompanying text looks correct in dark mode but is near-invisible in light mode. Unlike a labelled pill, there is no `text-accent-foreground` child to catch the problem.
- **When to check**: Any time you add a purely visual indicator — a dot, a stripe, a pill background, a left-border rail — that carries no text content.
- **Fix pattern**: Use `bg-primary` for indicators that must be visually prominent in both modes. Reserve `bg-accent` for backgrounds that are always paired with `text-accent-foreground` (e.g. the "Needs you" pill: `bg-accent text-accent-foreground`).
- **History**: Introduced on unread dot and decision-point gutter rail in PR #622, fixed in the review commit on `bet/timeline-ux`.
