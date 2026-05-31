# Known Pitfalls Registry

A living registry of bugs that have been fixed before and should be checked for in new code. Before submitting a PR, review this list for any patterns that match your changes.

## PG NOTIFY Payload Size (8KB Limit)

- **What**: `pg_notify()` silently fails — it rolls back the triggering INSERT — if the payload exceeds 8KB. There is no warning or error; the row simply doesn't get inserted.
- **When to check**: Any time you write or modify a DB trigger that uses `pg_notify()`.
- **Fix pattern**: Truncate or omit large fields (especially `content`, `description`, or any free-text column) before including them in the notification payload. See migration `0006_notify_drop_data.sql` for the established pattern.
- **History**: Originally fixed for the `events` table in migration `0006_notify_drop_data.sql`. Re-introduced for `session_logs` in PR #224 when a new trigger included the full `NEW.content` field.

## Shell Injection via String Interpolation

- **What**: Interpolating untrusted strings into shell commands allows command injection. An attacker-controlled value in an `export` statement, `exec()` call, or template literal that becomes shell input can execute arbitrary commands.
- **When to check**: Any time you construct shell commands from variables — `export` statements, `exec()` calls, `spawn()` with `shell: true`, or template literals that become shell input.
- **Fix pattern**: Validate input against a strict allowlist regex before interpolation. For env var keys, use `[A-Za-z_][A-Za-z0-9_]*`. Prefer parameterized APIs (e.g., `spawn(cmd, args)` without `shell: true`) over string interpolation. See `.claude/rules/input-validation.md` for the full checklist.
- **History**: Shell injection via env var key interpolation in `buildEnvExports()`, fixed in PR #230.

## Numeric Parameter Parsing (NaN Propagation)

- **What**: `Number()` returns `NaN` for non-numeric strings, and `NaN` propagates silently through arithmetic. When passed to a SQL query, it produces unexpected results or errors without any validation failure at the parsing step.
- **When to check**: Any HTTP query parameter, path parameter, or config value parsed as a number.
- **Fix pattern**: Always check `Number.isFinite()` after parsing and fall back to a sensible default. Also validate range (e.g., no negative values for pagination `limit` or `offset`). See `.claude/rules/input-validation.md` for the safe parsing pattern.
- **History**: `NaN` propagation to SQL query in `GET /sessions` route, fixed in PR #235.

## Inline Action Buttons Need a CTA Affordance, Not Just Text Color

- **What**: An action button styled as plain colored text (no border, no background, no underline, no icon) reads as a metadata label when it sits next to other muted-foreground chips (status badges, durations, timestamps). Two failure modes hit this surface so far:
  1. `text-accent` — invisible in light mode because `--accent` is a near-white background token, and `hover:text-accent-hover` silently does nothing (no `accent-hover` token defined).
  2. `text-muted-foreground hover:text-foreground` — visible in both themes but indistinguishable from the adjacent muted metadata, so it reads as a label rather than an action.
- **When to check**: Any time you add an action element inline with metadata (status badges, durations, timestamps) — especially inside a `flex-wrap` row of text-only chips.
- **Fix pattern**: Use the shadcn `Button` primitive from `@/components/ui/button` with a stock variant. `variant="outline"` is the default fit for an inline action — it ships with border + padding + hover state that work in both themes by construction. Don't hand-roll a `bg-accent` chip or override the variant's height/padding. If a stock variant genuinely doesn't fit, file an insight rather than inventing one inline.
- **History**: Introduced on Restart/Retry buttons in PR #503 (`text-accent`), the first fix on `bet/session-restart` (`text-muted-foreground`) made it visible but it still read as a label, then fixed for real by swapping the raw `<button>` for the `Button` primitive with `variant="outline" size="sm"` on `session-detail-panel.tsx`.

## Adding New Entries

This file should be updated whenever a new recurring bug pattern is identified. Each entry must include:

1. **What** — describe the bug and why it is dangerous (silent failure, security risk, data corruption, etc.)
2. **When to check** — the specific trigger that should prompt you to look for this pattern
3. **Fix pattern** — the concrete fix, with a reference to existing code or rules that demonstrate it
4. **History** — which PR introduced and/or fixed the bug, so future developers can find the full context
