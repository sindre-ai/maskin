# Feature Flags

Ship a feature to a couple of named testers before everyone else. Config lives
in the `apps/dev` environment and is read at runtime, so turning a feature on or
off is an env change plus a backend restart — never a frontend rebuild, never a
redeploy of `apps/web`.

## The two env vars

```
FF_TESTER_ACTOR_IDS=<uuid>,<uuid>                  # actors who get early access
FF_TESTER_FEATURES=new-design,new-model            # flag ids those actors see
```

Both are comma-separated and optional; empty means every flag is off for
everyone. Values are trimmed, empty entries dropped, actor ids compared
case-insensitively. They are deliberately **not** `VITE_`-prefixed — the tester
actor ids stay server-side and never reach the browser.

A flag has exactly two states: **off**, or **on for the tester actors**. There
is no "on for everyone" setting, on purpose — see *Retiring a flag* below.

One tester audience is shared by all flags. `FF_TESTER_FEATURES=a,b` means the
same people see both. Schedules are independent (graduate `a` while `b` waits);
audiences are not. Per-flag audiences would need a new var.

## Adding a flag

1. **Register the id** in `FLAGS` in `apps/dev/src/lib/feature-flags.ts`. Ids
   absent from this registry always resolve to `false`, so a typo in the env
   can't invent a flag.
2. **Add the boundary** — see the rule below.
3. **Add the id** to `FF_TESTER_FEATURES` in the environment and restart.

Nothing else is needed: `GET /api/feature-flags` resolves every registered flag
for the calling actor automatically, and the frontend fetches all of them at
once.

## One boundary per feature, as high in the tree as possible

Read the flag **once**, at the highest sensible point — the app shell or a route
layout — and branch there. Do not scatter `useFeatureFlag` checks across
individual components.

```tsx
const newDesign = useFeatureFlag('new-design')
...
{newDesign ? <ObjectsPageV2 /> : <LegacyObjectsPage />}
```

`new-design` is the live flag. It was retired once when the v2 shell shipped to
everyone, and re-added for the untested v2 surfaces. Its read sites are all route
components, each swapping a whole page, with the pre-v2 components vendored under
a sibling `legacy/` directory that dies with the flag:

| Route component | Pre-v2 branch |
|---|---|
| `objects/index.tsx` | `components/objects/legacy/` |
| `objects/$objectId.tsx` | `components/objects/legacy/` |
| `search.tsx` | `components/search/legacy/` |
| `marketplace/index.tsx` | `components/marketplace/legacy/` |
| `marketplace/$loopId/index.tsx` | `components/marketplace/legacy/` |
| `marketplace/$loopId/$itemId.tsx` | `components/marketplace/legacy/` |

Note what is *not* behind it: the routes' `validateSearch`, the shared filter and
grouping helpers, `useWorkspaceSearch`, the marketplace hooks, and the additive
`ObjectReference` `pill` variant and `item-type-label` helpers. Both branches run
on the same search schema and the same data layer, per the rule below.

**One route component = one boundary.** `new-design` has more than two read sites
because it governs more than two pages, and a page is the highest point at which
its own branch can be chosen. What must never happen is a *second* check inside a
page already on one side of the boundary — that is the signal the boundary is in
the wrong place, and the fix is to move it up rather than add another check.

When a feature rewrites components in place, keep the old ones under a clearly
marked `legacy/` directory with a header comment saying which flag governs them
and that the directory dies with the flag.

## What NOT to flag

Flags are for the **visual layer only**. Do not flag data-layer changes, API
changes, or migrations — those must be safe for all users on their own, because
a user with the flag off still hits the same backend. If a design change
genuinely requires a breaking backend change, raise it rather than wrapping it
in a flag.

## Test-only override

`localStorage['ff:<flagId>'] = 'on' | 'off'` beats the server response. This
exists **solely** so a Playwright run can drive both sides of a boundary without
provisioning a second actor. It is not a user-facing mechanism: testers get
their flags from `FF_TESTER_ACTOR_IDS` on login, on every device, with no
client-side action.

A spec that needs a specific flag state sets it via `page.addInitScript` before
the app boots — see how `auth.fixture.ts` seeds its other localStorage keys.

## Retiring a flag — how a feature ships to everyone

You do **not** promote a flag. You delete it:

1. Remove the boundary (keep the new branch, drop the old one)
2. Delete the `legacy/` directory it guarded
3. Remove the id from `FLAGS`
4. Remove the id from `FF_TESTER_FEATURES` and restart

There is deliberately no "everyone" env list, because such a list only ever
grows and quietly becomes a graveyard of undeleted code. If a flag has been on
for testers for months, that is the signal to finish step 1–4, not to promote it.

## Failure behaviour

The frontend cache (`apps/web/src/lib/feature-flags.ts`) is
stale-while-revalidate: it seeds synchronously from `localStorage` so a repeat
visit never flashes the wrong UI, then revalidates in the background. On any
fetch failure it falls back to the last cached value, then to all-false. It
never throws — a flags outage must not white-screen the app.

## Files

| File | Role |
|------|------|
| `apps/dev/src/lib/feature-flags.ts` | `FLAGS` registry + pure `resolveFlags()` |
| `apps/dev/src/routes/feature-flags.ts` | `GET /api/feature-flags` (auth'd, `no-store`, booleans only) |
| `apps/web/src/lib/feature-flags.ts` | fetch + localStorage cache, sync reads |
| `apps/web/src/hooks/use-feature-flag.ts` | `useFeatureFlag(id): boolean` |
| `apps/web/src/routes/_authed.tsx` | loads flags in `beforeLoad` |

Remember `turbo.json` `globalPassThroughEnv` — an env var missing from that list
is silently unavailable at runtime, with no error.
