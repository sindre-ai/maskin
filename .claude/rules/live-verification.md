# Live Verification — Integrations and Provider Surfaces

`verification.md` requires integration tests and E2E specs. Those gates are
necessary and they are **not sufficient for provider integrations**. A Slack bet
shipped to `main` with a green unit suite, a green integration suite and a green
Playwright run, while a webhook that never fired, filter chips rendering raw
Slack ids, and an event taxonomy the trigger matcher had to special-case in a
string-suffix hack all went undetected.

Every one of those defects was invisible in the diff and provable in under a
minute against a real Slack workspace. Reviewing the diff harder cannot reach
this class of bug. The gate has to be evidence from a live environment.

## When this rule applies

Any change touching:

- `apps/dev/src/lib/integrations/providers/**`
- `apps/dev/src/routes/integrations*.ts` or `webhooks*.ts`
- A provider's MCP server (`providers/*/mcp-server.ts`)
- The trigger surfaces that consume provider events —
  `services/trigger-runner.ts`, `apps/web/src/components/triggers/**`
- Any provider setup or connect UX

## The rule: mocks are evidence of nothing

**A test double that you wrote cannot verify your model of the provider is
correct.** It encodes that model. When the model is wrong the double is wrong in
exactly the same way, and the suite goes green on a path production can never
take. This has now happened twice on record:

- The Unipile in-process mock answered `200` on the bare `/chats` route the live
  API answers `501` on, so `linkedin_send_message` could never open a new
  conversation while the whole suite passed (`known-pitfalls.md`).
- The Slack event taxonomy split one provider event into three synthetic ones by
  channel-id prefix. Every test asserted the split it was written alongside.

Mocks remain correct for verifying *our* logic — branch coverage, error
handling, auth. They are never evidence that a provider behaves as assumed.
When a mock stands in for a provider route, it must reproduce the provider's
**actual** response for the wrong call, not a convenient success.

## Required: a declared surface matrix, derived from code

Every qualifying PR declares its matrix in the PR body. Derive it by reading the
code, never from memory:

| Axis | Source of truth |
|------|-----------------|
| Events | the provider config's `events.definitions` array |
| Tools | the tools registered in `providers/<name>/mcp-server.ts` |
| Scopes | the provider's app manifest (e.g. `docs/integrations/slack/manifest.yml`) |
| Setup steps | the connect/setup UX, step by step, including every failure branch |

Each row the PR touches carries a verdict: **verified live**, **unchanged and
out of scope**, or **known broken** (with a linked follow-up). A row with no
verdict blocks the merge. This is deliberately mechanical — the reviewer diffs
the matrix against the config file and fails the PR on a missing row, rather
than judging provider semantics from a diff, which it cannot do.

## Required: evidence per verified row

For each row marked verified live, attach the real artefacts:

- **Webhook** — the payload the provider actually delivered (redacted), the
  `events` row id it produced, and the trigger that fired. Verify by query
  against the `events` table, not by "the handler returned 200".
- **MCP tool** — the request and the provider's real response, from a session
  against a live workspace. A tool that has only ever been called against a mock
  is unverified.
- **Setup UX** — a walkthrough of the real flow at 375px and 1024px, including
  what a user sees on the failure branches (denied consent, missing scope, bot
  not in channel).

Run the matrix in **staging first, then production**. Production is where the
real app manifest, the real scope grants and the real installs live; staging
cannot prove those. A production smoke run of every touched row is a named,
blocking step, not a follow-up.

## Verify by query, not by status

The same discipline the Alloy and Faro entries in `known-pitfalls.md` arrive at:
a component reporting healthy, a handler returning 200, and a green suite are
all *statuses*. None is an observation of the thing working. Ask the system for
the row, the message, the rendered label — and read what comes back.

## Naming: users never see provider ids

Any id sourced from a provider — channel, user, team, conversation, thread —
must render as a human-readable name wherever a user can see it: pickers, saved
filter chips, trigger summaries, confirmations, error messages. An id is
acceptable only as secondary metadata beside a resolved name, never as the
label, and never as the fallback when resolution fails — resolve it or say
plainly that it could not be resolved.

Check the saved/collapsed state, not just the picker. A filter that reads well
while being chosen and renders `C09ABCDEF` once saved has failed this rule.

## Taxonomy: do not invent event types the provider does not send

Normalize the provider's event as the provider sends it, and express variation
as **filters over payload fields** the provider already supplies. Splitting one
provider event into several synthetic entity types duplicates a dimension that
is already in the payload and forces compensating logic everywhere downstream.

The Slack case is the worked example: splitting `message` by channel-id prefix
into `channel_message` / `group_message` / `direct_message` required a
string-suffix special case in `trigger-runner.ts` so the catch-all would match
its own subtypes, plus two parallel lookup tables in `slack-filters.tsx`. The
`channel_type` field on the payload already carried that information.
