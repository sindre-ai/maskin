# Web ↔ iOS Parity

The web app (`apps/web`) and the Apple app (`apps/apple`) are one product with two
clients. A user must not find a feature, field, filter, action, label or behaviour on one
that is missing or different on the other. Agents have repeatedly changed one client and
left the other behind; this rule closes that gap.

## The rule

**A user-visible change to one client is incomplete until the equivalent change is made in
the other, in the same task and the same PR.** This holds in both directions:

- Changed `apps/web`? Make the equivalent change in `apps/apple`.
- Changed `apps/apple`? Make the equivalent change in `apps/web`.

Do not open a PR, or report the work as done, with only one side changed.

## What counts as user-visible

Parity applies to anything a person can see or do:

- New, removed or renamed features, screens, tabs, settings, actions, buttons
- Fields, filters, sort options, grouping, search behaviour, empty/error/loading states
- Labels, copy, status names and their meaning
- Permissions and what is shown to whom
- Bug fixes to behaviour (the same bug usually exists on both sides — check, then fix both)

## What does NOT need a mirror

- Backend-only changes with no client effect (both clients consume the same API)
- Tooling, CI, docs, tests, refactors that change no behaviour
- **Platform idiom.** Match the *capability and meaning*, not the pixels. iOS uses native
  controls (`NavigationStack`, sheets, `.searchable`, swipe actions); web uses its own
  patterns (see `apps/web/CLAUDE.md`). A hover menu on web may be a swipe action or
  context menu on iOS. Do not recreate web chrome on iOS or vice versa.
- Web-only surfaces (e.g. `apps/landing`, admin pages) or Apple-only surfaces (watch,
  tv, widgets) — only when the other client genuinely has no equivalent surface. If a
  user could reasonably expect it on the other client, it needs one.

## How to work

1. **Before starting**, find the counterpart: search the other client for the same screen,
   feature or label. State in your plan where each side will change.
2. **Backend first, when needed.** If the change needs an API change, make it once; then
   update both clients. Regenerate the Apple client (`apps/apple/CLAUDE.md`) and the web
   types.
3. **Same wording, same names, same behaviour.** Reuse the exact label/copy, the same
   sort order (alphabetical default — see root CLAUDE.md), the same status semantics.
4. **Verify both.** Run the web checks (lint, type-check, tests, the three viewports) and
   the Apple checks (`swift test`, simulator build, `scripts/run-must-keep.sh`).
5. **Declare it in the PR body** with a short parity line per change:
   `Web: <what changed> · iOS: <what changed>` — or, for an exempt change,
   `Parity: n/a — <reason from the list above>`.

## When you genuinely cannot do both

Only the user can waive this. If the other side is blocked (missing API, needs a design
decision, can't build iOS in this environment), do **not** silently ship one side:

- Stop and tell the user exactly which side is missing and why.
- Ship only if the user agrees, and then open a linked follow-up task for the missing
  side and name it in the PR description under `Parity: deferred`.

"It's a small change" and "the other app is someone else's area" are not reasons to skip.
